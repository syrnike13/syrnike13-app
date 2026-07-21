#include "microphone_publication_controller.hpp"

#include <algorithm>
#include <chrono>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "../common/diagnostic_log.hpp"
#include "audio_constants.hpp"
#include "livekit_connect_policy.hpp"
#include "media_operation.hpp"

namespace syrnike::desktop_native::media {
namespace {

using diagnostics::DiagnosticField;

void logPublication(std::string_view event,
                    std::initializer_list<DiagnosticField> fields = {}) {
  auto &logger = diagnostics::DiagnosticLog::instance();
  if (!logger.enabled()) return;
  logger.write(std::string("microphone_publication_") + std::string(event),
               fields);
}

std::string processingMode(bool enabled) {
  return enabled ? "software" : "disabled";
}

RuntimeEvent lifecycle(const MediaCommand &command, const char *status,
                       std::string detail = {}) {
  RuntimeEvent event;
  event.type = "sessionLifecycle";
  event.request_id = command.request_id;
  event.session_id = command.session_id;
  event.generation = command.generation;
  event.kind = "microphone";
  event.status = status;
  event.detail = std::move(detail);
  return event;
}

RuntimeEvent startedReply(const MediaCommand &command,
                          const MicrophonePipelineSnapshot &pipeline) {
  RuntimeEvent result;
  result.type = "reply";
  result.request_id = command.request_id;
  result.session_id = command.session_id;
  result.generation = command.generation;
  result.ok = true;
  result.kind = "microphone";
  result.audio_mode = "microphone";
  result.noise_suppression = processingMode(pipeline.noise_suppression_enabled);
  result.echo_cancellation = processingMode(pipeline.echo_cancellation_enabled);
  result.native_participant_identity = command.participant_identity;
  result.device_id = pipeline.device_id;
  result.revision = pipeline.revision;
  return result;
}

RuntimeEvent failedReply(const MediaCommand &command, const std::string &code,
                         const std::string &message, bool retryable,
                         std::string stage = {},
                         std::optional<std::int64_t> hresult = {}) {
  RuntimeEvent event;
  event.type = "reply";
  event.request_id = command.request_id;
  event.session_id = command.session_id;
  event.generation = command.generation;
  event.ok = false;
  event.error = NativeError{
      .code = code,
      .message = message,
      .stage = stage.empty() ? command.type : std::move(stage),
      .retryable = retryable,
      .session_id = command.session_id,
      .generation = command.generation,
      .hresult = hresult,
  };
  return event;
}

std::string terminalFailureCode(const MediaCommand &command) {
  return command.video_source.empty() ? "microphone_runtime_lost"
                                      : command.video_source;
}

std::string terminalFailureStage(const MediaCommand &command) {
  return command.device_kind.empty() ? "microphone_publication"
                                     : command.device_kind;
}

std::optional<std::int64_t> terminalFailureHresult(
    const MediaCommand &command) {
  if (command.diagnostic_hresult == 0) return std::nullopt;
  return command.diagnostic_hresult;
}

}  // namespace

void validateMicrophonePublicationCommand(const MediaCommand &command) {
  if (command.session_id.empty())
    throw std::invalid_argument("sessionId is required");
  if (command.participant_identity.empty()) {
    throw std::invalid_argument("participantIdentity is required");
  }
}

MediaCommand trackCommand(MediaCommand command) {
  command.livekit_url.clear();
  command.livekit_token.clear();
  return command;
}

struct MicrophonePublicationController::PublishedTrack {
  std::string session_id;
  std::uint64_t generation = 0;
  std::string participant_identity;
  std::string publication_sid;
  std::unique_ptr<LiveKitTrackPublication> publication;
  std::shared_ptr<livekit::AudioSource> source;
  std::shared_ptr<livekit::LocalAudioTrack> track;
};

struct MicrophonePublicationController::AttemptState {
  MediaCommand command;
  MicrophonePipelineSnapshot pipeline;
  std::shared_ptr<livekit::AudioSource> source;
  std::shared_ptr<livekit::LocalAudioTrack> track;
  std::unique_ptr<LiveKitTrackPublication> publication;
  std::thread worker;
  std::mutex mutex;
  MediaOperation operation;
  std::atomic_bool finished{false};
  bool desired_muted = false;
  bool succeeded = false;
  bool stale = false;
  bool outcome_emitted = false;
  bool sink_attached = false;
  std::string publication_sid;
  std::string error;
};

struct MicrophonePublicationController::RetiringState {
  std::string session_id;
  std::uint64_t generation = 0;
  std::shared_ptr<PublishedTrack> track;
  std::thread worker;
  LiveKitConnectPolicy::Clock::time_point started_at =
      LiveKitConnectPolicy::Clock::now();
  std::atomic_bool finished{false};
};

struct FallbackTransportLoss {
  std::string session_id;
  std::uint64_t generation = 0;
  std::string detail;
  std::string code;
  std::string stage;
  bool retryable = true;
  std::optional<std::int64_t> hresult;
};

class MicrophonePublicationController::Implementation {
 public:
  Implementation(SequencedEmitter &emitter, InternalPost post,
                 IsCurrent is_current, AddSink add_sink, RemoveSink remove_sink,
                 CaptureHealthy capture_healthy,
                 std::shared_ptr<LiveKitPublicationClient> livekit_client,
                 ApplyMute apply_mute)
      : emitter_(emitter),
        post_(std::move(post)),
        is_current_(std::move(is_current)),
        add_sink_(std::move(add_sink)),
        remove_sink_(std::move(remove_sink)),
        capture_healthy_(std::move(capture_healthy)),
        livekit_client_(std::move(livekit_client)),
        apply_mute_(std::move(apply_mute)) {
    if (!apply_mute_) {
      apply_mute_ = [](const auto &track, bool muted) {
        if (!track) return;
        if (muted)
          track->mute();
        else
          track->unmute();
      };
    }
  }

