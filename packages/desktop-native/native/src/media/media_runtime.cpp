#include "media_runtime.hpp"

#include <windows.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <exception>
#include <mutex>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

#include "audio_devices.hpp"
#include "camera_actor.hpp"
#include "camera_capture.hpp"
#include "../common/diagnostic_log.hpp"
#include "microphone_actor.hpp"
#include "display_sources.hpp"
#include "generation_fence.hpp"
#include "media_runtime_support.hpp"
#include "screen_actor.hpp"
#include "screen_video_capture.hpp"
#include "preview_actor.hpp"
#include "voice_actor.hpp"

namespace syrnike::desktop_native::media {
namespace {

using diagnostics::DiagnosticField;

std::uint64_t steadyNowMs() {
  return diagnostics::DiagnosticLog::instance().steadyNowMs();
}

void logRuntime(
  std::string_view event,
  std::initializer_list<DiagnosticField> fields = {}
) {
  auto& logger = diagnostics::DiagnosticLog::instance();
  if (!logger.enabled()) return;
  logger.write(event, fields);
}

}  // namespace

class MediaRuntime::Implementation {
 public:
  Implementation(
    EventSinkPtr sink,
    std::shared_ptr<LiveKitPublicationClient> livekit_client,
    MediaRuntime::SteadyNow screen_now
  ) : emitter_(std::move(sink)),
      livekit_client_(std::move(livekit_client)),
      microphone_(emitter_, [this](MediaCommand command) {
        if (microphone_commands_.tryPush(std::move(command))) return true;
        if (shutting_down_.load()) return false;
        std::terminate();
      },
      [this](const std::string& session_id, std::uint64_t generation) {
        return desired_microphone_.isCurrent(session_id, generation);
      }, livekit_client_),
      screen_(emitter_, [this](MediaCommand command) {
        if (screen_commands_.tryPush(std::move(command))) return true;
        if (shutting_down_.load()) return false;
        std::terminate();
      }, [this](const std::string& session_id, std::uint64_t generation) {
        return desired_screen_.isCurrent(session_id, generation);
      }, livekit_client_, [this](
        const std::string& session_id,
        std::uint64_t generation,
        std::function<void()> commit
      ) {
        return desired_screen_.commitIfCurrent(
          session_id,
          generation,
          std::move(commit)
        );
      }, std::move(screen_now)),
      camera_(emitter_, [this](MediaCommand command) {
        if (camera_commands_.tryPush(std::move(command))) return true;
        if (shutting_down_.load()) return false;
        std::terminate();
      }, [this](const std::string& session_id, std::uint64_t generation) {
        return desired_camera_.isCurrent(session_id, generation);
      }, livekit_client_),
      preview_(emitter_),
      voice_(emitter_, [this](MediaCommand command) {
        if (voice_commands_.tryPush(std::move(command))) return true;
        return shutting_down_.load();
      }, [this](const std::string& session_id, std::uint64_t generation) {
        return desired_voice_.isCurrent(session_id, generation);
      }, livekit_client_),
      worker_([this] { run(); }) {
    logRuntime("media_runtime_constructed");
  }

  void waitUntilReady() {
    logRuntime("media_runtime_wait_until_ready_start");
    std::unique_lock lock(startup_mutex_);
    startup_changed_.wait(lock, [&] { return startup_complete_; });
    if (startup_error_.empty()) return;
    logRuntime("media_runtime_wait_until_ready_error", {{"message", startup_error_}});
    throw std::runtime_error(startup_error_);
  }

  ~Implementation() { shutdownAndWait(); }

