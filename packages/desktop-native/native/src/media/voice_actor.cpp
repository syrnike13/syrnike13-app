#include "voice_actor.hpp"

#include "media_operation.hpp"
#include "voice_attempt_commit.hpp"

#include <atomic>
#include <chrono>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <utility>

namespace syrnike::desktop_native::media {
namespace {

constexpr auto kAttemptCommitDeadline = std::chrono::seconds(2);

std::uint64_t nextVoiceOwnerToken() noexcept {
  static std::atomic_uint64_t next_token{1};
  return next_token.fetch_add(1, std::memory_order_relaxed);
}

class VoicePostGate final {
 public:
  explicit VoicePostGate(VoiceActor::InternalPost post)
    : post_(std::move(post)) {}

  bool post(MediaCommand command) {
    std::lock_guard lock(mutex_);
    return open_ && post_ ? post_(std::move(command)) : false;
  }

  void close() {
    std::lock_guard lock(mutex_);
    open_ = false;
    post_ = {};
  }

 private:
  std::mutex mutex_;
  bool open_ = true;
  VoiceActor::InternalPost post_;
};

RuntimeEvent reply(const MediaCommand& command) {
  RuntimeEvent event;
  event.type = NativeEventType::Reply;
  event.request_id = command.request_id;
  event.session_id = command.session_id;
  event.generation = command.generation;
  event.ok = true;
  return event;
}

RuntimeEvent lifecycle(
  const MediaCommand& command,
  const char* status,
  std::string detail = {}
) {
  RuntimeEvent event;
  event.type = NativeEventType::SessionLifecycle;
  event.request_id = command.request_id;
  event.session_id = command.session_id;
  event.generation = command.generation;
  event.kind = "voice";
  event.status = status;
  event.detail = std::move(detail);
  return event;
}

RuntimeEvent cancelledReply(const MediaCommand& command) {
  auto event = reply(command);
  event.ok = false;
  event.error = NativeError{
    "stale_generation",
    "Voice connection attempt was superseded",
    "connectVoice",
    false,
    command.session_id,
    command.generation,
  };
  return event;
}

}  // namespace

class VoiceActor::Implementation {
 public:
  Implementation(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitVoiceSession> voice_session,
    CleanupStartProbe cleanup_start_probe,
    CleanupEnqueueProbe cleanup_enqueue_probe
  ) : emitter_(emitter),
      post_gate_(std::make_shared<VoicePostGate>(std::move(post))),
      is_current_(std::move(is_current)),
      voice_session_(std::move(voice_session)),
      cleanup_supervisor_(&CleanupSupervisor::instance()),
      cleanup_start_probe_(std::move(cleanup_start_probe)),
      cleanup_enqueue_probe_(
        std::move(cleanup_enqueue_probe)
      ) {}

  ~Implementation() { shutdown(); }

