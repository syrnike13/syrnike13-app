#include "camera/camera_device_registry.hpp"
#include "camera/camera_frame.hpp"
#include "camera/camera_capture.hpp"
#include "camera/camera_pipeline.hpp"
#include "lab/synthetic_camera_reader.hpp"
#include "camera/camera_preview.hpp"
#include "capture/optional_preview_budget.hpp"
#include "screen/local_screen_preview.hpp"
#include "fault_evidence.hpp"
#include <d3d11_1.h>

#include <array>
#include <atomic>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <thread>

using namespace syrnike::windows_media::camera;
namespace {
void require(bool value, const char* reason) { if (!value) throw std::runtime_error(reason); }
template <typename Predicate>
void until(Predicate predicate, const char* reason,
           std::chrono::milliseconds budget = std::chrono::seconds{2}) {
  const auto deadline = std::chrono::steady_clock::now() + budget;
  while (!predicate()) {
    require(std::chrono::steady_clock::now() < deadline, reason);
    std::this_thread::sleep_for(std::chrono::milliseconds{1});
  }
}
void checkedConversion() {
  require(validCameraProfile({1280, 720, 30}) && validCameraProfile({1920, 1080, 30}) &&
          !validCameraProfile({3840, 2160, 30}), "Profile limits changed");
  std::array<std::uint8_t, 16> output{};
  const std::array<std::uint8_t, 6> nv12{16, 235, 16, 235, 128, 128};
  CameraBufferView view{nv12, 2, 2, 0, 2, CameraPixelFormat::nv12};
  require(convertCameraToBgra(view, output), "Valid NV12 rejected");
  require(output[0] == 0 && output[4] == 255 && output[3] == 255, "NV12 luma conversion changed");
  view.bytes = std::span(nv12).first(5);
  require(!convertCameraToBgra(view, output), "Truncated UV row accepted");
  view.bytes = nv12;
  view.stride = (std::numeric_limits<std::int32_t>::min)();
  require(!convertCameraToBgra(view, output), "Invalid signed stride accepted");
  view.stride = 2;
  view.width = (std::numeric_limits<std::uint32_t>::max)();
  require(!convertCameraToBgra(view, output), "Overflow dimensions accepted");
  const std::array<std::uint8_t, 8> yuy2{16, 128, 235, 128, 235, 128, 16, 128};
  require(convertCameraToBgra({yuy2, 2, 2, 0, 4, CameraPixelFormat::yuy2}, output) &&
          output[0] == 0 && output[4] == 255 && output[8] == 255, "YUY2 ordering changed");
  const std::array<std::uint8_t, 16> rgb{1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 0};
  require(convertCameraToBgra({rgb, 2, 2, 8, -8, CameraPixelFormat::bgra}, output) &&
          output[0] == 7 && output[8] == 1 && output[15] == 255, "Bottom-up RGB row mapping changed");
  require(!convertCameraToBgra({rgb, 2, 2, 0, -8, CameraPixelFormat::bgra}, output), "Negative buffer access accepted");
  require(!convertCameraToBgra({rgb, 2, 2, 0, 8, CameraPixelFormat::bgra}, std::span(output).first(15)),
          "Undersized destination accepted");
}
void boundedFrames() {
  CameraFramePort port;
  port.selectGeneration(1);
  std::array<std::uint8_t, 16> pixels{};
  CameraFrameMetadata metadata{1, 1, 1'000'000, 2, 2}, received;
  for (std::uint64_t sequence = 1; sequence <= 100; ++sequence) {
    metadata.sequence = sequence;
    pixels.fill(static_cast<std::uint8_t>(sequence));
    require(port.publish(metadata, pixels), "Valid camera frame rejected");
  }
  require(port.stats().queued == 1 && port.stats().overwritten == 99, "Camera backlog exceeded one frame");
  require(port.take(received, pixels, 1'000'000) && received.sequence == 100 && pixels[0] == 100,
          "Latest camera frame not delivered");
  metadata.sequence = 101;
  require(port.publish(metadata, pixels), "Age fixture rejected");
  require(!port.take(received, pixels, 3'000'000) && port.stats().stale == 1, "Old camera frame rendered");
  metadata.sequence = 102;
  require(port.publish(metadata, pixels), "Generation fixture rejected");
  port.selectGeneration(2);
  require(!port.take(received, pixels, 1'000'000) && !port.publish(metadata, pixels), "Old capture generation revived");
  metadata.generation = 2;
  metadata.sequence = 1;
  require(port.publish(metadata, pixels) && port.take(received, pixels, 1'000'000), "New capture generation failed");
  port.selectGeneration(0);
  require(!port.publish(metadata, pixels) && port.stats().queued == 0, "Stopped camera port revived");
}
void concurrentFrames() {
  CameraFramePort port;
  port.selectGeneration(1);
  std::atomic_bool done{false};
  std::thread producer([&] {
    std::array<std::uint8_t, 16> pixels{};
    for (std::uint64_t sequence = 1; sequence <= 20'000; ++sequence) {
      pixels.fill(static_cast<std::uint8_t>(sequence));
      (void)port.publish({1, sequence, 1'000'000, 2, 2}, pixels);
    }
    done.store(true, std::memory_order_release);
  });
  CameraFrameMetadata received;
  std::array<std::uint8_t, 16> pixels{};
  std::uint64_t previous = 0;
  bool valid = true;
  while (!done.load(std::memory_order_acquire) || port.stats().queued) {
    if (!port.take(received, pixels, 1'000'000)) { std::this_thread::yield(); continue; }
    valid &= received.sequence > previous;
    for (const auto pixel : pixels) valid &= pixel == static_cast<std::uint8_t>(received.sequence);
    previous = received.sequence;
  }
  producer.join();
  require(valid && previous != 0, "Concurrent camera frame copy was torn or reordered");
}
class Enumerator final : public CameraDeviceEnumerator {
 public:
  std::optional<std::vector<CameraEndpoint>> endpoints = std::vector<CameraEndpoint>{};
  std::optional<std::vector<CameraEndpoint>> enumerate() override { return endpoints; }
  bool changed() const noexcept override { return true; }
};
void registryIdentity() {
  auto enumerator = std::make_unique<Enumerator>();
  auto* fixture = enumerator.get();
  fixture->endpoints = std::vector<CameraEndpoint>{{L"device-b", "same name"}, {L"device-a", "same name"}};
  CameraDeviceRegistry registry(std::move(enumerator));
  const auto first = registry.refresh();
  require(first.devices.size() == 2 && first.devices[0].id != first.devices[1].id && first.devices[0].is_default,
          "Camera identity depended on label or enumeration order");
  const auto original = first.devices[0].id;
  auto restarted_enumerator = std::make_unique<Enumerator>();
  restarted_enumerator->endpoints = std::vector<CameraEndpoint>{{L"device-b", "renamed"}};
  CameraDeviceRegistry restarted(std::move(restarted_enumerator));
  require(restarted.refresh().devices.front().id == first.devices[1].id,
          "Restart changed the retained camera identity");
  require(!restarted.resolve(original), "Restart rebound a removed camera to another device");
  fixture->endpoints = std::vector<CameraEndpoint>{{L"device-b", "same name"}};
  const auto removed = registry.refresh();
  require(removed.devices[0].is_default && removed.events.size() == 2 && !registry.resolve(original),
          "Removal/default change was not reported");
  fixture->endpoints = std::vector<CameraEndpoint>{{L"device-a", "renamed"}, {L"device-b", "same name"}};
  const auto restored = registry.refresh();
  require(restored.devices[0].id == original && registry.resolve(original)->label == "renamed",
          "Camera return lost stable opaque identity");
  (*fixture->endpoints)[0].available = false;
  const auto unavailable = registry.refresh();
  require(!registry.resolve(original) && unavailable.devices[1].is_default, "Unavailable camera remained default");
  fixture->endpoints.reset();
  require(registry.refresh().status == CameraRegistryStatus::enumeration_failed && !registry.resolve({}),
          "Failed enumeration resolved stale device state");
}
void cameraFaultRetiresItsReader(bool missing_callback) {
  using namespace syrnike::windows_media::lab;
  using Clock = std::chrono::steady_clock;
  auto control = std::make_shared<SyntheticCameraControl>();
  control->emit_late_callback = true;
  CameraCapture capture({L"synthetic", "Synthetic"}, {1280, 720, 30}, 1, false, syntheticCameraReader(control));
  require(capture.start() == CameraFailure::none, "Camera fault fixture did not become healthy");
  if (missing_callback) {
    control->withhold_samples = true;
    std::unique_lock lock(control->fault_mutex);
    require(control->fault_changed.wait_for(lock, std::chrono::seconds{1}, [&] {
      return control->withheld_samples == 1;
    }), "Camera reader did not withhold its requested callback");
  } else {
    control->next_failure = CameraFailure::device_removed;
  }
  until([&] { return capture.stats().state == CameraCaptureState::failed; },
        "Camera fault was not detected", std::chrono::milliseconds{2'500});
  require(capture.stats().failure == (missing_callback ? CameraFailure::no_frames : CameraFailure::device_removed),
          "Camera no-progress and explicit device failure were confused");
  require(capture.stop(Clock::now() + std::chrono::seconds{2}) && control->readers_alive == 0 &&
              control->samples_alive == 0 && control->late_callbacks == 1 && capture.output()->stats().queued == 0,
          "Camera fault leaked a reader/sample or accepted a late callback");
}

void asynchronousCaptureLifetime() {
  using namespace syrnike::windows_media::lab;
  using Clock = std::chrono::steady_clock;
  auto control = std::make_shared<SyntheticCameraControl>();
  control->emit_late_callback = true;
  CameraCapture capture({L"synthetic", "Synthetic"}, {1280, 720, 30}, 1, false, syntheticCameraReader(control));
  require(capture.start() == CameraFailure::none && capture.stats().frames >= 3 &&
          capture.stats().state == CameraCaptureState::running, "Camera committed without healthy frame proof");
  control->copy_delay_ms = 250;
  until([&] { return capture.stats().stale > 0; }, "Slow sample conversion hid camera age");
  const auto after_delay = capture.stats().frames;
  until([&] { return capture.stats().frames > after_delay + 1; }, "Fresh capture did not recover after a stall");
  control->delay_ms = 1000;
  until([&] { return control->delay_ms == 0; }, "Pending sample fixture was not consumed");
  const auto began = Clock::now();
  require(capture.stop(began + std::chrono::seconds{2}), "Pending sample cancellation failed");
  require(Clock::now() - began < std::chrono::milliseconds{300}, "Stop waited for the pending sample deadline");
  require(control->readers_alive == 0 && control->samples_alive == 0 && control->late_callbacks == 1 &&
          capture.output()->stats().queued == 0, "Late callback retained capture/sample resources");

  control = std::make_shared<SyntheticCameraControl>();
  control->supports_1080 = false;
  CameraCapture unsupported({L"synthetic", "Synthetic"}, {1920, 1080, 30}, 2, false, syntheticCameraReader(control));
  require(unsupported.start() == CameraFailure::unsupported_profile && unsupported.stats().frames == 0 &&
          unsupported.stop(Clock::now() + std::chrono::seconds{2}), "Unsupported profile entered running");
  CameraCapture downgraded({L"synthetic", "Synthetic"}, {1920, 1080, 30}, 3, true, syntheticCameraReader(control));
  require(downgraded.start() == CameraFailure::none && downgraded.stats().downgraded &&
          downgraded.stats().actual.width == 1280, "Explicit profile downgrade was hidden");
  control->next_failure = CameraFailure::device_removed;
  until([&] { return downgraded.stats().state == CameraCaptureState::failed; }, "Device loss was not terminal to capture");
  require(downgraded.stats().failure == CameraFailure::device_removed &&
          downgraded.stop(Clock::now() + std::chrono::seconds{2}) && control->readers_alive == 0,
          "Device removal cleanup failed");
}
void transactionalPipelineDemands() {
  using namespace syrnike::windows_media::lab;
  using Clock = std::chrono::steady_clock;
  auto enumerator = std::make_unique<Enumerator>();
  enumerator->endpoints = std::vector<CameraEndpoint>{{L"first", "First"}, {L"second", "Second"}};
  CameraDeviceRegistry registry(std::move(enumerator));
  const auto devices = registry.refresh();
  auto control = std::make_shared<SyntheticCameraControl>();
  CameraPipeline pipeline(syntheticCameraReader(control));
  require(pipeline.selectDevice(registry, devices.devices[0].id, {1280, 720, 30}) == CameraFailure::none &&
          pipeline.setDemand(true, false) == CameraFailure::none, "Publication capture did not start");
  for (int index = 0; index < 100; ++index)
    require(pipeline.setDemand(true, index % 2 == 0) == CameraFailure::none, "Preview demand update failed");
  require(control->opens == 1 && control->readers_alive == 1, "Preview opened or restarted a capture");
  const auto old_generation = pipeline.stats().capture.generation;
  control->fail_open = true;
  require(pipeline.selectDevice(registry, devices.devices[1].id, {1920, 1080, 30}) == CameraFailure::unavailable,
          "Failed camera candidate unexpectedly committed");
  require(pipeline.stats().capture.generation == old_generation && control->readers_alive == 1 &&
          pipeline.stats().capture.state == CameraCaptureState::running, "Candidate failure destroyed the working camera");
  control->fail_open = false;
  require(pipeline.selectDevice(registry, devices.devices[1].id, {1920, 1080, 30}) == CameraFailure::none,
          "Healthy candidate failed to commit");
  const auto switched = pipeline.stats();
  require(switched.capture.actual.width == 1920 && switched.capture.frames >= 3 && switched.commits == 2 &&
          control->maximum_readers == 2 && control->readers_alive == 1, "Candidate transaction exceeded capture limits");
  require(pipeline.setDemand(false, true) == CameraFailure::none && control->readers_alive == 1 &&
          pipeline.publication()->generation() == 0 && pipeline.preview()->generation() == switched.capture.generation,
          "Preview-only demand did not retain the shared capture");
  require(pipeline.setDemand(false, false) == CameraFailure::none && control->readers_alive == 0 &&
          !pipeline.stats().active, "No-demand camera retained a source reader");
  control->supports_1080 = false;
  require(pipeline.selectDevice(registry, devices.devices[0].id, {1920, 1080, 30}, true) == CameraFailure::none &&
          pipeline.setDemand(true, false) == CameraFailure::none && pipeline.stats().capture.downgraded,
          "Explicit downgrade did not start the lower supported profile");
  const auto downgraded_generation = pipeline.stats().capture.generation;
  require(pipeline.selectDevice(registry, devices.devices[0].id, {1920, 1080, 30}, false) == CameraFailure::unsupported_profile &&
          pipeline.stats().capture.generation == downgraded_generation && control->readers_alive == 1,
          "Removing downgrade permission silently kept an unsupported exact profile");
  require(pipeline.stop(Clock::now() + std::chrono::seconds{2}) && control->samples_alive == 0,
          "Camera pipeline teardown retained samples");
}
void previewIsolation(bool quarantine = false) {
  using namespace syrnike::windows_media;
  using Clock = std::chrono::steady_clock;
  auto owner = capture::processD3d11Device(true);
  auto port = std::make_shared<CameraFramePort>();
  port->selectGeneration(1);
  auto preview = std::make_unique<CameraPreview>(port);
  std::vector<std::uint8_t> pixels(1280 * 720 * 4);
  for (std::size_t index = 0; index < pixels.size(); index += 4) {
    pixels[index] = 40; pixels[index + 1] = 200; pixels[index + 2] = 60; pixels[index + 3] = 255;
  }
  std::uint64_t sequence = 0;
  const auto offer = [&] {
    const auto now = std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
        Clock::now().time_since_epoch()).count();
    (void)port->publish({port->generation(), ++sequence, now, 1280, 720}, pixels);
  };
  const auto take = [&] {
    std::optional<CameraPreviewLease> lease;
    until([&] { offer(); lease = preview->take(); return lease.has_value(); }, "Camera GPU preview deadline");
    return std::move(*lease);
  };
  auto first = std::make_optional(take());
  Microsoft::WRL::ComPtr<ID3D11Device1> device1;
  require(SUCCEEDED(owner->device()->QueryInterface(IID_PPV_ARGS(&device1))), "Camera preview device1");
  Microsoft::WRL::ComPtr<ID3D11Texture2D> imported;
  require(SUCCEEDED(device1->OpenSharedResource1(reinterpret_cast<HANDLE>(first->handle()),
      IID_PPV_ARGS(&imported))), "Camera preview import");
  Microsoft::WRL::ComPtr<IDXGIKeyedMutex> keyed;
  require(SUCCEEDED(imported.As(&keyed)) && keyed->AcquireSync(0, 0) == S_OK, "Camera preview Electron readiness key");
  D3D11_TEXTURE2D_DESC desc{};
  imported->GetDesc(&desc);
  require(desc.Width == 640 && desc.Height == 360, "Camera preview dimensions");
  desc.BindFlags = 0; desc.MiscFlags = 0; desc.Usage = D3D11_USAGE_STAGING; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> readback;
  require(SUCCEEDED(owner->device()->CreateTexture2D(&desc, nullptr, &readback)), "Camera preview readback allocation");
  {
    std::lock_guard lock(owner->contextMutex());
    owner->context()->CopyResource(readback.Get(), imported.Get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    require(SUCCEEDED(owner->context()->Map(readback.Get(), 0, D3D11_MAP_READ, 0, &mapped)), "Camera preview readback");
    const auto* pixel = static_cast<const std::uint8_t*>(mapped.pData);
    const bool matches = pixel[0] == 40 && pixel[1] == 200 && pixel[2] == 60 && pixel[3] == 255;
    owner->context()->Unmap(readback.Get(), 0);
    require(matches, "Camera preview pixels differ from capture");
  }
  require(SUCCEEDED(keyed->ReleaseSync(0)), "Camera preview consumer release");
  keyed.Reset(); imported.Reset(); readback.Reset();
  auto second = std::make_optional(take());
  const auto submitted = preview->stats().submitted;
  const auto stall_end = Clock::now() + std::chrono::milliseconds{250};
  while (Clock::now() < stall_end) { offer(); std::this_thread::sleep_for(std::chrono::milliseconds{5}); }
  require(preview->stats().outstanding == 2 && preview->stats().submitted == submitted &&
          preview->stats().dropped > 0, "Held preview escaped its two-slot budget");
  auto& screen = screen::LocalScreenPreview::processPreview();
  require(screen.beginPublication(1) && screen.demand(1, true), "Screen preview shared budget setup");
  require(capture::optionalPreviewBytes() <= capture::kOptionalPreviewBytes &&
          screen.stats().backing_bytes < 2 * 1280ULL * 720 * 4, "Screen and camera double-booked optional budget");
  screen.stopPublication();
  port->selectGeneration(2);
  first.reset(); second.reset();
  {
    auto resumed = take();
    require(resumed.metadata().generation == 2, "Old camera preview generation survived switch");
  }
  port->selectGeneration(0);
  until([&] { return preview->stats().backing_bytes == 0; }, "Preview off retained reusable textures");
  port->selectGeneration(3);
  auto current = std::make_optional(take());
  require(preview->stop(Clock::now() + std::chrono::seconds{2}), "Camera preview stop deadline");
  preview.reset();
  require(capture::optionalPreviewBytes() > 0, "Held preview lease lost its backing at stop");
  if (quarantine) {
    require(SUCCEEDED(device1->OpenSharedResource1(reinterpret_cast<HANDLE>(current->handle()),
        IID_PPV_ARGS(&imported))) && SUCCEEDED(imported.As(&keyed)) && keyed->AcquireSync(0, 0) == S_OK,
        "Quarantine consumer did not acquire its texture");
    current.reset(); // Deliberately violates the consumer's key-release order.
    require(capture::optionalPreviewBytes() > 0, "Unproven renderer release recycled its global budget");
    require(SUCCEEDED(keyed->ReleaseSync(0)), "Quarantine fixture could not finish consumer work");
    keyed.Reset(); imported.Reset();
    require(capture::optionalPreviewBytes() > 0, "Quarantined budget became reusable without process restart");
    return;
  }
  current.reset();
  require(capture::optionalPreviewBytes() == 0, "Camera preview leases leaked optional budget");
  // Stop immediately after submission, with no consumer or later frame to
  // flush the driver. The final query must drain without quarantining backing.
  for (unsigned cycle = 0; cycle < 20; ++cycle) {
    preview = std::make_unique<CameraPreview>(port);
    until([&] { offer(); return preview->stats().submitted > 0; }, "Preview stop fixture did not submit");
    require(preview->stop(Clock::now() + std::chrono::seconds{2}), "Submitted preview stop deadline");
    require(preview->stats().failure == CameraPreviewFailure::none, "Submitted preview failed to drain");
    preview.reset();
    require(capture::optionalPreviewBytes() == 0, "Submitted preview stop retained GPU backing");
  }
}
}  // namespace
int main(int argc, char** argv) try {
  if (argc == 2 && std::string_view(argv[1]) == "--preview-quarantine") {
    previewIsolation(true);
    std::cout << "Camera preview unproven renderer release kept its process budget\n";
    return 0;
  }
  if (argc == 2 && std::string_view(argv[1]) == "--preview") {
    previewIsolation();
    std::cout << "Camera GPU preview pixels, stalls, epochs and shared budget passed\n";
    return 0;
  }
  checkedConversion();
  boundedFrames();
  concurrentFrames();
  registryIdentity();
  asynchronousCaptureLifetime();
  transactionalPipelineDemands();
  syrnike::windows_media::tests::repeatFault("camera-device-removed", [] { cameraFaultRetiresItsReader(false); });
  syrnike::windows_media::tests::repeatFault("camera-reader-no-callback", [] { cameraFaultRetiresItsReader(true); });
  std::cout << "Camera format, freshness and registry contracts passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