  ~Implementation() { shutdown(); }

  void start(const MediaCommand &command,
             const MicrophonePipelineSnapshot &pipeline) {
    reapFinishedRetiring();
    reapFinishedCandidate();
    if (!is_current_(command.session_id, command.generation)) {
      throw std::runtime_error("stale microphone connect generation");
    }
    validateMicrophonePublicationCommand(command);
    if (!capture_healthy_()) {
      throw std::runtime_error(
          "microphone capture pipeline is not healthy at connect start");
    }

    if (candidate_) {
      cancelAttempt(candidate_, "stale microphone connect generation");
      const auto status = capacityStatus(LiveKitConnectPolicy::Clock::now());
      emitter_.emit(failedReply(
          command,
          status == MicrophonePublicationCapacityStatus::ActorUnresponsive
              ? "actor_unresponsive"
              : "actor_busy",
          "previous microphone publication attempt is still outstanding",
          true));
      return;
    }
    if (retiring_ || committed_pending_retire_) {
      const auto status = capacityStatus(LiveKitConnectPolicy::Clock::now());
      emitter_.emit(failedReply(
          command,
          status == MicrophonePublicationCapacityStatus::ActorUnresponsive
              ? "actor_unresponsive"
              : "actor_busy",
          "microphone retirement capacity is still occupied", true));
      return;
    }

    auto attempt = std::make_shared<AttemptState>();
    attempt->command = trackCommand(command);
    attempt->pipeline = pipeline;
    attempt->desired_muted = command.muted;
    attempt->source = std::make_shared<livekit::AudioSource>(
        syrnike::voice::kSampleRate,
        syrnike::voice::kChannels);
    candidate_ = attempt;

    emitter_.emit(lifecycle(command, "starting", "livekit_connecting"));
    try {
      attempt->worker = std::thread([this, attempt] { runAttempt(attempt); });
    } catch (...) {
      removeAttemptSink(attempt);
      candidate_.reset();
      throw;
    }
  }

