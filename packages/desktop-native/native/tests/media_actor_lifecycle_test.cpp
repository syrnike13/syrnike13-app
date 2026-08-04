#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "common/event_sink.hpp"
#include "common/sequenced_emitter.hpp"
#include "media/microphone_actor.hpp"
#include "media/generation_fence.hpp"
#include "media/livekit_disconnect_reason.hpp"
#include "media/preview_actor.hpp"
#include "media/screen_actor.hpp"

namespace {

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
    terminal.type = "screenCaptureEnded";
    terminal.session_id = "screen-transition";
    terminal.generation = 7;
    incident_emitter.emit(std::move(terminal));

    const auto events = incident_sink->events();
    const auto incidents = std::count_if(
      events.begin(),
      events.end(),
      [](const RuntimeEvent& event) {
        return event.type == "screenBackendRestart";
      }
    );
    if (
      events.size() != 2 ||
      events[0].type != "screenBackendRestart" ||
      events[0].video_recoverable_lost_count != 1 ||
      events[1].type != "screenCaptureEnded" ||
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
  invalid_microphone.type = "connectMicrophone";
  invalid_microphone.session_id = "mic";
  invalid_microphone.generation = 1;
  requireThrows(
    [&] { static_cast<void>(microphone.connect(invalid_microphone)); },
    "microphone actor accepted missing LiveKit credentials"
  );

  microphone_intent.advance("mic", 2);
  MediaCommand stale_disconnect;
  stale_disconnect.type = "disconnectMicrophone";
  stale_disconnect.session_id = "mic";
  stale_disconnect.generation = 1;
  requireThrows(
    [&] { microphone.disconnect(stale_disconnect); },
    "stale microphone disconnect reached actor state"
  );

  MediaCommand partial;
  partial.type = "configureMicrophone";
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

  std::mutex idle_post_mutex;
  std::condition_variable idle_post_changed;
  int idle_post_attempts = 0;
  std::optional<MediaCommand> accepted_idle_expiry;
  auto idle_livekit =
    std::make_shared<DeterministicFakeLiveKitVoiceSession>();
  MicrophoneActor idle_retry_microphone(
    emitter,
    [&](MediaCommand command) {
      if (command.type != "__microphoneIdleExpired") return true;
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
  invalid_screen.type = "connectScreen";
  invalid_screen.session_id = "screen";
  invalid_screen.generation = 1;
  requireThrows(
    [&] { static_cast<void>(screen.connect(invalid_screen)); },
    "screen actor accepted missing LiveKit credentials"
  );
  screen_intent.advance("screen", 2);
  MediaCommand stale_screen_stop;
  stale_screen_stop.type = "stopScreenCapture";
  stale_screen_stop.session_id = "screen";
  stale_screen_stop.generation = 1;
  requireThrows(
    [&] { screen.stopCapture(stale_screen_stop); },
    "stale screen stop reached actor state"
  );
  MediaCommand idle_screen;
  idle_screen.type = "stopScreenCapture";
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
  start_preview.type = "startMicrophonePreview";
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
