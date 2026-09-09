#include "audio/microphone_pipeline.hpp"
#include "audio/livekit_microphone_dsp.hpp"
#include "audio/microphone_sender.hpp"
#include "core/engine.hpp"
#include "lab/heap_allocation_probe.hpp"
#include <windows.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <cstdlib>
#include "fault_evidence.hpp"

using namespace syrnike::windows_media::audio;
namespace {
using Clock = std::chrono::steady_clock;
using HeapProbe = syrnike::windows_media::lab::HeapAllocationProbe;
HeapProbe::Counts worker_allocations;
class LabDefaultEnumerator final : public AudioDeviceEnumerator {
 public:
  explicit LabDefaultEnumerator(bool unavailable_candidate = false) : unavailable_candidate_(unavailable_candidate) {}
  std::optional<std::vector<AudioEndpoint>> enumerate() override {
    auto endpoints = windows_->enumerate();
    pending_ = false;
    if (endpoints && !default_.empty()) for (auto& endpoint : *endpoints) {
      if (endpoint.direction == AudioDirection::input) endpoint.is_default = endpoint.endpoint_id == default_;
    }
    if (endpoints && unavailable_candidate_) endpoints->push_back({
      L"microphone-lab-deliberately-unavailable", AudioDirection::input, "Unavailable lab candidate", false});
    return endpoints;
  }
  bool changed() const noexcept override { return pending_ || windows_->changed(); }
  void simulateDefault(std::wstring endpoint) { default_ = std::move(endpoint); pending_ = true; }
 private:
  std::unique_ptr<AudioDeviceEnumerator> windows_ = makeWindowsAudioDeviceEnumerator();
  std::wstring default_;
  bool pending_ = false;
  bool unavailable_candidate_ = false;
};
class MeasuredEnhancement final : public MicrophoneEnhancement {
 public:
  MeasuredEnhancement() : enhancement_(makeLiveKitMicrophoneEnhancement()) { heap_.begin(); }
  ~MeasuredEnhancement() override { worker_allocations = heap_.end(); }
  EchoAvailability process(std::array<std::int16_t, kMicrophoneFrameSamples>& samples,
                           const EchoReferenceFrame* reference, bool noise, bool echo) noexcept override {
    return enhancement_->process(samples, reference, noise, echo);
  }
  bool resetEcho() noexcept override { return enhancement_->resetEcho(); }
 private:
  std::unique_ptr<MicrophoneEnhancement> enhancement_;
  HeapProbe heap_;
};
std::unique_ptr<MicrophoneEnhancement> measuredEnhancement() { return std::make_unique<MeasuredEnhancement>(); }
void resourceSample(const MicrophonePipelineStats& pipeline, const MicrophoneSenderStats& sender, std::int64_t elapsed_ms) {
  DWORD handles = 0;
  if (!GetProcessHandleCount(GetCurrentProcess(), &handles)) throw std::runtime_error("Resource handle probe failed");
  PROCESS_MEMORY_COUNTERS_EX memory{};
  memory.cb = sizeof(memory);
  if (!GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory)))
    throw std::runtime_error("Resource memory probe failed");
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snapshot == INVALID_HANDLE_VALUE) throw std::runtime_error("Resource thread probe failed");
  THREADENTRY32 entry{};
  entry.dwSize = sizeof(entry);
  unsigned threads = 0;
  if (Thread32First(snapshot, &entry)) do {
    if (entry.th32OwnerProcessID == GetCurrentProcessId()) ++threads;
  } while (Thread32Next(snapshot, &entry));
  CloseHandle(snapshot);
  std::cout << "MICROPHONE_RESOURCE {\"elapsedMs\":" << elapsed_ms << ",\"handles\":" << handles
            << ",\"threads\":" << threads << ",\"privateBytes\":" << memory.PrivateUsage
            << ",\"captured\":" << pipeline.capture.frames << ",\"submitted\":" << sender.submitted
            << ",\"pendingFrames\":" << sender.pending_frames << ",\"latestFrameAgeUs\":" << sender.latest_frame_age_us
            << ",\"maximumFrameAgeUs\":" << sender.maximum_frame_age_us
            << ",\"staleFrames\":" << pipeline.stale_frames + sender.rejected_stale << "}" << std::endl;
}
void require(bool success, const char* message) {
  if (!success) throw std::runtime_error(message);
}
MicrophoneFrame nextFrame(MicrophonePipeline& pipeline) {
  const auto port = pipeline.output();
  const auto deadline = Clock::now() + std::chrono::seconds{1};
  for (;;) {
    if (auto frame = port->take()) return *frame;
    require(Clock::now() < deadline, "Microphone pipeline output deadline");
    const auto wait = WaitForSingleObject(pipeline.outputEvent(), 100);
    require(wait == WAIT_OBJECT_0 || wait == WAIT_TIMEOUT, "Microphone output wait failed");
  }
}
}  // namespace
int microphoneCandidateFaultLab() {
  AudioDeviceRegistry registry(std::make_unique<LabDefaultEnumerator>(true));
  const auto inventory = registry.refresh();
  require(inventory.status == AudioRegistryStatus::ready, "Microphone registry failed");
  const auto invalid = std::find_if(inventory.devices.begin(), inventory.devices.end(), [](const auto& device) {
    return device.direction == AudioDirection::input && device.label == "Unavailable lab candidate";
  });
  require(invalid != inventory.devices.end(), "Unavailable candidate fixture missing");
  syrnike::windows_media::tests::repeatFault("microphone-candidate-failure", [&] {
    MicrophonePipeline pipeline(makeLiveKitMicrophoneEnhancement);
    require(pipeline.selectInput(registry, {AudioDirection::input, {}}) == MicrophonePipelineFailure::none,
            "Default microphone selection failed");
    MicrophoneDspConfig config;
    config.gate_enabled = false;
    require(pipeline.configure(config) == MicrophonePipelineFailure::none &&
            pipeline.setDemand({true, false, true}) == MicrophonePipelineFailure::none,
            "Microphone candidate fixture did not become healthy");
    const auto first = nextFrame(pipeline);
    const auto before = pipeline.stats();
    require(pipeline.selectInput(registry, {AudioDirection::input, invalid->id}) == MicrophonePipelineFailure::capture_failed,
            "Unavailable microphone candidate was committed");
    config.muted = true;
    require(pipeline.configure(config) == MicrophonePipelineFailure::none,
            "Microphone candidate failure blocked mute control");
    (void)pipeline.output()->take();
    const auto muted = nextFrame(pipeline);
    const auto continued = pipeline.stats();
    require(muted.generation == first.generation && muted.sequence > first.sequence &&
            continued.capture.state == MicrophoneCaptureState::healthy &&
            continued.committed_switches == before.committed_switches &&
            std::all_of(muted.samples.begin(), muted.samples.end(), [](auto value) { return value == 0; }),
            "Microphone candidate failure replaced the active generation or lost mute/progress");
    const auto opened = continued.capture_opens;
    require(pipeline.selectInput(registry, {AudioDirection::input, {}}) == MicrophonePipelineFailure::none &&
            pipeline.stats().capture_opens == opened, "Restoring the healthy selection reopened capture");
    require(pipeline.stop(Clock::now() + std::chrono::seconds(2)), "Microphone candidate fixture did not drain");
  });
  return 0;
}