  void setMuted(const MediaCommand &command) {
    bool matched = false;
    if (candidate_ && candidate_->command.session_id == command.session_id) {
      std::lock_guard lock(candidate_->mutex);
      candidate_->desired_muted = command.muted;
      matched = true;
    }
    if (committed_ && committed_->session_id == command.session_id) {
      muted_ = command.muted;
      if (committed_->track) {
        if (muted_)
          committed_->track->mute();
        else
          committed_->track->unmute();
      }
      matched = true;
    }
    if (!matched && (committed_ || candidate_)) {
      throw std::runtime_error("stale microphone mute generation");
    }
  }

  void disconnect(const MediaCommand &command, bool emit_stopped) {
    reapFinishedRetiring();
    reapFinishedCandidate();
    if (command.type == "disconnectMicrophone" && !command.session_id.empty() &&
        !is_current_(command.session_id, command.generation)) {
      throw std::runtime_error("stale microphone disconnect generation");
    }
    if (candidate_) {
      cancelAttempt(candidate_, "microphone connect cancelled by disconnect");
    }
    if (!committed_) return;
    if (!command.session_id.empty() &&
        committed_->session_id != command.session_id)
      return;

    const auto stopped_session_id = committed_->session_id;
    const auto stopped_generation = committed_->generation;
    retireCommittedOrDefer();
    if (emit_stopped) {
      RuntimeEvent stopped;
      stopped.type = "sessionStopped";
      stopped.request_id = command.request_id;
      stopped.session_id =
          command.session_id.empty() ? stopped_session_id : command.session_id;
      stopped.generation =
          command.session_id.empty() ? stopped_generation : command.generation;
      stopped.reason = "disconnected";
      emitter_.emit(std::move(stopped));
    }
  }

  void handleTerminal(const MediaCommand &command) {
    reapFinishedRetiring();
    const auto code = terminalFailureCode(command);
    const auto stage = terminalFailureStage(command);
    const auto hresult = terminalFailureHresult(command);
    const bool retryable = command.video_source.empty()
                               ? true
                               : command.diagnostic_retryable;
    if (candidate_ && candidate_->command.session_id == command.session_id &&
        candidate_->command.generation == command.generation) {
      cancelAttempt(candidate_, command.internal_message, true, code, stage,
                    retryable, hresult);
      return;
    }
    if (committed_ && committed_->session_id == command.session_id &&
        committed_->generation == command.generation) {
      if (candidate_ &&
          candidate_->command.session_id == command.session_id &&
          is_current_(candidate_->command.session_id,
                      candidate_->command.generation)) {
        fallback_transport_loss_ = FallbackTransportLoss{
            command.session_id, command.generation, command.internal_message,
            code, stage, retryable, hresult};
        retireCommittedOrDefer();
        logPublication(
            "fallback_transport_lost_during_candidate",
            {{"sessionId", command.session_id},
             {"generation", command.generation},
             {"candidateGeneration", candidate_->command.generation}});
        return;
      }
      retireCommittedOrDefer();
      RuntimeEvent event;
      event.type = "sessionLifecycle";
      event.session_id = command.session_id;
      event.generation = command.generation;
      event.kind = "microphone";
      event.status = "error";
      event.detail = command.internal_message;
      event.error = NativeError{
          .code = code,
          .message = command.internal_message,
          .stage = stage,
          .retryable = retryable,
          .session_id = command.session_id,
          .generation = command.generation,
          .hresult = hresult,
      };
      emitter_.emit(std::move(event));
      RuntimeEvent stopped;
      stopped.type = "sessionStopped";
      stopped.session_id = command.session_id;
      stopped.generation = command.generation;
      stopped.reason = "runtime_error";
      emitter_.emit(std::move(stopped));
    }
  }

  void handleWorkerCommand(const MediaCommand &command) {
    if (command.type == "__microphoneAttemptReady") {
      finishAttempt(command.session_id, command.generation);
      return;
    }
    if (command.type == "__microphoneAttemptFailed") {
      finishAttempt(command.session_id, command.generation);
      return;
    }
    if (command.type == "__microphoneRetireDone") {
      if (retiring_ && retiring_->session_id == command.session_id &&
          retiring_->generation == command.generation) {
        finishRetiring();
      }
    }
  }

