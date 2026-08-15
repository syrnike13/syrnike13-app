#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <mutex>
#include <new>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include <mmdeviceapi.h>

#include "common/event_sink.hpp"
#include "common/sequenced_emitter.hpp"
#include "media/audio_constants.hpp"
#include "media/microphone_actor.hpp"
#include "media/generation_fence.hpp"
#include "media/livekit_disconnect_reason.hpp"
#include "media/preview_actor.hpp"
#include "media/screen_actor.hpp"

namespace {

thread_local bool count_capture_memory = false;
thread_local bool inside_capture_submission = false;
std::atomic_size_t capture_allocations{0};
std::atomic_size_t capture_deallocations{0};

class CollectingSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent event) override {
    std::lock_guard lock(mutex_);
    events_.push_back(std::move(event));
    return true;
  }

  void close() override {}

  std::size_t size() const {
    std::lock_guard lock(mutex_);
    return events_.size();
  }

  std::vector<syrnike::desktop_native::RuntimeEvent> events() const {
    std::lock_guard lock(mutex_);
    return events_;
  }

  void clear() {
    std::lock_guard lock(mutex_);
    events_.clear();
  }

 private:
  mutable std::mutex mutex_;
  std::vector<syrnike::desktop_native::RuntimeEvent> events_;
};

template <typename Action>
void requireThrows(Action action, const char* message) {
  try {
    action();
  } catch (const std::exception&) {
    return;
  }
  throw std::runtime_error(message);
}

}  // namespace

void* operator new(std::size_t size) {
  if (count_capture_memory) capture_allocations.fetch_add(1);
  if (void* allocation = std::malloc(size)) return allocation;
  throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
  if (count_capture_memory) capture_allocations.fetch_add(1);
  if (void* allocation = std::malloc(size)) return allocation;
  throw std::bad_alloc();
}
void operator delete(void* allocation) noexcept {
  if (count_capture_memory) capture_deallocations.fetch_add(1);
  std::free(allocation);
}
void operator delete[](void* allocation) noexcept {
  if (count_capture_memory) capture_deallocations.fetch_add(1);
  std::free(allocation);
}
void operator delete(void* allocation, std::size_t) noexcept {
  if (count_capture_memory) capture_deallocations.fetch_add(1);
  std::free(allocation);
}
void operator delete[](void* allocation, std::size_t) noexcept {
  if (count_capture_memory) capture_deallocations.fetch_add(1);
  std::free(allocation);
}

