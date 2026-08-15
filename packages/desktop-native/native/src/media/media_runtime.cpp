#include "media_runtime.hpp"

#include <windows.h>

#include <atomic>
#include <cassert>
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
#include "audio_failure.hpp"
#include "accepted_control_post.hpp"
#include "actor_mailbox.hpp"
#include "camera_actor.hpp"
#include "camera_capture.hpp"
#include "../common/diagnostic_log.hpp"
#include "../common/native_message_bindings.hpp"
#include "microphone_actor.hpp"
#include "display_sources.hpp"
#include "generation_fence.hpp"
#include "media_runtime_support.hpp"
#include "screen_actor.hpp"
#include "media_runtime_shutdown_order.hpp"
#include "screen_video_capture.hpp"
#include "preview_actor.hpp"
#include "renderer_texture_lease_registry.hpp"
#include "voice_actor.hpp"
#include "voice_control_lane.hpp"

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

std::shared_ptr<LiveKitVoiceSession> bindVoiceSessionRuntimeLifetime(
  std::shared_ptr<LiveKitVoiceSession> voice_session,
  const std::shared_ptr<LiveKitRuntimeLifetime>& lifetime
) {
  if (!voice_session) voice_session = createRealLiveKitVoiceSession(lifetime);
  voice_session->retainRuntimeLifetime(lifetime);
  return voice_session;
}

bool requiresAcceptedControlPost(const MediaCommand& command) noexcept {
  return isValidNativeCommandType(command.type) &&
    nativeCommandPolicy(command.type).delivery ==
      NativeDeliveryGuarantee::AcceptedExactOnce;
}

std::string acceptedControlKey(const MediaCommand& command) {
  const auto wire_name = nativeCommandName(command.type);
  std::string key;
  key.reserve(
    wire_name.size() + command.session_id.size() +
    command.track_id.size() + 64
  );
  key.append(wire_name);
  key.push_back('\n');
  key.append(command.session_id);
  key.push_back('\n');
  key.append(std::to_string(command.generation));
  key.push_back('\n');
  key.append(std::to_string(command.internal_epoch));
  key.push_back('\n');
  key.append(command.track_id);
  return key;
}

class VoiceControlCompletionGuard final {
 public:
  VoiceControlCompletionGuard(
    VoiceControlLane& lane,
    const MediaCommand& command
  ) noexcept : lane_(lane), command_(command) {}

  ~VoiceControlCompletionGuard() { lane_.complete(command_); }

  VoiceControlCompletionGuard(const VoiceControlCompletionGuard&) = delete;
  VoiceControlCompletionGuard& operator=(
    const VoiceControlCompletionGuard&
  ) = delete;

 private:
  VoiceControlLane& lane_;
  const MediaCommand& command_;
};

}  // namespace