  void updatePendingPipeline(
      const std::string &session_id, std::uint64_t generation,
      const MicrophonePipelineSnapshot &pipeline) {
    if (!candidate_ || (!session_id.empty() &&
        (candidate_->command.session_id != session_id ||
         candidate_->command.generation != generation))) return;
    std::lock_guard lock(candidate_->mutex);
    candidate_->pipeline = pipeline;
  }

  void shutdown() {
    if (candidate_) {
      cancelAttempt(candidate_, "microphone runtime is shutting down");
      waitJoin(candidate_->worker);
      disconnectAttemptBlocking(candidate_);
      candidate_.reset();
    }
    if (committed_) {
      remove_sink_(committed_->source);
      auto previous = std::move(committed_);
      unpublishTrackBlocking(*previous);
    }
    committed_pending_retire_ = false;
    committed_pending_since_.reset();
    if (retiring_) {
      waitJoin(retiring_->worker);
      if (!retiring_->finished.load(std::memory_order_acquire) &&
          retiring_->track) {
        unpublishTrackBlocking(*retiring_->track);
      }
      retiring_.reset();
    }
  }

  std::string activeSessionId() const {
    return committed_ && !committed_pending_retire_ ? committed_->session_id
                                                    : std::string{};
  }

  std::uint64_t activeGeneration() const {
    return committed_ && !committed_pending_retire_ ? committed_->generation
                                                    : 0;
  }

  bool hasBlockedCapacity() const {
    return capacityStatus(LiveKitConnectPolicy::Clock::now()) !=
           MicrophonePublicationCapacityStatus::Available;
  }

  MicrophonePublicationCapacityStatus capacityStatus(
      LiveKitConnectPolicy::Clock::time_point now) const {
    std::optional<LiveKitConnectPolicy::Clock::time_point> oldest;
    const auto include =
        [&](LiveKitConnectPolicy::Clock::time_point started_at) {
          if (!oldest || started_at < *oldest) oldest = started_at;
        };
    if (candidate_) include(candidate_->operation.startedAt());
    if (retiring_) include(retiring_->started_at);
    if (committed_pending_retire_ && committed_pending_since_) {
      include(*committed_pending_since_);
    }
    if (!oldest) return MicrophonePublicationCapacityStatus::Available;
    if (now - *oldest >= LiveKitConnectPolicy::kNativeOperationDeadline) {
      return MicrophonePublicationCapacityStatus::ActorUnresponsive;
    }
    return MicrophonePublicationCapacityStatus::ActorBusy;
  }