int microphoneMuteCycleLab() {
  AudioDeviceRegistry registry(std::make_unique<LabDefaultEnumerator>(true));
  const auto devices = registry.refresh();
  require(devices.status == AudioRegistryStatus::ready, "Microphone registry failed");
  auto input = registry.resolve({AudioDirection::input, {}});
  require(input.has_value(), "Default microphone unavailable");
  MicrophonePipeline pipeline(measuredEnhancement);
  require(pipeline.selectInput(registry, {AudioDirection::input, {}}) == MicrophonePipelineFailure::none, "Input selection failed");
  MicrophoneDspConfig config;
  config.gate_enabled = false;
  config.muted = true;
  require(pipeline.configure(config) == MicrophonePipelineFailure::none, "Initial muted config failed");
  require(pipeline.setDemand({true, false, true}) == MicrophonePipelineFailure::none, "Warm capture failed");
  const auto initial = pipeline.stats();
  auto frame = nextFrame(pipeline);
  require(std::all_of(frame.samples.begin(), frame.samples.end(), [](auto value) { return value == 0; }),
          "Start-muted frame was not digital silence");
  std::uint64_t mute_frames = 1;
  std::uint64_t meter_revisions = 0, previous_meter_frames = 0;
  const auto began = Clock::now();
  for (unsigned cycle = 0; cycle < 200; ++cycle) {
    for (const bool muted : {false, true}) {
      config.muted = muted;
      config.input_volume = cycle % 2 ? 1.0f : 0.5f;
      config.noise_suppression = cycle % 3 != 0;
      require(pipeline.configure(config) == MicrophonePipelineFailure::none, "Ordered config failed");
      // Acknowledgement fences all earlier processing. Discard its pending
      // output, then inspect a frame produced with the committed config.
      (void)pipeline.output()->take();
      frame = nextFrame(pipeline);
      require(frame.generation == initial.capture.generation, "Mute/config reopened input");
      if (muted) {
        require(std::all_of(frame.samples.begin(), frame.samples.end(), [](auto value) { return value == 0; }),
                "Muted frame was not digital silence");
        ++mute_frames;
      }
      const auto stats = pipeline.stats();
      if (stats.meter.frames != previous_meter_frames) {
        ++meter_revisions;
        previous_meter_frames = stats.meter.frames;
      }
    }
  }
  // A failed candidate must leave the original generation producing frames.
  const auto invalid = std::find_if(devices.devices.begin(), devices.devices.end(), [](const auto& device) {
    return device.label == "Unavailable lab candidate";
  });
  require(invalid != devices.devices.end(), "Unavailable candidate fixture missing");
  const auto rollback = pipeline.selectInput(registry, {AudioDirection::input, invalid->id});
  require(rollback == MicrophonePipelineFailure::capture_failed, "Failed candidate did not roll back");
  (void)pipeline.output()->take();
  frame = nextFrame(pipeline);
  require(frame.generation == initial.capture.generation, "Failed candidate replaced active capture");
  require(pipeline.setDemand({false, false, true}) == MicrophonePipelineFailure::none, "Meter-only demand failed");
  const auto final = pipeline.stats();
  require(final.capture_opens == 2 && final.committed_switches == 1, "Unexpected capture lifecycle count");
  const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - began).count();
  require(meter_revisions <= static_cast<std::uint64_t>(elapsed_ms / 100 + 2), "Meter exceeded 10 Hz cadence");
  require(pipeline.setDemand({}) == MicrophonePipelineFailure::none, "Capture demand removal failed");
  const auto idle_meter = pipeline.stats().meter;
  require(idle_meter.input_level == 0 && idle_meter.output_level == 0 && !idle_meter.speaking && !idle_meter.gate_open,
          "Stopped input retained stale activity");
  require(pipeline.stop(Clock::now() + std::chrono::seconds{5}), "Pipeline stop deadline");
  // The joined worker publishes this value from its enhancement destructor.
  require(worker_allocations.allocations == 0 && worker_allocations.reallocations == 0,
          "Microphone DSP worker allocated after initialization");
  std::cout << "{\"command\":\"microphone-mute-cycle\",\"status\":\"pass\",\"cycles\":200"
            << ",\"publicationAttached\":false,\"mutedFrames\":" << mute_frames
            << ",\"captureOpens\":" << final.capture_opens << ",\"committedInputs\":" << final.committed_switches
            << ",\"failedCandidateRollback\":true,\"meterUpdates\":" << meter_revisions
            << ",\"elapsedMs\":" << elapsed_ms << ",\"outputFrames\":" << final.output_frames
            << ",\"staleFrames\":" << final.stale_frames
            << ",\"dspWorkerAllocations\":" << worker_allocations.allocations
            << ",\"dspWorkerReallocations\":" << worker_allocations.reallocations
            << ",\"idleMeterCleared\":true,\"stopped\":true}\n";
  return 0;
}

