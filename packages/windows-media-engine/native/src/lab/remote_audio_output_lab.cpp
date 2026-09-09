#include "audio/remote_audio_output.hpp"
#include "lab/remote_audio_probe.hpp"
#include <windows.h>

#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include "fault_evidence.hpp"

using namespace syrnike::windows_media::audio;
namespace {
using Clock = std::chrono::steady_clock;
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
std::int64_t timestamp() {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
class OutputFixtureDevices final : public AudioDeviceEnumerator {
 public:
  std::optional<std::vector<AudioEndpoint>> enumerate() override {
    auto values = native_->enumerate();
    if (values) values->push_back({L"syrnike-nonexistent-lab-output", AudioDirection::output,
                                  "invalid-candidate-fixture", false});
    return values;
  }
  bool changed() const noexcept override { return native_->changed(); }
 private:
  std::unique_ptr<AudioDeviceEnumerator> native_ = makeWindowsAudioDeviceEnumerator();
};
struct Measurement {
  std::uint64_t frames = 0, audible = 0;
  WasapiOutputStats stats;
};
std::jthread produceTone(const std::shared_ptr<RemoteAudioPcmPort>& input) {
  return std::jthread([input](std::stop_token stop) {
    std::uint64_t sequence = 0;
    auto next = Clock::now();
    while (!stop.stop_requested()) {
      RemoteAudioFrame frame;
      frame.generation = 1;
      frame.sequence = ++sequence;
      frame.decoded_timestamp_100ns = timestamp();
      for (std::size_t index = 0; index < kRemoteAudioFrames; ++index) {
        const auto value = static_cast<std::int16_t>(400 * std::sin(
            2 * 3.14159265358979323846 * 700 * static_cast<double>(sequence * 480 + index) / 48000));
        frame.samples[index * 2] = frame.samples[index * 2 + 1] = value;
      }
      (void)input->publish(frame);
      next = (std::max)(next + std::chrono::milliseconds{10}, Clock::now());
      std::this_thread::sleep_until(next);
    }
  });
}
Measurement measure(RemoteAudioOutput& output, std::chrono::milliseconds duration) {
  auto reference = output.echoReference();
  require(reference != nullptr, "Output reference missing");
  Measurement result;
  const auto began = Clock::now();
  while (Clock::now() - began < duration) {
    if (auto frame = reference->take()) {
      ++result.frames;
      int peak = 0;
      for (const auto sample : frame->samples) peak = (std::max)(peak, std::abs(static_cast<int>(sample)));
      if (peak > 100) ++result.audible;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds{5});
  }
  result.stats = output.stats().active;
  return result;
}
}
int remoteAudioFaultMatrix() {
  namespace lab = syrnike::windows_media::lab;
  AudioDeviceRegistry registry(std::make_unique<OutputFixtureDevices>());
  const auto inventory = registry.refresh();
  require(inventory.status == AudioRegistryStatus::ready, "Output registry unavailable");
  const auto endpoint = registry.resolve({AudioDirection::output, {}});
  require(endpoint.has_value(), "Default output unavailable");
  std::optional<AudioDeviceId> invalid;
  for (const auto& device : inventory.devices)
    if (device.direction == AudioDirection::output && device.label == "invalid-candidate-fixture") invalid = device.id;
  require(invalid.has_value(), "Invalid output fixture missing");
  const auto worker_fault = [&](bool stop_progress) {
    lab::render_probe_epoch = 2;
    struct ResetFault {
      ~ResetFault() {
        lab::render_stop_client = false;
        lab::render_device_loss = false;
        lab::render_probe_epoch = 0;
      }
    } reset;
    WasapiOutput healthy, failing;
    require(healthy.start(*endpoint, 1) == WasapiOutputFailure::none &&
            failing.start(*endpoint, 2) == WasapiOutputFailure::none, "Output fault fixture did not become healthy");
    const auto before = healthy.stats();
    if (stop_progress) lab::render_stop_client = true;
    else lab::render_device_loss = true;
    const auto deadline = Clock::now() + std::chrono::milliseconds(750);
    while (failing.stats().failure == WasapiOutputFailure::none && Clock::now() < deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    const auto expected = stop_progress ? WasapiOutputFailure::no_progress : WasapiOutputFailure::device_lost;
    require(failing.stats().failure == expected, "Output fault missed its typed liveness deadline");
    require(failing.stop(Clock::now() + std::chrono::seconds(2)), "Failed output worker did not join");
    const auto stopped = failing.stats();
    require(!stopped.client_alive && !stopped.thread_alive, "Failed output retained WASAPI resources");
    const auto progress_deadline = Clock::now() + std::chrono::milliseconds(250);
    while (healthy.stats().consumed_frames <= before.consumed_frames && Clock::now() < progress_deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    const auto continued = healthy.stats();
    require(continued.state == WasapiOutputState::running && continued.epoch == before.epoch &&
            continued.consumed_frames > before.consumed_frames, "A local output fault stopped the healthy worker");
    require(healthy.stop(Clock::now() + std::chrono::seconds(2)), "Healthy output did not join");
  };
  const auto candidate_fault = [&] {
    RemoteAudioMixerWorker mixer;
    RemoteAudioOutput output(mixer);
    require(output.selectOutput(registry, {AudioDirection::output, {}}) == RemoteOutputFailure::none,
            "Output candidate fixture did not become healthy");
    const auto before = output.stats();
    require(output.selectOutput(registry, {AudioDirection::output, invalid}) == RemoteOutputFailure::candidate_failed,
            "Invalid output candidate was committed");
    require(output.setDeafened(true) && output.setDeafened(false), "Candidate failure blocked live output controls");
    const auto deadline = Clock::now() + std::chrono::milliseconds(250);
    while (output.stats().active.consumed_frames <= before.active.consumed_frames && Clock::now() < deadline)
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    const auto continued = output.stats();
    require(continued.state == RemoteOutputState::running && continued.commits == before.commits &&
            continued.active.epoch == before.active.epoch &&
            continued.active.consumed_frames > before.active.consumed_frames,
            "Candidate failure replaced or silenced the healthy output");
    require(output.stop(Clock::now() + std::chrono::seconds(2)) &&
            mixer.stop(Clock::now() + std::chrono::seconds(2)), "Output candidate fixture did not drain");
  };
  syrnike::windows_media::tests::repeatFault("output-device-invalidated", [&] { worker_fault(false); });
  syrnike::windows_media::tests::repeatFault("output-no-progress", [&] { worker_fault(true); });
  syrnike::windows_media::tests::repeatFault("output-candidate-failure", candidate_fault);
  return 0;
}

int remoteAudioOutputStress() {
  AudioDeviceRegistry registry(std::make_unique<OutputFixtureDevices>());
  const auto devices = registry.refresh();
  require(devices.status == AudioRegistryStatus::ready, "Output registry unavailable");
  std::optional<AudioDeviceId> alternate, invalid;
  for (const auto& device : devices.devices) {
    if (device.direction != AudioDirection::output) continue;
    if (device.label == "invalid-candidate-fixture") invalid = device.id;
    else if (!device.is_default && !alternate) alternate = device.id;
  }
  require(alternate.has_value() && invalid.has_value(), "Output switch fixture needs a second active output");
  RemoteAudioMixerWorker mixer;
  auto input = std::make_shared<RemoteAudioPcmPort>(1, 2);
  require(mixer.configure(std::array{RemoteAudioInput{input, 1, false}}, false), "Output fixture graph rejected");
  auto producer = produceTone(input);
  RemoteAudioOutput output(mixer);
  require(output.selectOutput(registry, {AudioDirection::output, {}}) == RemoteOutputFailure::none, "Default output failed");
  const auto baseline = measure(output, std::chrono::milliseconds{1000});
  require(baseline.audible > 60 && baseline.stats.consumed_frames > 0, "Baseline output not progressing");
  auto old_reference = output.echoReference();
  require(output.selectOutput(registry, {AudioDirection::output, alternate}) == RemoteOutputFailure::none, "Explicit output switch failed");
  const auto switched = measure(output, std::chrono::milliseconds{1000});
  require(switched.audible > 60 && switched.stats.epoch != baseline.stats.epoch && switched.stats.consumed_frames > 0 &&
          !old_reference->take(), "Output switch lacked fresh progress/epoch fence");
  const auto working_epoch = switched.stats.epoch;
  require(output.selectOutput(registry, {AudioDirection::output, invalid}) == RemoteOutputFailure::candidate_failed,
          "Invalid candidate was not rejected");
  const auto rollback = measure(output, std::chrono::milliseconds{500});
  require(rollback.stats.epoch == working_epoch && rollback.audible > 30 && output.stats().commits == 2,
          "Failed candidate disturbed working output");
  auto& probe_epoch = syrnike::windows_media::lab::render_probe_epoch;
  probe_epoch = output.stats().candidates + 1;
  syrnike::windows_media::lab::render_stop_client = true;
  require(output.selectOutput(registry, {AudioDirection::output, {}}) == RemoteOutputFailure::candidate_failed,
          "Candidate without consumption progress was committed");
  const auto stalled_candidate = output.stats();
  require(stalled_candidate.candidate_failure == WasapiOutputFailure::no_progress &&
          stalled_candidate.active.epoch == working_epoch && stalled_candidate.commits == 2 &&
          stalled_candidate.active.consumed_frames > rollback.stats.consumed_frames + 12'000,
          "Working renderer did not progress while candidate failed its health proof");
  probe_epoch = working_epoch;
  syrnike::windows_media::lab::render_delay_ms = 250;
  const auto delayed = measure(output, std::chrono::milliseconds{1200});
  require(delayed.stats.delayed_wakes > 0 && delayed.stats.underruns > 0 && delayed.audible > 70 &&
          delayed.stats.maximum_wake_gap_100ns >= 2'000'000 &&
          delayed.stats.maximum_scheduled_age_100ns <= kRemoteAudioMaximumAge100ns &&
          delayed.stats.padding_frames <= kRemoteAudioTargetPadding,
          "Delayed output did not discard debt and recover fresh padding");
  old_reference = output.echoReference();
  syrnike::windows_media::lab::render_stop_client = true;
  const auto stopped_at = Clock::now();
  while (output.stats().active.state != WasapiOutputState::failed && Clock::now() - stopped_at < std::chrono::seconds{2})
    std::this_thread::sleep_for(std::chrono::milliseconds{5});
  const auto failed = output.stats().active;
  const auto detection_ms = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - stopped_at).count();
  require(failed.failure == WasapiOutputFailure::no_progress && detection_ms < 1500 && !old_reference->take(),
          "Stopped audio client did not fail with finite no-progress detection");
  require(output.reconcile(registry, devices.revision) == RemoteOutputFailure::none, "Output recovery failed");
  const auto recovered = measure(output, std::chrono::milliseconds{1000});
  require(recovered.stats.epoch != working_epoch && recovered.audible > 60 && output.stats().commits == 3,
          "Output recovery did not commit a healthy fresh epoch");
  require(output.selectOutput(registry, {AudioDirection::output, {}}) == RemoteOutputFailure::none,
          "Return to default output failed");
  const auto restored = measure(output, std::chrono::milliseconds{500});
  require(restored.audible > 30, "Default output restoration is silent");
  producer.request_stop();
  producer.join();
  require(output.stop(Clock::now() + std::chrono::seconds{5}) && mixer.stop(Clock::now() + std::chrono::seconds{5}),
          "Output stress cleanup deadline");
  std::cout << "{\"scope\":\"mixer-wasapi-output-stress\",\"status\":\"pass\",\"physicalEndpointSwitch\":true,"
            << "\"failedCandidateFixture\":\"nonexistent-endpoint\",\"injectedWakeDelayMs\":250,"
            << "\"stalledCandidateRejected\":true,\"oldOutputProgressDuringCandidate\":true,"
            << "\"maximumWakeGapUs\":" << delayed.stats.maximum_wake_gap_100ns / 10
            << ",\"maximumScheduledAgeUs\":" << delayed.stats.maximum_scheduled_age_100ns / 10
            << ",\"underruns\":" << delayed.stats.underruns << ",\"postDelayAudibleFrames\":" << delayed.audible
            << ",\"noProgressDetectionMs\":" << detection_ms
            << ",\"oldEpoch\":" << working_epoch << ",\"recoveredEpoch\":" << recovered.stats.epoch
            << ",\"stopped\":true}" << std::endl;
  return 0;
}
int remoteAudioDefaultRemoval() {
  AudioDeviceRegistry registry(makeWindowsAudioDeviceEnumerator());
  const auto devices = registry.refresh();
  require(devices.status == AudioRegistryStatus::ready, "Default-removal registry unavailable");
  const auto original = registry.resolve({AudioDirection::output, {}});
  require(original.has_value(), "Default-removal original endpoint unavailable");
  require(std::count_if(devices.devices.begin(), devices.devices.end(), [](const auto& device) {
    return device.direction == AudioDirection::output;
  }) >= 2, "Default removal requires an alternate active output");
  RemoteAudioMixerWorker mixer;
  auto input = std::make_shared<RemoteAudioPcmPort>(1, 2);
  require(mixer.configure(std::array{RemoteAudioInput{input, 1, false}}, false), "Default-removal graph rejected");
  auto producer = produceTone(input);
  RemoteAudioOutput output(mixer);
  require(output.selectOutput(registry, {AudioDirection::output, {}}) == RemoteOutputFailure::none, "Default-removal output failed");
  const auto before = measure(output, std::chrono::milliseconds{500});
  require(before.audible > 30, "Default-removal baseline silent");
  std::array<wchar_t, 32768> module{};
  const auto length = GetModuleFileNameW(nullptr, module.data(), static_cast<DWORD>(module.size()));
  require(length > 0 && length < module.size(), "Default-removal helper path unavailable");
  std::wstring helper(module.data(), length);
  helper.resize(helper.find_last_of(L"\\/") + 1);
  helper += L"default_endpoint_proof.exe";
  auto command = L"\"" + helper + L"\" --remove-output";
  struct Helper {
    PROCESS_INFORMATION process{};
    ~Helper() {
      // The separate process is the restoration owner. Never kill it on a
      // receiver failure; it restores endpoint visibility and all three roles.
      if (process.hProcess) { (void)WaitForSingleObject(process.hProcess, 15000); CloseHandle(process.hProcess); }
      if (process.hThread) CloseHandle(process.hThread);
    }
  } child;
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  require(CreateProcessW(helper.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
          nullptr, nullptr, &startup, &child.process) != FALSE, "Default-removal helper failed to start");
  bool removed = false, returned = false;
  std::uint64_t removal_epoch = 0;
  const auto deadline = Clock::now() + std::chrono::seconds{12};
  auto latest = devices;
  while (Clock::now() < deadline) {
    if (registry.changed()) {
      latest = registry.refresh();
      require(latest.status == AudioRegistryStatus::ready, "Default-removal refresh failed");
    }
    const auto outcome = output.reconcile(registry, latest.revision);
    require(outcome == RemoteOutputFailure::none || outcome == RemoteOutputFailure::unavailable ||
            outcome == RemoteOutputFailure::candidate_failed, "Default-removal transaction failed");
    const auto current = registry.resolve({AudioDirection::output, {}});
    const auto stats = output.stats();
    if (current && current->endpoint_id != original->endpoint_id && stats.state == RemoteOutputState::running &&
        stats.active.epoch != before.stats.epoch) {
      removed = true;
      removal_epoch = stats.active.epoch;
    }
    if (removed && current && current->endpoint_id == original->endpoint_id &&
        stats.state == RemoteOutputState::running && stats.active.epoch != removal_epoch) returned = true;
    if (returned && WaitForSingleObject(child.process.hProcess, 0) == WAIT_OBJECT_0) break;
    std::this_thread::sleep_for(std::chrono::milliseconds{20});
  }
  DWORD helper_result = STILL_ACTIVE;
  require(GetExitCodeProcess(child.process.hProcess, &helper_result) && helper_result == 0, "Endpoint/default restoration unconfirmed");
  require(removed && returned, "Default removal and return did not commit distinct healthy outputs");
  const auto after = measure(output, std::chrono::milliseconds{500});
  require(after.audible > 30 && after.stats.consumed_frames > 0, "Restored default output silent");
  producer.request_stop();
  producer.join();
  require(output.stop(Clock::now() + std::chrono::seconds{5}) && mixer.stop(Clock::now() + std::chrono::seconds{5}),
          "Default-removal cleanup deadline");
  std::cout << "{\"scope\":\"wasapi-default-endpoint-removal-return\",\"status\":\"pass\","
            << "\"programmaticEndpointDisable\":true,\"physicalUnplug\":false,\"defaultRolesRestored\":3,"
            << "\"initialEpoch\":" << before.stats.epoch << ",\"fallbackEpoch\":" << removal_epoch
            << ",\"restoredEpoch\":" << after.stats.epoch << ",\"restoredAudibleFrames\":" << after.audible << "}" << std::endl;
  return 0;
}