 private:
  void runAttempt(const std::shared_ptr<AttemptState> &attempt) {
    std::unique_ptr<LiveKitTrackPublication> candidate_publication;
    std::string candidate_publication_sid;
    try {
      candidate_publication = livekit_client_->createMicrophonePublication(
          attempt->command.session_id, attempt->command.generation);
      if (!candidate_publication->isRoomConnected()) {
        throw std::runtime_error("LiveKit voice Room is not connected");
      }
      if (!isCurrentCandidate(attempt)) {
        throw std::runtime_error("stale microphone connect generation");
      }
      auto track = livekit_client_->createMicrophoneTrack(attempt->source);
      livekit::AudioEncodingOptions audio_encoding;
      audio_encoding.max_bitrate = attempt->command.audio_bitrate;
      livekit::TrackPublishOptions publish_options;
      publish_options.audio_encoding = audio_encoding;
      publish_options.dtx = true;
      publish_options.source = livekit::TrackSource::SOURCE_MICROPHONE;
      candidate_publication_sid =
          candidate_publication->publishAudioTrack(track, publish_options);
      if (candidate_publication_sid.empty()) {
        throw std::runtime_error(
            "LiveKit microphone publication was not acknowledged");
      }
      logPublication(
          "publish_acknowledged",
          {{"sessionId", attempt->command.session_id},
           {"generation", attempt->command.generation}});
      if (!capture_healthy_()) {
        throw std::runtime_error(
            "microphone capture pipeline is not healthy at commit");
      }
      if (!isCurrentCandidate(attempt)) {
        throw std::runtime_error("stale microphone publish generation");
      }
      {
        std::lock_guard lock(attempt->mutex);
        attempt->publication = std::move(candidate_publication);
        attempt->track = std::move(track);
        attempt->publication_sid = std::move(candidate_publication_sid);
        attempt->succeeded = true;
      }
      attempt->finished.store(true, std::memory_order_release);
      MediaCommand internal;
      internal.type = "__microphoneAttemptReady";
      internal.session_id = attempt->command.session_id;
      internal.generation = attempt->command.generation;
      post_(std::move(internal));
    } catch (const std::exception &error) {
      {
        std::lock_guard lock(attempt->mutex);
        attempt->stale = isStaleMessage(error.what());
        attempt->error = error.what();
        attempt->succeeded = false;
      }
      if (candidate_publication && !candidate_publication_sid.empty()) {
        try {
          candidate_publication->unpublishTrack(candidate_publication_sid);
        } catch (...) {
        }
      }
      attempt->finished.store(true, std::memory_order_release);
      MediaCommand internal;
      internal.type = "__microphoneAttemptFailed";
      internal.session_id = attempt->command.session_id;
      internal.generation = attempt->command.generation;
      internal.internal_message = error.what();
      post_(std::move(internal));
    }
  }

  bool isCurrentCandidate(const std::shared_ptr<AttemptState> &attempt) {
    std::lock_guard lock(attempt->mutex);
    return !attempt->operation.cancelled() &&
           !attempt->operation.expired() &&
           is_current_(attempt->command.session_id,
                       attempt->command.generation);
  }

  void finishAttempt(const std::string &session_id, std::uint64_t generation) {
    if (!candidate_ || candidate_->command.session_id != session_id ||
        candidate_->command.generation != generation)
      return;
    auto attempt = candidate_;
    if (!attempt->finished.load(std::memory_order_acquire)) return;
    waitJoin(attempt->worker);
    bool succeeded = false;
    bool stale = false;
    bool expired = false;
    bool desired_muted = false;
    std::string error;
    {
      std::lock_guard lock(attempt->mutex);
      succeeded = attempt->succeeded;
      stale = attempt->stale || attempt->operation.cancelled();
      expired = attempt->operation.expired();
      desired_muted = attempt->desired_muted;
      error = attempt->error;
    }
    stale = stale || !is_current_(session_id, generation);

    if (!succeeded || stale || expired) {
      removeAttemptSink(attempt);
      emitAttemptFailureOnce(
          attempt, stale ? "stale_generation" :
            (expired ? "native_operation_timeout" : "native_command_failed"),
          expired ? "microphone publication deadline expired" :
            (error.empty() ? (stale ? "stale microphone publish generation"
                                 : "microphone publication failed")
                        : error),
          !stale);
      if (attempt->publication && retiring_) {
        return;
      }
      if (attempt->publication) {
        auto cleanup = takePublishedTrack(attempt);
        tryStartRetiring(std::move(cleanup));
      }
      candidate_.reset();
      emitFallbackLossIfUnrecoverable(session_id);
      return;
    }

    // Promotion is actor-owned. A worker-side generation check is only an
    // optimization because dispatch may advance the fence between that check
    // and this completion message.
    if (!is_current_(session_id, generation)) {
      removeAttemptSink(attempt);
      emitAttemptFailureOnce(attempt, "stale_generation",
                             "stale microphone publish generation", false);
      if (attempt->publication && retiring_) {
        return;
      }
      if (attempt->publication) {
        auto cleanup = takePublishedTrack(attempt);
        tryStartRetiring(std::move(cleanup));
      }
      candidate_.reset();
      emitFallbackLossIfUnrecoverable(session_id);
      return;
    }

    if (retiring_ || committed_pending_retire_) {
      return;
    }

    try {
      apply_mute_(attempt->track, desired_muted);
    } catch (const std::exception &mute_error) {
      removeAttemptSink(attempt);
      emitAttemptFailureOnce(attempt, "native_command_failed",
                             mute_error.what(), true);
      auto cleanup = takePublishedTrack(attempt);
      tryStartRetiring(std::move(cleanup));
      candidate_.reset();
      emitFallbackLossIfUnrecoverable(session_id);
      return;
    }

    if (!is_current_(session_id, generation)) {
      removeAttemptSink(attempt);
      emitAttemptFailureOnce(attempt, "stale_generation",
                             "stale microphone publish generation", false);
      auto cleanup = takePublishedTrack(attempt);
      tryStartRetiring(std::move(cleanup));
      candidate_.reset();
      emitFallbackLossIfUnrecoverable(session_id);
      return;
    }

    add_sink_(attempt->source, session_id, generation);
    attempt->sink_attached = true;
    logPublication(
        "committed",
        {{"sessionId", session_id},
         {"generation", generation},
         {"muted", desired_muted}});

    if (!is_current_(session_id, generation)) {
      removeAttemptSink(attempt);
      emitAttemptFailureOnce(attempt, "stale_generation",
                             "stale microphone publish generation", false);
      auto cleanup = takePublishedTrack(attempt);
      tryStartRetiring(std::move(cleanup));
      candidate_.reset();
      emitFallbackLossIfUnrecoverable(session_id);
      return;
    }

    auto next = takePublishedTrack(attempt);
    candidate_.reset();
    if (fallback_transport_loss_ &&
        fallback_transport_loss_->session_id == session_id) {
      fallback_transport_loss_.reset();
    }

    auto previous = std::move(committed_);
    committed_ = std::move(next);
    muted_ = desired_muted;
    emitter_.emit(startedReply(attempt->command, attempt->pipeline));
    RuntimeEvent started = startedReply(attempt->command, attempt->pipeline);
    started.type = "sessionStarted";
    started.ok = true;
    emitter_.emit(std::move(started));
    emitter_.emit(lifecycle(attempt->command, "running"));
    if (previous) {
      remove_sink_(previous->source);
      tryStartRetiring(std::move(previous));
    }
  }