int microphonePublicationFailureLab() {
  auto transport = std::make_shared<syrnike::windows_media::LiveKitRoomTransport>();
  AudioDeviceRegistry registry(makeWindowsAudioDeviceEnumerator());
  require(registry.refresh().status == AudioRegistryStatus::ready, "Microphone registry failed");
  MicrophonePipeline pipeline(makeLiveKitMicrophoneEnhancement);
  require(pipeline.selectInput(registry, {AudioDirection::input, {}}) == MicrophonePipelineFailure::none,
          "Input selection failed");
  require(pipeline.setDemand({true, true, true}) == MicrophonePipelineFailure::none, "Warm capture failed");
  const auto generation = nextFrame(pipeline).generation;
  for (unsigned attempt = 0; attempt < 10; ++attempt) {
    // Use the real SDK lane with no joined Room: publication must fail without
    // committing a track or changing the independently owned warm capture.
    MicrophoneSender sender(transport, pipeline.output(), pipeline.outputEvent());
    require(sender.start() == MicrophonePublicationFailure::publish_failed, "Missing Room did not fail publication");
    require(sender.stop(Clock::now() + std::chrono::seconds{6}), "Failed publication cleanup deadline");
    const auto publication = sender.stats();
    require(!publication.published && publication.publication_commits == 0 && publication.submitted == 0,
            "Failed publication became committed");
    (void)pipeline.output()->take();
    require(nextFrame(pipeline).generation == generation, "Failed publication interrupted warm input");
  }
  require(pipeline.setDemand({false, false, true}) == MicrophonePipelineFailure::none, "Meter demand failed");
  (void)pipeline.output()->take();
  require(nextFrame(pipeline).generation == generation, "Publication demand removal reopened capture");
  const auto capture = pipeline.stats();
  require(capture.capture_opens == 1 && capture.committed_switches == 1, "Publication failure changed capture lifecycle");
  require(pipeline.stop(Clock::now() + std::chrono::seconds{5}), "Failure fixture shutdown deadline");
  std::cout << "{\"command\":\"microphone-publication-failure\",\"status\":\"pass\",\"attempts\":10"
            << ",\"failure\":\"publish_failed\",\"publicationCommits\":0,\"captureOpens\":1"
            << ",\"warmCapturePreserved\":true,\"stopped\":true}" << std::endl;
  return 0;
}

