#include "screen/local_screen_preview.hpp"
#include "screen/screen_frame_pipeline.hpp"
#include <d3d11_1.h>
#include <d3d11sdklayers.h>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>

using namespace syrnike::windows_media;
using namespace std::chrono_literals;
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
int main() {
  try {
    auto owner = capture::processD3d11Device(true);
    auto& preview = screen::LocalScreenPreview::processPreview();
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = 1920; desc.Height = 1080; desc.ArraySize = 1; desc.MipLevels = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> source;
    std::vector<std::uint32_t> pixels(1920 * 1080, 0xff20c040);
    D3D11_SUBRESOURCE_DATA data{pixels.data(), 1920 * 4, 0};
    require(SUCCEEDED(owner->device()->CreateTexture2D(&desc, &data, &source)), "source allocation");
    capture::D3d11FrameView view{owner, source.Get()};
    capture::FrameMetadata metadata{1, screen::screenSteadyTimestamp100ns(), 1920, 1080};
    require(preview.beginPublication(7), "publication admission");
    require(!preview.beginPublication(8), "second owner admitted");
    preview.offer(view, metadata);
    require(preview.stats().backing_bytes == 0, "off allocated textures");
    std::uint64_t revision = 0;
    const auto frame = [&] {
      metadata.capture_timestamp_100ns = screen::screenSteadyTimestamp100ns();
      ++metadata.sequence;
      preview.offer(view, metadata);
      const auto deadline = std::chrono::steady_clock::now() + 2s;
      while (std::chrono::steady_clock::now() < deadline) {
        if (auto value = preview.takeFrame()) return *value;
        std::this_thread::yield();
      }
      throw std::runtime_error("preview frame deadline");
    };
    require(preview.demand(++revision, true), "preview on");
    const auto first = frame();
    require(first.publication_generation == 7 && first.width == 1280 && first.height == 720,
            "preview correlation/downscale");
    // Read the actual exported GPU allocation, not just internal counters.
    Microsoft::WRL::ComPtr<ID3D11Device1> device1;
    require(SUCCEEDED(owner->device()->QueryInterface(IID_PPV_ARGS(&device1))), "device1");
    Microsoft::WRL::ComPtr<ID3D11Texture2D> imported;
    require(SUCCEEDED(device1->OpenSharedResource1(reinterpret_cast<HANDLE>(first.handle),
        IID_PPV_ARGS(&imported))), "shared texture import");
    Microsoft::WRL::ComPtr<IDXGIKeyedMutex> keyed;
    require(SUCCEEDED(imported.As(&keyed)) && keyed->AcquireSync(0, 0) == S_OK, "preview fence");
    D3D11_TEXTURE2D_DESC readback_desc{};
    imported->GetDesc(&readback_desc);
    readback_desc.BindFlags = 0; readback_desc.MiscFlags = 0;
    readback_desc.Usage = D3D11_USAGE_STAGING; readback_desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> readback;
    require(SUCCEEDED(owner->device()->CreateTexture2D(&readback_desc, nullptr, &readback)), "readback");
    {
      std::lock_guard lock(owner->contextMutex());
      owner->context()->CopyResource(readback.Get(), imported.Get());
      D3D11_MAPPED_SUBRESOURCE mapped{};
      require(SUCCEEDED(owner->context()->Map(readback.Get(), 0, D3D11_MAP_READ, 0, &mapped)), "map preview");
      const auto* pixel = static_cast<const std::uint8_t*>(mapped.pData);
      const bool matches = pixel[1] > 160 && pixel[0] < 100 && pixel[2] < 80;
      owner->context()->Unmap(readback.Get(), 0);
      require(matches, "preview does not contain source pixels");
    }
    require(SUCCEEDED(keyed->ReleaseSync(0)), "release keyed mutex");
    keyed.Reset(); imported.Reset(); readback.Reset();
    const auto second = frame();
    for (int i = 0; i < 1000; ++i) preview.offer(view, metadata);
    auto stalled = preview.stats();
    require(stalled.outstanding == 2 && stalled.pool_drops >= 1000 &&
        stalled.backing_bytes <= preview.kPreviewBudget, "never release exceeded fixed pool");
    require(preview.demand(++revision, false), "stop preview");
    require(!preview.demand(revision - 1, true), "stale demand resurrected preview");
    require(!preview.release(first.generation, first.sequence + 1, first.slot), "wrong release accepted");
    require(preview.release(first.generation, first.sequence, first.slot), "retired release");
    require(!preview.release(first.generation, first.sequence, first.slot), "duplicate release accepted");
    require(preview.release(second.generation, second.sequence, second.slot), "second release");
    require(preview.stats().backing_bytes == 0 && preview.stats().publication_active,
            "preview stop changed publication or retained backing");
    for (int cycle = 0; cycle < 100; ++cycle) {
      require(preview.demand(++revision, true), "cycle on");
      const auto lease = frame();
      std::thread release([&preview, lease] {
        require(preview.release(lease.generation, lease.sequence, lease.slot), "concurrent release");
      });
      require(preview.demand(++revision, false), "cycle off");
      release.join();
      require(preview.stats().backing_bytes == 0, "cycle leaked texture");
    }
    require(preview.setProcessBudget(preview.kPublicationReserve + preview.kRemoteReserve), "pressure admission");
    require(preview.demand(++revision, true), "pressure demand");
    preview.offer(view, metadata);
    require(!preview.takeFrame() && preview.stats().pressure_drops == 1 &&
        preview.stats().backing_bytes == 0 && preview.stats().publication_active, "preview did not yield budget");
    require(preview.setProcessBudget(preview.kProcessBudget), "restore budget");
    const auto outstanding = frame();
    preview.stopPublication();
    require(preview.stats().state == screen::PreviewState::stopped, "publication stop did not end preview");
    require(preview.release(outstanding.generation, outstanding.sequence, outstanding.slot), "stop outstanding release");
    require(preview.stats().backing_bytes == 0 && preview.stats().outstanding == 0 &&
        preview.stats().quarantined == 0, "final resources");
    require(preview.beginPublication(8), "new publication");
    const auto failures_before = preview.stats().failures;
    preview.offer({}, metadata);
    require(preview.stats().failures == failures_before + 1 &&
        preview.stats().state == screen::PreviewState::degraded && preview.stats().publication_active,
        "preview failure changed publication");
    // Producer exits with an asynchronous copy outstanding. Stop and poll on a
    // different thread must not inherit keyed-mutex ownership from that worker.
    std::thread producer([&] { preview.offer(view, metadata); });
    producer.join();
    preview.stopPublication();
    const auto retire_deadline = std::chrono::steady_clock::now() + 2s;
    while (preview.stats().pending && std::chrono::steady_clock::now() < retire_deadline) {
      require(!preview.takeFrame(), "retired copy delivered");
      std::this_thread::yield();
    }
    require(preview.stats().backing_bytes == 0 && preview.stats().quarantined == 0,
            "producer-exit copy leaked");
    view.texture = nullptr; source.Reset();
    owner->context()->ClearState(); owner->context()->Flush();
    Microsoft::WRL::ComPtr<ID3D11Debug> debug;
    Microsoft::WRL::ComPtr<ID3D11InfoQueue> messages;
    require(owner->debugLayerEnabled() && SUCCEEDED(owner->device()->QueryInterface(IID_PPV_ARGS(&debug))) &&
        SUCCEEDED(owner->device()->QueryInterface(IID_PPV_ARGS(&messages))), "D3D debug layer required");
    messages->ClearStoredMessages();
    require(SUCCEEDED(debug->ReportLiveDeviceObjects(static_cast<D3D11_RLDO_FLAGS>(
        D3D11_RLDO_DETAIL | D3D11_RLDO_IGNORE_INTERNAL))), "D3D live resource report");
    for (UINT64 i = 0; i < messages->GetNumStoredMessages(); ++i) {
      SIZE_T size = 0;
      require(SUCCEEDED(messages->GetMessage(i, nullptr, &size)), "D3D message size");
      std::vector<std::uint8_t> buffer(size);
      auto* message = reinterpret_cast<D3D11_MESSAGE*>(buffer.data());
      require(SUCCEEDED(messages->GetMessage(i, message, &size)), "D3D message");
      require(message->ID != D3D11_MESSAGE_ID_LIVE_TEXTURE2D, "D3D reports live preview/source texture");
    }
    std::cout << "PASS: pixels, independent demand, hard pool, priority, 100 concurrent cycles, publication stop\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; return 1;
  }
}