  bool tryStartRetiring(std::unique_ptr<PublishedTrack> track) {
    if (!track) return true;
    if (retiring_) return false;
    retiring_ = std::make_shared<RetiringState>();
    retiring_->session_id = track->session_id;
    retiring_->generation = track->generation;
    retiring_->track = std::shared_ptr<PublishedTrack>(std::move(track));
    const auto state = retiring_;
    try {
      state->worker = std::thread([this, state] {
        unpublishTrackBlocking(*state->track);
        state->finished.store(true, std::memory_order_release);
        MediaCommand internal;
        internal.type = "__microphoneRetireDone";
        internal.session_id = state->session_id;
        internal.generation = state->generation;
        post_(std::move(internal));
      });
    } catch (...) {
      logPublication("retiring_worker_launch_failed",
                     {{"sessionId", state->session_id},
                      {"generation", state->generation}});
      return false;
    }
    return true;
  }

  void retireCommittedOrDefer() {
    if (!committed_) return;
    remove_sink_(committed_->source);
    if (retiring_) {
      committed_pending_retire_ = true;
      if (!committed_pending_since_) {
        committed_pending_since_ = LiveKitConnectPolicy::Clock::now();
      }
      logPublication("retiring_slot_busy",
                     {{"sessionId", committed_->session_id},
                      {"generation", committed_->generation}});
      return;
    }
    auto previous = std::move(committed_);
    committed_pending_retire_ = false;
    committed_pending_since_.reset();
    tryStartRetiring(std::move(previous));
  }

  void drainDeferredCleanup() {
    if (retiring_) return;
    if (committed_pending_retire_ && committed_) {
      auto previous = std::move(committed_);
      committed_pending_retire_ = false;
      committed_pending_since_.reset();
      tryStartRetiring(std::move(previous));
      return;
    }
    committed_pending_retire_ = false;
    committed_pending_since_.reset();
    reapFinishedCandidate();
  }

