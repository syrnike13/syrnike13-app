#include "voice_actor.hpp"

#include <mutex>
#include <optional>
#include <stdexcept>
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
    {
      std::lock_guard lock(mutex_);
      attempt_command_ = command;
      attempt_ = std::thread([this, command] {
        MediaCommand completion;
        completion.type = "__voiceConnectCompleted";
        completion.session_id = command.session_id;
        completion.generation = command.generation;
        try {
          if (!client_->connectVoice(
                command.session_id,
                command.generation,
                command.livekit_url,
                command.livekit_token,
                post_
              )) {
            completion.internal_message = "LiveKit voice connection failed";
          }
        } catch (const std::exception& error) {
          completion.internal_message = error.what();
        } catch (...) {
          completion.internal_message = "LiveKit voice connection failed";
        }
        if (!post_(std::move(completion))) return;
      });
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
    std::optional<MediaCommand> original;
    {
      std::lock_guard lock(mutex_);
      if (!attempt_command_ ||
          attempt_command_->session_id != completion.session_id ||
          attempt_command_->generation != completion.generation) {
        return;
      }
      attempt = std::move(attempt_);
      original = std::move(attempt_command_);
      attempt_command_.reset();
    }
    if (attempt.joinable()) attempt.join();

    // A disconnect or newer connect owns cancellation. A stale completion must
    // never call disconnectVoice(), because that Room may already belong to the
    // newer generation.
    if (!is_current_(completion.session_id, completion.generation)) return;
    if (!completion.internal_message.empty()) {
      NativeError error{
        "native_command_failed",
        completion.internal_message,
        "connectVoice",
        true,
        original->session_id,
        original->generation,
      };
      auto failed = reply(*original);
      failed.ok = false;
      failed.error = error;
      emitter_.emit(std::move(failed));

      RuntimeEvent runtime_error;
      runtime_error.type = "runtimeError";
      runtime_error.request_id = original->request_id;
      runtime_error.session_id = original->session_id;
      runtime_error.generation = original->generation;
      runtime_error.error = std::move(error);
      emitter_.emit(std::move(runtime_error));
      return;
    }
    emitter_.emit(reply(*original));
    emitter_.emit(lifecycle(*original, "running"));
  }

  void shutdown() { retireAttempt(false); }

 private:
  void retireAttempt(bool emit_cancelled_reply = true) {
    std::thread attempt;
    std::optional<MediaCommand> original;
    {
      std::lock_guard lock(mutex_);
      // Real LiveKit detaches the current Room under its own mutex before
      // disconnecting it, which makes waitConnected return cooperatively.
      client_->disconnectVoice();
      attempt = std::move(attempt_);
      original = std::move(attempt_command_);
      attempt_command_.reset();
    }
    if (attempt.joinable() && attempt.get_id() != std::this_thread::get_id()) {
      attempt.join();
    }
    if (emit_cancelled_reply && original && !original->request_id.empty()) {
      emitter_.emit(cancelledReply(*original));
    }
  }

  SequencedEmitter& emitter_;
  InternalPost post_;
  IsCurrent is_current_;
  std::shared_ptr<LiveKitPublicationClient> client_;
  std::mutex mutex_;
  std::thread attempt_;
  std::optional<MediaCommand> attempt_command_;
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