class MediaRuntime::Implementation
  : public std::enable_shared_from_this<MediaRuntime::Implementation> {
  struct SubsystemShutdownState {
    std::chrono::steady_clock::time_point deadline;
    std::thread voice_worker;
    std::thread voice_control_worker;
    std::thread microphone_worker;
    std::thread microphone_operation_worker;
    std::thread screen_worker;
    std::thread camera_worker;
    std::thread query_worker;
  };

 public:
  Implementation(
    EventSinkPtr sink,
    std::shared_ptr<LiveKitVoiceSession> voice_session,
    MediaRuntime::SteadyNow screen_now,
    MediaRuntime::BeforeMicrophoneOperation before_microphone_operation,
    MediaRuntime::BeforeVoiceShutdown before_voice_shutdown,
    std::shared_ptr<LiveKitRuntimeLifetime> livekit_lifetime,
    CleanupStartProbe subsystem_cleanup_start_probe,
    MediaRuntime::AfterSubsystemCleanup after_subsystem_cleanup,
    MicrophoneCaptureAdapter microphone_capture_adapter,
    MicrophoneIdleCaptureTiming microphone_idle_timing,
    ScreenFrameHandoffObserver screen_frame_handoff_observer,
    AfterScreenVideoPublished after_screen_video_published,
    ScreenVideoPublicationObserver screen_video_publication_observer
  ) : emitter_(std::move(sink)),
      cleanup_supervisor_(&CleanupSupervisor::instance()),
      subsystem_cleanup_job_(std::make_shared<CleanupJob>(
        std::move(subsystem_cleanup_start_probe)
      )),
      livekit_lifetime_(
        livekit_lifetime
          ? std::move(livekit_lifetime)
          : std::make_shared<LiveKitRuntimeLifetime>()
      ),
      voice_session_(bindVoiceSessionRuntimeLifetime(
        std::move(voice_session),
        livekit_lifetime_
      )),
      before_microphone_operation_(std::move(before_microphone_operation)),
      before_voice_shutdown_(std::move(before_voice_shutdown)),
      after_subsystem_cleanup_(std::move(after_subsystem_cleanup)),
      accepted_control_post_(
        [this](MediaCommand command) {
          return postAcceptedControl(std::move(command));
        },
        [this](const std::string&) {
          handleAcceptedControlLoss();
        }
      ),
      microphone_(emitter_, [this](MediaCommand command) {
        return postInternal(microphone_commands_, std::move(command));
      },
      [this](const std::string& session_id, std::uint64_t generation) {
        return desired_microphone_.isCurrent(session_id, generation);
      }, voice_session_, std::move(microphone_idle_timing), nullptr,
      std::move(microphone_capture_adapter)),
      screen_(emitter_, [this](MediaCommand command) {
        return postInternal(screen_commands_, std::move(command));
      }, [this](const std::string& session_id, std::uint64_t generation) {
        return desired_screen_.isCurrent(session_id, generation);
      }, voice_session_, [this](
        const std::string& session_id,
        std::uint64_t generation,
        std::function<void()> commit
      ) {
        return desired_screen_.commitIfCurrent(
          session_id,
          generation,
          std::move(commit)
        );
      }, std::move(screen_now), {}, {}, {},
      std::move(screen_frame_handoff_observer),
      std::move(after_screen_video_published),
      std::move(screen_video_publication_observer)),
      camera_(emitter_, [this](MediaCommand command) {
        return postInternal(camera_commands_, std::move(command));
      }, [this](const std::string& session_id, std::uint64_t generation) {
        return desired_camera_.isCurrent(session_id, generation);
      }, voice_session_),
      preview_(emitter_),
      voice_(emitter_, [this](MediaCommand command) {
        if (
          command.type == NativeCommandType::LocalCameraPreviewFrame ||
          command.type == NativeCommandType::LocalCameraPreviewFailed ||
          command.type == NativeCommandType::LocalCameraPreviewTrackRemoved
        ) {
          return postInternal(camera_commands_, std::move(command));
        }
        if (
          isValidNativeCommandType(command.type) &&
          nativeCommandPolicy(command.type).lane ==
            NativeMessageLane::VoiceControl
        ) {
          return postVoiceControlInternal(std::move(command));
        }
        return postInternal(voice_commands_, std::move(command));
      }, [this](const std::string& session_id, std::uint64_t generation) {
        return desired_voice_.isCurrent(session_id, generation);
      }, voice_session_) {
    logRuntime("media_runtime_constructed");
  }

  void start() {
    worker_ = std::thread([this] { run(); });
  }

  void waitUntilReady() {
    logRuntime("media_runtime_wait_until_ready_start");
    std::unique_lock lock(startup_mutex_);
    startup_changed_.wait(lock, [&] { return startup_complete_; });
    if (startup_error_.empty()) return;
    logRuntime("media_runtime_wait_until_ready_error", {{"message", startup_error_}});
    throw std::runtime_error(startup_error_);
  }

  ~Implementation() {
    try {
      shutdownAndWait();
    } catch (...) {
      // Destructors are the final containment boundary for environments that
      // drop the ObjectWrap without awaiting shutdown.
    }
    destroying_.store(true, std::memory_order_release);
  }

  bool dispatch(MediaCommand command) {
    const auto dispatch_started_at = steadyNowMs();
    if (shutting_down_.load()) return false;
    if (command.type == NativeCommandType::ListDisplaySources) {
      if (command.display_source_action == "metadata" &&
          command.display_page == 0) {
        if (!display_sources_.beginEnumeration(command.display_enumeration_id)) {
          return false;
        }
      } else if (command.display_source_action == "cancel") {
        display_sources_.cancelEnumeration(command.display_enumeration_id);
      }
    }
    if (command.type == NativeCommandType::InvalidateMicrophone) {
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
          std::string(nativeCommandName(command.type)),
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
    if (!isValidNativeCommandType(command.type)) {
      emitter_.emit(failedReply(command, NativeError{
        "unsupported_command",
        "Native command is absent from the typed policy registry",
        "native_dispatch",
        false,
        command.session_id,
        command.generation,
      }));
      return true;
    }
    const auto& command_policy = nativeCommandPolicy(command.type);
    const auto* dispatch_binding = nativeCommandDispatchBinding(command.type);
    if (!dispatch_binding ||
        dispatch_binding->schema != command_policy.schema ||
        dispatch_binding->action != command_policy.action ||
        dispatch_binding->destination != command_policy.destination) {
      emitter_.emit(failedReply(command, NativeError{
        "unsupported_command",
        "Native command has no concrete schema or dispatch binding",
        "native_dispatch",
        false,
        command.session_id,
        command.generation,
      }));
      return true;
    }
    if (command.type == NativeCommandType::ProbeVoiceControl) {
      emitVoiceControlProbe(command);
      return true;
    }
    const bool is_voice_control =
      command_policy.lane == NativeMessageLane::VoiceControl;
    auto pending = pending_commands_.load(std::memory_order_relaxed);
    if (is_voice_control) {
      pending_commands_.fetch_add(1, std::memory_order_relaxed);
    } else {
      while (true) {
        if (pending >= 256) return false;
        if (pending_commands_.compare_exchange_weak(pending, pending + 1)) break;
      }
    }
    const auto type = command.type;
    const auto command_request_id = command.request_id;
    const auto command_action_id = command.diagnostic_action_id;
    const auto command_operation_id = command.diagnostic_operation_id;
    const auto command_diagnostic_revision = command.diagnostic_revision;
    const auto command_host_epoch = command.diagnostic_host_epoch;
    const auto command_session_id = command.session_id;
    const auto command_generation = command.generation;
    const auto command_warm_key = type == NativeCommandType::WarmMicrophone ? warmKey(command) : std::string{};
    std::pair<std::string, std::uint64_t> previous_desired_microphone;
    std::pair<std::string, std::uint64_t> previous_warm_microphone;
    std::pair<std::string, std::uint64_t> previous_desired_screen;
    std::pair<std::string, std::uint64_t> previous_desired_camera;
    std::pair<std::string, std::uint64_t> previous_desired_voice;
    bool generation_accepted = true;
    if (type == NativeCommandType::ConnectVoice || type == NativeCommandType::DisconnectVoice) {
      previous_desired_voice = desired_voice_.current();
      generation_accepted = desired_voice_.advance(
        command.session_id,
        command.generation
      );
    }
    if (
      type == NativeCommandType::ConnectMicrophone ||
      type == NativeCommandType::DisconnectMicrophone
    ) {
      previous_desired_microphone = desired_microphone_.current();
      generation_accepted = desired_microphone_.advance(
        command.session_id,
        command.generation
      );
    }
    if (type == NativeCommandType::WarmMicrophone) {
      previous_warm_microphone = desired_microphone_warm_.current();
      generation_accepted = desired_microphone_warm_.advance(
        warmKey(command),
        command.generation
      );
    }
    if (
      type == NativeCommandType::ConnectScreen || type == NativeCommandType::StartScreenCapture ||
      type == NativeCommandType::StopScreenCapture || type == NativeCommandType::DisconnectScreen
    ) {
      previous_desired_screen = desired_screen_.current();
      generation_accepted = desired_screen_.advance(
        command.session_id,
        command.generation
      );
    }
    if (type == NativeCommandType::ConnectCamera || type == NativeCommandType::DisconnectCamera) {
      previous_desired_camera = desired_camera_.current();
      generation_accepted = desired_camera_.advance(command.session_id, command.generation);
    }
    if (!generation_accepted) {
      pending_commands_.fetch_sub(1, std::memory_order_relaxed);
      emitter_.emit(failedReply(command, NativeError{
        "stale_generation",
        "Native command generation is older than the current intent",
        std::string(nativeCommandName(command.type)),
        false,
        command.session_id,
        command.generation,
      }));
      logRuntime(
        "media_runtime_dispatch_stale_generation",
        {
          {"command", std::string(nativeCommandName(type))},
          {"requestId", command_request_id},
          {"actionId", command_action_id},
          {"operationId", command_operation_id},
          {"revision", command_diagnostic_revision},
          {"hostEpoch", command_host_epoch},
          {"sessionId", command_session_id},
          {"generation", command_generation},
          {"commandStage", "native_dispatch"},
          {"outcome", "rejected"}
        }
      );
      return true;
    }
    bool accepted = false;
    const std::uint64_t enqueue_started_at = steadyNowMs();
    std::uint64_t queue_depth = 0;
    const auto destination = dispatch_binding->destination;
    command.internal_enqueued_steady_ms = enqueue_started_at;
    bool duplicate_voice_control = false;
    if (is_voice_control) {
      command.internal_queue_depth =
        static_cast<std::uint32_t>(voice_control_commands_.size() + 1);
      const auto admission = voice_control_commands_.tryPush(command);
      accepted = admission == VoiceControlAdmission::Accepted ||
        admission == VoiceControlAdmission::Duplicate;
      duplicate_voice_control = admission == VoiceControlAdmission::Duplicate;
      if (accepted) queue_depth = voice_control_commands_.size();
    } else switch (destination) {
      case NativeMessageDestination::Runtime:
        accepted = control_commands_.tryPush(std::move(command));
        if (accepted) queue_depth = control_commands_.size();
        break;
      case NativeMessageDestination::Voice:
        command.internal_queue_depth =
          static_cast<std::uint32_t>(voice_commands_.size() + 1);
        accepted = voice_commands_.tryPush(std::move(command));
        if (accepted) queue_depth = voice_commands_.size();
        break;
      case NativeMessageDestination::Microphone:
        command.internal_queue_depth =
          static_cast<std::uint32_t>(microphone_commands_.size() + 1);
        accepted = microphone_commands_.tryPush(std::move(command));
        if (accepted) queue_depth = microphone_commands_.size();
        break;
      case NativeMessageDestination::Screen:
        command.internal_queue_depth =
          static_cast<std::uint32_t>(screen_commands_.size() + 1);
        accepted = screen_commands_.tryPush(std::move(command));
        if (accepted) queue_depth = screen_commands_.size();
        break;
      case NativeMessageDestination::Camera:
        command.internal_queue_depth =
          static_cast<std::uint32_t>(camera_commands_.size() + 1);
        accepted = camera_commands_.tryPush(std::move(command));
        if (accepted) queue_depth = camera_commands_.size();
        break;
      case NativeMessageDestination::Query:
        command.internal_queue_depth =
          static_cast<std::uint32_t>(query_commands_.size() + 1);
        accepted = query_commands_.tryPush(std::move(command));
        if (accepted) queue_depth = query_commands_.size();
        break;
      case NativeMessageDestination::Hooks:
      case NativeMessageDestination::Node:
        break;
    }
    if (duplicate_voice_control) {
      pending_commands_.fetch_sub(1, std::memory_order_relaxed);
      emitter_.emit(reply(command));
    }
    logRuntime(
      accepted ? "media_runtime_dispatch_accepted" : "media_runtime_dispatch_rejected",
      {
        {"command", std::string(nativeCommandName(type))},
        {"requestId", command_request_id},
        {"actionId", command_action_id},
        {"operationId", command_operation_id},
        {"revision", command_diagnostic_revision},
        {"hostEpoch", command_host_epoch},
        {"sessionId", command_session_id},
        {"generation", command_generation},
        {"dispatchSteadyMs", dispatch_started_at},
        {"queueDepth", queue_depth},
        {"commandStage", "native_dispatch"},
        {"outcome", accepted ? "accepted" : "rejected"}
      }
    );
    if (!accepted) {
      pending_commands_.fetch_sub(1, std::memory_order_relaxed);
      if (type == NativeCommandType::ConnectVoice || type == NativeCommandType::DisconnectVoice) {
        desired_voice_.restoreIfCurrent(
          command_session_id,
          command_generation,
          previous_desired_voice.first,
          previous_desired_voice.second
        );
      }
      if (
        type == NativeCommandType::ConnectMicrophone ||
        type == NativeCommandType::DisconnectMicrophone
      ) {
        desired_microphone_.restoreIfCurrent(
          command_session_id,
          command_generation,
          previous_desired_microphone.first,
          previous_desired_microphone.second
        );
      }
      if (type == NativeCommandType::WarmMicrophone) {
        desired_microphone_warm_.restoreIfCurrent(
          command_warm_key,
          command_generation,
          previous_warm_microphone.first,
          previous_warm_microphone.second
        );
      }
      if (
        type == NativeCommandType::ConnectScreen || type == NativeCommandType::StartScreenCapture ||
        type == NativeCommandType::StopScreenCapture || type == NativeCommandType::DisconnectScreen
      ) {
        desired_screen_.restoreIfCurrent(
          command_session_id,
          command_generation,
          previous_desired_screen.first,
          previous_desired_screen.second
        );
      }
      if (type == NativeCommandType::ConnectCamera || type == NativeCommandType::DisconnectCamera) {
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
    display_sources_.shutdown();
    accepted_control_post_.close();
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
    // Pending lossy media events own GPU frame handles through on_drop. Drain
    // them while ScreenActor/CameraActor and the shared voice session are
    // still alive; emitter_ is declared first and would otherwise be destroyed
    // after those owners.
    emitter_.close();
    logRuntime("media_runtime_shutdown_joined");
  }

  [[nodiscard]] PreviewQueueMetrics microphonePreviewQueueMetrics() const noexcept {
    return preview_.queueMetrics();
  }

 private:
  bool postAcceptedControl(MediaCommand command) {
    if (command.type == NativeCommandType::VoiceTerminal) {
      return postInternalDirect(voice_commands_, std::move(command));
    }
    if (command.type == NativeCommandType::MicrophoneTerminal) {
      return postInternalDirect(microphone_commands_, std::move(command));
    }
    if (command.type == NativeCommandType::ScreenTerminal ||
        command.type == NativeCommandType::ScreenAudioTerminal) {
      return postInternalDirect(screen_commands_, std::move(command));
    }
    if (command.type == NativeCommandType::CameraTerminal) {
      return postInternalDirect(camera_commands_, std::move(command));
    }
    return false;
  }

  void handleAcceptedControlLoss() noexcept {
    accepted_control_loss_.signal(
      emitter_,
      [](void* context) noexcept {
        auto& runtime = *static_cast<Implementation*>(context);
        runtime.shutting_down_.store(true, std::memory_order_release);
        runtime.control_commands_.close();
      },
      this
    );
    logRuntime("media_runtime_accepted_control_delivery_lost");
  }

  template <typename Queue>
  bool postInternal(Queue& queue, MediaCommand command) {
    if (requiresAcceptedControlPost(command)) {
      try {
        return accepted_control_post_.postOnce(
          acceptedControlKey(command),
          std::move(command)
        );
      } catch (...) {
        handleAcceptedControlLoss();
        return false;
      }
    }
    return postInternalDirect(queue, std::move(command));
  }

  template <typename Queue>
  bool postInternalDirect(Queue& queue, MediaCommand command) {
    assert(
      !destroying_.load(std::memory_order_acquire) &&
      "actor posted after MediaRuntime destruction began"
    );
    const auto traffic = classifyActorCommand(command);
    command.internal_enqueued_steady_ms = steadyNowMs();
    const auto depth = queue.size() + 1;
    command.internal_queue_depth = static_cast<std::uint32_t>(depth);

    // Telemetry: track queue depth for capacity planning
    if (depth > 10 && (depth % 50 == 0 || depth > 200)) {
      logRuntime(
        "actor_queue_depth_high",
        {{"depth", static_cast<std::uint64_t>(depth)}}
      );
    }

    if (traffic == ActorCommandTraffic::CoalescedMedia) {
      // This path stays allocation-free after the producer has attached its
      // release callback. Rejection leaves release ownership with producer.
      return queue.tryPush(std::move(command));
    }
    const auto type = command.type;
    const auto session_id = command.session_id;
    const auto generation = command.generation;
    if (queue.tryPushFor(std::move(command), std::chrono::milliseconds(250))) {
      return true;
    }
    if (shutting_down_.load()) return false;
    logRuntime(
      "media_runtime_internal_control_backpressure_timeout",
      {
        {"command", std::string(nativeCommandName(type))},
        {"sessionId", session_id},
        {"generation", generation},
        {"queueDepth", static_cast<std::uint64_t>(queue.size())}
      }
    );
    return false;
  }

  bool postVoiceControlInternal(MediaCommand command) {
    assert(
      !destroying_.load(std::memory_order_acquire) &&
      "actor posted after MediaRuntime destruction began"
    );
    command.internal_enqueued_steady_ms = steadyNowMs();
    command.internal_queue_depth = static_cast<std::uint32_t>(
      voice_control_commands_.size() + 1
    );
    if (voice_control_commands_.tryPushFor(
          std::move(command),
          std::chrono::milliseconds(250)
        )) {
      return true;
    }
    if (!shutting_down_.load()) {
      logRuntime(
        "media_runtime_voice_control_backpressure_timeout",
        {{"queueDepth", static_cast<std::uint64_t>(
          voice_control_commands_.size()
        )}}
      );
    }
    return false;
  }

  void runtimeError(const MediaCommand& command, NativeError error) {
    error.session_id = command.session_id;
    if (!command.session_id.empty()) error.generation = command.generation;
    RuntimeEvent event;
    event.type = NativeEventType::RuntimeError;
    event.request_id = command.request_id;
    event.session_id = command.session_id;
    event.generation = command.generation;
    event.error = std::move(error);
    emitter_.emit(std::move(event));
  }

  void emitVoiceControlProbe(const MediaCommand& command) {
    const auto snapshot = voice_control_commands_.snapshot(
      command.diagnostic_host_epoch,
      rendererTextureLeaseStats()
    );
    auto event = reply(command);
    event.kind = "voiceControlProbe";
    event.voice_control_host_epoch = snapshot.host_epoch;
    event.voice_control_queue_depth = snapshot.queue_depth;
    event.voice_control_queue_capacity = snapshot.queue_capacity;
    event.voice_control_oldest_queue_wait_ms = snapshot.oldest_queue_wait_ms;
    event.voice_control_last_queue_wait_ms = snapshot.last_queue_wait_ms;
    event.voice_control_current_operation = snapshot.current_operation;
    event.voice_control_current_operation_age_ms =
      snapshot.current_operation_age_ms;
    event.voice_control_duplicate_commands = snapshot.duplicate_commands;
    event.voice_control_rejected_commands = snapshot.rejected_commands;
    event.voice_control_worker_state = snapshot.worker_state;
    event.voice_control_retirement_state = snapshot.retirement_state;
    event.voice_control_outstanding_renderer_leases =
      snapshot.outstanding_renderer_leases;
    event.voice_control_outstanding_renderer_generations =
      snapshot.outstanding_renderer_generations;
    event.voice_control_worker_owner = snapshot.worker_owner;
    event.voice_control_retirement_owner = snapshot.retirement_owner;
    emitter_.emit(std::move(event));
  }

  static void dropCommandResource(MediaCommand& command) noexcept {
    auto on_drop = std::move(command.on_drop);
    command.on_drop = {};
    if (!on_drop) return;
    try {
      on_drop();
    } catch (...) {
      logRuntime("media_runtime_command_resource_release_failed");
    }
  }

  void handleMicrophone(const MediaCommand& command) {
    if (command.type == NativeCommandType::MicrophoneTerminal) {
      if (!terminalIncarnationFence().isCurrent(
            command.terminal_producer, command.terminal_incarnation
          )) {
        return;
      }
      const bool fail_preview = microphone_.handleTerminal(command);
      if (
        fail_preview &&
        !preview_session_id_.empty()
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
      return;
    }
    if (command.type == NativeCommandType::MicrophonePublicationUnpublished) {
      if (auto event = microphone_.handlePublicationUnpublished(command)) {
        emitter_.emit(std::move(*event));
      }
      return;
    }
    if (
      command.type == NativeCommandType::MicrophoneAttemptReady ||
      command.type == NativeCommandType::MicrophoneAttemptFailed ||
      command.type == NativeCommandType::MicrophoneRetireDone ||
      command.type == NativeCommandType::MicrophoneEndpointChanged ||
      command.type == NativeCommandType::MicrophoneProcessingStatus ||
      command.type == NativeCommandType::MicrophoneIdleExpired
    ) {
      microphone_.handleWorkerCommand(command);
      return;
    }
    if (command.type == NativeCommandType::WarmMicrophone) {
      if (!desired_microphone_warm_.isCurrent(warmKey(command), command.generation)) {
        throw std::runtime_error("stale microphone warm generation");
      }
      microphone_.warm(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == NativeCommandType::ProbeMicrophoneActor) {
      emitter_.emit(microphone_.probe(command));
      return;
    }
    if (command.type == NativeCommandType::ConnectMicrophone) {
      microphone_.connect(command);
      return;
    }
    if (command.type == NativeCommandType::ConfigureMicrophone) {
      emitter_.emit(microphone_.configure(command));
      return;
    }
    if (command.type == NativeCommandType::SetMicrophoneMuted) {
      microphone_.setMuted(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == NativeCommandType::DisconnectMicrophone) {
      microphone_.disconnect(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == NativeCommandType::StartPreview) {
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
      microphone_.setPreviewConsumer(
        command.session_id,
        command.generation,
        [
          this,
          session_id = command.session_id,
          generation = command.generation
        ](auto pcm) {
          preview_.pushFrame(session_id, generation, pcm);
        }
      );
      emitter_.emit(result);
      RuntimeEvent started = result;
      started.type = NativeEventType::MicrophonePreviewStarted;
      emitter_.emit(std::move(started));
      return;
    }
    if (command.type == NativeCommandType::StopPreview) {
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

  void routeMicrophone(MediaCommand& command) {
    if (command.type == NativeCommandType::ProbeMicrophoneActor) {
      emitter_.emit(microphone_.probe(command));
      return;
    }
    if (!microphone_operations_.tryPushFor(
          command,
          std::chrono::milliseconds(250)
        )) {
      throw std::runtime_error(
        "microphone operation queue remained full past its bounded deadline"
      );
    }
    // The operation queue now owns any command-scoped native release. Disarm
    // the routing queue's guard so a future resource-bearing command cannot
    // release the same payload twice.
    command.on_drop = {};
  }

  void handleVoiceControl(MediaCommand& command) {
    if (command.type == NativeCommandType::ReleaseRemoteVideoFrame) {
      static_cast<void>(releaseRendererTextureLease(
        RendererTextureLeaseFence{
          NativeCommandType::RemoteVideoFrame,
          command.session_id,
          command.generation,
          command.track_id
        },
        command.frame_sequence
      ));
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == NativeCommandType::ReleaseLocalScreenPreviewFrame) {
      screen_.handleWorkerCommand(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == NativeCommandType::ReleaseLocalCameraPreviewFrame) {
      static_cast<void>(releaseRendererTextureLease(
        RendererTextureLeaseFence{
          NativeCommandType::LocalCameraPreviewFrame,
          command.session_id,
          command.generation,
          command.track_id
        },
        command.frame_sequence
      ));
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == NativeCommandType::SetLocalCameraPreviewDemand) {
      if (!desired_camera_.isCurrent(command.session_id, command.generation)) {
        throw std::runtime_error("stale camera preview generation");
      }
      camera_.setPreviewDemand(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == NativeCommandType::RetryLocalCameraPreview) {
      if (!desired_camera_.isCurrent(command.session_id, command.generation)) {
        throw std::runtime_error("stale camera preview recovery generation");
      }
      camera_.retryPreview(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == NativeCommandType::SetLocalScreenPreviewDemand) {
      if (!desired_screen_.isCurrent(command.session_id, command.generation)) {
        throw std::runtime_error("stale screen preview generation");
      }
      screen_.handleWorkerCommand(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == NativeCommandType::SetRemoteVideoDemand) {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) {
        throw std::runtime_error("stale remote video demand generation");
      }
      const auto owner_call = requireSessionPortValue(
        voice_session_->bindCurrentOwner(command.session_id, command.generation)
      );
      requireSessionPortSuccess(voice_session_->remoteDemand().set(
        owner_call,
        command.track_id,
        command.demanded
      ));
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == NativeCommandType::ReconcileRemotePublication) {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) {
        return;
      }
      const auto owner_call = requireSessionPortValue(
        voice_session_->bindCurrentOwner(command.session_id, command.generation)
      );
      requireSessionPortSuccess(voice_session_->remoteDemand().reconcile(
        owner_call,
        command.track_id,
        command.internal_epoch
      ));
      return;
    }
    if (command.type == NativeCommandType::RetryRemoteVideo) {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) {
        throw std::runtime_error("stale remote video recovery generation");
      }
      const auto owner_call = requireSessionPortValue(
        voice_session_->bindCurrentOwner(command.session_id, command.generation)
      );
      requireSessionPortSuccess(voice_session_->remoteDemand().retry(
        owner_call,
        command.track_id,
        command.internal_message
      ));
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == NativeCommandType::ConfigureVoiceOutput) {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) {
        throw std::runtime_error("stale voice output generation");
      }
      if (!command.has_deafened) {
        throw std::invalid_argument("deafened is required");
      }
      const auto output_call = requireSessionPortValue(
        voice_session_->bindCurrentOwner(command.session_id, command.generation)
      );
      static_cast<void>(requireSessionPortValue(
        voice_session_->output().setDevice(output_call, command.device_id)
      ));
      microphone_.setEchoReferenceOutputDevice(command.device_id);
      requireSessionPortSuccess(
        voice_session_->output().setDeafened(output_call, command.deafened)
      );
      if (command.has_output_volume) {
        requireSessionPortSuccess(
          voice_session_->output().setVolume(
            output_call,
            command.output_volume
          )
        );
      }
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == NativeCommandType::ConfigureRemoteAudio) {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) {
        throw std::runtime_error("stale remote audio generation");
      }
      if (!command.has_revision) {
        throw std::invalid_argument("revision is required");
      }
      const auto owner_call = requireSessionPortValue(
        voice_session_->bindCurrentOwner(command.session_id, command.generation)
      );
      requireSessionPortSuccess(voice_session_->output().configureRemoteAudio(
        owner_call,
        RemoteAudioSettings{
          command.revision,
          command.user_volumes,
          command.user_mutes,
          command.stream_volumes,
          command.stream_mutes,
        }
      ));
      emitter_.emit(reply(command));
      return;
    }
    unknown(command);
  }

  void handleVoice(MediaCommand& command) {
    if (command.type == NativeCommandType::VoiceConnectCompleted) {
      voice_.handleWorkerCommand(command);
      return;
    }
    if (command.type == NativeCommandType::VoiceConnectionStateChanged) {
      if (!desired_voice_.isCurrent(command.session_id, command.generation))
        return;
      RuntimeEvent event;
      event.type = NativeEventType::VoiceConnectionState;
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.state = command.status;
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == NativeCommandType::RemoteVideoPublicationAvailable ||
        command.type == NativeCommandType::RemoteVideoPublicationUnavailable) {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) return;
      RuntimeEvent event;
      event.type = command.type == NativeCommandType::RemoteVideoPublicationAvailable
        ? NativeEventType::RemoteVideoPublicationAvailable
        : NativeEventType::RemoteVideoPublicationUnavailable;
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.track_id = command.track_id;
      event.participant_identity = command.participant_identity;
      event.video_source = command.video_source;
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == NativeCommandType::VoiceOutputStateChanged) {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) return;
      RuntimeEvent event;
      event.type = NativeEventType::SessionLifecycle;
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.kind = "output";
      event.status = command.status == "recovering"
        ? "starting"
        : (command.status == "failed" ? "error" : command.status);
      event.device_id = command.device_id;
      event.detail = command.internal_message;
      if (!command.video_source.empty()) {
        event.error = NativeError{
          command.video_source,
          event.detail.empty() ? "Remote audio output state changed" : event.detail,
          command.status == "recovering"
            ? "recoverVoiceOutput"
            : "configureVoiceOutput",
          command.diagnostic_retryable,
          command.session_id,
          command.generation,
          command.diagnostic_hresult == 0
            ? std::optional<std::int64_t>{}
            : std::optional<std::int64_t>{command.diagnostic_hresult},
        };
      }
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == NativeCommandType::VoiceRemoteAudioTrackFailed) {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) return;
      RuntimeEvent event;
      event.type = NativeEventType::RuntimeError;
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.track_id = command.track_id;
      event.detail = command.internal_message;
      event.error = NativeError{
        command.video_source.empty()
          ? "audio_output_direct_sink_attach_failed"
          : command.video_source,
        command.internal_message,
        "remoteAudioTrack",
        command.diagnostic_retryable,
        command.session_id,
        command.generation,
        command.diagnostic_hresult == 0
          ? std::optional<std::int64_t>{}
          : std::optional<std::int64_t>{command.diagnostic_hresult},
      };
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == NativeCommandType::RemoteVideoFrame) {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) {
        if (command.on_drop) {
          dropCommandResource(command);
        } else {
          const auto owner_call = voice_session_->bindCurrentOwner(
            command.session_id, command.generation
          );
          if (!owner_call.hasError()) {
            static_cast<void>(voice_session_->remoteFrameRelease().releaseRemoteFrame(
              owner_call.value().value, command.track_id, command.frame_sequence
            ));
          }
        }
        return;
      }
      RuntimeEvent event;
      event.type = NativeEventType::RemoteVideoFrame;
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
      event.on_drop = std::move(command.on_drop);
      if (!event.on_drop) {
        const auto voice_session = voice_session_;
        const auto release_call = requireSessionPortValue(
          voice_session_->bindCurrentOwner(command.session_id, command.generation)
        );
        const auto track_id = command.track_id;
        const auto frame_sequence = command.frame_sequence;
        event.on_drop = exactOnceNativeRelease(
          [voice_session, release_call, track_id, frame_sequence] {
            static_cast<void>(voice_session->remoteFrameRelease().releaseRemoteFrame(
              release_call, track_id, frame_sequence
            ));
          }
        );
      }
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == NativeCommandType::RemoteVideoTrackRemoved || command.type == NativeCommandType::RemoteVideoFailed) {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) return;
      RuntimeEvent event;
      event.type = command.type == NativeCommandType::RemoteVideoFailed
        ? NativeEventType::RemoteVideoFailed
        : NativeEventType::RemoteVideoTrackRemoved;
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.track_id = command.track_id;
      event.video_source = command.video_source;
      event.reason = command.recovery_mode;
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == NativeCommandType::VoiceTerminal) {
      if (!terminalIncarnationFence().isCurrent(
            command.terminal_producer, command.terminal_incarnation
          )) {
        return;
      }
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) return;
      desired_voice_.set("__voice_terminal__", command.generation);
      voice_commands_.discardMedia(command.session_id, command.generation);
      RuntimeEvent event;
      event.type = NativeEventType::VoiceTerminal;
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
    if (command.type == NativeCommandType::VoiceActiveSpeakers) {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) return;
      RuntimeEvent event;
      event.type = NativeEventType::ActiveSpeakers;
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.kind = "voice";
      event.participant_identities = command.participant_identities;
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == NativeCommandType::VoiceStats) {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) return;
      RuntimeEvent event;
      event.type = NativeEventType::VoiceStats;
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.kind = "voice";
      event.voice_rtc_transport = std::move(command.voice_rtc_transport);
      event.voice_rtc_outbound = std::move(command.voice_rtc_outbound);
      event.voice_rtc_inbound = std::move(command.voice_rtc_inbound);
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == NativeCommandType::LocalMicrophoneUnpublished) {
      if (!desired_voice_.isCurrent(command.session_id, command.generation)) return;
      command.type = NativeCommandType::MicrophonePublicationUnpublished;
      if (!postInternal(microphone_commands_, command)) {
        throw std::runtime_error(
          "failed to route local microphone publication loss"
        );
      }
      return;
    }
    if (command.type == NativeCommandType::ConnectVoice) {
      voice_.connect(command);
      return;
    }
    if (command.type == NativeCommandType::DisconnectVoice) {
      voice_.disconnect(command);
      return;
    }
    unknown(command);
  }

  void handleScreen(MediaCommand& command) {
    if (command.type == NativeCommandType::LocalScreenPreviewFailed) {
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
      event.type = NativeEventType::LocalScreenPreviewFailed;
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.track_id = command.track_id;
      event.error = NativeError{
        "LOCAL_SCREEN_PREVIEW_FAILED",
        message,
        command.video_source,
        true,
        command.session_id,
        command.generation,
        command.diagnostic_hresult == 0
          ? std::optional<std::int64_t>{}
          : std::optional<std::int64_t>{command.diagnostic_hresult}
      };
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == NativeCommandType::LocalScreenPreviewFrame) {
      if (!desired_screen_.isCurrent(command.session_id, command.generation)) {
        if (command.on_drop) {
          dropCommandResource(command);
        } else {
          MediaCommand release = command;
          release.type = NativeCommandType::ReleaseLocalScreenPreviewFrame;
          screen_.handleWorkerCommand(release);
        }
        return;
      }
      RuntimeEvent event;
      event.type = NativeEventType::LocalScreenPreviewFrame;
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
      event.on_drop = std::move(command.on_drop);
      if (!event.on_drop) {
        MediaCommand release = command;
        release.type = NativeCommandType::ReleaseLocalScreenPreviewFrame;
        event.on_drop = exactOnceNativeRelease(
          [this, release = std::move(release)] {
            screen_.handleWorkerCommand(release);
          }
        );
      }
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == NativeCommandType::LocalScreenPreviewTrackRemoved) {
      RuntimeEvent event;
      event.type = NativeEventType::LocalScreenPreviewTrackRemoved;
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.track_id = command.track_id;
      event.video_source = "screen";
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == NativeCommandType::ScreenAudioTerminal) {
      if (!terminalIncarnationFence().isCurrent(
            command.terminal_producer, command.terminal_incarnation
          )) {
        return;
      }
      if (!desired_screen_.isCurrent(command.session_id, command.generation)) return;
      screen_.handleWorkerCommand(command);
      return;
    }
    if (command.type == NativeCommandType::ScreenTerminal) {
      if (!terminalIncarnationFence().isCurrent(
            command.terminal_producer, command.terminal_incarnation
          )) {
        return;
      }
      if (!desired_screen_.isCurrent(command.session_id, command.generation)) return;
      try {
        screen_.handleTerminal(command);
      } catch (...) {
        desired_screen_.setIfCurrent(
          command.session_id,
          command.generation,
          "__screen_terminal__",
          command.generation);
        screen_commands_.discardMedia(command.session_id, command.generation);
        throw;
      }
      desired_screen_.setIfCurrent(
        command.session_id,
        command.generation,
        "__screen_terminal__",
        command.generation);
      screen_commands_.discardMedia(command.session_id, command.generation);
      return;
    }
    if (
      command.type == NativeCommandType::ScreenAttemptReady ||
      command.type == NativeCommandType::ScreenAttemptFailed ||
      command.type == NativeCommandType::ScreenAudioAttemptReady ||
      command.type == NativeCommandType::ScreenAudioAttemptFailed ||
      command.type == NativeCommandType::ScreenRetireDone
    ) {
      screen_.handleWorkerCommand(command);
      return;
    }
    if (command.type == NativeCommandType::ConnectScreen) {
      emitter_.emit(lifecycle(command, "screen", "starting", "livekit_connecting"));
      screen_.connect(command);
      return;
    }
    if (command.type == NativeCommandType::ProbeScreenActor) {
      emitter_.emit(screen_.probe(command));
      return;
    }
    if (command.type == NativeCommandType::StartScreenCapture) {
      emitter_.emit(lifecycle(command, "screen", "starting", "capture_starting"));
      screen_.startCapture(command);
      return;
    }
    if (command.type == NativeCommandType::StopScreenCapture) {
      screen_.stopCapture(command);
      emitter_.emit(reply(command));
      return;
    }
    if (command.type == NativeCommandType::DisconnectScreen) {
      screen_.disconnect(command);
      emitter_.emit(reply(command));
      return;
    }
    unknown(command);
  }

  void handleCamera(MediaCommand& command) {
    if (command.type == NativeCommandType::LocalCameraPreviewFrame) {
      if (!desired_camera_.isCurrent(command.session_id, command.generation)) {
        if (command.on_drop) {
          dropCommandResource(command);
        } else {
          camera_.releasePreviewFrame(command);
        }
        return;
      }
      RuntimeEvent event;
      event.type = NativeEventType::LocalCameraPreviewFrame;
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.track_id = command.track_id;
      event.participant_identity = command.participant_identity;
      event.video_source = "camera";
      event.frame_sequence = command.frame_sequence;
      event.timestamp_us = command.timestamp_us;
      event.nt_handle = command.nt_handle;
      event.width = command.width;
      event.height = command.height;
      event.on_drop = std::move(command.on_drop);
      if (!event.on_drop) {
        const auto voice_session = voice_session_;
        const auto release_call = requireSessionPortValue(
          voice_session_->bindCurrentOwner(command.session_id, command.generation)
        );
        const auto track_id = command.track_id;
        const auto frame_sequence = command.frame_sequence;
        event.on_drop = exactOnceNativeRelease(
          [voice_session, release_call, track_id, frame_sequence] {
            static_cast<void>(voice_session->cameraPreview().releasePreviewFrame(
              release_call, track_id, frame_sequence
            ));
          }
        );
      }
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == NativeCommandType::LocalCameraPreviewFailed) {
      const auto owner_call = voice_session_->bindCurrentOwner(
        command.session_id, command.generation
      );
      if (!owner_call.hasError()) {
        static_cast<void>(voice_session_->cameraPreview().stop(
          owner_call.value().value, command.track_id
        ));
      }
      RuntimeEvent event;
      event.type = NativeEventType::LocalCameraPreviewFailed;
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.track_id = command.track_id;
      event.error = NativeError{
        "LOCAL_CAMERA_PREVIEW_FAILED",
        command.internal_message.empty()
          ? "Local camera preview failed"
          : command.internal_message,
        "local_camera_preview",
        false,
        command.session_id,
        command.generation
      };
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == NativeCommandType::LocalCameraPreviewTrackRemoved) {
      RuntimeEvent event;
      event.type = NativeEventType::LocalCameraPreviewTrackRemoved;
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.track_id = command.track_id;
      event.video_source = "camera";
      emitter_.emit(std::move(event));
      return;
    }
    if (command.type == NativeCommandType::CameraTerminal) {
      if (!terminalIncarnationFence().isCurrent(
            command.terminal_producer, command.terminal_incarnation
          )) {
        return;
      }
      if (!desired_camera_.isCurrent(command.session_id, command.generation)) return;
      try {
        camera_.handleTerminal(command);
      } catch (...) {
        desired_camera_.set("__camera_terminal__", command.generation);
        camera_commands_.discardMedia(command.session_id, command.generation);
        throw;
      }
      desired_camera_.set("__camera_terminal__", command.generation);
      camera_commands_.discardMedia(command.session_id, command.generation);
      return;
    }
    if (command.type == NativeCommandType::ConnectCamera) {
      emitter_.emit(lifecycle(command, "camera", "starting", "capture_starting"));
      camera_.connect(command);
      return;
    }
    if (command.type == NativeCommandType::ProbeCameraActor) {
      emitter_.emit(camera_.probe(command));
      return;
    }
    if (command.type == NativeCommandType::DisconnectCamera) {
      camera_.disconnect(command);
      emitter_.emit(reply(command));
      return;
    }
    unknown(command);
  }

  void handleQuery(const MediaCommand& command) {
    if (command.type == NativeCommandType::ListDevices) {
      auto result = reply(command);
      result.kind = "devices";
      if (command.device_kind == "audioinput") {
        result.devices = listAudioDevices(eCapture);
      } else if (command.device_kind == "audiooutput") {
        result.devices = listAudioDevices(eRender);
      } else if (command.device_kind == "videoinput") {
        result.devices = listCameraDevices();
      } else {
        emitter_.emit(failedReply(command, NativeError{
          "invalid_device_kind",
          "Unsupported media device kind",
          std::string(nativeCommandName(command.type)),
          false,
        }));
        return;
      }
      emitter_.emit(std::move(result));
      return;
    }
    if (command.type == NativeCommandType::ListDisplaySources) {
      auto result = reply(command);
      result.kind = "sources";
      if (command.display_source_action == "metadata") {
        result.sources = display_sources_.metadataPage(
            command.display_enumeration_id,
            command.display_page,
            command.self_window_handle);
      } else if (command.display_source_action == "thumbnail") {
        result.sources = display_sources_.visual(
            command.display_enumeration_id,
            command.source_id,
            command.self_window_handle);
      } else if (command.display_source_action == "cancel") {
        display_sources_.cancelEnumeration(command.display_enumeration_id);
      } else {
        emitter_.emit(failedReply(command, NativeError{
          "invalid_display_source_action",
          "Display-source queries require metadata, thumbnail, or cancel",
          std::string(nativeCommandName(command.type)),
          false,
        }));
        return;
      }
      emitter_.emit(std::move(result));
      return;
    }
    if (command.type == NativeCommandType::ProbeQueryWorker) {
      emitter_.emit(reply(command));
      return;
    }
    unknown(command);
  }

  void unknown(const MediaCommand& command) {
    const auto kind = isValidNativeCommandType(command.type) &&
        nativeCommandPolicy(command.type).destination ==
          NativeMessageDestination::Screen
      ? "screen"
      : "microphone";
    if (!command.session_id.empty()) {
      emitter_.emit(lifecycle(command, kind, "error", "unknown_command"));
    }
    NativeError error{
      "unknown_command",
      "Unknown media runtime command: " +
        std::string(nativeCommandName(command.type)),
      std::string(nativeCommandName(command.type)),
      false,
    };
    emitCommandFailure(command, std::move(error));
  }

  static bool isInternalCommand(const MediaCommand& command) noexcept {
    return isValidNativeCommandType(command.type) &&
      nativeCommandPolicy(command.type).visibility ==
        NativeMessageVisibility::Internal;
  }

  void emitCommandFailure(const MediaCommand& command, NativeError error) {
    if (!command.request_id.empty()) {
      emitter_.emit(failedReply(command, error));
    }
    runtimeError(command, std::move(error));
  }

  template <typename Queue, typename Handler>
  void commandLoop(
    const char* queue_name,
    Queue& queue,
    Handler handler,
    bool decrement_pending = true
  ) {
    while (auto command = queue.waitPop()) {
      ActorCommandResourceGuard resource_guard(*command);
      const auto command_started_at = steadyNowMs();
      if (diagnostics::DiagnosticLog::instance().enabled()) {
        const auto wait_ms = command->internal_enqueued_steady_ms == 0
          ? std::uint64_t{0}
          : command_started_at - command->internal_enqueued_steady_ms;
        logRuntime(
          "media_runtime_command_start",
          {
            {"queue", queue_name},
            {"command", nativeCommandName(command->type)},
            {"requestId", command->request_id},
            {"actionId", command->diagnostic_action_id},
            {"operationId", command->diagnostic_operation_id},
            {"revision", command->diagnostic_revision},
            {"hostEpoch", command->diagnostic_host_epoch},
            {"sessionId", command->session_id},
            {"generation", command->generation},
            {"enqueuedQueueDepth", static_cast<std::uint64_t>(command->internal_queue_depth)},
            {"queueWaitMs", wait_ms},
            {"commandStage", "native_worker"},
            {"outcome", "started"}
          }
        );
      }
      try {
        handler(*command);
        logRuntime(
          "media_runtime_command_ok",
          {
            {"queue", queue_name},
            {"command", nativeCommandName(command->type)},
            {"requestId", command->request_id},
            {"actionId", command->diagnostic_action_id},
            {"operationId", command->diagnostic_operation_id},
            {"revision", command->diagnostic_revision},
            {"hostEpoch", command->diagnostic_host_epoch},
            {"sessionId", command->session_id},
            {"generation", command->generation},
            {"durationMs", steadyNowMs() - command_started_at},
            {"commandStage", "native_worker"},
            {"outcome", "success"}
          }
        );
      } catch (const std::exception& error) {
        const std::string message = error.what();
        const bool stale_generation = message.starts_with("stale ");
        const bool actor_unresponsive =
          dynamic_cast<const ScreenActorUnresponsiveError*>(&error) != nullptr;
        const bool actor_busy =
          dynamic_cast<const ScreenActorBusyError*>(&error) != nullptr;
        const auto* audio_failure = dynamic_cast<const AudioFailure*>(&error);
        NativeError native_error{
          stale_generation
            ? "stale_generation"
            : (audio_failure
                ? audio_failure->code()
                : (actor_unresponsive
                ? "actor_unresponsive"
                : (actor_busy ? "actor_busy" : "native_command_failed"))),
          message,
          std::string(nativeCommandName(command->type)),
          audio_failure ? audio_failure->retryable() : !stale_generation,
        };
        native_error.session_id = command->session_id;
        if (!command->session_id.empty()) native_error.generation = command->generation;
        if (audio_failure && audio_failure->hresult() != S_OK) {
          native_error.hresult = static_cast<std::int64_t>(audio_failure->hresult());
        }
        emitCommandFailure(*command, std::move(native_error));
        logRuntime(
          "media_runtime_command_error",
          {
            {"queue", queue_name},
            {"command", nativeCommandName(command->type)},
            {"requestId", command->request_id},
            {"actionId", command->diagnostic_action_id},
            {"operationId", command->diagnostic_operation_id},
            {"revision", command->diagnostic_revision},
            {"hostEpoch", command->diagnostic_host_epoch},
            {"sessionId", command->session_id},
            {"generation", command->generation},
            {"durationMs", steadyNowMs() - command_started_at},
            {"message", message},
            {"stale", stale_generation},
            {"commandStage", "native_worker"},
            {"outcome", "error"}
          }
        );
      } catch (...) {
        NativeError native_error{
          "native_command_failed",
          "Native command failed with an unknown exception",
          std::string(nativeCommandName(command->type)),
          true,
          command->session_id,
          command->session_id.empty()
            ? std::optional<std::uint64_t>{}
            : std::optional<std::uint64_t>{command->generation},
        };
        emitCommandFailure(*command, std::move(native_error));
        logRuntime(
          "media_runtime_command_unknown_error",
          {
            {"queue", queue_name},
            {"command", nativeCommandName(command->type)},
            {"requestId", command->request_id},
            {"actionId", command->diagnostic_action_id},
            {"operationId", command->diagnostic_operation_id},
            {"revision", command->diagnostic_revision},
            {"hostEpoch", command->diagnostic_host_epoch},
            {"sessionId", command->session_id},
            {"generation", command->generation},
            {"internal", isInternalCommand(*command)},
            {"durationMs", steadyNowMs() - command_started_at},
            {"commandStage", "native_worker"},
            {"outcome", "error"}
          }
        );
      }
      if (decrement_pending && !command->request_id.empty()) {
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
    display_sources_.shutdown();
    desired_voice_.advance("__shutdown__", UINT64_MAX);
    desired_microphone_.advance("__shutdown__", UINT64_MAX);
    desired_microphone_warm_.advance("__shutdown__", UINT64_MAX);
    desired_screen_.advance("__shutdown__", UINT64_MAX);
    desired_camera_.advance("__shutdown__", UINT64_MAX);
    voice_commands_.closeAndDiscard();
    voice_control_commands_.closeAndDiscard();
    microphone_commands_.closeAndDiscard();
    screen_commands_.closeAndDiscard();
    camera_commands_.closeAndDiscard();
    query_commands_.closeAndDiscard();
    microphone_operations_.closeAndDiscard();
  }

  static void joinIfRunning(std::thread& worker) {
    if (worker.joinable()) worker.join();
  }

  static void finishQuarantinedSubsystemShutdown(void* context) {
    auto& owner = *static_cast<Implementation*>(context);
    auto& state = owner.subsystem_shutdown_;
    forEachMediaRuntimeShutdownStep([&](MediaRuntimeShutdownStep step) {
      switch (step) {
        case MediaRuntimeShutdownStep::JoinVoiceWorkers:
          joinIfRunning(state.voice_worker);
          joinIfRunning(state.voice_control_worker);
          break;
        case MediaRuntimeShutdownStep::JoinScreenWorker:
          joinIfRunning(state.screen_worker);
          break;
        case MediaRuntimeShutdownStep::JoinCameraWorker:
          joinIfRunning(state.camera_worker);
          break;
        case MediaRuntimeShutdownStep::JoinQueryWorker:
          joinIfRunning(state.query_worker);
          break;
        case MediaRuntimeShutdownStep::JoinMicrophoneWorkers:
          joinIfRunning(state.microphone_worker);
          joinIfRunning(state.microphone_operation_worker);
          break;
        case MediaRuntimeShutdownStep::ShutdownScreen:
          try { owner.screen_.shutdown(state.deadline); } catch (...) {}
          break;
        case MediaRuntimeShutdownStep::ShutdownCamera:
          try { owner.camera_.shutdown(state.deadline); } catch (...) {}
          break;
        case MediaRuntimeShutdownStep::ShutdownPreviewAndMicrophone:
          if (!owner.preview_session_id_.empty()) {
            owner.microphone_.clearPreviewConsumer(
              owner.preview_session_id_,
              owner.preview_generation_
            );
          }
          try { owner.preview_.shutdown(state.deadline); } catch (...) {}
          try { owner.microphone_.shutdown(); } catch (...) {}
          break;
        case MediaRuntimeShutdownStep::ShutdownVoice:
          try { owner.voice_.shutdown(); } catch (...) {}
          break;
      }
    });
  }

  static void notifyQuarantinedSubsystemShutdownComplete(void* context) {
    auto& owner = *static_cast<Implementation*>(context);
    if (owner.after_subsystem_cleanup_) {
      try { owner.after_subsystem_cleanup_(); } catch (...) {}
    }
  }

  bool quarantineSubsystemShutdown(
    std::chrono::steady_clock::time_point deadline,
    std::thread voice_worker,
    std::thread voice_control_worker,
    std::thread microphone_worker,
    std::thread microphone_operation_worker,
    std::thread screen_worker,
    std::thread camera_worker,
    std::thread query_worker
  ) {
    auto owner = weak_from_this().lock();
    if (!owner) return false;
    if (subsystem_cleanup_submitted_.exchange(true)) return true;
    subsystem_shutdown_.deadline = deadline;
    subsystem_shutdown_.voice_worker = std::move(voice_worker);
    subsystem_shutdown_.voice_control_worker =
      std::move(voice_control_worker);
    subsystem_shutdown_.microphone_worker = std::move(microphone_worker);
    subsystem_shutdown_.microphone_operation_worker =
      std::move(microphone_operation_worker);
    subsystem_shutdown_.screen_worker = std::move(screen_worker);
    subsystem_shutdown_.camera_worker = std::move(camera_worker);
    subsystem_shutdown_.query_worker = std::move(query_worker);
    subsystem_cleanup_job_->prepare(
      std::move(owner),
      this,
      reinterpret_cast<CleanupResourceKey>(this),
      finishQuarantinedSubsystemShutdown,
      notifyQuarantinedSubsystemShutdownComplete
    );
    cleanup_supervisor_->submitOrEscalate(
      subsystem_cleanup_job_, "media_runtime"
    );
    return true;
  }

  void run() {
    logRuntime("media_runtime_worker_start");
    const auto com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_initialized = SUCCEEDED(com_result);
    std::thread microphone_worker;
    std::thread microphone_operation_worker;
    std::thread screen_worker;
    std::thread camera_worker;
    std::thread query_worker;
    std::thread voice_worker;
    std::thread voice_control_worker;
    bool startup_ready = false;
    try {
      livekit_lifetime_->initialize();
      voice_worker = std::thread([this] {
        commandLoop("voice", voice_commands_, [this](auto& command) {
          handleVoice(command);
        });
      });
      voice_control_worker = std::thread([this] {
        commandLoop(
          "voice-control",
          voice_control_commands_,
          [this](auto& command) {
            VoiceControlCompletionGuard completion(
              voice_control_commands_,
              command
            );
            handleVoiceControl(command);
          }
        );
      });
      microphone_worker = std::thread([this] {
        commandLoop("microphone", microphone_commands_, [this](auto& command) {
          routeMicrophone(command);
        });
      });
      microphone_operation_worker = std::thread([this] {
        commandLoop(
          "microphone-operation",
          microphone_operations_,
          [this](const auto& command) {
            if (before_microphone_operation_) {
              before_microphone_operation_(command);
            }
            handleMicrophone(command);
          },
          false
        );
      });
      screen_worker = std::thread([this] {
        commandLoop("screen", screen_commands_, [this](auto& command) {
          handleScreen(command);
        });
      });
      camera_worker = std::thread([this] {
        commandLoop("camera", camera_commands_, [this](auto& command) {
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
      const auto actor_shutdown_deadline =
          std::chrono::steady_clock::now() + kNativeShutdownBudget;
      if (before_voice_shutdown_) {
        try { before_voice_shutdown_(); } catch (...) {}
      }
      if (!quarantineSubsystemShutdown(
            actor_shutdown_deadline,
            std::move(voice_worker),
            std::move(voice_control_worker),
            std::move(microphone_worker),
            std::move(microphone_operation_worker),
            std::move(screen_worker),
            std::move(camera_worker),
            std::move(query_worker)
          )) {
        throw std::runtime_error(
          "native runtime shutdown owner was not established"
        );
      }
      if (shutdown_command &&
          shutdown_command->type == NativeCommandType::Shutdown) {
        emitter_.emit(reply(*shutdown_command));
      }
      logRuntime("media_runtime_worker_exit_clean");
    } catch (const std::exception& error) {
      shutting_down_.store(true);
      closeWorkerQueues();
      joinIfRunning(voice_worker);
      joinIfRunning(voice_control_worker);
      joinIfRunning(microphone_worker);
      joinIfRunning(microphone_operation_worker);
      joinIfRunning(screen_worker);
      joinIfRunning(camera_worker);
      joinIfRunning(query_worker);
      if (!preview_session_id_.empty()) {
        microphone_.clearPreviewConsumer(preview_session_id_, preview_generation_);
      }
      const auto actor_shutdown_deadline =
          std::chrono::steady_clock::now() + kNativeShutdownBudget;
      try { preview_.shutdown(actor_shutdown_deadline); } catch (...) {}
      try { microphone_.shutdown(); } catch (...) {}
      try { screen_.shutdown(actor_shutdown_deadline); } catch (...) {}
      try { camera_.shutdown(actor_shutdown_deadline); } catch (...) {}
      try { voice_.shutdown(); } catch (...) {}
      if (!startup_ready) {
        markStartupFailed(error.what());
        if (com_initialized) CoUninitialize();
        return;
      }
      RuntimeEvent event;
      event.type = NativeEventType::RuntimeError;
      event.error = NativeError{"livekit_initialize_failed", error.what(), "initialize", false};
      emitter_.emit(std::move(event));
      logRuntime("media_runtime_worker_exit_fatal", {{"message", error.what()}});
      shutting_down_.store(true, std::memory_order_release);
      if (com_initialized) CoUninitialize();
      return;
    }
    if (com_initialized) CoUninitialize();
    logRuntime("media_runtime_worker_exit");
  }

  // Lifetime invariant: callback targets are declared before every actor that
  // captures them. Reverse member destruction therefore stops actors before
  // their queues, generation fences, LiveKit session/lease, and emitter die.
  SequencedEmitter emitter_;
  ActorMailbox<> voice_commands_;
  VoiceControlLane voice_control_commands_;
  BoundedQueue<MediaCommand, 256> microphone_commands_;
  BoundedQueue<MediaCommand, 256> microphone_operations_;
  ActorMailbox<> screen_commands_;
  ActorMailbox<> camera_commands_;
  BoundedQueue<MediaCommand, 256> query_commands_;
  BoundedQueue<MediaCommand, 4> control_commands_;
  std::atomic_bool shutting_down_{false};
  std::atomic_bool destroying_{false};
  std::atomic_uint32_t pending_commands_{0};
  GenerationFence desired_voice_;
  GenerationFence desired_microphone_;
  GenerationFence desired_microphone_warm_;
  GenerationFence desired_screen_;
  GenerationFence desired_camera_;
  DisplaySourceService display_sources_;
  CleanupSupervisor* cleanup_supervisor_;
  std::shared_ptr<CleanupJob> subsystem_cleanup_job_;
  SubsystemShutdownState subsystem_shutdown_;
  std::atomic_bool subsystem_cleanup_submitted_{false};
  std::shared_ptr<LiveKitRuntimeLifetime> livekit_lifetime_;
  std::shared_ptr<LiveKitVoiceSession> voice_session_;
  MediaRuntime::BeforeMicrophoneOperation before_microphone_operation_;
  MediaRuntime::BeforeVoiceShutdown before_voice_shutdown_;
  MediaRuntime::AfterSubsystemCleanup after_subsystem_cleanup_;
  AcceptedControlLossEscalation accepted_control_loss_;
  AcceptedControlPost accepted_control_post_;
  MicrophoneActor microphone_;
  ScreenActor screen_;
  CameraActor camera_;
  PreviewActor preview_;
  VoiceActor voice_;
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
  std::shared_ptr<LiveKitVoiceSession> voice_session,
  SteadyNow screen_now,
  BeforeMicrophoneOperation before_microphone_operation,
  BeforeVoiceShutdown before_voice_shutdown,
  std::shared_ptr<LiveKitRuntimeLifetime> livekit_lifetime,
  CleanupStartProbe subsystem_cleanup_start_probe,
  AfterSubsystemCleanup after_subsystem_cleanup,
  MicrophoneCaptureAdapter microphone_capture_adapter,
  MicrophoneIdleCaptureTiming microphone_idle_timing,
  ScreenFrameHandoffObserver screen_frame_handoff_observer,
  AfterScreenVideoPublished after_screen_video_published,
  ScreenVideoPublicationObserver screen_video_publication_observer
) : implementation_(std::make_shared<Implementation>(
      std::move(sink),
      std::move(voice_session),
      std::move(screen_now),
      std::move(before_microphone_operation),
      std::move(before_voice_shutdown),
      std::move(livekit_lifetime),
      std::move(subsystem_cleanup_start_probe),
      std::move(after_subsystem_cleanup),
      std::move(microphone_capture_adapter),
      std::move(microphone_idle_timing),
      std::move(screen_frame_handoff_observer),
      std::move(after_screen_video_published),
      std::move(screen_video_publication_observer)
    )) {
  implementation_->start();
}

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

PreviewQueueMetrics MediaRuntime::microphonePreviewQueueMetrics() const noexcept {
  return implementation_->microphonePreviewQueueMetrics();
}

}  // namespace syrnike::desktop_native::media
