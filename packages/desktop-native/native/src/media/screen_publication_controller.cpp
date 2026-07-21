#include "screen_publication_controller.hpp"

#include <livekit/local_audio_track.h>
#include <livekit/local_video_track.h>

#include <algorithm>
#include <chrono>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string_view>
#include <utility>

#include "../common/diagnostic_log.hpp"
#include "livekit_connect_policy.hpp"
#include "media_operation.hpp"

namespace syrnike::desktop_native::media {
namespace {

using diagnostics::DiagnosticField;

std::string sanitizeDiagnosticMessage(std::string_view message) {
  return diagnostics::redactForDiagnostics(message);
}

std::uint64_t steadyNowMs() {
  return diagnostics::DiagnosticLog::instance().steadyNowMs();
}

void logScreen(
  std::string_view event,
  std::initializer_list<DiagnosticField> fields = {}
) {
  auto& logger = diagnostics::DiagnosticLog::instance();
  if (!logger.enabled()) return;
  logger.write(event, fields);
}

int screenBitrate(int requested) {
  return std::clamp(requested, 625'000, 10'000'000);
}

std::string screenFailureCode(std::string_view message) {
  constexpr std::string_view typed_codes[] = {
    "gpu_capture_unavailable",
    "gpu_encoder_unavailable",
    "gpu_interop_unavailable",
    "gpu_device_lost",
    "target_closed",
  };
  for (const auto code : typed_codes) {
    if (message == code ||
        (message.starts_with(code) && message.size() > code.size() &&
         message[code.size()] == ':')) {
      return std::string(code);
    }
  }
  return "native_command_failed";
}

}  // namespace

class ScreenPublicationController::Implementation {
 public:
  Implementation(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitPublicationClient> livekit_client,
    CommitIfCurrent commit_if_current,
    Now now,
    DescribePublication describe_publication,
    StartCaptureWorkers start_capture_workers,
    CapturePromoted capture_promoted,
    QueryEncoderCapability query_encoder_capability,
    CreateVideoSource create_video_source
  ) : emitter_(emitter),
      post_(std::move(post)),
      is_current_(std::move(is_current)),
      livekit_client_(std::move(livekit_client)),
      commit_if_current_(std::move(commit_if_current)),
      now_(std::move(now)),
      describe_publication_(std::move(describe_publication)),
      start_capture_workers_(std::move(start_capture_workers)),
      capture_promoted_(std::move(capture_promoted)),
      query_encoder_capability_(std::move(query_encoder_capability)),
      create_video_source_(std::move(create_video_source)) {
    if (!commit_if_current_) {
      commit_if_current_ = [this](
        const std::string& session_id,
        std::uint64_t generation,
        std::function<void()> commit
      ) {
        if (!is_current_(session_id, generation)) return false;
        commit();
        return true;
      };
    }
    if (!now_) now_ = [] { return LiveKitConnectPolicy::Clock::now(); };
    if (!query_encoder_capability_) {
      query_encoder_capability_ = [] {
        return livekit::queryD3D11H264Capability();
      };
    }
    if (!create_video_source_) {
      create_video_source_ = [](int width, int height) {
        return std::shared_ptr<livekit::D3D11H264VideoSource>(
          livekit::createD3D11H264VideoSource(width, height)
        );
      };
    }
  }

  ~Implementation() { shutdown(); }

  void connect(const MediaCommand& command) {
    reapFinishedWork();
    validateCurrent(command, "connect");
    validateConnect(command);
    logScreen(
      "screen_connect_start",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"candidateActive", candidate_ != nullptr},
        {"captureActive", active_ != nullptr}
      }
    );

    if (candidate_) {
      candidate_->operation.requestCancel();
      throwCapacityOccupied("screen publication attempt is still completing");
    }
    if (active_) {
      if (matches(*active_, command) && publicationIdentityMatches(*active_, command)) {
        emitter_.emit(successfulReply(command));
        return;
      }
      throw std::logic_error(
        "cannot prepare or retag a screen publication while capture is active"
      );
    }
    if (prepared_ && publicationIdentityMatches(*prepared_, command)) {
      const bool committed = commit_if_current_(
        command.session_id,
        command.generation,
        [&] {
          prepared_->command = trackCommand(command);
          prepared_->publication->updateIdentity(command.session_id, command.generation);
        }
      );
      if (!committed) throw std::runtime_error("stale screen connect generation");
      emitter_.emit(successfulReply(command));
      return;
    }
    if (deferred_retire_) {
      throwCapacityOccupied("screen retirement backlog is occupied");
    }

    auto attempt = std::make_shared<AttemptState>();
    attempt->kind = AttemptKind::Prepare;
    attempt->command = trackCommand(command);
    attempt->resources = std::make_unique<ScreenResources>();
    attempt->resources->command = trackCommand(command);
    if (prepared_) attempt->obsolete = std::move(prepared_);
    launchAttempt(std::move(attempt));
  }