int microphonePublicationLab(unsigned seconds, std::optional<AudioDeviceId> explicit_input, bool expect_device_loss) {
  require(seconds >= 15 && seconds <= 1800, "Microphone publication duration outside bounds");
  require(!expect_device_loss || (explicit_input && seconds >= 30), "Device-loss proof needs explicit input and at least 30 seconds");
  using namespace syrnike::windows_media;
  const auto* url = std::getenv("LIVEKIT_URL");
  const auto* token = std::getenv("LIVEKIT_PUBLISHER_TOKEN");
  require(url && token, "Microphone lab Room credentials missing");
  auto transport = std::make_shared<LiveKitRoomTransport>();
  Engine engine(EngineOptions{.room_transport = transport});
  require(engine.start().ok, "Microphone lab Engine start failed");
  require(engine.installCredentialLease({"microphone-lab", url, token}).ok, "Credential installation failed");
  EngineDesiredState desired;
  desired.revision = 1;
  desired.room = RoomIntent{"native-v2-media-lab", "native-v2-publisher", "microphone-lab"};
  require(engine.applyDesiredState(desired).ok, "Microphone Room intent failed");
  const auto connected_by = Clock::now() + std::chrono::seconds{12};
  while (!transport->activeRoom() && Clock::now() < connected_by)
    std::this_thread::sleep_for(std::chrono::milliseconds{10});
  require(transport->activeRoom() != nullptr, "Microphone Room connection timeout");
  {
    AudioDeviceRegistry registry(makeWindowsAudioDeviceEnumerator());
    require(registry.refresh().status == AudioRegistryStatus::ready, "Microphone registry failed");
    auto input = registry.resolve({AudioDirection::input, explicit_input});
    require(input.has_value(), "Selected microphone unavailable");
    MicrophonePipeline pipeline(measuredEnhancement);
    require(pipeline.selectInput(registry, {AudioDirection::input, explicit_input}) == MicrophonePipelineFailure::none, "Input selection failed");
    MicrophoneDspConfig config;
    config.muted = true;
    config.gate_enabled = false;
    config.noise_suppression = false;
    config.automatic_gain = false;
    require(pipeline.configure(config) == MicrophonePipelineFailure::none, "Muted config failed");
    require(pipeline.setDemand({true, true, true}) == MicrophonePipelineFailure::none, "Warm capture failed");
    MicrophoneSender sender(transport, pipeline.output(), pipeline.outputEvent());
    require(sender.start() == MicrophonePublicationFailure::none, "Microphone publication failed");
    const auto initial_generation = pipeline.stats().capture.generation;
    const auto original_room = transport->activeRoom();
    bool device_loss_seen = false, input_recovered = false;
    const auto began = Clock::now();
    const auto phase = [](const char* name) {
      const auto unix_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch()).count();
      std::cout << "MICROPHONE_PHASE {\"name\":\"" << name << "\",\"atUnixMs\":" << unix_ms << "}" << std::endl;
    };
    phase("muted");
    std::this_thread::sleep_for(std::chrono::seconds{1});
    config.muted = false;
    require(pipeline.configure(config) == MicrophonePipelineFailure::none, "Unmute failed");
    phase("audible");
    std::this_thread::sleep_for(std::chrono::seconds{3});
    phase("cycles");
    for (unsigned cycle = 0; cycle < 200; ++cycle) {
      for (const bool muted : {true, false}) {
        config.muted = muted;
        config.noise_suppression = cycle % 2 != 0;
        config.input_volume = cycle % 3 ? 1.0f : 0.5f;
        require(pipeline.configure(config) == MicrophonePipelineFailure::none, "Publication mute/config failed");
        std::this_thread::sleep_for(std::chrono::milliseconds{10});
      }
    }
    config.muted = true;
    config.noise_suppression = false;
    config.input_volume = 1.0f;
    require(pipeline.configure(config) == MicrophonePipelineFailure::none, "Final mute failed");
    phase("muted");
    std::this_thread::sleep_for(std::chrono::seconds{1});
    config.muted = false;
    require(pipeline.configure(config) == MicrophonePipelineFailure::none, "Final unmute failed");
    phase("audible");
    auto next_resource = Clock::now();
    if (expect_device_loss) std::cout << "MICROPHONE_DEVICE_LOSS_READY" << std::endl;
    while (Clock::now() - began < std::chrono::seconds{seconds}) {
      const auto current = pipeline.stats().capture;
      if (expect_device_loss && current.failure == MicrophoneCaptureFailure::device_lost && !device_loss_seen) {
        device_loss_seen = true;
        std::cout << "MICROPHONE_DEVICE_LOSS {\"failure\":\"device_lost\"}" << std::endl;
      }
      if (registry.changed()) {
        require(registry.refresh().status == AudioRegistryStatus::ready, "Microphone device refresh failed");
        const auto reconciled = pipeline.reconcileInput(registry);
        require(reconciled == MicrophonePipelineFailure::none ||
                (expect_device_loss && reconciled == MicrophonePipelineFailure::input_unavailable),
                "Microphone reconciliation failed");
      }
      if (expect_device_loss && device_loss_seen) {
        const auto recovered = pipeline.stats().capture;
        input_recovered = recovered.state == MicrophoneCaptureState::healthy && recovered.generation != initial_generation;
        require(transport->activeRoom() == original_room, "Device loss replaced the Room");
      }
      if (Clock::now() >= next_resource) {
        resourceSample(pipeline.stats(), sender.stats(),
                       std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - began).count());
        next_resource = Clock::now() + std::chrono::seconds{30};
      }
      std::this_thread::sleep_for(std::chrono::milliseconds{100});
    }
    resourceSample(pipeline.stats(), sender.stats(),
                   std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - began).count());
    const auto publication = sender.stats();
    const auto capture = pipeline.stats();
    require(publication.failure == MicrophonePublicationFailure::none && publication.publication_commits == 1 &&
            publication.submitted > 500, "Microphone publication continuity failed");
    if (expect_device_loss) require(device_loss_seen && input_recovered, "Physical input loss/recovery was not observed");
    else require(capture.capture_opens == 1 && capture.committed_switches == 1, "Mute recreated capture");
    require(sender.stop(Clock::now() + std::chrono::seconds{6}), "Microphone sender cleanup timeout");
    // Removing publication demand preserves the exact same warm meter/input.
    require(pipeline.setDemand({false, false, true}) == MicrophonePipelineFailure::none, "Unpublish demand failed");
    (void)pipeline.output()->take();
    require(nextFrame(pipeline).generation == capture.capture.generation, "Unpublish destroyed warm input");
    require(pipeline.stop(Clock::now() + std::chrono::seconds{5}), "Microphone pipeline cleanup timeout");
    require(worker_allocations.allocations == 0 && worker_allocations.reallocations == 0, "DSP worker allocated");
    std::cout << "MICROPHONE_REPORT {\"status\":\"pass\",\"cycles\":200,\"dspUpdatesWhilePublishing\":true"
              << ",\"explicitInput\":" << (explicit_input ? "true" : "false") << ",\"captureOpens\":" << capture.capture_opens
              << ",\"publicationCommits\":" << publication.publication_commits << ",\"submitted\":" << publication.submitted
              << ",\"maximumFrameAgeUs\":" << publication.maximum_frame_age_us
              << ",\"deviceLossObserved\":" << (device_loss_seen ? "true" : "false")
              << ",\"inputRecovered\":" << (input_recovered ? "true" : "false")
              << ",\"rejectedStale\":" << publication.rejected_stale << ",\"dspWorkerAllocations\":0}" << std::endl;
  }
  require(engine.shutdown(std::chrono::seconds{12}).ok, "Microphone Engine shutdown failed");
  return 0;
}