  void finishRetiring() {
    if (!retiring_) return;
    waitJoin(retiring_->worker);
    retiring_.reset();
    drainDeferredCleanup();
  }

  void removeAttemptSink(const std::shared_ptr<AttemptState> &attempt) {
    if (!attempt || !attempt->sink_attached) return;
    attempt->sink_attached = false;
    remove_sink_(attempt->source);
  }

  void emitFallbackLossIfUnrecoverable(const std::string &session_id) {
    if (!fallback_transport_loss_ ||
        fallback_transport_loss_->session_id != session_id) {
      return;
    }
    const auto loss = std::move(*fallback_transport_loss_);
    fallback_transport_loss_.reset();

    MediaCommand logical;
    logical.session_id = loss.session_id;
    logical.generation = loss.generation;
    auto failed = lifecycle(logical, "error", loss.detail);
    failed.error = NativeError{
        .code = loss.code,
        .message = loss.detail,
        .stage = loss.stage,
        .retryable = loss.retryable,
        .session_id = loss.session_id,
        .generation = loss.generation,
        .hresult = loss.hresult,
    };
    emitter_.emit(std::move(failed));

    RuntimeEvent stopped;
    stopped.type = "sessionStopped";
    stopped.session_id = loss.session_id;
    stopped.generation = loss.generation;
    stopped.reason = "runtime_error";
    emitter_.emit(std::move(stopped));
  }

  void emitAttemptFailureOnce(const std::shared_ptr<AttemptState> &attempt,
                              const std::string &code,
                              const std::string &message, bool retryable,
                              std::string stage = {},
                              std::optional<std::int64_t> hresult = {}) {
    if (!attempt || attempt->outcome_emitted) return;
    attempt->outcome_emitted = true;
    emitter_.emit(failedReply(attempt->command, code, message, retryable,
                              std::move(stage), hresult));
  }

  void cancelAttempt(const std::shared_ptr<AttemptState> &attempt,
                     const std::string &reason, bool emit_terminal = false,
                     std::string code = "microphone_runtime_lost",
                     std::string stage = "microphone_publication",
                     bool retryable = true,
                     std::optional<std::int64_t> hresult = {}) {
    if (!attempt) return;
    {
      std::lock_guard lock(attempt->mutex);
      attempt->operation.requestCancel();
      attempt->error = reason;
    }
    removeAttemptSink(attempt);
    if (emit_terminal && !attempt->outcome_emitted) {
      auto failed = lifecycle(attempt->command, "error", reason);
      failed.error = NativeError{
          .code = code,
          .message = reason,
          .stage = stage,
          .retryable = retryable,
          .session_id = attempt->command.session_id,
          .generation = attempt->command.generation,
          .hresult = hresult,
      };
      emitter_.emit(std::move(failed));
      emitAttemptFailureOnce(
          attempt, code,
          reason.empty() ? "microphone publication terminated" : reason,
          retryable, std::move(stage), hresult);
    }
  }

  void reapFinishedCandidate() {
    if (!candidate_ || !candidate_->finished.load(std::memory_order_acquire))
      return;
    const auto session_id = candidate_->command.session_id;
    const auto generation = candidate_->command.generation;
    finishAttempt(session_id, generation);
  }

  void reapFinishedRetiring() {
    if (!retiring_ || !retiring_->finished.load(std::memory_order_acquire))
      return;
    finishRetiring();
  }

  static std::unique_ptr<PublishedTrack> takePublishedTrack(
      const std::shared_ptr<AttemptState> &attempt) {
    auto room = std::make_unique<PublishedTrack>();
    room->session_id = attempt->command.session_id;
    room->generation = attempt->command.generation;
    room->participant_identity = attempt->command.participant_identity;
    room->publication_sid = std::move(attempt->publication_sid);
    room->source = std::move(attempt->source);
    room->track = std::move(attempt->track);
    room->publication = std::move(attempt->publication);
    return room;
  }