  bool dispatch(MediaCommand command) {
    const auto dispatch_started_at = steadyNowMs();
    if (shutting_down_.load()) return false;
    if (command.type == "invalidateMicrophone") {
      logRuntime(
        "media_runtime_invalidate_microphone_received",
        {
          {"sessionId", command.session_id},
          {"generation", command.generation}
        }
      );
      if (desired_microphone_.advance(command.session_id, command.generation)) {
        emitter_.emit(reply(command));
        logRuntime(
          "media_runtime_invalidate_microphone_accepted",
          {
            {"sessionId", command.session_id},
            {"generation", command.generation}
          }
        );
      } else {
        emitter_.emit(failedReply(command, NativeError{
          "stale_generation",
          "Microphone generation is older than the current intent",
          command.type,
          false,
          command.session_id,
          command.generation,
        }));
        logRuntime(
          "media_runtime_invalidate_microphone_rejected",
          {
            {"sessionId", command.session_id},
            {"generation", command.generation}
          }
        );
      }
      return true;
    }
    auto pending = pending_commands_.load(std::memory_order_relaxed);
    while (true) {
      if (pending >= 256) return false;
      if (pending_commands_.compare_exchange_weak(pending, pending + 1)) break;
    }
    const auto type = command.type;
    const auto command_request_id = command.request_id;
    const auto command_session_id = command.session_id;
    const auto command_generation = command.generation;
    const auto command_warm_key = type == "warmMicrophone" ? warmKey(command) : std::string{};
    std::pair<std::string, std::uint64_t> previous_desired_microphone;
    std::pair<std::string, std::uint64_t> previous_warm_microphone;
    std::pair<std::string, std::uint64_t> previous_desired_screen;
    std::pair<std::string, std::uint64_t> previous_desired_camera;
    std::pair<std::string, std::uint64_t> previous_desired_voice;
    bool generation_accepted = true;
    if (type == "connectVoice" || type == "disconnectVoice") {
      previous_desired_voice = desired_voice_.current();
      generation_accepted = desired_voice_.advance(
        command.session_id,
        command.generation
      );
    }
    if (
      type == "connectMicrophone" ||
      type == "disconnectMicrophone"
    ) {
      previous_desired_microphone = desired_microphone_.current();
      generation_accepted = desired_microphone_.advance(
        command.session_id,
        command.generation
      );
    }
    if (type == "warmMicrophone") {
      previous_warm_microphone = desired_microphone_warm_.current();
      generation_accepted = desired_microphone_warm_.advance(
        warmKey(command),
        command.generation
      );
    }
    if (
      type == "connectScreen" || type == "startScreenCapture" ||
      type == "stopScreenCapture" || type == "disconnectScreen"
    ) {
      previous_desired_screen = desired_screen_.current();
      generation_accepted = desired_screen_.advance(
        command.session_id,
        command.generation
      );
    }
    if (type == "connectCamera" || type == "disconnectCamera") {
      previous_desired_camera = desired_camera_.current();
      generation_accepted = desired_camera_.advance(command.session_id, command.generation);
    }
    if (!generation_accepted) {
      pending_commands_.fetch_sub(1, std::memory_order_relaxed);
      emitter_.emit(failedReply(command, NativeError{
        "stale_generation",
        "Native command generation is older than the current intent",
        command.type,
        false,
        command.session_id,
        command.generation,
      }));
      logRuntime(
        "media_runtime_dispatch_stale_generation",
        {
          {"command", type},
          {"requestId", command_request_id},
          {"sessionId", command_session_id},
          {"generation", command_generation}
        }
      );
      return true;
    }
    bool accepted = false;
    const std::uint64_t enqueue_started_at = steadyNowMs();
    std::uint64_t queue_depth = 0;
    if (type == "shutdown") {
      accepted = control_commands_.tryPush(std::move(command));
      if (accepted) queue_depth = control_commands_.size();
    }
    else if (
      type == "connectVoice" || type == "disconnectVoice" ||
      type == "configureRemoteAudio" ||
      type == "configureVoiceOutput" ||
      type == "__voiceConnectCompleted" ||
      type == "__voiceOutputFailed" ||
      type == "__voiceActiveSpeakers" ||
      type == "__remoteVideoFrame" ||
      type == "__remoteVideoTrackRemoved" ||
      type == "__remoteVideoFailed" ||
      type == "__remoteVideoRetryRequested" ||
      type == "__remoteScreenPublicationAvailable" ||
      type == "__remoteScreenPublicationUnavailable" ||
      type == "releaseRemoteVideoFrame" ||
      type == "setRemoteVideoDemand" ||
      type == "__voiceTerminal"
    ) {
      command.internal_enqueued_steady_ms = enqueue_started_at;
      command.internal_queue_depth = static_cast<std::uint32_t>(voice_commands_.size() + 1);
      accepted = voice_commands_.tryPush(std::move(command));
      if (accepted) queue_depth = voice_commands_.size();
    }
    else if (
      type == "__microphoneTerminal" ||
      type == "__microphoneAttemptReady" ||
      type == "__microphoneAttemptFailed" ||
      type == "__microphoneRetireDone" ||
      type == "warmMicrophone" || type == "connectMicrophone" ||
      type == "configureMicrophone" || type == "setMicrophoneMuted" ||
      type == "disconnectMicrophone" || type == "startPreview" ||
      type == "probeMicrophoneActor" ||
      type == "stopPreview"
    ) {
      command.internal_enqueued_steady_ms = enqueue_started_at;
      command.internal_queue_depth = static_cast<std::uint32_t>(microphone_commands_.size() + 1);
      accepted = microphone_commands_.tryPush(std::move(command));
      if (accepted) queue_depth = microphone_commands_.size();
    }
    else if (
      type == "__screenTerminal" ||
      type == "__screenAttemptReady" ||
      type == "__screenAttemptFailed" ||
      type == "__screenRetireDone" ||
      type == "__screenRtpStalled" ||
      type == "connectScreen" || type == "startScreenCapture" ||
      type == "stopScreenCapture" || type == "disconnectScreen" ||
      type == "setLocalScreenPreviewDemand" ||
      type == "releaseLocalScreenPreviewFrame" ||
      type == "__localScreenPreviewFrame" ||
      type == "__localScreenPreviewFailed" ||
      type == "__localScreenPreviewTrackRemoved" ||
      type == "probeScreenActor"
    ) {
      command.internal_enqueued_steady_ms = enqueue_started_at;
      command.internal_queue_depth = static_cast<std::uint32_t>(screen_commands_.size() + 1);
      accepted = screen_commands_.tryPush(std::move(command));
      if (accepted) queue_depth = screen_commands_.size();
    } else if (
      type == "__cameraTerminal" || type == "connectCamera" ||
      type == "disconnectCamera"
    ) {
      command.internal_enqueued_steady_ms = enqueue_started_at;
      command.internal_queue_depth = static_cast<std::uint32_t>(camera_commands_.size() + 1);
      accepted = camera_commands_.tryPush(std::move(command));
      if (accepted) queue_depth = camera_commands_.size();
    } else {
      command.internal_enqueued_steady_ms = enqueue_started_at;
      command.internal_queue_depth = static_cast<std::uint32_t>(query_commands_.size() + 1);
      accepted = query_commands_.tryPush(std::move(command));
      if (accepted) queue_depth = query_commands_.size();
    }
    logRuntime(
      accepted ? "media_runtime_dispatch_accepted" : "media_runtime_dispatch_rejected",
      {
        {"command", type},
        {"requestId", command_request_id},
        {"sessionId", command_session_id},
        {"generation", command_generation},
        {"dispatchSteadyMs", dispatch_started_at},
        {"queueDepth", queue_depth}
      }
    );
    if (!accepted) {
      pending_commands_.fetch_sub(1, std::memory_order_relaxed);
      if (type == "connectVoice" || type == "disconnectVoice") {
        desired_voice_.restoreIfCurrent(
          command_session_id,
          command_generation,
          previous_desired_voice.first,
          previous_desired_voice.second
        );
      }
      if (
        type == "connectMicrophone" ||
        type == "disconnectMicrophone"
      ) {
        desired_microphone_.restoreIfCurrent(
          command_session_id,
          command_generation,
          previous_desired_microphone.first,
          previous_desired_microphone.second
        );
      }
      if (type == "warmMicrophone") {
        desired_microphone_warm_.restoreIfCurrent(
          command_warm_key,
          command_generation,
          previous_warm_microphone.first,
          previous_warm_microphone.second
        );
      }
      if (
        type == "connectScreen" || type == "startScreenCapture" ||
        type == "stopScreenCapture" || type == "disconnectScreen"
      ) {
        desired_screen_.restoreIfCurrent(
          command_session_id,
          command_generation,
          previous_desired_screen.first,
          previous_desired_screen.second
        );
      }
      if (type == "connectCamera" || type == "disconnectCamera") {
        desired_camera_.restoreIfCurrent(
          command_session_id, command_generation,
          previous_desired_camera.first, previous_desired_camera.second
        );
      }
    }
    return accepted;
  }