  void startCapture(const MediaCommand& command) {
    reapFinishedWork();
    validateCurrent(command, "capture");
    validateConnect(command);
    logScreen(
      "screen_capture_start",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"candidateActive", candidate_ != nullptr},
        {"captureActive", active_ != nullptr},
        {"audioRequested", command.audio_requested}
      }
    );

    if (candidate_) {
      candidate_->operation.requestCancel();
      throwCapacityOccupied("screen publication attempt is still completing");
    }
    if (active_ && matches(*active_, command)) {
      emitStarted(command, *active_, false);
      return;
    }
    if (deferred_retire_) {
      throwCapacityOccupied("screen retirement backlog is occupied");
    }
    if (active_) {
      retireResources(std::move(active_));
      if (deferred_retire_) {
        throwCapacityOccupied("screen retirement worker is still occupied");
      }
    }

    auto attempt = std::make_shared<AttemptState>();
    attempt->kind = AttemptKind::Start;
    attempt->command = trackCommand(command);
    if (prepared_ && publicationIdentityMatches(*prepared_, command)) {
      attempt->resources = std::move(prepared_);
      attempt->resources->command = trackCommand(command);
    } else {
      attempt->resources = std::make_unique<ScreenResources>();
      attempt->resources->command = trackCommand(command);
      if (prepared_) attempt->obsolete = std::move(prepared_);
    }
    launchAttempt(std::move(attempt));
  }

  void stopCapture(const MediaCommand& command, bool emit_stopped) {
    reapFinishedWork();
    logScreen(
      "screen_stop_start",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"emitStopped", emit_stopped}
      }
    );
    if (!is_current_(command.session_id, command.generation)) {
      logScreen(
        "screen_stop_stale",
        {{"sessionId", command.session_id}, {"generation", command.generation}}
      );
      throw std::runtime_error("stale screen stop generation");
    }
    if (pending_restart_ &&
        pending_restart_->session_id == command.session_id &&
        pending_restart_->generation == command.generation) {
      pending_restart_.reset();
    }
    if (candidate_ && candidate_->kind == AttemptKind::Start &&
        candidate_->command.session_id == command.session_id) {
      candidate_->operation.requestCancel();
    }
    if (!active_ || (!command.session_id.empty() && !matchesSession(*active_, command))) return;
    const auto stopped_session_id = active_->command.session_id;
    const auto stopped_generation = active_->command.generation;
    retireResources(std::move(active_));
    if (emit_stopped) emitStopped(stopped_session_id, stopped_generation, "stopped");
  }

  void restartCaptureAfterStall(const MediaCommand& command) {
    reapFinishedWork();
    if (shutdown_ || !is_current_(command.session_id, command.generation)) return;
    if (!active_ || !matches(*active_, command) || pending_restart_) return;

    pending_restart_ = active_->command;
    pending_restart_->request_id.clear();
    logScreen(
      "screen_stall_restart_requested",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation}
      }
    );
    retireResources(std::move(active_));
  }

  void disconnect(const MediaCommand& command, bool emit_stopped) {
    reapFinishedWork();
    logScreen(
      "screen_disconnect_start",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"emitStopped", emit_stopped},
        {"terminal", command.terminal},
        {"force", command.force}
      }
    );
    if ((command.type == "disconnectScreen" || command.terminal || command.force) &&
        !is_current_(command.session_id, command.generation)) {
      logScreen(
        "screen_disconnect_stale",
        {{"sessionId", command.session_id}, {"generation", command.generation}}
      );
      throw std::runtime_error("stale screen disconnect generation");
    }
    bool matched = false;
    if (pending_restart_ &&
        (command.session_id.empty() ||
         pending_restart_->session_id == command.session_id)) {
      pending_restart_.reset();
      matched = true;
    }
    if (candidate_ &&
        (command.session_id.empty() || candidate_->command.session_id == command.session_id)) {
      candidate_->operation.requestCancel();
      matched = true;
    }
    if (active_ && (command.session_id.empty() || matchesSession(*active_, command))) {
      const auto stopped_session_id = active_->command.session_id;
      const auto stopped_generation = active_->command.generation;
      retireResources(std::move(active_));
      if (emit_stopped) emitStopped(stopped_session_id, stopped_generation, "disconnected");
      matched = true;
    }
    if (prepared_ && (command.session_id.empty() || matchesSession(*prepared_, command))) {
      retireResources(std::move(prepared_));
      matched = true;
    }
    if (!matched && !command.terminal && !command.force && !command.session_id.empty()) return;
    logScreen(
      "screen_disconnect_done",
      {{"sessionId", command.session_id}, {"generation", command.generation}}
    );
  }

  bool handleTerminal(const MediaCommand& command, bool livekit_terminal) {
    reapFinishedWork();
    bool affected = false;
    if (pending_restart_ &&
        pending_restart_->session_id == command.session_id &&
        pending_restart_->generation == command.generation) {
      pending_restart_.reset();
      affected = true;
    }
    if (candidate_ && matches(*candidate_, command) &&
        (livekit_terminal || candidate_->kind == AttemptKind::Start)) {
      affected = candidate_->operation.requestCancel();
      if (affected) {
        candidate_->terminal_cancelled = true;
        candidate_->terminal_reason = command.internal_message;
      }
    }
    if (active_ && matches(*active_, command)) {
      retireResources(std::move(active_));
      affected = true;
    }
    if (livekit_terminal && prepared_ && matches(*prepared_, command)) {
      retireResources(std::move(prepared_));
      affected = true;
    }
    return affected;
  }

  void handleWorkerCommand(const MediaCommand& command) {
    if (command.type == "__screenAttemptReady" ||
        command.type == "__screenAttemptFailed") {
      finishAttempt(command.session_id, command.generation);
      return;
    }
    if (command.type == "__screenRetireDone") {
      finishRetire(command.internal_message);
    }
  }

  RuntimeEvent probe(const MediaCommand& command) {
    reapFinishedWork();
    const auto now = now_();
    const auto stuck_threshold = LiveKitConnectPolicy::kNativeOperationDeadline;
    const bool candidate_stuck = candidate_ &&
      now - candidate_->started_at >= stuck_threshold;
    const bool retirement_stuck = retiring_ &&
      now - retiring_->started_at >= stuck_threshold;
    const bool deferred_stuck = deferred_retire_ &&
      deferred_retire_->retire_requested_at != LiveKitConnectPolicy::Clock::time_point{} &&
      now - deferred_retire_->retire_requested_at >= stuck_threshold;
    if (!candidate_stuck && !retirement_stuck && !deferred_stuck) {
      auto result = successfulReply(command);
      result.state = candidate_ || retiring_ || deferred_retire_ ? "busy" : "available";
      return result;
    }

    logScreen(
      "screen_probe_unresponsive",
      {
        {"candidateStuck", candidate_stuck},
        {"retirementStuck", retirement_stuck},
        {"deferredStuck", deferred_stuck},
        {"sessionId", candidate_stuck
          ? candidate_->command.session_id
          : (retirement_stuck
            ? retiring_->session_id
            : deferred_retire_->command.session_id)},
        {"generation", candidate_stuck
          ? candidate_->command.generation
          : (retirement_stuck
            ? retiring_->generation
            : deferred_retire_->command.generation)}
      }
    );

    auto result = failedReply(
      command,
      "actor_unresponsive",
      candidate_stuck
        ? "screen publication worker exceeded its operation deadline"
        : "screen retirement worker exceeded its operation deadline",
      true
    );
    if (result.error) {
      if (candidate_stuck) {
        result.error->session_id = candidate_->command.session_id;
        result.error->generation = candidate_->command.generation;
      } else if (retirement_stuck) {
        result.error->session_id = retiring_->session_id;
        result.error->generation = retiring_->generation;
      } else {
        result.error->session_id = deferred_retire_->command.session_id;
        result.error->generation = deferred_retire_->command.generation;
      }
    }
    return result;
  }

  void shutdown() {
    if (shutdown_) return;
    shutdown_ = true;
    pending_restart_.reset();
    logScreen("screen_shutdown_start");
    if (candidate_) {
      candidate_->operation.requestCancel();
      if (candidate_->worker.joinable()) candidate_->worker.join();
      if (candidate_->resources && candidate_->resources->publication) {
        try { retireResources(std::move(candidate_->resources)); } catch (...) {}
      }
      candidate_.reset();
    }
    if (active_) {
      try { retireResources(std::move(active_)); } catch (...) {}
    }
    if (prepared_) {
      try { retireResources(std::move(prepared_)); } catch (...) {}
    }
    drainRetirements();
    logScreen("screen_shutdown_done");
  }

 private:
  enum class AttemptKind { Prepare, Start };

  struct ScreenResources {
    MediaCommand command;
    std::unique_ptr<LiveKitTrackPublication> publication;
    ScreenPublicationDescription description;
    std::shared_ptr<std::atomic_bool> capture_running;
    std::thread capture_thread;
    std::thread audio_thread;
    std::shared_ptr<livekit::D3D11H264VideoSource> video_source;
    std::shared_ptr<livekit::LocalVideoTrack> video_track;
    std::string video_publication_sid;
    std::shared_ptr<livekit::AudioSource> audio_source;
    std::shared_ptr<livekit::LocalAudioTrack> audio_track;
    std::string audio_publication_sid;
    LiveKitConnectPolicy::Clock::time_point retire_requested_at{};
  };

  struct AttemptState {
    AttemptKind kind = AttemptKind::Prepare;
    MediaCommand command;
    std::unique_ptr<ScreenResources> resources;
    std::unique_ptr<ScreenResources> obsolete;
    std::thread worker;
    MediaOperation operation;
    std::atomic_bool finished{false};
    LiveKitConnectPolicy::Clock::time_point started_at = LiveKitConnectPolicy::Clock::now();
    bool succeeded = false;
    bool stale = false;
    bool terminal_cancelled = false;
    std::string terminal_reason;
    std::string error;
  };

  struct RetiringState {
    std::string id;
    std::string session_id;
    std::uint64_t generation = 0;
    std::unique_ptr<ScreenResources> resources;
    std::thread worker;
    std::atomic_bool finished{false};
    LiveKitConnectPolicy::Clock::time_point started_at = LiveKitConnectPolicy::Clock::now();
  };

  RuntimeEvent successfulReply(const MediaCommand& command) const {
    RuntimeEvent result;
    result.type = "reply";
    result.request_id = command.request_id;
    result.session_id = command.session_id;
    result.generation = command.generation;
    result.ok = true;
    return result;
  }

  RuntimeEvent failedReply(
    const MediaCommand& command,
    const std::string& code,
    const std::string& message,
    bool retryable
  ) const {
    RuntimeEvent result;
    result.type = "reply";
    result.request_id = command.request_id;
    result.session_id = command.session_id;
    result.generation = command.generation;
    result.ok = false;
    result.error = NativeError{
      code,
      message,
      command.type,
      retryable,
      command.session_id,
      command.generation,
    };
    return result;
  }

  void validateConnect(const MediaCommand& command) const {
    if (command.participant_identity.empty()) {
      throw std::invalid_argument("participantIdentity is required");
    }
  }

  void validateCurrent(const MediaCommand& command, const char* operation) const {
    if (is_current_(command.session_id, command.generation)) return;
    throw std::runtime_error(std::string("stale screen ") + operation + " generation");
  }

  static bool matches(const ScreenResources& resources, const MediaCommand& command) {
    return resources.command.session_id == command.session_id &&
      resources.command.generation == command.generation;
  }

  static bool matches(const AttemptState& attempt, const MediaCommand& command) {
    return attempt.command.session_id == command.session_id &&
      attempt.command.generation == command.generation;
  }

  static bool matchesSession(
    const ScreenResources& resources,
    const MediaCommand& command
  ) {
    return resources.command.session_id == command.session_id;
  }

  static MediaCommand trackCommand(MediaCommand command) {
    command.livekit_url.clear();
    command.livekit_token.clear();
    return command;
  }

  static bool publicationIdentityMatches(
    const ScreenResources& resources,
    const MediaCommand& command
  ) {
    return resources.publication &&
      resources.command.session_id == command.session_id &&
      resources.command.participant_identity == command.participant_identity;
  }

  bool isCurrent(const std::shared_ptr<AttemptState>& attempt) const {
    return !attempt->operation.cancelled() &&
      !attempt->operation.expired() &&
      is_current_(attempt->command.session_id, attempt->command.generation);
  }

  [[noreturn]] void throwCapacityOccupied(const char* message) const {
    const auto now = now_();
    const bool attempt_overdue = candidate_ &&
      now - candidate_->started_at >= LiveKitConnectPolicy::kNativeOperationDeadline;
    const bool retirement_overdue = retiring_ &&
      now - retiring_->started_at >= LiveKitConnectPolicy::kNativeOperationDeadline;
    if (attempt_overdue || retirement_overdue) {
      throw ScreenActorUnresponsiveError(message);
    }
    throw ScreenActorBusyError(message);
  }

  void launchAttempt(std::shared_ptr<AttemptState> attempt) {
    attempt->started_at = now_();
    candidate_ = std::move(attempt);
    const auto candidate = candidate_;
    logScreen(
      "screen_attempt_launch",
      {
        {"sessionId", candidate->command.session_id},
        {"generation", candidate->command.generation},
        {"operation", candidate->kind == AttemptKind::Prepare ? "prepare" : "start"},
        {"replacesPreparedPublication", candidate->obsolete != nullptr}
      }
    );
    try {
      candidate->worker = std::thread([this, candidate] { runAttempt(candidate); });
    } catch (...) {
      auto failed = std::move(candidate_);
      if (failed->obsolete) prepared_ = std::move(failed->obsolete);
      else if (failed->resources && failed->resources->publication) {
        prepared_ = std::move(failed->resources);
      }
      throw ScreenActorUnresponsiveError("failed to start screen publication worker");
    }
  }

  void runAttempt(const std::shared_ptr<AttemptState>& attempt) {
    const auto started_at_ms = steadyNowMs();
    try {
      if (attempt->obsolete) {
        logScreen(
          "screen_attempt_retire_obsolete_publication",
          {
            {"sessionId", attempt->obsolete->command.session_id},
            {"generation", attempt->obsolete->command.generation}
          }
        );
        cleanupResources(*attempt->obsolete);
      }
      if (!isCurrent(attempt)) throw std::runtime_error("stale screen connect generation");
      auto& resources = *attempt->resources;
      const auto& command = attempt->command;
      if (!resources.publication) {
        resources.publication = livekit_client_->createScreenPublication(
          command.session_id,
          command.generation
        );
        if (!resources.publication->isRoomConnected()) {
          throw std::runtime_error("LiveKit voice Room is not connected");
        }
        logScreen(
          "screen_connect_livekit_connected",
          {
            {"sessionId", command.session_id},
            {"generation", command.generation},
            {"elapsedMs", steadyNowMs() - started_at_ms}
          }
        );
      } else {
        logScreen(
          "screen_connect_reuse_prepared_publication",
          {{"sessionId", command.session_id}, {"generation", command.generation}}
        );
      }
      resources.command = trackCommand(command);
      resources.publication->updateIdentity(command.session_id, command.generation);
      if (!isCurrent(attempt)) throw std::runtime_error("stale screen connect generation");

      if (attempt->kind == AttemptKind::Start) {
        publishAndStartCapture(attempt, resources);
      }
      if (!isCurrent(attempt)) throw std::runtime_error("stale screen publish generation");
      attempt->succeeded = true;
      logScreen(
        "screen_attempt_worker_ready",
        {
          {"sessionId", command.session_id},
          {"generation", command.generation},
          {"operation", attempt->kind == AttemptKind::Prepare ? "prepare" : "start"},
          {"elapsedMs", steadyNowMs() - started_at_ms}
        }
      );
    } catch (const std::exception& error) {
      attempt->error = error.what();
      attempt->stale = attempt->operation.cancelled() ||
        std::string_view(error.what()).starts_with("stale ");
      if (attempt->resources) cleanupResources(*attempt->resources);
      attempt->succeeded = false;
      logScreen(
        "screen_attempt_worker_failed",
        {
          {"sessionId", attempt->command.session_id},
          {"generation", attempt->command.generation},
          {"stale", attempt->stale},
          {"elapsedMs", steadyNowMs() - started_at_ms},
          {"message", sanitizeDiagnosticMessage(error.what())}
        }
      );
    } catch (...) {
      attempt->error = "unknown screen publication failure";
      attempt->stale = attempt->operation.cancelled();
      if (attempt->resources) cleanupResources(*attempt->resources);
      attempt->succeeded = false;
    }
    attempt->obsolete.reset();
    attempt->finished.store(true);
    MediaCommand internal;
    internal.type = attempt->succeeded ? "__screenAttemptReady" : "__screenAttemptFailed";
    internal.session_id = attempt->command.session_id;
    internal.generation = attempt->command.generation;
    internal.internal_message = attempt->error;
    post_(std::move(internal));
  }

  void publishAndStartCapture(
    const std::shared_ptr<AttemptState>& attempt,
    ScreenResources& resources
  ) {
    const auto& command = attempt->command;
    resources.description = describe_publication_(command);
    resources.description.fps = std::clamp(command.fps, 1, 240);
    resources.description.bitrate = screenBitrate(command.bitrate);
    const auto& description = resources.description;

    const auto capability = query_encoder_capability_();
    if (!capability.available) {
      throw std::runtime_error(
        "gpu_encoder_unavailable: " + capability.reason
      );
    }
    resources.video_source = create_video_source_(
      static_cast<int>(description.width),
      static_cast<int>(description.height)
    );
    if (!resources.video_source) {
      throw std::runtime_error("gpu_encoder_unavailable");
    }
    resources.video_track = livekit::LocalVideoTrack::createLocalVideoTrack(
      "screen",
      resources.video_source
    );
    livekit::TrackPublishOptions video_options;
    video_options.source = livekit::TrackSource::SOURCE_SCREENSHARE;
    video_options.stream = "screen";
    video_options.simulcast = false;
    video_options.video_codec = livekit::VideoCodec::H264;
    video_options.video_encoder = livekit::VideoEncoderBackend::WindowsD3D11Hardware;
    video_options.video_encoding = livekit::VideoEncodingOptions{
      static_cast<std::uint64_t>(description.bitrate),
      static_cast<double>(description.fps),
    };
    logScreen(
      "screen_publish_start",
      {{"sessionId", command.session_id}, {"generation", command.generation}}
    );
    resources.video_publication_sid = resources.publication->publishVideoTrack(
      resources.video_track,
      video_options
    );
    if (resources.video_publication_sid.empty()) {
      throw std::runtime_error("LiveKit screen publication SID is empty");
    }
    logScreen(
      "screen_publish_ack",
      {{"sessionId", command.session_id}, {"generation", command.generation}}
    );
    if (!isCurrent(attempt)) throw std::runtime_error("stale screen publish generation");

    if (description.publish_audio) {
      resources.audio_source = std::make_shared<livekit::AudioSource>(48'000, 2);
      resources.audio_track = livekit::LocalAudioTrack::createLocalAudioTrack(
        "screen-audio",
        resources.audio_source
      );
      livekit::AudioEncodingOptions audio_encoding;
      audio_encoding.max_bitrate = command.audio_bitrate;
      livekit::TrackPublishOptions audio_options;
      audio_options.audio_encoding = audio_encoding;
      audio_options.dtx = false;
      audio_options.red = false;
      audio_options.source = livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO;
      logScreen(
        "screen_audio_publish_start",
        {{"sessionId", command.session_id}, {"generation", command.generation}}
      );
      resources.audio_publication_sid = resources.publication->publishAudioTrack(
        resources.audio_track,
        audio_options
      );
      if (resources.audio_publication_sid.empty()) {
        throw std::runtime_error("LiveKit screen audio publication SID is empty");
      }
      logScreen(
        "screen_audio_publish_ack",
        {{"sessionId", command.session_id}, {"generation", command.generation}}
      );
      if (!isCurrent(attempt)) {
        throw std::runtime_error("stale screen audio publish generation");
      }
    }

    resources.capture_running = std::make_shared<std::atomic_bool>(true);
    start_capture_workers_(
      command,
      description,
      resources.video_source,
      resources.video_track,
      resources.audio_source,
      resources.capture_running,
      [this, attempt] { return isCurrent(attempt); },
      resources.capture_thread,
      resources.audio_thread
    );
  }

  void finishAttempt(const std::string& session_id, std::uint64_t generation) {
    if (!candidate_ || candidate_->command.session_id != session_id ||
        candidate_->command.generation != generation) return;
    auto attempt = std::move(candidate_);
    if (attempt->worker.joinable()) attempt->worker.join();
    const bool terminal_failure = attempt->terminal_cancelled &&
      is_current_(attempt->command.session_id, attempt->command.generation);
    bool promoted = false;
    if (attempt->succeeded && !attempt->stale &&
        !attempt->operation.cancelled() && !attempt->operation.expired() &&
        !terminal_failure) {
      promoted = commit_if_current_(
        attempt->command.session_id,
        attempt->command.generation,
        [&] {
          if (attempt->kind == AttemptKind::Prepare) {
            prepared_ = std::move(attempt->resources);
          } else {
            active_ = std::move(attempt->resources);
          }
        }
      );
    }
    const bool expired = attempt->operation.expired();
    bool stale = attempt->stale || attempt->operation.cancelled();
    if (attempt->succeeded) stale = stale || !promoted;
    else if (!stale) {
      stale = !is_current_(attempt->command.session_id, attempt->command.generation);
    }
    if (terminal_failure) stale = false;
    if (!attempt->succeeded || !promoted) {
      if (attempt->resources && attempt->resources->publication) {
        retireResources(std::move(attempt->resources));
      }
      emitter_.emit(failedReply(
        attempt->command,
        terminal_failure
          ? "screen_runtime_lost"
          : (stale ? "stale_generation" :
              (expired ? "native_operation_timeout" : screenFailureCode(attempt->error))),
        terminal_failure
          ? (attempt->terminal_reason.empty()
              ? "screen runtime ended during publication"
              : attempt->terminal_reason)
          : (expired ? "screen publication deadline expired" :
              (attempt->error.empty()
              ? (stale ? "stale screen publication generation" : "screen publication failed")
              : attempt->error)),
        terminal_failure || !stale
      ));
      logScreen(
        "screen_attempt_not_promoted",
        {
          {"sessionId", attempt->command.session_id},
          {"generation", attempt->command.generation},
          {"stale", stale},
          {"succeeded", attempt->succeeded}
        }
      );
      return;
    }

    if (attempt->kind == AttemptKind::Prepare) {
      emitter_.emit(successfulReply(attempt->command));
      logScreen(
        "screen_prepare_promoted",
        {{"sessionId", attempt->command.session_id}, {"generation", attempt->command.generation}}
      );
      return;
    }
    capture_promoted_(attempt->command.session_id, attempt->command.generation);
    emitStarted(attempt->command, *active_, true);
    logScreen(
      "screen_capture_promoted",
      {{"sessionId", attempt->command.session_id}, {"generation", attempt->command.generation}}
    );
  }

  void emitStarted(
    const MediaCommand& command,
    const ScreenResources& resources,
    bool emit_session_started
  ) {
    const auto& description = resources.description;
    auto result = successfulReply(command);
    result.kind = "screen";
    result.width = static_cast<int>(description.width);
    result.height = static_cast<int>(description.height);
    result.fps = description.fps;
    result.bitrate = description.bitrate;
    result.audio_mode = description.audio_mode;
    result.loopback_mode = description.loopback_mode;
    result.audio_target_process_id = description.audio_target_process_id;
    result.native_participant_identity = command.participant_identity;
    // Stall recovery reuses the original capture command after clearing its
    // request id. It still needs lifecycle events, but an empty-id reply is not
    // a valid runtime event and would make the utility host terminate.
    if (!command.request_id.empty()) emitter_.emit(result);
    if (emit_session_started) {
      RuntimeEvent started = result;
      started.type = "sessionStarted";
      emitter_.emit(std::move(started));
    }
    RuntimeEvent running;
    running.type = "sessionLifecycle";
    running.request_id = command.request_id;
    running.session_id = command.session_id;
    running.generation = command.generation;
    running.kind = "screen";
    running.status = "running";
    running.width = static_cast<int>(description.width);
    running.height = static_cast<int>(description.height);
    running.fps = description.fps;
    running.bitrate = description.bitrate;
    running.audio_mode = description.audio_mode;
    emitter_.emit(std::move(running));
  }

  void emitStopped(
    const std::string& session_id,
    std::uint64_t generation,
    const std::string& reason
  ) {
    if (session_id.empty()) return;
    RuntimeEvent event;
    event.type = "sessionStopped";
    event.session_id = session_id;
    event.generation = generation;
    event.reason = reason;
    emitter_.emit(std::move(event));
  }

  void cleanupResources(ScreenResources& resources) {
    const auto session_id = resources.command.session_id;
    const auto generation = resources.command.generation;
    if (resources.capture_running) resources.capture_running->store(false);
    if (resources.capture_thread.joinable()) resources.capture_thread.join();
    if (resources.audio_thread.joinable()) resources.audio_thread.join();
    if (resources.publication && !resources.video_publication_sid.empty()) {
      logScreen(
        "screen_unpublish_video_start",
        {{"sessionId", session_id}, {"generation", generation}}
      );
      try {
        resources.publication->unpublishTrack(resources.video_publication_sid);
        logScreen(
          "screen_unpublish_video_done",
          {{"sessionId", session_id}, {"generation", generation}}
        );
      } catch (const std::exception& error) {
        logScreen(
          "screen_unpublish_video_failed",
          {
            {"sessionId", session_id},
            {"generation", generation},
            {"message", sanitizeDiagnosticMessage(error.what())}
          }
        );
      } catch (...) {
        logScreen(
          "screen_unpublish_video_failed_unknown",
          {{"sessionId", session_id}, {"generation", generation}}
        );
      }
    }
    if (resources.publication && !resources.audio_publication_sid.empty()) {
      logScreen(
        "screen_unpublish_audio_start",
        {{"sessionId", session_id}, {"generation", generation}}
      );
      try {
        resources.publication->unpublishTrack(resources.audio_publication_sid);
        logScreen(
          "screen_unpublish_audio_done",
          {{"sessionId", session_id}, {"generation", generation}}
        );
      } catch (const std::exception& error) {
        logScreen(
          "screen_unpublish_audio_failed",
          {
            {"sessionId", session_id},
            {"generation", generation},
            {"message", sanitizeDiagnosticMessage(error.what())}
          }
        );
      } catch (...) {
        logScreen(
          "screen_unpublish_audio_failed_unknown",
          {{"sessionId", session_id}, {"generation", generation}}
        );
      }
    }
    resources.video_publication_sid.clear();
    resources.audio_publication_sid.clear();
    resources.publication.reset();
    resources.video_track.reset();
    resources.audio_track.reset();
    resources.video_source.reset();
    resources.audio_source.reset();
    resources.capture_running.reset();
  }

  void retireResources(std::unique_ptr<ScreenResources> resources) {
    if (!resources) return;
    if (resources->capture_running) resources->capture_running->store(false);
    if (resources->retire_requested_at == LiveKitConnectPolicy::Clock::time_point{}) {
      resources->retire_requested_at = now_();
    }
    if (retiring_) {
      if (deferred_retire_) {
        throw std::logic_error("screen retirement bound exceeded");
      }
      deferred_retire_ = std::move(resources);
      logScreen("screen_retire_deferred");
      return;
    }
    auto retiring = std::make_shared<RetiringState>();
    retiring->id = std::to_string(++next_retire_id_);
    retiring->resources = std::move(resources);
    retiring->session_id = retiring->resources->command.session_id;
    retiring->generation = retiring->resources->command.generation;
    retiring->started_at = retiring->resources->retire_requested_at;
    logScreen(
      "screen_retire_launch",
      {
        {"retireId", retiring->id},
        {"sessionId", retiring->resources->command.session_id},
        {"generation", retiring->resources->command.generation}
      }
    );
    const auto state = retiring;
    try {
      retiring->worker = std::thread(
        [this, state]() mutable {
          cleanupResources(*state->resources);
          state->resources.reset();
          state->finished.store(true);
          MediaCommand done;
          done.type = "__screenRetireDone";
          done.internal_message = state->id;
          post_(std::move(done));
        }
      );
    } catch (...) {
      deferred_retire_ = std::move(retiring->resources);
      throw ScreenActorUnresponsiveError("failed to start screen retirement worker");
    }
    retiring_ = std::move(retiring);
  }

  void finishRetire(const std::string& id) {
    if (!retiring_ || retiring_->id != id) return;
    if (retiring_->worker.joinable()) retiring_->worker.join();
    retiring_.reset();
    logScreen("screen_retire_done", {{"retireId", id}});
    startDeferredRetire();
    startPendingRestart();
  }

  void startDeferredRetire() {
    if (!retiring_ && deferred_retire_) {
      auto next = std::move(deferred_retire_);
      retireResources(std::move(next));
    }
  }

  void startPendingRestart() {
    if (shutdown_ || retiring_ || deferred_retire_ || candidate_ ||
        !pending_restart_) return;
    auto command = std::move(*pending_restart_);
    pending_restart_.reset();
    if (!is_current_(command.session_id, command.generation)) return;

    auto attempt = std::make_shared<AttemptState>();
    attempt->kind = AttemptKind::Start;
    attempt->command = std::move(command);
    attempt->resources = std::make_unique<ScreenResources>();
    attempt->resources->command = attempt->command;
    logScreen(
      "screen_stall_restart_launch",
      {
        {"sessionId", attempt->command.session_id},
        {"generation", attempt->command.generation}
      }
    );
    launchAttempt(std::move(attempt));
  }

  void reapFinishedWork() {
    if (candidate_ && candidate_->finished.load()) {
      finishAttempt(candidate_->command.session_id, candidate_->command.generation);
    }
    if (retiring_ && retiring_->finished.load()) {
      const auto id = retiring_->id;
      finishRetire(id);
    }
    if (!retiring_ && deferred_retire_) startDeferredRetire();
    if (!retiring_ && !deferred_retire_) startPendingRestart();
  }

  void drainRetirements() {
    while (retiring_ || deferred_retire_) {
      if (!retiring_ && deferred_retire_) {
        auto resources = std::move(deferred_retire_);
        cleanupResources(*resources);
        continue;
      }
      if (retiring_ && retiring_->worker.joinable()) retiring_->worker.join();
      retiring_.reset();
    }
  }

  SequencedEmitter& emitter_;
  InternalPost post_;
  IsCurrent is_current_;
  std::shared_ptr<LiveKitPublicationClient> livekit_client_;
  CommitIfCurrent commit_if_current_;
  Now now_;
  DescribePublication describe_publication_;
  StartCaptureWorkers start_capture_workers_;
  CapturePromoted capture_promoted_;
  QueryEncoderCapability query_encoder_capability_;
  CreateVideoSource create_video_source_;
  std::unique_ptr<ScreenResources> prepared_;
  std::unique_ptr<ScreenResources> active_;
  std::shared_ptr<AttemptState> candidate_;
  std::shared_ptr<RetiringState> retiring_;
  std::unique_ptr<ScreenResources> deferred_retire_;
  std::optional<MediaCommand> pending_restart_;
  std::uint64_t next_retire_id_ = 0;
  bool shutdown_ = false;
};