int main() try {
  using namespace syrnike::desktop_native;
  using namespace syrnike::desktop_native::media;

  {
    auto incident_sink = std::make_shared<CollectingSink>();
    SequencedEmitter incident_emitter(incident_sink);
    const ScreenGpuRecoveryTransition transition{
      "wgc_gpu", "switch_backend", 1
    };
    if (!emitScreenBackendRestart(
          incident_emitter, "screen-transition", 7, transition)) {
      throw std::runtime_error("screen backend restart event was rejected");
    }
    RuntimeEvent terminal;
    terminal.type = syrnike::desktop_native::NativeEventType::ScreenCaptureEnded;
    terminal.session_id = "screen-transition";
    terminal.generation = 7;
    incident_emitter.emit(std::move(terminal));

    const auto events = incident_sink->events();
    const auto incidents = std::count_if(
      events.begin(),
      events.end(),
      [](const RuntimeEvent& event) {
        return event.type == syrnike::desktop_native::NativeEventType::ScreenBackendRestart;
      }
    );
    if (
      events.size() != 2 ||
      events[0].type != syrnike::desktop_native::NativeEventType::ScreenBackendRestart ||
      events[0].video_recoverable_lost_count != 1 ||
      events[1].type != syrnike::desktop_native::NativeEventType::ScreenCaptureEnded ||
      incidents != 1
    ) {
      throw std::runtime_error(
        "transition followed by terminal did not emit exactly one incident"
      );
    }
  }

  const auto participant_removed =
    describeLiveKitDisconnectReason(livekit::DisconnectReason::ParticipantRemoved);
  if (
    participant_removed.code != "participant_removed" ||
    participant_removed.numeric_code != 4 ||
    !participant_removed.known
  ) {
    throw std::runtime_error("known LiveKit disconnect reason mapping drifted");
  }
  if (
    formatLiveKitDisconnectTerminalMessage(livekit::DisconnectReason::ParticipantRemoved) !=
    "livekit_disconnected:participant_removed"
  ) {
    throw std::runtime_error("known LiveKit disconnect terminal message drifted");
  }
  const auto unknown_reason = static_cast<livekit::DisconnectReason>(99);
  const auto unknown = describeLiveKitDisconnectReason(unknown_reason);
  if (unknown.code != "unknown" || unknown.numeric_code != 99 || unknown.known) {
    throw std::runtime_error("unknown LiveKit disconnect reason mapping drifted");
  }
  if (formatLiveKitDisconnectTerminalMessage(unknown_reason) != "livekit_disconnected:unknown:99") {
    throw std::runtime_error("unknown LiveKit disconnect terminal message drifted");
  }

  auto sink = std::make_shared<CollectingSink>();
  SequencedEmitter emitter(sink);
  auto post = [](MediaCommand) { return true; };
  auto actor_livekit =
    std::make_shared<DeterministicFakeLiveKitVoiceSession>();
  GenerationFence microphone_intent;
  microphone_intent.advance("mic", 1);
  auto microphone_current = [&](const std::string& session_id, std::uint64_t generation) {
    return microphone_intent.isCurrent(session_id, generation);
  };
  MicrophoneActor microphone(
    emitter,
    post,
    microphone_current,
    actor_livekit
  );
  MediaCommand invalid_microphone;
  invalid_microphone.type = syrnike::desktop_native::NativeCommandType::ConnectMicrophone;
  invalid_microphone.session_id = "mic";
  invalid_microphone.generation = 1;
  requireThrows(
    [&] { static_cast<void>(microphone.connect(invalid_microphone)); },
    "microphone actor accepted missing LiveKit credentials"
  );

  microphone_intent.advance("mic", 2);
  MediaCommand stale_disconnect;
  stale_disconnect.type = syrnike::desktop_native::NativeCommandType::DisconnectMicrophone;
  stale_disconnect.session_id = "mic";
  stale_disconnect.generation = 1;
  requireThrows(
    [&] { microphone.disconnect(stale_disconnect); },
    "stale microphone disconnect reached actor state"
  );

  MediaCommand partial;
  partial.type = syrnike::desktop_native::NativeCommandType::ConfigureMicrophone;
  partial.input_volume = 0.5f;
  partial.has_input_volume = true;
  microphone.configure(partial);
  MediaCommand revised = partial;
  revised.request_id = "configure-2";
  revised.revision = 2;
  revised.has_revision = true;
  const auto configured = microphone.configure(revised);
  if (configured.kind != "microphoneConfig" || !configured.revision || *configured.revision != 2) {
    throw std::runtime_error("microphone configure did not return pipeline revision");
  }
  MediaCommand explicit_device = revised;
  explicit_device.revision = 3;
  explicit_device.device_id = "capture-device";
  microphone.configure(explicit_device);
  MediaCommand default_device = revised;
  default_device.revision = 4;
  default_device.device_id.clear();
  const auto default_configured = microphone.configure(default_device);
  if (!default_configured.device_id.empty()) {
    throw std::runtime_error("microphone pipeline did not restore default-device selection");
  }
  MediaCommand stale_revision = revised;
  stale_revision.revision = 1;
  requireThrows(
    [&] { static_cast<void>(microphone.configure(stale_revision)); },
    "stale microphone config revision reached actor state"
  );
  microphone.disconnect(partial);
  microphone.disconnect(partial);
  microphone.handleTerminal(partial);
  microphone.shutdown();
  microphone.shutdown();

  std::mutex policy_mutex;
  std::vector<WindowsAudioAttemptPhase> microphone_policy_phases;
  auto microphone_policy = std::make_shared<WindowsAudioSessionAttemptPolicy>(
    WindowsAudioSessionAttemptOperations{
      .category = [](IAudioClient*, WindowsAudioSessionUse use,
                     AUDCLNT_STREAMOPTIONS) {
        return applyWindowsAudioCategoryPolicy(
          use,
          [](AUDIO_STREAM_CATEGORY) { return S_OK; }
        );
      },
      .ducking = [](IAudioClient*, WindowsAudioSessionUse use) {
        return applyWindowsAudioDuckingPolicy(
          use,
          [](bool) { return S_OK; }
        );
      },
    },
    [&](const WindowsAudioAttemptStep& step) {
      std::lock_guard lock(policy_mutex);
      microphone_policy_phases.push_back(step.phase);
    }
  );
  std::atomic_int microphone_attempts{0};
  std::vector<std::string> microphone_candidate_devices;
  std::vector<std::string> microphone_attempt_devices;
  std::vector<std::uint64_t> microphone_attempt_epochs;
  std::vector<std::function<bool(std::span<const float>, bool)>>
    microphone_attempt_submitters;
  std::mutex echo_lifecycle_mutex;
  std::vector<std::thread::id> echo_lifecycle_threads;
  std::vector<std::optional<std::string>> echo_lifecycle_targets;
  std::atomic_bool block_echo_start{false};
  std::atomic_bool echo_start_entered{false};
  std::atomic_bool release_echo_start{false};
  std::atomic_size_t echo_polls{0};
  std::atomic_size_t echo_lifecycle_on_capture{0};
  MicrophoneActor policy_microphone(
    emitter,
    post,
    microphone_current,
    std::make_shared<DeterministicFakeLiveKitVoiceSession>(),
    {},
    microphone_policy,
    MicrophoneCaptureAdapter{
      .probe_candidate = [&](MicrophoneCaptureCandidateRequest request) {
        std::lock_guard lock(policy_mutex);
        microphone_candidate_devices.push_back(std::move(request.device_id));
      },
      .run = [&](MicrophoneCaptureAttemptRequest request) {
        {
          std::lock_guard lock(policy_mutex);
          microphone_attempt_devices.push_back(request.device_id);
          microphone_attempt_epochs.push_back(request.epoch);
          microphone_attempt_submitters.push_back(request.submit_pcm);
        }
        const auto attempt = request.audio_attempt_policy->run(
          nullptr,
          WindowsAudioSessionUse::MicrophoneCapture,
          request.bypass_system_audio_input_processing
            ? AUDCLNT_STREAMOPTIONS_RAW
            : AUDCLNT_STREAMOPTIONS_NONE,
          [] { return S_OK; }
        );
        if (attempt.initialize.status != WindowsAudioPolicyStatus::Applied) {
          throw std::runtime_error("deterministic microphone attempt failed");
        }
        microphone_attempts.fetch_add(1, std::memory_order_release);
        request.mark_ready();
        while (request.keep_running()) std::this_thread::yield();
      },
    },
    MicrophoneEchoReferenceAdapter{
      .configure = [&](std::optional<std::string> target) {
        if (inside_capture_submission) {
          echo_lifecycle_on_capture.fetch_add(1, std::memory_order_relaxed);
        }
        {
          std::lock_guard lock(echo_lifecycle_mutex);
          echo_lifecycle_threads.push_back(std::this_thread::get_id());
          echo_lifecycle_targets.push_back(target);
        }
        if (target && block_echo_start.load(std::memory_order_acquire)) {
          echo_start_entered.store(true, std::memory_order_release);
          while (!release_echo_start.load(std::memory_order_acquire)) {
            std::this_thread::yield();
          }
        }
      },
      .poll = [&] {
        echo_polls.fetch_add(1, std::memory_order_relaxed);
        return syrnike::voice::MicrophoneEchoReferenceRealtimeFrame{};
      },
    }
  );
  policy_microphone.setPreviewConsumer(
    "mic",
    2,
    [](std::span<const std::int16_t>) {}
  );
  MediaCommand warm_microphone;
  warm_microphone.type = NativeCommandType::WarmMicrophone;
  warm_microphone.generation = 1;
  // Keep this slice focused on routing-snapshot ownership. The WebRTC APM
  // path has its own hot-path coverage and may allocate inside the SDK.
  warm_microphone.has_noise_suppression = true;
  warm_microphone.noise_suppression = false;
  warm_microphone.has_automatic_gain_control = true;
  warm_microphone.automatic_gain_control = false;
  policy_microphone.warm(warm_microphone);
  MediaCommand microphone_recreate;
  microphone_recreate.type = NativeCommandType::MicrophoneEndpointChanged;
  microphone_recreate.internal_message = "default_changed";
  microphone_recreate.internal_epoch = static_cast<std::uint64_t>(eConsole);
  policy_microphone.handleWorkerCommand(microphone_recreate);
  MediaCommand select_microphone;
  select_microphone.type = NativeCommandType::ConfigureMicrophone;
  select_microphone.request_id = "select-capture-device";
  select_microphone.device_id = "capture-device";
  select_microphone.revision = 1;
  select_microphone.has_revision = true;
  const auto selected_microphone = policy_microphone.configure(select_microphone);
  if (!selected_microphone.ok || selected_microphone.device_id != "capture-device") {
    throw std::runtime_error("MicrophoneActor rejected selected capture device");
  }
  std::vector<std::function<bool(std::span<const float>, bool)>>
    retained_submitters;
  {
    std::lock_guard lock(policy_mutex);
    if (
      microphone_attempt_devices !=
        std::vector<std::string>{"", "", "capture-device"} ||
      microphone_candidate_devices !=
        std::vector<std::string>{"", "capture-device"} ||
      microphone_attempt_epochs.size() != 3 ||
      !(microphone_attempt_epochs[0] < microphone_attempt_epochs[1] &&
        microphone_attempt_epochs[1] < microphone_attempt_epochs[2])
    ) {
      throw std::runtime_error(
        "MicrophoneActor selected endpoint did not replace the default capture owner"
      );
    }
    retained_submitters = microphone_attempt_submitters;
  }
  const std::vector<float> retired_pcm(
    syrnike::voice::kSamplesPer10Ms,
    0.1f
  );
  if (
    retained_submitters.size() != 3 ||
    retained_submitters[0](std::span<const float>(retired_pcm), true) ||
    retained_submitters[1](std::span<const float>(retired_pcm), true)
  ) {
    throw std::runtime_error(
      "MicrophoneActor retired capture epoch accepted submitted PCM"
    );
  }
  if (!retained_submitters.back()(retired_pcm, false)) {
    throw std::runtime_error("MicrophoneActor realtime snapshot warmup failed");
  }
  std::atomic_bool routing_writer_ready{false};
  std::atomic_bool stop_routing_writer{false};
  std::atomic_size_t routing_swaps{0};
  std::thread routing_writer([&] {
    std::uint64_t generation = 3;
    routing_writer_ready.store(true, std::memory_order_release);
    while (!stop_routing_writer.load(std::memory_order_acquire)) {
      policy_microphone.setPreviewConsumer(
        "mic", generation, [](std::span<const std::int16_t>) {}
      );
      policy_microphone.clearPreviewConsumer("mic", generation);
      ++generation;
      routing_swaps.fetch_add(1, std::memory_order_relaxed);
    }
  });
  while (!routing_writer_ready.load(std::memory_order_acquire)) {
    std::this_thread::yield();
  }
  capture_allocations.store(0, std::memory_order_relaxed);
  capture_deallocations.store(0, std::memory_order_relaxed);
  count_capture_memory = true;
  std::size_t submitted_during_swaps = 0;
  constexpr std::size_t kConcurrentRoutingFrames = 32;
  while (submitted_during_swaps < kConcurrentRoutingFrames) {
    if (!retained_submitters.back()(retired_pcm, false)) {
      count_capture_memory = false;
      stop_routing_writer.store(true, std::memory_order_release);
      routing_writer.join();
      throw std::runtime_error(
        "MicrophoneActor rejected current PCM during routing swaps"
      );
    }
    ++submitted_during_swaps;
  }
  count_capture_memory = false;
  stop_routing_writer.store(true, std::memory_order_release);
  routing_writer.join();
  if (routing_swaps.load(std::memory_order_acquire) == 0 ||
      capture_allocations.load(std::memory_order_acquire) != 0 ||
      capture_deallocations.load(std::memory_order_acquire) != 0) {
    std::cerr << "routing swap realtime memory: submitted="
              << submitted_during_swaps << " allocations="
              << capture_allocations.load() << " deallocations="
              << capture_deallocations.load() << " swaps="
              << routing_swaps.load() << '\n';
    throw std::runtime_error(
      "MicrophoneActor routing swap allocated or reclaimed on capture thread"
    );
  }

  MediaCommand enable_echo;
  enable_echo.type = NativeCommandType::ConfigureMicrophone;
  enable_echo.request_id = "enable-echo-reference";
  enable_echo.device_id = "capture-device";
  enable_echo.revision = 2;
  enable_echo.has_revision = true;
  enable_echo.has_echo_cancellation = true;
  enable_echo.echo_cancellation = true;
  block_echo_start.store(true, std::memory_order_release);
  std::thread echo_control([&] {
    static_cast<void>(policy_microphone.configure(enable_echo));
  });
  while (!echo_start_entered.load(std::memory_order_acquire)) {
    std::this_thread::yield();
  }
  std::atomic_bool capture_returned{false};
  std::atomic_bool capture_accepted{false};
  std::thread capture_during_echo_start([&] {
    inside_capture_submission = true;
    capture_accepted.store(
      retained_submitters.back()(retired_pcm, false),
      std::memory_order_release
    );
    inside_capture_submission = false;
    capture_returned.store(true, std::memory_order_release);
  });
  const auto capture_deadline =
    std::chrono::steady_clock::now() + std::chrono::milliseconds(250);
  while (!capture_returned.load(std::memory_order_acquire) &&
         std::chrono::steady_clock::now() < capture_deadline) {
    std::this_thread::yield();
  }
  if (!capture_returned.load(std::memory_order_acquire)) {
    release_echo_start.store(true, std::memory_order_release);
    echo_control.join();
    capture_during_echo_start.join();
    throw std::runtime_error(
      "microphone capture waited behind echo-reference lifecycle"
    );
  }
  capture_during_echo_start.join();
  release_echo_start.store(true, std::memory_order_release);
  echo_control.join();
  inside_capture_submission = true;
  const bool accepted_with_echo =
    retained_submitters.back()(retired_pcm, false);
  inside_capture_submission = false;
  if (!capture_accepted.load(std::memory_order_acquire) ||
      !accepted_with_echo ||
      echo_polls.load(std::memory_order_acquire) == 0) {
    throw std::runtime_error(
      "microphone capture did not consume the prestarted echo SPSC endpoint"
    );
  }
  MediaCommand disable_echo = enable_echo;
  disable_echo.request_id = "disable-echo-reference";
  disable_echo.revision = 3;
  disable_echo.echo_cancellation = false;
  static_cast<void>(policy_microphone.configure(disable_echo));
  {
    std::lock_guard lock(echo_lifecycle_mutex);
    if (echo_lifecycle_targets !=
        std::vector<std::optional<std::string>>{
          std::optional<std::string>{"default"}, std::nullopt
        }) {
      throw std::runtime_error(
        "echo-reference lifecycle did not remain control-owned and exact"
      );
    }
  }
  if (echo_lifecycle_on_capture.load(std::memory_order_acquire) != 0) {
    throw std::runtime_error(
      "echo-reference lifecycle ran on the capture submission lane"
    );
  }
  for (const auto& event : sink->events()) {
    if (event.type != NativeEventType::MicrophoneMetrics) {
      throw std::runtime_error(
        "echo-reference control test emitted a non-telemetry event"
      );
    }
  }
  sink->clear();
  policy_microphone.shutdown();
  {
    std::lock_guard lock(policy_mutex);
    if (
      microphone_attempts.load(std::memory_order_acquire) != 3 ||
      microphone_policy_phases != std::vector<WindowsAudioAttemptPhase>{
        WindowsAudioAttemptPhase::BeforeInitialize,
        WindowsAudioAttemptPhase::Initialize,
        WindowsAudioAttemptPhase::BeforeInitialize,
        WindowsAudioAttemptPhase::Initialize,
        WindowsAudioAttemptPhase::BeforeInitialize,
        WindowsAudioAttemptPhase::Initialize,
      }
    ) {
      throw std::runtime_error(
        "MicrophoneActor warm/recreate did not reapply ordered policy exactly once per attempt"
      );
    }
  }

  std::mutex idle_post_mutex;
  std::condition_variable idle_post_changed;
  int idle_post_attempts = 0;
  std::optional<MediaCommand> accepted_idle_expiry;
  auto idle_livekit =
    std::make_shared<DeterministicFakeLiveKitVoiceSession>();
  MicrophoneActor idle_retry_microphone(
    emitter,
    [&](MediaCommand command) {
      if (command.type != syrnike::desktop_native::NativeCommandType::MicrophoneIdleExpired) return true;
      std::lock_guard lock(idle_post_mutex);
      ++idle_post_attempts;
      if (idle_post_attempts > 1) accepted_idle_expiry = command;
      idle_post_changed.notify_all();
      return idle_post_attempts > 1;
    },
    microphone_current,
    idle_livekit,
    MicrophoneIdleCaptureTiming{
      .grace = std::chrono::milliseconds(10),
      .post_retry = std::chrono::milliseconds(10),
    }
  );
  idle_retry_microphone.setPreviewConsumer(
    "preview-idle-retry",
    1,
    [](std::span<const std::int16_t>) {}
  );
  idle_retry_microphone.clearPreviewConsumer("preview-idle-retry", 1);
  {
    std::unique_lock lock(idle_post_mutex);
    if (!idle_post_changed.wait_for(
          lock,
          std::chrono::milliseconds(250),
          [&] { return idle_post_attempts >= 2; }
        )) {
      throw std::runtime_error(
        "rejected microphone idle expiry was not retried within its bound"
      );
    }
  }
  if (!accepted_idle_expiry) {
    throw std::runtime_error("microphone idle expiry retry was not accepted");
  }
  idle_retry_microphone.handleWorkerCommand(*accepted_idle_expiry);
  idle_retry_microphone.shutdown();

  GenerationFence screen_intent;
  screen_intent.advance("screen", 1);
  auto screen_current = [&](const std::string& session_id, std::uint64_t generation) {
    return screen_intent.isCurrent(session_id, generation);
  };
  ScreenActor screen(emitter, post, screen_current, actor_livekit);
  MediaCommand invalid_screen;
  invalid_screen.type = syrnike::desktop_native::NativeCommandType::ConnectScreen;
  invalid_screen.session_id = "screen";
  invalid_screen.generation = 1;
  requireThrows(
    [&] { static_cast<void>(screen.connect(invalid_screen)); },
    "screen actor accepted missing LiveKit credentials"
  );
  screen_intent.advance("screen", 2);
  MediaCommand stale_screen_stop;
  stale_screen_stop.type = syrnike::desktop_native::NativeCommandType::StopScreenCapture;
  stale_screen_stop.session_id = "screen";
  stale_screen_stop.generation = 1;
  requireThrows(
    [&] { screen.stopCapture(stale_screen_stop); },
    "stale screen stop reached actor state"
  );
  MediaCommand idle_screen;
  idle_screen.type = syrnike::desktop_native::NativeCommandType::StopScreenCapture;
  idle_screen.session_id = "screen";
  idle_screen.generation = 2;
  screen.stopCapture(idle_screen);
  screen.stopCapture(idle_screen);
  screen.disconnect(invalid_screen);
  screen.handleTerminal(invalid_screen);
  screen.shutdown();
  screen.shutdown();

  PreviewActor preview(emitter);
  MediaCommand no_preview;
  preview.stop(no_preview);
  preview.stop(no_preview);
  preview.shutdown();
  preview.shutdown();

  std::mutex preview_gate_mutex;
  std::condition_variable preview_gate_changed;
  bool preview_gate_entered = false;
  bool preview_gate_release = false;
  auto blocked_preview = std::make_unique<PreviewActor>(
      emitter,
      [&] {
        std::unique_lock lock(preview_gate_mutex);
        preview_gate_entered = true;
        preview_gate_changed.notify_all();
        preview_gate_changed.wait(lock, [&] { return preview_gate_release; });
      });
  MediaCommand start_preview;
  start_preview.type = syrnike::desktop_native::NativeCommandType::StartMicrophonePreview;
  start_preview.request_id = "blocked-preview";
  start_preview.session_id = "preview";
  start_preview.generation = 1;
  static_cast<void>(blocked_preview->start(start_preview));
  {
    std::unique_lock lock(preview_gate_mutex);
    if (!preview_gate_changed.wait_for(
            lock, std::chrono::seconds(1),
            [&] { return preview_gate_entered; })) {
      throw std::runtime_error("preview worker did not enter injected block");
    }
  }
  const auto preview_destroy_started = std::chrono::steady_clock::now();
  blocked_preview.reset();
  if (std::chrono::steady_clock::now() - preview_destroy_started >
      std::chrono::milliseconds(1800)) {
    throw std::runtime_error("preview destructor exceeded shutdown deadline");
  }
  {
    std::lock_guard lock(preview_gate_mutex);
    preview_gate_release = true;
  }
  preview_gate_changed.notify_all();

  if (sink->size() != 0) {
    throw std::runtime_error("idle actor lifecycle emitted phantom events");
  }
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
#include <chrono>
#include <condition_variable>