  static void unpublishTrackBlocking(PublishedTrack &room) {
    if (room.publication) {
      if (!room.publication_sid.empty()) {
        try {
          room.publication->unpublishTrack(room.publication_sid);
          logPublication(
              "unpublished",
              {{"sessionId", room.session_id},
               {"generation", room.generation}});
        } catch (...) {
          logPublication(
              "unpublish_failed",
              {{"sessionId", room.session_id},
               {"generation", room.generation}});
        }
      }
    }
  }

  static void disconnectAttemptBlocking(
      const std::shared_ptr<AttemptState> &attempt) {
    if (!attempt || !attempt->publication) return;
    if (!attempt->publication_sid.empty()) {
      try {
        attempt->publication->unpublishTrack(attempt->publication_sid);
      } catch (...) {
      }
    }
  }

  static void waitJoin(std::thread &worker) {
    if (worker.joinable()) worker.join();
  }

  static bool isStaleMessage(std::string_view message) {
    return message.starts_with("stale ");
  }

  SequencedEmitter &emitter_;
  InternalPost post_;
  IsCurrent is_current_;
  AddSink add_sink_;
  RemoveSink remove_sink_;
  CaptureHealthy capture_healthy_;
  std::shared_ptr<LiveKitPublicationClient> livekit_client_;
  ApplyMute apply_mute_;
  std::unique_ptr<PublishedTrack> committed_;
  std::shared_ptr<AttemptState> candidate_;
  std::shared_ptr<RetiringState> retiring_;
  bool committed_pending_retire_ = false;
  std::optional<LiveKitConnectPolicy::Clock::time_point>
      committed_pending_since_;
  bool muted_ = false;
  std::optional<FallbackTransportLoss> fallback_transport_loss_;
};

MicrophonePublicationController::MicrophonePublicationController(
    SequencedEmitter &emitter, InternalPost post, IsCurrent is_current,
    AddSink add_sink, RemoveSink remove_sink, CaptureHealthy capture_healthy,
    std::shared_ptr<LiveKitPublicationClient> livekit_client,
    ApplyMute apply_mute)
    : implementation_(std::make_unique<Implementation>(
          emitter, std::move(post), std::move(is_current), std::move(add_sink),
          std::move(remove_sink), std::move(capture_healthy),
          std::move(livekit_client), std::move(apply_mute))) {}

MicrophonePublicationController::~MicrophonePublicationController() = default;
void MicrophonePublicationController::start(
    const MediaCommand &command, const MicrophonePipelineSnapshot &pipeline) {
  implementation_->start(command, pipeline);
}
void MicrophonePublicationController::setMuted(const MediaCommand &command) {
  implementation_->setMuted(command);
}
void MicrophonePublicationController::disconnect(const MediaCommand &command,
                                                 bool emit_stopped) {
  implementation_->disconnect(command, emit_stopped);
}
void MicrophonePublicationController::handleTerminal(
    const MediaCommand &command) {
  implementation_->handleTerminal(command);
}
void MicrophonePublicationController::handleWorkerCommand(
    const MediaCommand &command) {
  implementation_->handleWorkerCommand(command);
}
void MicrophonePublicationController::updatePendingPipeline(
    const std::string &session_id, std::uint64_t generation,
    const MicrophonePipelineSnapshot &pipeline) {
  implementation_->updatePendingPipeline(session_id, generation, pipeline);
}
void MicrophonePublicationController::shutdown() {
  implementation_->shutdown();
}
std::string MicrophonePublicationController::activeSessionId() const {
  return implementation_->activeSessionId();
}
std::uint64_t MicrophonePublicationController::activeGeneration() const {
  return implementation_->activeGeneration();
}
MicrophonePublicationCapacityStatus
MicrophonePublicationController::capacityStatus(
    std::chrono::steady_clock::time_point now) const {
  return implementation_->capacityStatus(now);
}
bool MicrophonePublicationController::hasBlockedCapacity() const {
  return implementation_->hasBlockedCapacity();
}

}  // namespace syrnike::desktop_native::media
