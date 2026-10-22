#include "screen/production_screen_pipeline.hpp"
#include "capture/monitor_capture.hpp"
#include "sources/source_registry.hpp"
#include <iostream>
#include <stdexcept>
#include <vector>
#include <atomic>

using namespace syrnike::windows_media;
using namespace syrnike::windows_media::screen;
using namespace std::chrono_literals;
namespace {
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
template <typename Predicate> void until(Predicate predicate) {
  const auto deadline = std::chrono::steady_clock::now() + 10s;
  while (!predicate()) {
    require(std::chrono::steady_clock::now() < deadline, "adaptive integration deadline");
    std::this_thread::sleep_for(1ms);
  }
}
class Adapter final : public ScreenPublicationAdapter {
 public:
  std::mutex mutex;
  ScreenOperationCompletion pending;
  std::uint64_t generation = 0;
  bool unpublish_seen = false;
  std::atomic<std::uint64_t> bandwidth{0};
  OutgoingNetworkObservation networkObservation() const noexcept override {
    if (!bandwidth.load()) return {};
    return {static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count()), bandwidth.load()};
  }
  void startPublish(std::uint64_t g, ScreenTrackDescriptor, ScreenOperationCompletion cb) override {
    std::scoped_lock lock(mutex);
    generation = g; pending = std::move(cb);
  }
  void startSubmit(std::uint64_t g, EncodedScreenFrame, ScreenOperationCompletion cb) override { cb(g, {}); }
  void startUnpublish(std::uint64_t g, ScreenOperationCompletion cb) override {
    { std::scoped_lock lock(mutex); unpublish_seen = true; }
    cb(g, {});
  }
  bool publishReady() { std::scoped_lock lock(mutex); return bool(pending); }
  void complete() {
    ScreenOperationCompletion cb;
    std::uint64_t g;
    { std::scoped_lock lock(mutex); cb = std::move(pending); g = generation; }
    require(bool(cb), "no pending publication"); cb(g, {});
  }
};
void supersededSettingAndDrain() {
  const auto device = capture::processD3d11Device(false);
  auto frames = std::make_shared<ScreenFramePipeline>();
  std::mutex adapters_mutex;
  std::vector<std::shared_ptr<Adapter>> adapters;
  ProductionScreenPipeline pipeline(device, frames, kScreenProfile1080p60,
      [&](std::function<void()>) {
        auto value = std::make_shared<Adapter>();
        std::scoped_lock lock(adapters_mutex); adapters.push_back(value); return value;
      });
  const auto adapterAt = [&](std::size_t index) {
    std::scoped_lock lock(adapters_mutex);
    return adapters.size() > index ? adapters[index] : std::shared_ptr<Adapter>{};
  };
  require(pipeline.enableAdaptiveQuality(31, 4), "enable rejected admitted profiles");
  require(pipeline.start("adaptive-test", 5s).ok, "initial start failed");
  until([&] { return adapterAt(0)->publishReady(); });
  adapterAt(0)->complete();
  until([&] { return pipeline.state() == ProductionScreenPipelineState::running; });
  require(pipeline.setSelectedPreset(2, 3), "first explicit preset rejected");
  until([&] { auto a = adapterAt(1); return a && a->publishReady(); });
  require(pipeline.setSelectedPreset(3, 0), "newer explicit preset rejected");
  require(!pipeline.setSelectedPreset(2, 4), "stale revision accepted");
  adapterAt(1)->complete();
  until([&] { auto a = adapterAt(2); return a && a->publishReady(); });
  const auto pending = pipeline.stats();
  require(pending.applied_revision == 1 && pending.reconfiguring,
          "late superseded publication became current");
  adapterAt(2)->complete();
  until([&] { return pipeline.stats().applied_revision == 3; });
  require(pipeline.stats().current_profile == 0 && pipeline.stats().profile_generation == 3,
          "replacement did not obey latest explicit preset");
  require(pipeline.stop(std::chrono::steady_clock::now() + 5s).ok, "replacement stop failed");
  const auto stopped = pipeline.stats();
  require(stopped.capture.active == 0 && stopped.converter.slots_in_use == 0 &&
          stopped.encoder.input_slots_in_use == 0 && stopped.encoder.output_slots_in_use == 0,
          "replacement retained media leases");
  for (const auto& a : adapters) {
    std::scoped_lock lock(a->mutex); require(a->unpublish_seen, "generation was not unpublished");
  }
}
void automaticControlKeepsGeneration() {
  const auto device = capture::processD3d11Device(false);
  auto frames = std::make_shared<ScreenFramePipeline>();
  auto adapter = std::make_shared<Adapter>();
  std::atomic<unsigned> creations{0};
  ProductionScreenPipeline pipeline(device, frames, kScreenProfile1080p60,
      [&](std::function<void()>) { ++creations; return adapter; });
  require(!pipeline.enableAdaptiveQuality(15, 4), "unsupported exact preset silently fell back");
  require(!pipeline.enableAdaptiveQuality(31, 3), "different initial preset silently accepted");
  require(pipeline.enableAdaptiveQuality(1U << 4, 4), "exact preset admission failed");
  require(pipeline.start("fixed-preset-test", 5s).ok, "initial start failed");
  until([&] { return adapter->publishReady(); }); adapter->complete();
  until([&] { return pipeline.state() == ProductionScreenPipelineState::running; });
  const auto instance = pipeline.stats().encoder.instance_id;
  // The encoder opens below the SDK's initial estimate and holds there while
  // the network is unknown.
  until([&] { return pipeline.stats().bitrate.applied_bitrate == 4'800'000; });
  require(pipeline.stats().target_bitrate == 4'800'000, "start bitrate was not commanded");
  adapter->bandwidth = 1'000'000;
  // Below the preset floor the stream fits the budget: per-frame quality falls
  // to half the floor, then admitted frames carry the rest of the cut.
  until([&] { return pipeline.stats().bitrate.applied_bitrate == 1'000'000; });
  require(pipeline.stats().admitted_fps == 51, "a budget below half the floor kept every frame");
  const auto reduced = pipeline.stats();
  require(reduced.current_profile == 4 && reduced.profile_generation == 1 &&
          reduced.encoder.instance_id == instance && reduced.profile_changes == 0 &&
          reduced.quality_warning && creations == 1, "automatic bitrate control replaced resources");
  { std::scoped_lock lock(adapter->mutex); require(!adapter->unpublish_seen, "automatic unpublish"); }
  require(!pipeline.setSelectedPreset(2, 0), "explicit unsupported preset accepted");
  require(pipeline.stop(std::chrono::steady_clock::now() + 5s).ok, "bitrate stop failed");
  require(!pipeline.stats().quality_warning && !pipeline.setSelectedPreset(3, 4),
          "stopped intent/warning fence failed");
}
// A real GPU frame source for the pipeline. Every frame is stamped
// `backdate` in the past, so each encoded frame (keyframes included) misses
// the 150 ms publication budget, as under heavy GPU load.
class GpuFrame final : public capture::FrameResource {
 public:
  GpuFrame(std::shared_ptr<capture::D3d11DeviceOwner> owner, ID3D11Texture2D* texture)
      : owner_(std::move(owner)), texture_(texture) {}
  std::uint64_t sampledHash() override { return 1; }
  std::optional<capture::D3d11FrameView> d3d11View() override { return capture::D3d11FrameView{owner_, texture_}; }
 private:
  std::shared_ptr<capture::D3d11DeviceOwner> owner_;
  ID3D11Texture2D* texture_;
};
class OneMonitor final : public sources::SourceEnumerator {
 public:
  sources::EnumerationBatch enumerate(const sources::EnumerationOptions&) override {
    sources::SourceCandidate value;
    value.kind = sources::SourceKind::Monitor;
    value.identity = "monitor-a";
    value.title = value.label = "Display";
    value.monitor = sources::MonitorMetadata{};
    sources::EnumerationBatch batch;
    batch.candidates = {std::move(value)};
    return batch;
  }
  sources::ResolveStatus validate(sources::SourceKind, const std::string&) override {
    return sources::ResolveStatus::Available;
  }
  sources::MonitorTargetResult resolveMonitorTarget(const std::string&) override {
    return {sources::ResolveStatus::Available, sources::MonitorTargetToken{41}};
  }
};
class PumpBackend final : public capture::MonitorCaptureBackend {
 public:
  capture::CaptureBackendProgress progress() const override { return {}; }
  capture::BackendStartResult start(const sources::MonitorTargetToken&, FrameCallback on_frame,
                                    TerminalCallback) override {
    std::scoped_lock lock(mutex); frame = std::move(on_frame); return {};
  }
  capture::CaptureStopResult stop(std::chrono::steady_clock::time_point) noexcept override {
    std::scoped_lock lock(mutex); frame = nullptr; return {};
  }
  void emit(capture::BackendFrame value) {
    FrameCallback callback;
    { std::scoped_lock lock(mutex); callback = frame; }
    if (callback) callback(std::move(value));
  }
  std::mutex mutex;
  FrameCallback frame;
};
void keyframeStallRecoversInPlace() {
  const auto device = capture::processD3d11Device(false);
  D3D11_TEXTURE2D_DESC description{};
  description.Width = 1280;
  description.Height = 720;
  description.MipLevels = description.ArraySize = 1;
  description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  description.SampleDesc.Count = 1;
  description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
  require(SUCCEEDED(device->device()->CreateTexture2D(&description, nullptr, &texture)),
          "test texture");
  sources::SourceRegistry registry(std::make_unique<OneMonitor>());
  const auto source = registry.enumerate().sources.at(0);
  auto backend = std::make_unique<PumpBackend>();
  auto* pump_backend = backend.get();
  capture::MonitorCapture monitor(registry, source.id, std::move(backend));
  require(monitor.start().ok, "pump capture start");
  auto frames = std::make_shared<ScreenFramePipeline>(1s);
  auto adapter = std::make_shared<Adapter>();
  std::atomic<unsigned> creations{0};
  ProductionScreenPipeline pipeline(device, frames, kScreenProfile1080p60,
      [&](std::function<void()>) { ++creations; return adapter; });
  require(pipeline.enableAdaptiveQuality(1U << 4, 4), "exact preset admission failed");
  pipeline.setInitialSourceSize(1280, 720);
  require(pipeline.start("keyframe-stall-test", 5s).ok, "initial start failed");
  until([&] { return adapter->publishReady(); }); adapter->complete();
  until([&] { return pipeline.state() == ProductionScreenPipelineState::running; });
  std::atomic_bool pumping{true};
  std::thread pump([&] {
    while (pumping) {
      pump_backend->emit({screenSteadyTimestamp100ns() - 2'000'000, 1280, 720,
                          capture::FramePixelFormat::Bgra8,
                          std::make_shared<GpuFrame>(device, texture.Get())});
      if (auto lease = monitor.waitForFrame(0ms)) (void)frames->submit(std::move(*lease));
      std::this_thread::sleep_for(16ms);
    }
  });
  const auto deadline = std::chrono::steady_clock::now() + 30s;
  const auto wait = [&](auto predicate, const char* message) {
    while (!predicate()) {
      require(std::chrono::steady_clock::now() < deadline, message);
      std::this_thread::sleep_for(5ms);
    }
  };
  try {
    const auto instance = pipeline.stats().encoder.instance_id;
    wait([&] { return pipeline.stats().encoder_recoveries >= 1; }, "stalled keyframes never recovered");
    const auto recovered = pipeline.stats();
    require(recovered.encoder.instance_id != instance, "recovery kept the stalled encoder");
    require(recovered.profile_generation == 1 && creations == 1,
            "in-place recovery replaced the publication");
    { std::scoped_lock lock(adapter->mutex); require(!adapter->unpublish_seen, "recovery unpublished"); }
    wait([&] { return pipeline.state() == ProductionScreenPipelineState::failed; },
         "recovery budget was unbounded");
    const auto failure = pipeline.failure();
    require(pipeline.stats().encoder_recoveries == kMaximumEncoderRecoveriesPerWindow,
            "share failed before using the in-place budget");
    require(failure && failure->code == "screen_keyframe_progress_deadline" && failure->retryable,
            "exhausted recovery is not a retryable keyframe failure");
  } catch (...) {
    pumping = false; pump.join(); throw;
  }
  pumping = false; pump.join();
  (void)pipeline.stop(std::chrono::steady_clock::now() + 5s);
  (void)monitor.stop(1s);
}
}
// Capture admission follows the policy's frame rate: a 60 Hz source passes
// the admitted share of frames, and 0 restores the preset's rate.
void admissionFollowsFrameRate() {
  for (const auto [admitted, expected] : {std::pair{0U, 60}, {46U, 46}, {30U, 30}}) {
    ScreenFrameCadence cadence;
    const auto interval = screenAdmissionIntervalUs(admitted, 60);
    int delivered = 0;
    for (int frame = 0; frame < 60 * 60; ++frame) {
      const auto time = 1'000'000LL + frame * 1'000'000LL / 60;
      if (cadence.due(time, interval)) { cadence.accepted(time, interval); ++delivered; }
    }
    require(delivered >= (expected - 1) * 60 && delivered <= (expected + 1) * 60,
            "capture admission did not follow the admitted frame rate");
  }
}
int main() {
  try { admissionFollowsFrameRate(); supersededSettingAndDrain(); automaticControlKeepsGeneration(); keyframeStallRecoversInPlace(); std::cout << "Fixed-preset sender control and explicit setting fences passed\n"; }
  catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