int microphoneDeviceSwitchLab() {
  auto enumerator = std::make_unique<LabDefaultEnumerator>();
  auto* simulated_defaults = enumerator.get(); // Registry owns it through this entire lab scope.
  AudioDeviceRegistry registry(std::move(enumerator));
  const auto devices = registry.refresh();
  require(devices.status == AudioRegistryStatus::ready, "Microphone registry failed");
  auto original = registry.resolve({AudioDirection::input, {}});
  require(original.has_value(), "Default microphone unavailable");
  MicrophonePipeline pipeline(makeLiveKitMicrophoneEnhancement);
  require(pipeline.selectInput(registry, {AudioDirection::input, {}}) == MicrophonePipelineFailure::none, "Default selection failed");
  require(pipeline.setDemand({true, false, true}) == MicrophonePipelineFailure::none, "Default capture failed");
  std::uint64_t successes = 0, rollbacks = 0;
  std::optional<AudioEndpoint> successful_input;
  for (const auto& device : devices.devices) {
    if (device.direction != AudioDirection::input || device.is_default) continue;
    auto candidate = registry.resolve({AudioDirection::input, device.id});
    require(candidate.has_value(), "Explicit input resolution failed");
    const auto before = pipeline.stats();
    const auto switched = pipeline.selectInput(registry, {AudioDirection::input, device.id});
    require(switched == MicrophonePipelineFailure::none || switched == MicrophonePipelineFailure::capture_failed,
            "Device switch exceeded finite lifecycle bounds");
    (void)pipeline.output()->take();
    const auto frame = nextFrame(pipeline);
    const bool committed = switched == MicrophonePipelineFailure::none;
    if (committed) {
      require(frame.generation != before.capture.generation, "Candidate did not commit a new generation");
      ++successes;
      successful_input = *candidate;
    } else {
      require(frame.generation == before.capture.generation, "Failed candidate broke active input");
      ++rollbacks;
    }
    std::cout << "MICROPHONE_DEVICE {\"id\":" << device.id << ",\"committed\":" << (committed ? "true" : "false")
              << ",\"candidateFailure\":" << static_cast<unsigned>(pipeline.stats().candidate_failure) << "}" << std::endl;
  }
  require(pipeline.selectInput(registry, {AudioDirection::input, {}}) == MicrophonePipelineFailure::none, "Default input restoration failed");
  if (successful_input) {
    const auto explicit_device = std::find_if(devices.devices.begin(), devices.devices.end(), [&](const auto& device) {
      const auto endpoint = registry.resolve({AudioDirection::input, device.id});
      return endpoint && endpoint->endpoint_id == successful_input->endpoint_id;
    });
    require(explicit_device != devices.devices.end(), "Successful explicit device disappeared");
    require(pipeline.selectInput(registry, {AudioDirection::input, explicit_device->id}) == MicrophonePipelineFailure::none,
            "Explicit input selection failed");
    const auto explicit_generation = pipeline.stats().capture.generation;
    simulated_defaults->simulateDefault(successful_input->endpoint_id);
    require(registry.refresh().status == AudioRegistryStatus::ready, "Explicit default projection failed");
    require(pipeline.reconcileInput(registry) == MicrophonePipelineFailure::none, "Explicit reconciliation failed");
    simulated_defaults->simulateDefault(original->endpoint_id);
    require(registry.refresh().status == AudioRegistryStatus::ready, "Explicit default restoration failed");
    require(pipeline.reconcileInput(registry) == MicrophonePipelineFailure::none, "Explicit restoration reconciliation failed");
    (void)pipeline.output()->take();
    require(nextFrame(pipeline).generation == explicit_generation, "Default notification replaced explicit selection");
    require(pipeline.selectInput(registry, {AudioDirection::input, {}}) == MicrophonePipelineFailure::none,
            "Follow-default selection failed");
    const auto before = pipeline.stats().capture.generation;
    simulated_defaults->simulateDefault(successful_input->endpoint_id);
    require(registry.changed(), "Simulated default notification missing");
    require(registry.refresh().status == AudioRegistryStatus::ready, "Default refresh failed");
    require(pipeline.reconcileInput(registry) == MicrophonePipelineFailure::none, "Follow-default transaction failed");
    (void)pipeline.output()->take();
    require(nextFrame(pipeline).generation != before, "Follow-default did not commit healthy input");
    // Restore the registry projection, never the operating system's default.
    simulated_defaults->simulateDefault(original->endpoint_id);
    require(registry.refresh().status == AudioRegistryStatus::ready, "Default projection restoration failed");
    require(pipeline.reconcileInput(registry) == MicrophonePipelineFailure::none, "Original default transaction failed");
  }
  require(pipeline.stop(Clock::now() + std::chrono::seconds{5}), "Device matrix shutdown failed");
  std::cout << "{\"command\":\"microphone-device-switch\",\"status\":\"" << (successes ? "pass" : "unavailable")
            << "\",\"successfulExplicitSwitches\":" << successes << ",\"failedCandidateRollbacks\":" << rollbacks
            << ",\"simulatedDefaultNotifications\":" << (successful_input ? 2 : 0)
            << ",\"explicitSelectionIgnoredDefaultChanges\":" << (successful_input ? "true" : "false")
            << ",\"systemDefaultChanged\":false,\"stopped\":true}" << std::endl;
  return successes ? 0 : 2;
}