  void requestShutdown() {
    logRuntime("media_runtime_request_shutdown");
    shutting_down_.store(true);
    desired_microphone_.advance("__shutdown__", UINT64_MAX);
    desired_microphone_warm_.advance("__shutdown__", UINT64_MAX);
    desired_screen_.advance("__shutdown__", UINT64_MAX);
    desired_camera_.advance("__shutdown__", UINT64_MAX);
    desired_voice_.advance("__shutdown__", UINT64_MAX);
    control_commands_.close();
  }

  void shutdownAndWait() {
    std::lock_guard lock(shutdown_mutex_);
    requestShutdown();
    if (worker_.joinable() && worker_.get_id() != std::this_thread::get_id()) worker_.join();
    logRuntime("media_runtime_shutdown_joined");
  }

 private:
  void runtimeError(const MediaCommand& command, NativeError error) {
    error.session_id = command.session_id;
    if (!command.session_id.empty()) error.generation = command.generation;
    RuntimeEvent event;
    event.type = "runtimeError";
    event.request_id = command.request_id;
    event.session_id = command.session_id;
    event.generation = command.generation;
    event.error = std::move(error);
    emitter_.emit(std::move(event));
  }

  void handleMicrophone(const MediaCommand& command) {
    if (command.type == "__microphoneTerminal") {
      if (
        !preview_session_id_.empty() &&
        microphone_.isCurrentCaptureFailure(command)
      ) {
        microphone_.clearPreviewConsumer(preview_session_id_, preview_generation_);
        preview_.failFromCapture(
          preview_session_id_,
          preview_generation_,
          command.internal_message
        );
        preview_session_id_.clear();
        preview_generation_ = 0;
      }
      microphone_.handleTerminal(command);
      return;
    }
    if (
      command.type == "__microphoneAttemptReady" ||
      command.type == "__microphoneAttemptFailed" ||
      command.type == "__microphoneRetireDone"
    ) {
      microphone_.handleWorkerCommand(command);
      return;
    }
    if (command.type == "warmMicrophone") {
      if (!desired_microphone_warm_.isCurrent(warmKey(command), command.generation)) {
        throw std::runtime_error("stale microphone warm generation");
      }
      microphone_.warm(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == "probeMicrophoneActor") {
      emitter_.emit(microphone_.probe(command));
      return;
    }
    if (command.type == "connectMicrophone") {
      microphone_.connect(command);
      return;
    }
    if (command.type == "configureMicrophone") {
      emitter_.emit(microphone_.configure(command));
      return;
    }
    if (command.type == "setMicrophoneMuted") {
      microphone_.setMuted(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == "disconnectMicrophone") {
      microphone_.disconnect(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == "startPreview") {
      if (!preview_session_id_.empty()) {
        microphone_.clearPreviewConsumer(preview_session_id_, preview_generation_);
        MediaCommand previous_preview;
        previous_preview.session_id = preview_session_id_;
        previous_preview.generation = preview_generation_;
        preview_.stop(previous_preview, false);
        preview_session_id_.clear();
        preview_generation_ = 0;
      }
      microphone_.warm(command);
      RuntimeEvent result;
      result = preview_.start(command);
      preview_session_id_ = command.session_id;
      preview_generation_ = command.generation;
      microphone_.setPreviewConsumer(command.session_id, command.generation, [this](auto pcm) {
        preview_.pushFrame(pcm);
      });
      emitter_.emit(result);
      RuntimeEvent started = result;
      started.type = "microphonePreviewStarted";
      emitter_.emit(std::move(started));
      return;
    }
    if (command.type == "stopPreview") {
      if (
        !preview_session_id_.empty() &&
        (command.session_id.empty() ||
          (command.session_id == preview_session_id_ &&
           command.generation == preview_generation_))
      ) {
        microphone_.clearPreviewConsumer(preview_session_id_, preview_generation_);
        MediaCommand active = command;
        active.session_id = preview_session_id_;
        active.generation = preview_generation_;
        preview_.stop(active);
        preview_session_id_.clear();
        preview_generation_ = 0;
      }
      emitter_.emit(reply(command));
      return;
    }
    unknown(command);
  }

  void handleVoice(const MediaCommand& command) {
    if (command.type == "__voiceConnectCompleted") {
      voice_.handleWorkerCommand(command);
      return;
    }
    if (command.type == "__remoteScreenPublicationAvailable" ||
        command.type == "__remoteScreenPublicationUnavailable") {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) return;
      RuntimeEvent event;
      event.type = command.type == "__remoteScreenPublicationAvailable"
        ? "remoteScreenPublicationAvailable"
        : "remoteScreenPublicationUnavailable";
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.track_id = command.track_id;
      event.participant_identity = command.participant_identity;
      event.video_source = "screen";
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == "__voiceOutputFailed") {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) return;
      RuntimeEvent event;
      event.type = "sessionLifecycle";
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.kind = "output";
      if (!command.device_id.empty() && command.device_id != "default") {
        livekit_client_->setVoiceOutputDevice("default");
        event.status = "running";
        event.device_id = "default";
        event.detail = "Selected audio output is unavailable; using system default";
      } else {
        event.status = "error";
        event.detail = command.internal_message.empty()
          ? "Remote audio renderer failed"
          : command.internal_message;
      }
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == "__remoteVideoFrame") {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) {
        livekit_client_->releaseRemoteVideoFrame(command.track_id, command.frame_sequence);
        return;
      }
      RuntimeEvent event;
      event.type = "remoteVideoFrame";
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.track_id = command.track_id;
      event.participant_identity = command.participant_identity;
      event.video_source = command.video_source;
      event.frame_sequence = command.frame_sequence;
      event.timestamp_us = command.timestamp_us;
      event.nt_handle = command.nt_handle;
      event.width = command.width;
      event.height = command.height;
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == "__remoteVideoTrackRemoved" || command.type == "__remoteVideoFailed") {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) return;
      RuntimeEvent event;
      event.type = command.type == "__remoteVideoFailed"
        ? "remoteVideoFailed" : "remoteVideoTrackRemoved";
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.track_id = command.track_id;
      event.video_source = command.video_source;
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == "__remoteVideoRetryRequested") {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) return;
      livekit_client_->retryRemoteVideo(command.track_id, command.internal_message);
      return;
    }
    if (command.type == "releaseRemoteVideoFrame") {
      livekit_client_->releaseRemoteVideoFrame(command.track_id, command.frame_sequence);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == "setRemoteVideoDemand") {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) {
        throw std::runtime_error("stale remote video demand generation");
      }
      livekit_client_->setRemoteVideoDemand(command.track_id, command.demanded);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == "__voiceTerminal") {
      RuntimeEvent event;
      event.type = "voiceTerminal";
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.kind = "voice";
      event.status = "error";
      event.error = NativeError{
        "rtc_terminal",
        command.internal_message.empty()
          ? "LiveKit voice connection terminated"
          : command.internal_message,
        "connectVoice",
        true,
        command.session_id,
        command.generation,
      };
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == "__voiceActiveSpeakers") {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) return;
      RuntimeEvent event;
      event.type = "activeSpeakers";
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.kind = "voice";
      event.participant_identities = command.participant_identities;
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == "connectVoice") {
      voice_.connect(command);
      return;
    }
    if (command.type == "disconnectVoice") {
      voice_.disconnect(command);
      return;
    }
    if (command.type == "configureVoiceOutput") {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) {
        throw std::runtime_error("stale voice output generation");
      }
      if (!command.has_deafened) {
        throw std::invalid_argument("deafened is required");
      }
      livekit_client_->setVoiceDeafened(command.deafened);
      livekit_client_->setVoiceOutputDevice(command.device_id);
      if (command.has_output_volume) {
        livekit_client_->setVoiceOutputVolume(command.output_volume);
      }
      emitter_.emit(reply(command));
      emitter_.emit(lifecycle(
        command,
        "output",
        "running",
        command.deafened ? "deafened" : "audible"
      ));
      return;
    }
    if (command.type == "configureRemoteAudio") {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) {
        throw std::runtime_error("stale remote audio generation");
      }
      if (!command.has_revision) throw std::invalid_argument("revision is required");
      livekit_client_->configureRemoteAudio(RemoteAudioSettings{
        command.revision,
        command.user_volumes,
        command.user_mutes,
        command.stream_volumes,
        command.stream_mutes,
      });
      emitter_.emit(reply(command));
      return;
    }
    unknown(command);
  }

  void handleScreen(const MediaCommand& command) {
    if (command.type == "__localScreenPreviewFailed") {
      const auto message = command.internal_message +
        " (HRESULT " + std::to_string(command.diagnostic_hresult) + ")";
      logRuntime(
        "local_screen_preview_failed",
        {
          {"sessionId", command.session_id},
          {"generation", command.generation},
          {"reason", command.video_source},
          {"hresult", command.diagnostic_hresult},
          {"message", diagnostics::redactForDiagnostics(command.internal_message)},
          {"suppressed", command.diagnostic_suppressed}
        }
      );
      RuntimeEvent event;
      event.type = "localScreenPreviewFailed";
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.track_id = command.track_id;
      event.error = NativeError{
        "LOCAL_SCREEN_PREVIEW_FAILED",
        message,
        command.video_source,
        true,
        command.session_id,
        command.generation
      };
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == "__localScreenPreviewFrame") {
      if (!desired_screen_.isCurrent(command.session_id, command.generation)) {
        MediaCommand release = command;
        release.type = "releaseLocalScreenPreviewFrame";
        screen_.handleWorkerCommand(release);
        return;
      }
      RuntimeEvent event;
      event.type = "localScreenPreviewFrame";
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.track_id = command.track_id;
      event.participant_identity = command.participant_identity;
      event.video_source = "screen";
      event.frame_sequence = command.frame_sequence;
      event.timestamp_us = command.timestamp_us;
      event.nt_handle = command.nt_handle;
      event.width = command.width;
      event.height = command.height;
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == "__localScreenPreviewTrackRemoved") {
      RuntimeEvent event;
      event.type = "localScreenPreviewTrackRemoved";
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.track_id = command.track_id;
      event.video_source = "screen";
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == "releaseLocalScreenPreviewFrame") {
      screen_.handleWorkerCommand(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == "setLocalScreenPreviewDemand") {
      if (!desired_screen_.isCurrent(command.session_id, command.generation)) {
        throw std::runtime_error("stale screen preview generation");
      }
      screen_.handleWorkerCommand(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == "__screenTerminal") {
      screen_.handleTerminal(command);
      return;
    }
    if (
      command.type == "__screenAttemptReady" ||
      command.type == "__screenAttemptFailed" ||
      command.type == "__screenRetireDone" ||
      command.type == "__screenRtpStalled"
    ) {
      screen_.handleWorkerCommand(command);
      return;
    }
    if (command.type == "connectScreen") {
      emitter_.emit(lifecycle(command, "screen", "starting", "livekit_connecting"));
      screen_.connect(command);
      return;
    }
    if (command.type == "probeScreenActor") {
      emitter_.emit(screen_.probe(command));
      return;
    }
    if (command.type == "startScreenCapture") {
      emitter_.emit(lifecycle(command, "screen", "starting", "capture_starting"));
      screen_.startCapture(command);
      return;
    }
    if (command.type == "stopScreenCapture") {
      screen_.stopCapture(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == "disconnectScreen") {
      screen_.disconnect(command);
      emitter_.emit(reply(command));
      return;
    }
    unknown(command);
  }

  void handleCamera(const MediaCommand& command) {
    if (command.type == "__cameraTerminal") {
      camera_.handleTerminal(command);
      return;
    }
    if (command.type == "connectCamera") {
      emitter_.emit(lifecycle(command, "camera", "starting", "capture_starting"));
      camera_.connect(command);
      return;
    }
    if (command.type == "disconnectCamera") {
      camera_.disconnect(command);
      emitter_.emit(reply(command));
      return;
    }
    unknown(command);
  }

  void handleQuery(const MediaCommand& command) {
    if (command.type == "listDevices") {
      auto result = reply(command);
      result.kind = "devices";
      result.devices = listAudioDevices();
      auto cameras = listCameraDevices();
      result.devices.insert(
        result.devices.end(),
        std::make_move_iterator(cameras.begin()),
        std::make_move_iterator(cameras.end())
      );
      if (!command.device_kind.empty()) {
        std::erase_if(result.devices, [&](const DeviceInfo& device) {
          return device.kind != command.device_kind;
        });
      }
      emitter_.emit(std::move(result));
      return;
    }
    if (command.type == "listDisplaySources") {
      auto result = reply(command);
      result.kind = "sources";
      result.sources = listDisplaySources(command.self_window_handle);
      emitter_.emit(std::move(result));
      return;
    }
    if (command.type == "probeQueryWorker") {
      emitter_.emit(reply(command));
      return;
    }
    unknown(command);
  }

  void unknown(const MediaCommand& command) {
    const auto kind = command.type.find("Screen") != std::string::npos ? "screen" : "microphone";
    if (!command.session_id.empty()) {
      emitter_.emit(lifecycle(command, kind, "error", "unknown_command"));
    }
    NativeError error{
      "unknown_command",
      "Unknown media runtime command: " + command.type,
      command.type,
      false,
    };
    emitter_.emit(failedReply(command, error));
    runtimeError(command, std::move(error));
  }

  template <typename Handler>
  void commandLoop(const char* queue_name, BoundedQueue<MediaCommand, 256>& queue, Handler handler) {
    while (const auto command = queue.waitPop()) {
      const auto command_started_at = steadyNowMs();
      if (diagnostics::DiagnosticLog::instance().enabled()) {
        const auto wait_ms = command->internal_enqueued_steady_ms == 0
          ? std::uint64_t{0}
          : command_started_at - command->internal_enqueued_steady_ms;
        logRuntime(
          "media_runtime_command_start",
          {
            {"queue", queue_name},
            {"command", command->type},
            {"requestId", command->request_id},
            {"sessionId", command->session_id},
            {"generation", command->generation},
            {"enqueuedQueueDepth", static_cast<std::uint64_t>(command->internal_queue_depth)},
            {"queueWaitMs", wait_ms}
          }
        );
      }
      try {
        handler(*command);
        logRuntime(
          "media_runtime_command_ok",
          {
            {"queue", queue_name},
            {"command", command->type},
            {"requestId", command->request_id},
            {"sessionId", command->session_id},
            {"generation", command->generation},
            {"durationMs", steadyNowMs() - command_started_at}
          }
        );
      } catch (const std::exception& error) {
        const std::string message = error.what();
        const bool stale_generation = message.starts_with("stale ");
        const bool actor_unresponsive =
          dynamic_cast<const ScreenActorUnresponsiveError*>(&error) != nullptr;
        const bool actor_busy =
          dynamic_cast<const ScreenActorBusyError*>(&error) != nullptr;
        NativeError native_error{
          stale_generation
            ? "stale_generation"
            : (actor_unresponsive
                ? "actor_unresponsive"
                : (actor_busy ? "actor_busy" : "native_command_failed")),
          message,
          command->type,
          !stale_generation,
        };
        native_error.session_id = command->session_id;
        if (!command->session_id.empty()) native_error.generation = command->generation;
        emitter_.emit(failedReply(*command, native_error));
        runtimeError(*command, std::move(native_error));
        logRuntime(
          "media_runtime_command_error",
          {
            {"queue", queue_name},
            {"command", command->type},
            {"requestId", command->request_id},
            {"sessionId", command->session_id},
            {"generation", command->generation},
            {"durationMs", steadyNowMs() - command_started_at},
            {"message", message},
            {"stale", stale_generation}
          }
        );
      }
      if (!command->request_id.empty()) {
        pending_commands_.fetch_sub(1, std::memory_order_relaxed);
      }
    }
  }

  void markStartupReady() {
    {
      std::lock_guard lock(startup_mutex_);
      startup_complete_ = true;
      startup_error_.clear();
    }
    startup_changed_.notify_all();
    logRuntime("media_runtime_startup_ready");
  }

  void markStartupFailed(const std::string& message) {
    {
      std::lock_guard lock(startup_mutex_);
      if (startup_complete_) return;
      startup_complete_ = true;
      startup_error_ = message;
    }
    startup_changed_.notify_all();
    logRuntime("media_runtime_startup_failed", {{"message", message}});
  }

  void closeWorkerQueues() {
    desired_voice_.advance("__shutdown__", UINT64_MAX);
    desired_microphone_.advance("__shutdown__", UINT64_MAX);
    desired_microphone_warm_.advance("__shutdown__", UINT64_MAX);
    desired_screen_.advance("__shutdown__", UINT64_MAX);
    desired_camera_.advance("__shutdown__", UINT64_MAX);
    voice_commands_.closeAndDiscard();
    microphone_commands_.closeAndDiscard();
    screen_commands_.closeAndDiscard();
    camera_commands_.closeAndDiscard();
    query_commands_.closeAndDiscard();
  }

  static void joinIfRunning(std::thread& worker) {
    if (worker.joinable()) worker.join();
  }

  void run() {
    logRuntime("media_runtime_worker_start");
    const auto com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_initialized = SUCCEEDED(com_result);
    std::optional<LiveKitLease> livekit;
    std::thread microphone_worker;
    std::thread screen_worker;
    std::thread camera_worker;
    std::thread query_worker;
    std::thread voice_worker;
    bool startup_ready = false;
    try {
      livekit.emplace();
      voice_worker = std::thread([this] {
        commandLoop("voice", voice_commands_, [this](const auto& command) {
          handleVoice(command);
        });
      });
      microphone_worker = std::thread([this] {
        commandLoop("microphone", microphone_commands_, [this](const auto& command) {
          handleMicrophone(command);
        });
      });
      screen_worker = std::thread([this] {
        commandLoop("screen", screen_commands_, [this](const auto& command) {
          handleScreen(command);
        });
      });
      camera_worker = std::thread([this] {
        commandLoop("camera", camera_commands_, [this](const auto& command) {
          handleCamera(command);
        });
      });
      query_worker = std::thread([this] {
        const auto result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        commandLoop("query", query_commands_, [this](const auto& command) { handleQuery(command); });
        if (SUCCEEDED(result)) CoUninitialize();
      });
      markStartupReady();
      startup_ready = true;

      auto shutdown_command = control_commands_.waitPop();
      if (shutdown_command && !shutdown_command->request_id.empty()) {
        pending_commands_.fetch_sub(1, std::memory_order_relaxed);
      }
      shutting_down_.store(true);
      closeWorkerQueues();
      joinIfRunning(voice_worker);
      joinIfRunning(microphone_worker);
      joinIfRunning(screen_worker);
      joinIfRunning(camera_worker);
      joinIfRunning(query_worker);
      if (!preview_session_id_.empty()) {
        microphone_.clearPreviewConsumer(preview_session_id_, preview_generation_);
      }
      preview_.shutdown();
      microphone_.shutdown();
      screen_.shutdown();
      camera_.shutdown();
      voice_.shutdown();
      if (shutdown_command && shutdown_command->type == "shutdown") {
        emitter_.emit(reply(*shutdown_command));
      }
      logRuntime("media_runtime_worker_exit_clean");
    } catch (const std::exception& error) {
      shutting_down_.store(true);
      closeWorkerQueues();
      joinIfRunning(voice_worker);
      joinIfRunning(microphone_worker);
      joinIfRunning(screen_worker);
      joinIfRunning(camera_worker);
      joinIfRunning(query_worker);
      if (!preview_session_id_.empty()) {
        microphone_.clearPreviewConsumer(preview_session_id_, preview_generation_);
      }
      try { preview_.shutdown(); } catch (...) {}
      try { microphone_.shutdown(); } catch (...) {}
      try { screen_.shutdown(); } catch (...) {}
      try { camera_.shutdown(); } catch (...) {}
      try { voice_.shutdown(); } catch (...) {}
      livekit.reset();
      if (!startup_ready) {
        markStartupFailed(error.what());
        if (com_initialized) CoUninitialize();
        return;
      }
      RuntimeEvent event;
      event.type = "runtimeError";
      event.error = NativeError{"livekit_initialize_failed", error.what(), "initialize", false};
      emitter_.emit(std::move(event));
      logRuntime("media_runtime_worker_exit_fatal", {{"message", error.what()}});
      std::terminate();
    }
    livekit.reset();
    if (com_initialized) CoUninitialize();
    logRuntime("media_runtime_worker_exit");
  }

  SequencedEmitter emitter_;
  std::shared_ptr<LiveKitPublicationClient> livekit_client_ = createRealLiveKitPublicationClient();
  GenerationFence desired_voice_;
  GenerationFence desired_microphone_;
  GenerationFence desired_microphone_warm_;
  MicrophoneActor microphone_;
  GenerationFence desired_screen_;
  ScreenActor screen_;
  GenerationFence desired_camera_;
  CameraActor camera_;
  PreviewActor preview_;
  VoiceActor voice_;
  BoundedQueue<MediaCommand, 256> voice_commands_;
  BoundedQueue<MediaCommand, 256> microphone_commands_;
  BoundedQueue<MediaCommand, 256> screen_commands_;
  BoundedQueue<MediaCommand, 256> camera_commands_;
  BoundedQueue<MediaCommand, 256> query_commands_;
  BoundedQueue<MediaCommand, 4> control_commands_;
  std::atomic_bool shutting_down_{false};
  std::atomic_uint32_t pending_commands_{0};
  std::string preview_session_id_;
  std::uint64_t preview_generation_ = 0;
  std::mutex shutdown_mutex_;
  std::mutex startup_mutex_;
  std::condition_variable startup_changed_;
  bool startup_complete_ = false;
  std::string startup_error_;
  std::thread worker_;
};

MediaRuntime::MediaRuntime(
  EventSinkPtr sink,
  std::shared_ptr<LiveKitPublicationClient> livekit_client,
  SteadyNow screen_now
) : implementation_(std::make_unique<Implementation>(
      std::move(sink),
      std::move(livekit_client),
      std::move(screen_now)
    )) {}

MediaRuntime::~MediaRuntime() = default;

void MediaRuntime::waitUntilReady() {
  implementation_->waitUntilReady();
}

bool MediaRuntime::dispatch(MediaCommand command) {
  return implementation_->dispatch(std::move(command));
}

void MediaRuntime::requestShutdown() {
  implementation_->requestShutdown();
}

void MediaRuntime::shutdownAndWait() {
  implementation_->shutdownAndWait();
}

}  // namespace syrnike::desktop_native::media
