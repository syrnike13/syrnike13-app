#include "voice_actor.hpp"

#include "media_operation.hpp"

#include <atomic>
#include <mutex>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <utility>

namespace syrnike::desktop_native::media {
namespace {

RuntimeEvent reply(const MediaCommand& command) {
  RuntimeEvent event;
  event.type = "reply";
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
  event.type = "sessionLifecycle";
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
    std::shared_ptr<LiveKitPublicationClient> client
  ) : emitter_(emitter), post_(std::move(post)), is_current_(std::move(is_current)),
      client_(std::move(client)) {}

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
    auto attempt = std::thread([
      client = client_,
      post = post_,
      state
    ] {
      while (!state->committed.load(std::memory_order_acquire)) {
        std::this_thread::yield();
      }
      const auto& command = state->command;
      MediaCommand completion;
      completion.type = "__voiceConnectCompleted";
      completion.session_id = command.session_id;
      completion.generation = command.generation;
      try {
        if (!client->connectVoice(
              command.session_id,
              command.generation,
              command.livekit_url,
              command.livekit_token,
              post
            )) {
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
      state->finished.store(true, std::memory_order_release);
      if (state->operation.cancelled()) return;
      post(std::move(completion));
    });
    {
      std::lock_guard lock(mutex_);
      attempt_state_ = state;
      attempt_ = std::move(attempt);
      state->committed.store(true, std::memory_order_release);
    }
  }

  void disconnect(const MediaCommand& command, bool emit_events) {
    retireAttempt();
    if (!emit_events) return;
    emitter_.emit(reply(command));
    emitter_.emit(lifecycle(command, "stopped"));
  }

  void handleWorkerCommand(const MediaCommand& completion) {
    std::thread attempt;
    std::shared_ptr<AttemptState> state;
    {
      std::lock_guard lock(mutex_);
      if (!attempt_state_ ||
          attempt_state_->command.session_id != completion.session_id ||
          attempt_state_->command.generation != completion.generation) {
        return;
      }
      attempt = std::move(attempt_);
      state = std::move(attempt_state_);
      attempt_state_.reset();
    }
    if (attempt.joinable()) attempt.join();
    const auto& original = state->command;

    // A disconnect or newer connect owns cancellation. A stale completion must
    // never call disconnectVoice(), because that Room may already belong to the
    // newer generation.
    if (!is_current_(completion.session_id, completion.generation)) return;
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
      runtime_error.type = "runtimeError";
      runtime_error.request_id = original.request_id;
      runtime_error.session_id = original.session_id;
      runtime_error.generation = original.generation;
      runtime_error.error = std::move(error);
      emitter_.emit(std::move(runtime_error));
      return;
    }
    emitter_.emit(reply(original));
    emitter_.emit(lifecycle(original, "running"));
  }

  void shutdown() { retireAttempt(false); }

 private:
  struct AttemptState {
    MediaCommand command;
    MediaOperation operation;
    std::atomic_bool committed{false};
    std::atomic_bool finished{false};
  };

  void retireAttempt(bool emit_cancelled_reply = true) {
    std::thread attempt;
    std::shared_ptr<AttemptState> state;
    {
      std::lock_guard lock(mutex_);
      attempt = std::move(attempt_);
      state = std::move(attempt_state_);
      attempt_state_.reset();
    }
    if (state) state->operation.requestCancel();
    // Real LiveKit detaches the current Room under its own mutex before
    // disconnecting it, which makes waitConnected return cooperatively.
    client_->disconnectVoice();
    if (attempt.joinable() && attempt.get_id() != std::this_thread::get_id()) {
      attempt.join();
    }
    if (emit_cancelled_reply && state && !state->command.request_id.empty()) {
      emitter_.emit(cancelledReply(state->command));
    }
  }

  SequencedEmitter& emitter_;
  InternalPost post_;
  IsCurrent is_current_;
  std::shared_ptr<LiveKitPublicationClient> client_;
  std::mutex mutex_;
  std::thread attempt_;
  std::shared_ptr<AttemptState> attempt_state_;
};

VoiceActor::VoiceActor(
  SequencedEmitter& emitter,
  InternalPost post,
  IsCurrent is_current,
  std::shared_ptr<LiveKitPublicationClient> client
) : implementation_(std::make_unique<Implementation>(
      emitter, std::move(post), std::move(is_current), std::move(client)
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