int microphoneDefaultChangeLab() {
  AudioDeviceRegistry registry(makeWindowsAudioDeviceEnumerator());
  const auto devices = registry.refresh();
  require(devices.status == AudioRegistryStatus::ready, "Microphone registry failed");
  const auto original = registry.resolve({AudioDirection::input, {}});
  require(original.has_value(), "Default microphone unavailable");
  MicrophonePipeline pipeline(makeLiveKitMicrophoneEnhancement);
  require(pipeline.selectInput(registry, {AudioDirection::input, {}}) == MicrophonePipelineFailure::none,
          "Default input selection failed");
  require(pipeline.setDemand({true, false, true}) == MicrophonePipelineFailure::none, "Warm input failed");
  std::optional<AudioEndpoint> target;
  for (const auto& device : devices.devices) {
    if (device.direction != AudioDirection::input || device.is_default) continue;
    if (pipeline.selectInput(registry, {AudioDirection::input, device.id}) == MicrophonePipelineFailure::none) {
      target = registry.resolve({AudioDirection::input, device.id});
      break;
    }
  }
  require(target.has_value(), "No second healthy input for real default-change proof");
  require(pipeline.selectInput(registry, {AudioDirection::input, {}}) == MicrophonePipelineFailure::none,
          "Warm default restoration failed");
  const auto before = pipeline.stats();
  require(target->endpoint_id.find(L'"') == std::wstring::npos, "Endpoint cannot be quoted for helper");
  std::array<wchar_t, 32768> module{};
  const auto length = GetModuleFileNameW(nullptr, module.data(), static_cast<DWORD>(module.size()));
  require(length > 0 && length < module.size(), "Lab executable path unavailable");
  std::wstring helper(module.data(), length);
  helper.resize(helper.find_last_of(L"\\/") + 1);
  helper += L"default_endpoint_proof.exe";
  auto command = L"\"" + helper + L"\" --input \"" + target->endpoint_id + L"\"";
  struct HelperProcess {
    PROCESS_INFORMATION process{};
    ~HelperProcess() {
      // Never kill the restoration owner. Its normal path restores both roles
      // after five seconds, even if this observer reports an error.
      if (process.hProcess) {
        (void)WaitForSingleObject(process.hProcess, 15000);
        CloseHandle(process.hProcess);
      }
      if (process.hThread) CloseHandle(process.hThread);
    }
  } child;
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  require(CreateProcessW(helper.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
                         nullptr, nullptr, &startup, &child.process) != FALSE, "Default-change helper failed to start");
  std::uint64_t transitions = 0;
  auto generation = before.capture.generation;
  const auto deadline = Clock::now() + std::chrono::seconds{12};
  while (Clock::now() < deadline) {
    if (registry.changed()) {
      require(registry.refresh().status == AudioRegistryStatus::ready, "Default notification refresh failed");
      require(pipeline.reconcileInput(registry) == MicrophonePipelineFailure::none, "Real default transaction failed");
      (void)pipeline.output()->take();
      const auto frame = nextFrame(pipeline);
      if (frame.generation != generation) { ++transitions; generation = frame.generation; }
    }
    if (transitions >= 2 && WaitForSingleObject(child.process.hProcess, 0) == WAIT_OBJECT_0) break;
    std::this_thread::sleep_for(std::chrono::milliseconds{20});
  }
  DWORD helper_result = STILL_ACTIVE;
  require(GetExitCodeProcess(child.process.hProcess, &helper_result) && helper_result == 0,
          "Default-change helper did not confirm restoration");
  require(registry.refresh().status == AudioRegistryStatus::ready, "Restored default refresh failed");
  const auto restored = registry.resolve({AudioDirection::input, {}});
  require(restored && restored->endpoint_id == original->endpoint_id, "System default input was not restored");
  const auto after = pipeline.stats();
  require(transitions == 2 && after.committed_switches == before.committed_switches + 2,
          "Real default notifications did not commit both healthy generations");
  require(pipeline.stop(Clock::now() + std::chrono::seconds{5}), "Default-change capture cleanup failed");
  std::cout << "{\"command\":\"microphone-default-change\",\"status\":\"pass\",\"realDefaultTransitions\":2"
            << ",\"healthyCommits\":2,\"systemDefaultRestored\":true,\"stopped\":true}" << std::endl;
  return 0;
}
