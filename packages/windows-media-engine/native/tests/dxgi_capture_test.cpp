#include "capture/dxgi_frame_compositor.hpp"
#include "sources/win32_source_enumerator.hpp"
#include <iostream>
#include <vector>
#include <thread>
#include <condition_variable>
#include <cmath>
#include "fault_evidence.hpp"

// Exercise the real worker and its cleanup with a one-shot platform failure.
// The shipping capture library has no runtime injection switch.
std::atomic<HRESULT> next_acquire_failure{S_OK};
HRESULT testDxgiAcquire(IDXGIOutputDuplication* duplication,
                       DXGI_OUTDUPL_FRAME_INFO* frame, IDXGIResource** resource) {
  const auto failure = next_acquire_failure.exchange(S_OK);
  if (FAILED(failure)) return failure;
  return duplication->AcquireNextFrame(0, frame, resource);
}
#define WINDOWS_MEDIA_TEST_DXGI_ACQUIRE testDxgiAcquire
#include "capture/dxgi_monitor_capture.cpp"
#undef WINDOWS_MEDIA_TEST_DXGI_ACQUIRE

using namespace syrnike::windows_media;
using namespace capture;
using namespace std::chrono_literals;
namespace {
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
void compositorGoldens() {
  auto device = processD3d11Device(true);
  const std::array<std::uint32_t, 6> pixels{0xff102030, 0xff405060, 0xff708090,
                                            0xffa0b0c0, 0xffd0e0f0, 0xff123456};
  D3D11_TEXTURE2D_DESC description{};
  description.Width = 2;
  description.Height = 3;
  description.MipLevels = description.ArraySize = description.SampleDesc.Count = 1;
  description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  D3D11_SUBRESOURCE_DATA initial{pixels.data(), 8, 0};
  Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
  require(SUCCEEDED(device->device()->CreateTexture2D(&description, &initial, &texture)),
          "test texture allocation failed");
  const std::array<std::array<unsigned, 6>, 4> golden{
      {{0, 1, 2, 3, 4, 5}, {4, 2, 0, 5, 3, 1}, {5, 4, 3, 2, 1, 0}, {1, 3, 5, 0, 2, 4}}};
  for (unsigned rotation = 1; rotation <= 4; ++rotation) {
    auto compositor = std::make_unique<detail::DxgiFrameCompositor>(
        device, 2, 3, static_cast<DXGI_MODE_ROTATION>(rotation));
    auto counters = compositor->counters();
    auto slot = compositor->reserve();
    require(slot.has_value(), "no initial slot");
    {
      std::unique_lock lock(device->contextMutex());
      compositor->copyDesktop(*slot, texture.Get(), lock);
    }
    auto frame = compositor->compose(*slot);
    std::array<std::uint8_t, 24> bytes{};
    frame->copyBgraTo(bytes, compositor->width() * 4);
    for (unsigned index = 0; index < 6; ++index) {
      std::uint32_t actual;
      std::memcpy(&actual, bytes.data() + index * 4, 4);
      require(actual == pixels[golden[rotation - 1][index]], "rotation pixel golden mismatch");
    }
    {
      DXGI_OUTDUPL_POINTER_SHAPE_INFO pointer{};
      pointer.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR;
      pointer.Width = pointer.Height = 1;
      pointer.Pitch = 4;
      const std::array<std::uint8_t, 4> color{9, 8, 7, 255};
      compositor->pointerShape(color, pointer);
      compositor->pointerPosition(
          {static_cast<LONG>(compositor->width() - 1), static_cast<LONG>(compositor->height() - 1)},
          true);
      const auto pointer_slot = compositor->reserve();
      require(pointer_slot.has_value(), "rotated cursor slot missing");
      {
        std::unique_lock lock(device->contextMutex());
        compositor->copyDesktop(*pointer_slot, texture.Get(), lock);
      }
      auto pointer_frame = compositor->compose(*pointer_slot);
      pointer_frame->copyBgraTo(bytes, compositor->width() * 4);
      require(bytes[20] == 9 && bytes[21] == 8 && bytes[22] == 7,
              "cursor position did not use rotated desktop coordinates");
      compositor->pointerPosition({0, 0}, false);
    }
    std::vector<std::shared_ptr<FrameResource>> held;
    held.push_back(frame);
    frame.reset();
    for (unsigned index = 1; index < 3; ++index) {
      slot = compositor->reserve();
      require(slot.has_value(), "fixed slot missing");
      {
        std::unique_lock lock(device->contextMutex());
        compositor->copyDesktop(*slot, texture.Get(), lock);
      }
      held.push_back(compositor->compose(*slot));
    }
    require(!compositor->reserve() && counters->occupied == 3 && counters->textures == 7,
            "pool exceeded three frames/seven textures");
    compositor.reset();
    require(counters->occupied == 3 && counters->textures == 6,
            "leased textures retired too early");
    held.clear();
    require(counters->occupied == 0 && counters->textures == 0, "leased textures leaked");
  }
  detail::DxgiFrameCompositor compositor(device, 2, 3, DXGI_MODE_ROTATION_IDENTITY);
  const auto read = [&](const std::vector<std::uint8_t>& shape,
                        DXGI_OUTDUPL_POINTER_SHAPE_INFO info) {
    compositor.pointerShape(shape, info);
    compositor.pointerPosition({0, 0}, true);
    auto slot = compositor.reserve();
    {
      std::unique_lock lock(device->contextMutex());
      compositor.copyDesktop(*slot, texture.Get(), lock);
    }
    auto frame = compositor.compose(*slot);
    std::array<std::uint8_t, 24> bytes{};
    frame->copyBgraTo(bytes, 8);
    return bytes;
  };
  DXGI_OUTDUPL_POINTER_SHAPE_INFO info{};
  info.Width = 2;
  info.Height = 1;
  info.Pitch = 8;
  info.HotSpot = {1, 1};  // DXGI position is top-left, never adjusted by hotspot.
  info.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR;
  auto bytes = read({200, 100, 50, 255, 200, 100, 50, 0}, info);
  require(bytes[0] == 200 && bytes[1] == 100 && bytes[2] == 50 && bytes[4] == 0x60,
          "color cursor alpha/top-left mismatch");
  bytes = read({200, 100, 50, 128, 200, 100, 50, 0}, info);
  require(std::abs(static_cast<int>(bytes[0]) - 124) <= 1 &&
              std::abs(static_cast<int>(bytes[1]) - 66) <= 1 &&
              std::abs(static_cast<int>(bytes[2]) - 33) <= 1,
          "color cursor partial alpha mismatch");
  info.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR;
  bytes = read({255, 0, 255, 255, 9, 8, 7, 0}, info);
  require(bytes[0] == (0x30 ^ 255) && bytes[1] == 0x20 && bytes[2] == (0x10 ^ 255) && bytes[4] == 9,
          "masked cursor XOR/replace mismatch");
  info.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME;
  info.Height = 2;
  info.Pitch = 1;
  bytes = read({0x80, 0xc0}, info);
  require(bytes[0] == (0x30 ^ 255) && bytes[4] == 255 && bytes[5] == 255,
          "monochrome AND/XOR mismatch");
  bool rejected = false;
  try {
    compositor.pointerShape({}, info);
  } catch (const detail::DxgiApiError&) {
    rejected = true;
  }
  require(rejected, "short cursor metadata was accepted");
}
void realDuplication(HRESULT injected_failure = S_OK) {
  sources::SourceRegistry registry(sources::createWin32SourceEnumerator());
  sources::EnumerationOptions options;
  options.kind = sources::EnumerationOptions::Kind::Monitor;
  auto values = registry.enumerate(options);
  require(values.ok && !values.sources.empty(), "monitor enumeration failed");
  auto target = registry.resolveMonitorTarget(values.sources.front().id);
  require(target.target.has_value(), "monitor resolution failed");
  auto backend = createDxgiMonitorCaptureBackend(true);
  std::mutex mutex;
  std::condition_variable changed;
  std::shared_ptr<FrameResource> frame;
  std::optional<CaptureFailure> failure;
  unsigned terminal_callbacks = 0;
  const auto started = backend->start(
      *target.target,
      [&](BackendFrame value) {
        std::scoped_lock lock(mutex);
        frame = std::move(value.resource);
        changed.notify_all();
      },
      [&](CaptureFailure value) {
        std::scoped_lock lock(mutex);
        failure = value;
        ++terminal_callbacks;
        changed.notify_all();
      });
  require(started.ok, started.failure ? started.failure->message.c_str() : "DXGI start failed");
  {
    std::unique_lock lock(mutex);
    changed.wait_for(lock, 3s, [&] { return frame || failure; });
    require(frame && !failure, failure ? failure->message.c_str() : "DXGI first frame missing");
  }
  if (FAILED(injected_failure)) {
    next_acquire_failure = injected_failure;
    std::unique_lock lock(mutex);
    require(changed.wait_for(lock, 1s, [&] { return failure.has_value(); }),
            "DXGI platform fault was not detected within one second");
    const auto expected = injected_failure == DXGI_ERROR_ACCESS_LOST
        ? CaptureFailureKind::access_lost : CaptureFailureKind::device_removed;
    require(failure->kind == expected, "DXGI platform fault lost its typed cause");
  }
  require(backend->stop(std::chrono::steady_clock::now() + 3s).ok, "DXGI stop failed");
  require(terminal_callbacks == (FAILED(injected_failure) ? 1U : 0U),
          "DXGI terminal callback was missing or duplicated during stop");
  frame.reset();
  const auto stats = backend->diagnostics();
  require(stats.acquired_frames > 0 && stats.acquired_frames == stats.released_frames &&
              stats.active_leases == 0 && stats.allocated_textures == 0,
          "DXGI frame/resource leak");
  if (SUCCEEDED(injected_failure))
    std::cout << "DXGI acquired=" << stats.acquired_frames << " released=" << stats.released_frames
              << " maximumHoldUs=" << stats.maximum_duplication_hold_us << '\n';
}
}  // namespace
int main() {
  try {
    compositorGoldens();
    realDuplication();
    // NVIDIA initializes a further nvwgf2umx worker during the first stress
    // batch. Warm the same 100-cycle workload before checking resource deltas.
    tests::repeatFault("dxgi-access-lost", [] { realDuplication(DXGI_ERROR_ACCESS_LOST); }, 100);
    tests::repeatFault("dxgi-device-removed", [] { realDuplication(DXGI_ERROR_DEVICE_REMOVED); }, 100);
    std::cout << "DXGI compositor/duplication passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