ScreenPublicationController::ScreenPublicationController(
  SequencedEmitter& emitter,
  InternalPost post,
  IsCurrent is_current,
  std::shared_ptr<LiveKitPublicationClient> livekit_client,
  CommitIfCurrent commit_if_current,
  Now now,
  DescribePublication describe_publication,
  StartCaptureWorkers start_capture_workers,
  CapturePromoted capture_promoted,
  QueryEncoderCapability query_encoder_capability,
  CreateVideoSource create_video_source
) : implementation_(std::make_unique<Implementation>(
      emitter,
      std::move(post),
      std::move(is_current),
      std::move(livekit_client),
      std::move(commit_if_current),
      std::move(now),
      std::move(describe_publication),
      std::move(start_capture_workers),
      std::move(capture_promoted),
      std::move(query_encoder_capability),
      std::move(create_video_source)
    )) {}

ScreenPublicationController::~ScreenPublicationController() = default;

void ScreenPublicationController::connect(const MediaCommand& command) {
  implementation_->connect(command);
}

void ScreenPublicationController::startCapture(const MediaCommand& command) {
  implementation_->startCapture(command);
}

void ScreenPublicationController::stopCapture(
  const MediaCommand& command,
  bool emit_stopped
) {
  implementation_->stopCapture(command, emit_stopped);
}

void ScreenPublicationController::restartCaptureAfterStall(
  const MediaCommand& command
) {
  implementation_->restartCaptureAfterStall(command);
}

void ScreenPublicationController::disconnect(
  const MediaCommand& command,
  bool emit_stopped
) {
  implementation_->disconnect(command, emit_stopped);
}

bool ScreenPublicationController::handleTerminal(
  const MediaCommand& command,
  bool livekit_terminal
) {
  return implementation_->handleTerminal(command, livekit_terminal);
}

void ScreenPublicationController::handleWorkerCommand(const MediaCommand& command) {
  implementation_->handleWorkerCommand(command);
}

RuntimeEvent ScreenPublicationController::probe(const MediaCommand& command) {
  return implementation_->probe(command);
}

void ScreenPublicationController::shutdown() { implementation_->shutdown(); }

}  // namespace syrnike::desktop_native::media