  void connect(const MediaCommand& command) {
    if (!is_current_(command.session_id, command.generation)) {
      throw std::runtime_error("stale voice connection generation");
    }
    if (command.livekit_url.empty() || command.livekit_token.empty()) {
      throw std::invalid_argument("voice LiveKit credentials are required");
    }

    retireAttempt();
    emitter_.emit(lifecycle(command, "starting", "livekit_connecting"));
    auto state = std::make_shared<AttemptState>();
    state->command = command;
    state->owner_epoch = SessionEpoch{
      command.session_id,
      command.generation,
      nextVoiceOwnerToken()
    };
    state->voice_session = voice_session_;
    state->cleanup_supervisor = cleanup_supervisor_;
    state->cleanup_enqueue_probe = cleanup_enqueue_probe_;
    state->cleanup_job = std::make_shared<CleanupJob>(cleanup_start_probe_);
    state->worker = std::thread([
      voice_session = voice_session_,
      post_gate = post_gate_,
      state
    ] {
      if (!state->commit.waitFor(
            std::chrono::duration_cast<std::chrono::milliseconds>(
              kAttemptCommitDeadline
            )
          )) {
        return;
      }
      const auto& command = state->command;
      MediaCommand completion;
      completion.type = NativeCommandType::VoiceConnectCompleted;
      completion.session_id = command.session_id;
      completion.generation = command.generation;
      completion.internal_epoch = state->owner_epoch.owner_token;
      auto post = [post_gate](MediaCommand command) {
        return post_gate->post(std::move(command));
      };
      try {
        auto call = SessionPortCall::forOwner(state->owner_epoch);
        call.deadline = state->operation.deadline();
        call.cancellation = state->cancellation;
        const auto connected = voice_session->lifecycle().connect(
          std::move(call), command.livekit_url, command.livekit_token, post
        );
        if (connected.hasError()) {
          completion.internal_message = describeSessionPortError(
            connected.error()
          );
          if (connected.error().code == SessionPortErrorCode::StaleOwner) {
            completion.video_source = "voice_connection_conflict";
          } else if (connected.error().code == SessionPortErrorCode::Timeout) {
            completion.video_source = "native_operation_timeout";
          }
        } else if (!connected.value().value) {
          completion.internal_message = "LiveKit voice connection failed";
        }
      } catch (const std::exception& error) {
        completion.internal_message = error.what();
        if (std::string_view(error.what()).starts_with("voice_connection_conflict:")) {
          completion.video_source = "voice_connection_conflict";
        }
      } catch (...) {
        completion.internal_message = "LiveKit voice connection failed";
      }
      if (state->operation.expired()) {
        if (completion.internal_message.empty()) {
          completion.internal_message = "LiveKit voice connection deadline expired";
        }
        completion.video_source = "native_operation_timeout";
      }
      if (state->operation.cancelled()) {
        disconnectOnce(*state, voice_session);
        return;
      }
      if (!post_gate->post(std::move(completion))) {
        Implementation::superviseCleanup(state);
      }
    });
    {
      std::lock_guard lock(mutex_);
      attempt_state_ = state;
    }
    state->commit.commit();
  }

  void disconnect(const MediaCommand& command, bool emit_events) {
    retireAttempt();
    if (!emit_events) return;
    emitter_.emit(reply(command));
    emitter_.emit(lifecycle(command, "stopped"));
  }

  void handleWorkerCommand(const MediaCommand& completion) {
    std::shared_ptr<AttemptState> state;
    {
      std::lock_guard lock(mutex_);
      if (!attempt_state_ ||
          attempt_state_->command.session_id != completion.session_id ||
          attempt_state_->command.generation != completion.generation ||
          attempt_state_->owner_epoch.owner_token !=
            completion.internal_epoch) {
        return;
      }
      state = std::move(attempt_state_);
      attempt_state_.reset();
    }
    if (state->worker.joinable()) state->worker.join();
    const auto& original = state->command;

    // A stale completion may retire only its exact Room-owner token. This
    // closes the old leak without allowing generation N cleanup to clear a
    // same-session generation N+1 replacement.
    if (!is_current_(completion.session_id, completion.generation)) {
      superviseCleanup(std::move(state));
      return;
    }
    if (!completion.internal_message.empty()) {
      NativeError error{
        completion.video_source.empty() ? "native_command_failed" : completion.video_source,
        completion.internal_message,
        "connectVoice",
        true,
        original.session_id,
        original.generation,
      };
      auto failed = reply(original);
      failed.ok = false;
      failed.error = error;
      emitter_.emit(std::move(failed));

      RuntimeEvent runtime_error;
      runtime_error.type = NativeEventType::RuntimeError;
      runtime_error.request_id = original.request_id;
      runtime_error.session_id = original.session_id;
      runtime_error.generation = original.generation;
      runtime_error.error = std::move(error);
      emitter_.emit(std::move(runtime_error));
      superviseCleanup(std::move(state));
      return;
    }
    bool superseded_before_commit = false;
    {
      std::lock_guard lock(mutex_);
      superseded_before_commit = attempt_state_ != nullptr;
      if (!superseded_before_commit) active_state_ = state;
    }
    if (superseded_before_commit) {
      superviseCleanup(std::move(state));
      return;
    }
    emitter_.emit(reply(original));
    emitter_.emit(lifecycle(original, "running"));
  }

  void shutdown() {
    if (shutdown_started_.exchange(true)) return;
    post_gate_->close();
    retireAttempt(false);
  }

 private:
  struct AttemptState {
    MediaCommand command;
    SessionEpoch owner_epoch;
    MediaOperation operation;
    VoiceAttemptCommit commit;
    livekit::OperationCancellation cancellation;
    std::atomic_bool disconnect_started{false};
    std::atomic_bool cleanup_submitted{false};
    std::shared_ptr<LiveKitVoiceSession> voice_session;
    CleanupSupervisor* cleanup_supervisor = nullptr;
    CleanupEnqueueProbe cleanup_enqueue_probe;
    std::thread worker;
    std::shared_ptr<CleanupJob> cleanup_job;
  };

  static void disconnectOwner(
    const std::shared_ptr<LiveKitVoiceSession>& voice_session,
    const SessionEpoch& owner_epoch
  ) noexcept {
    if (!voice_session || owner_epoch.owner_token == 0) return;
    try {
      static_cast<void>(voice_session->lifecycle().disconnect(
        SessionPortCall::forOwner(owner_epoch)
      ));
    } catch (...) {}
  }

  static void disconnectOnce(
    AttemptState& state,
    const std::shared_ptr<LiveKitVoiceSession>& voice_session
  ) noexcept {
    if (state.disconnect_started.exchange(true)) return;
    disconnectOwner(voice_session, state.owner_epoch);
  }

  static void superviseCleanup(std::shared_ptr<AttemptState> state) {
    if (!state) return;
    if (state->cleanup_submitted.exchange(true, std::memory_order_acq_rel)) {
      return;
    }
    if (!state->cleanup_job->prepare(
          state,
          static_cast<CleanupResourceKey>(state->owner_epoch.owner_token),
          [](void* owner) noexcept {
            auto* retired = static_cast<AttemptState*>(owner);
            disconnectOnce(*retired, retired->voice_session);
            if (retired->worker.joinable() &&
                retired->worker.get_id() != std::this_thread::get_id()) {
              retired->worker.join();
            }
          }
        )) {
      std::terminate();
    }
    runCleanupEnqueueProbe(state->cleanup_enqueue_probe);
    state->cleanup_supervisor->submitOrEscalate(state->cleanup_job, "voice");
  }

  void retireAttempt(bool emit_cancelled_reply = true) {
    std::shared_ptr<AttemptState> state;
    std::shared_ptr<AttemptState> active_state;
    {
      std::lock_guard lock(mutex_);
      state = std::move(attempt_state_);
      attempt_state_.reset();
      active_state = std::move(active_state_);
      active_state_.reset();
    }
    if (state) {
      state->operation.requestCancel();
      state->commit.cancel();
      state->cancellation.requestCancel();
    }
    if (emit_cancelled_reply && state && !state->command.request_id.empty()) {
      emitter_.emit(cancelledReply(state->command));
    }
    superviseCleanup(std::move(state));
    superviseCleanup(std::move(active_state));
  }

  SequencedEmitter& emitter_;
  std::shared_ptr<VoicePostGate> post_gate_;
  IsCurrent is_current_;
  std::shared_ptr<LiveKitVoiceSession> voice_session_;
  CleanupSupervisor* cleanup_supervisor_;
  CleanupStartProbe cleanup_start_probe_;
  CleanupEnqueueProbe cleanup_enqueue_probe_;
  std::atomic_bool shutdown_started_{false};
  std::mutex mutex_;
  std::shared_ptr<AttemptState> attempt_state_;
  std::shared_ptr<AttemptState> active_state_;
};

VoiceActor::VoiceActor(
  SequencedEmitter& emitter,
  InternalPost post,
  IsCurrent is_current,
  std::shared_ptr<LiveKitVoiceSession> voice_session,
  CleanupStartProbe cleanup_start_probe,
  CleanupEnqueueProbe cleanup_enqueue_probe
) : implementation_(std::make_unique<Implementation>(
      emitter,
      std::move(post),
      std::move(is_current),
      std::move(voice_session),
      std::move(cleanup_start_probe),
      std::move(cleanup_enqueue_probe)
    )) {}

VoiceActor::~VoiceActor() = default;
void VoiceActor::connect(const MediaCommand& command) { implementation_->connect(command); }
void VoiceActor::disconnect(const MediaCommand& command, bool emit_events) {
  implementation_->disconnect(command, emit_events);
}
void VoiceActor::handleWorkerCommand(const MediaCommand& command) {
  implementation_->handleWorkerCommand(command);
}
void VoiceActor::shutdown() { implementation_->shutdown(); }

}  // namespace syrnike::desktop_native::media
