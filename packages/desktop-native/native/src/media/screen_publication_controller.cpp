#include "screen_publication_controller.hpp"

#include <livekit/local_audio_track.h>
#include <livekit/local_video_track.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <vector>

#include "../common/diagnostic_log.hpp"
#include "livekit_connect_policy.hpp"
#include "media_operation.hpp"
#include "media_runtime_support.hpp"
#include "video_resource_admission.hpp"

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
    "gpu_resource_saturated",
    "gpu_encoder_session_saturated",
    "gpu_permission_denied",
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

bool screenFailureRetryable(std::string_view code) noexcept {
  return code != "target_closed" && code != "gpu_permission_denied";
}

std::string screenAudioFailureCode(std::string_view message) {
  constexpr std::string_view typed_codes[] = {
    "audio_device_lost",
    "audio_capture_failed",
    "audio_source_timeout",
    "native_operation_timeout",
    "stale_generation",
  };
  for (const auto code : typed_codes) {
    if (message == code ||
        (message.starts_with(code) && message.size() > code.size() &&
         message[code.size()] == ':')) {
      return std::string(code);
    }
  }
  return "audio_capture_failed";
}

class ScreenPostGate final {
 public:
  explicit ScreenPostGate(
      ScreenPublicationController::InternalPost post)
      : post_(std::move(post)) {}

  bool post(MediaCommand command) {
    ScreenPublicationController::InternalPost post;
    {
      std::lock_guard lock(mutex_);
      if (!enabled_) return false;
      post = post_;
      ++in_flight_;
    }
    bool posted = false;
    try {
      posted = post && post(std::move(command));
    } catch (...) {
      leave();
      throw;
    }
    leave();
    return posted;
  }

  void disable() noexcept {
    std::unique_lock lock(mutex_);
    enabled_ = false;
    changed_.wait(lock, [&] { return in_flight_ == 0; });
    post_ = {};
  }

 private:
  void leave() noexcept {
    std::lock_guard lock(mutex_);
    --in_flight_;
    if (in_flight_ == 0) changed_.notify_all();
  }

  std::mutex mutex_;
  std::condition_variable changed_;
  bool enabled_ = true;
  std::size_t in_flight_ = 0;
  ScreenPublicationController::InternalPost post_;
};

class ScreenCurrentGate final {
 public:
  explicit ScreenCurrentGate(
      ScreenPublicationController::IsCurrent current)
      : current_(std::move(current)) {}

  bool current(const std::string& session_id, std::uint64_t generation) {
    ScreenPublicationController::IsCurrent current;
    {
      std::lock_guard lock(mutex_);
      if (!enabled_) return false;
      current = current_;
      ++in_flight_;
    }
    bool result = false;
    try {
      result = current && current(session_id, generation);
    } catch (...) {
      leave();
      throw;
    }
    leave();
    return result;
  }

  void disable() noexcept {
    std::unique_lock lock(mutex_);
    enabled_ = false;
    changed_.wait(lock, [&] { return in_flight_ == 0; });
    current_ = {};
  }

 private:
  void leave() noexcept {
    std::lock_guard lock(mutex_);
    --in_flight_;
    if (in_flight_ == 0) changed_.notify_all();
  }

  std::mutex mutex_;
  std::condition_variable changed_;
  bool enabled_ = true;
  std::size_t in_flight_ = 0;
  ScreenPublicationController::IsCurrent current_;
};

class ScreenRetireCleanupTask final {
 public:
  using CleanupThunk = void (*)(
      const std::shared_ptr<void>&,
      const std::shared_ptr<void>&) noexcept;

  void configure(
      std::shared_ptr<void> owner,
      std::shared_ptr<void> state,
      CleanupThunk cleanup) noexcept {
    owner_ = std::move(owner);
    state_ = std::move(state);
    cleanup_ = cleanup;
  }

  void run() noexcept {
    if (started_.exchange(true, std::memory_order_acq_rel)) return;
    if (cleanup_) cleanup_(owner_, state_);
    cleanup_ = nullptr;
    state_.reset();
    owner_.reset();
  }

 private:
  std::atomic_bool started_{false};
  std::shared_ptr<void> owner_;
  std::shared_ptr<void> state_;
  CleanupThunk cleanup_ = nullptr;
};

}  // namespace

class ScreenPublicationController::Implementation
    : public std::enable_shared_from_this<
          ScreenPublicationController::Implementation> {
 public:
  Implementation(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitVoiceSession> voice_session,
    CommitIfCurrent commit_if_current,
    Now now,
    DescribePublication describe_publication,
    PrepareCapture prepare_capture,
    StartVideoCaptureWorker start_video_capture_worker,
    StartAudioCaptureWorker start_audio_capture_worker,
    CapturePromoted capture_promoted,
    AfterVideoPublished after_video_published,
    ScreenVideoPublicationObserver video_publication_observer,
    QueryEncoderCapability query_encoder_capability,
    CreateVideoSource create_video_source,
    CleanupStartProbe cleanup_start_probe,
    CleanupEnqueueProbe cleanup_enqueue_probe,
    BeforeResourceCleanup before_resource_cleanup,
    VideoResourceAdmissionBudget* resource_budget
  ) : emitter_(emitter),
      post_(std::make_shared<ScreenPostGate>(std::move(post))),
      is_current_(std::make_shared<ScreenCurrentGate>(
          std::move(is_current))),
      voice_session_(std::move(voice_session)),
      commit_if_current_(std::move(commit_if_current)),
      now_(std::move(now)),
      describe_publication_(std::move(describe_publication)),
      prepare_capture_(std::move(prepare_capture)),
      start_video_capture_worker_(std::move(start_video_capture_worker)),
      start_audio_capture_worker_(std::move(start_audio_capture_worker)),
      capture_promoted_(std::move(capture_promoted)),
      after_video_published_(std::move(after_video_published)),
      video_publication_observer_(std::move(video_publication_observer)),
      query_encoder_capability_(std::move(query_encoder_capability)),
      create_video_source_(std::move(create_video_source)),
      before_resource_cleanup_(std::move(before_resource_cleanup)),
      cleanup_supervisor_(&CleanupSupervisor::instance()),
      cleanup_start_probe_(std::move(cleanup_start_probe)),
      cleanup_enqueue_probe_(std::move(cleanup_enqueue_probe)),
      resource_budget_(resource_budget
          ? resource_budget
          : &processVideoResourceAdmissionBudget()),
      shutdown_cleanup_task_(
          std::make_shared<ScreenRetireCleanupTask>()),
      shutdown_cleanup_job_(
          std::make_shared<CleanupJob>(cleanup_start_probe_)),
      shutdown_retiring_state_(std::make_shared<RetiringState>()) {
    if (!commit_if_current_) {
      commit_if_current_ = [this](
        const std::string& session_id,
        std::uint64_t generation,
        std::function<void()> commit
      ) {
        if (!is_current_->current(session_id, generation)) return false;
        commit();
        return true;
      };
    }
    if (!now_) now_ = [] { return LiveKitConnectPolicy::Clock::now(); };
    if (!prepare_capture_) {
      throw std::invalid_argument("screen capture preflight callback is required");
    }
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
      const auto description = describe_publication_(command);
      reconcileAudio(command, *active_, description);
      emitStarted(command, *active_, false);
      return;
    }
    if (deferred_retire_) {
      throwCapacityOccupied("screen retirement backlog is occupied");
    }
    if (active_) {
      if (audio_candidate_) retireAudioAttempt(std::move(audio_candidate_));
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
    if (!is_current_->current(command.session_id, command.generation)) {
      logScreen(
        "screen_stop_stale",
        {{"sessionId", command.session_id}, {"generation", command.generation}}
      );
      throw std::runtime_error("stale screen stop generation");
    }
    if (candidate_ && candidate_->kind == AttemptKind::Start &&
        candidate_->command.session_id == command.session_id) {
      candidate_->operation.requestCancel();
    }
    if (audio_candidate_ &&
        audio_candidate_->command.session_id == command.session_id) {
      retireAudioAttempt(std::move(audio_candidate_));
    }
    if (!active_ || (!command.session_id.empty() && !matchesSession(*active_, command))) return;
    const auto stopped_session_id = active_->command.session_id;
    const auto stopped_generation = active_->command.generation;
    retireResources(std::move(active_));
    if (emit_stopped) emitStopped(stopped_session_id, stopped_generation, "stopped");
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
    if ((command.type == NativeCommandType::DisconnectScreen || command.terminal || command.force) &&
        !is_current_->current(command.session_id, command.generation)) {
      logScreen(
        "screen_disconnect_stale",
        {{"sessionId", command.session_id}, {"generation", command.generation}}
      );
      throw std::runtime_error("stale screen disconnect generation");
    }
    bool matched = false;
    if (candidate_ &&
        (command.session_id.empty() || candidate_->command.session_id == command.session_id)) {
      candidate_->operation.requestCancel();
      matched = true;
    }
    if (audio_candidate_ &&
        (command.session_id.empty() ||
         audio_candidate_->command.session_id == command.session_id)) {
      retireAudioAttempt(std::move(audio_candidate_));
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
    if (candidate_ && matches(*candidate_, command) &&
        (livekit_terminal || candidate_->kind == AttemptKind::Start)) {
      affected = candidate_->operation.requestCancel();
      if (affected) {
        candidate_->terminal_cancelled = true;
        candidate_->terminal_reason = command.internal_message;
      }
    }
    if (audio_candidate_ &&
        audio_candidate_->command.session_id == command.session_id &&
        audio_candidate_->command.generation == command.generation) {
      retireAudioAttempt(std::move(audio_candidate_));
      affected = true;
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
    if (command.type == NativeCommandType::ScreenAudioAttemptReady ||
        command.type == NativeCommandType::ScreenAudioAttemptFailed) {
      finishAudioAttempt(command);
      return;
    }
    if (command.type == NativeCommandType::ScreenAudioTerminal) {
      handleAudioTerminal(command);
      return;
    }
    if (command.type == NativeCommandType::ScreenAttemptReady ||
        command.type == NativeCommandType::ScreenAttemptFailed) {
      finishAttempt(command.session_id, command.generation);
      return;
    }
    if (command.type == NativeCommandType::ScreenRetireDone) {
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
    const bool audio_candidate_stuck = audio_candidate_ &&
      now - audio_candidate_->started_at >= stuck_threshold;
    const auto stuck_audio_retirement = std::find_if(
      audio_retiring_.begin(),
      audio_retiring_.end(),
      [now, stuck_threshold](const auto& retirement) {
        return retirement &&
          !retirement->finished.load(std::memory_order_acquire) &&
          now - retirement->started_at >= stuck_threshold;
      }
    );
    const bool audio_retirement_stuck =
      stuck_audio_retirement != audio_retiring_.end();
    if (!candidate_stuck && !retirement_stuck && !deferred_stuck &&
        !audio_candidate_stuck && !audio_retirement_stuck) {
      auto result = successfulReply(command);
      result.state = candidate_ || retiring_ || deferred_retire_ ||
          audio_candidate_ || !audio_retiring_.empty()
        ? "busy"
        : "available";
      return result;
    }

    std::string stuck_session_id;
    std::uint64_t stuck_generation = 0;
    if (candidate_stuck) {
      stuck_session_id = candidate_->command.session_id;
      stuck_generation = candidate_->command.generation;
    } else if (audio_candidate_stuck) {
      stuck_session_id = audio_candidate_->command.session_id;
      stuck_generation = audio_candidate_->command.generation;
    } else if (retirement_stuck) {
      stuck_session_id = retiring_->session_id;
      stuck_generation = retiring_->generation;
    } else if (audio_retirement_stuck) {
      const auto& retirement = **stuck_audio_retirement;
      const MediaCommand* audio_command = retirement.attempt
        ? &retirement.attempt->command
        : (retirement.resources ? &retirement.resources->command : nullptr);
      if (audio_command) {
        stuck_session_id = audio_command->session_id;
        stuck_generation = audio_command->generation;
      }
    } else {
      stuck_session_id = deferred_retire_->command.session_id;
      stuck_generation = deferred_retire_->command.generation;
    }

    logScreen(
      "screen_probe_unresponsive",
      {
        {"candidateStuck", candidate_stuck},
        {"retirementStuck", retirement_stuck},
        {"deferredStuck", deferred_stuck},
        {"audioCandidateStuck", audio_candidate_stuck},
        {"audioRetirementStuck", audio_retirement_stuck},
        {"audioQuarantined", static_cast<std::uint64_t>(audio_retiring_.size())},
        {"sessionId", stuck_session_id},
        {"generation", stuck_generation}
      }
    );

    const char* message = candidate_stuck
      ? "screen publication worker exceeded its operation deadline"
      : (audio_candidate_stuck
        ? "screen audio publication worker exceeded its operation deadline"
        : (audio_retirement_stuck
          ? "screen audio retirement worker exceeded its operation deadline"
          : "screen retirement worker exceeded its operation deadline"));
    auto result = failedReply(
      command,
      "actor_unresponsive",
      message,
      true
    );
    if (result.error) {
      result.error->session_id = std::move(stuck_session_id);
      result.error->generation = stuck_generation;
    }
    return result;
  }

  void shutdown(
      std::optional<std::chrono::steady_clock::time_point> stop_by =
          std::nullopt) {
    if (shutdown_) return;
    const auto deadline = stop_by.value_or(
        std::chrono::steady_clock::now() + kNativeShutdownBudget);
    shutdown_ = true;
    shutdown_requested_.store(true, std::memory_order_release);
    post_->disable();
    is_current_->disable();
    logScreen("screen_shutdown_start");
    if (candidate_) {
      auto attempt = std::move(candidate_);
      attempt->operation.requestCancel();
      const auto retirement = quarantineAttempt(std::move(attempt));
      if (retirement && retirement->cleanup_job &&
          !retirement->cleanup_job->waitUntil(deadline)) {
        const auto cleanup = cleanup_supervisor_->snapshot();
        logScreen(
          "screen_attempt_quarantined_at_shutdown",
          {
            {"sessionId", retirement->session_id},
            {"generation", retirement->generation},
            {"activeJobs", static_cast<std::uint64_t>(cleanup.active_jobs)},
            {"backlogJobs", static_cast<std::uint64_t>(cleanup.backlog_jobs)},
            {"ownedJobs", static_cast<std::uint64_t>(cleanup.owned_jobs)}
          }
        );
      }
    }
    if (audio_candidate_) {
      retireAudioAttempt(std::move(audio_candidate_));
    }
    if (active_) {
      try { retireResources(std::move(active_)); } catch (...) {}
    }
    if (prepared_) {
      try { retireResources(std::move(prepared_)); } catch (...) {}
    }
    drainRetirements(deadline);
    drainAudioRetirements(deadline);
    logScreen("screen_shutdown_done");
  }

 private:
  enum class AttemptKind { Prepare, Start };
  struct ScreenAudioResources {
    MediaCommand command;
    ScreenPublicationDescription description;
    std::uint64_t epoch = 0;
    std::shared_ptr<std::atomic_bool> running;
    std::shared_ptr<syrnike::voice::ScreenAudioStopSignal> stop;
    std::thread worker;
    std::shared_ptr<livekit::AudioSource> source;
    std::shared_ptr<livekit::LocalAudioTrack> track;
    std::string publication_sid;
    SessionEpoch owner_epoch;
    LiveKitConnectPolicy::Clock::time_point retire_requested_at{};
  };

  struct ScreenResources {
    MediaCommand command;
    ScreenPublicationDescription description;
    std::shared_ptr<std::atomic_bool> video_running;
    std::thread video_thread;
    std::shared_ptr<VideoResourceLease> encoder_lease;
    std::shared_ptr<livekit::D3D11H264VideoSource> video_source;
    std::shared_ptr<livekit::LocalVideoTrack> video_track;
    std::shared_ptr<ScreenGpuCapturer> capturer;
    std::string video_publication_sid;
    SessionEpoch owner_epoch;
    std::unique_ptr<ScreenAudioResources> audio;
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
    bool publication_lifecycle_started = false;
    std::atomic_bool publication_lifecycle_terminal{false};
    std::string terminal_reason;
    std::string error;
  };

  struct AudioAttemptState {
    MediaCommand command;
    ScreenPublicationDescription description;
    std::uint64_t epoch = 0;
    std::unique_ptr<ScreenAudioResources> resources;
    std::thread worker;
    MediaOperation operation;
    std::atomic_bool finished{false};
    LiveKitConnectPolicy::Clock::time_point started_at =
      LiveKitConnectPolicy::Clock::now();
    bool succeeded = false;
    bool stale = false;
    bool terminal_cancelled = false;
    std::string terminal_reason;
    std::string error;
  };

  struct AttemptRetiringState {
    std::string session_id;
    std::uint64_t generation = 0;
    std::shared_ptr<AttemptState> attempt;
    std::shared_ptr<CleanupJob> cleanup_job;
    std::atomic_bool cleanup_started{false};
    std::atomic_bool finished{false};
  };

  struct RetiringState {
    std::string id;
    std::string session_id;
    std::uint64_t generation = 0;
    std::unique_ptr<ScreenResources> resources;
    std::shared_ptr<CleanupJob> cleanup_job;
    std::atomic_bool cleanup_started{false};
    std::atomic_bool finished{false};
    LiveKitConnectPolicy::Clock::time_point started_at = LiveKitConnectPolicy::Clock::now();
  };

  struct AudioRetiringState {
    std::string id;
    std::shared_ptr<AudioAttemptState> attempt;
    std::unique_ptr<ScreenAudioResources> resources;
    std::shared_ptr<CleanupJob> cleanup_job;
    std::atomic_bool cleanup_started{false};
    std::atomic_bool finished{false};
    LiveKitConnectPolicy::Clock::time_point started_at =
      LiveKitConnectPolicy::Clock::now();
  };

  RuntimeEvent successfulReply(const MediaCommand& command) const {
    RuntimeEvent result;
    result.type = NativeEventType::Reply;
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
    result.type = NativeEventType::Reply;
    result.request_id = command.request_id;
    result.session_id = command.session_id;
    result.generation = command.generation;
    result.ok = false;
    result.error = NativeError{
      code,
      message,
      std::string(nativeCommandName(command.type)),
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
    if (is_current_->current(command.session_id, command.generation)) return;
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
    return resources.command.session_id == command.session_id &&
      resources.command.participant_identity == command.participant_identity;
  }

  bool isCurrent(const std::shared_ptr<AttemptState>& attempt) const {
    return !shutdown_requested_.load(std::memory_order_acquire) &&
      !attempt->operation.cancelled() &&
      !attempt->operation.expired() &&
      is_current_->current(
          attempt->command.session_id, attempt->command.generation);
  }

  bool isCurrent(const std::shared_ptr<AudioAttemptState>& attempt) const {
    return !shutdown_requested_.load(std::memory_order_acquire) &&
      !attempt->operation.cancelled() &&
      !attempt->operation.expired() &&
      is_current_->current(
        attempt->command.session_id,
        attempt->command.generation
      );
  }

  void emitAudioLifecycle(
    const MediaCommand& command,
    const std::string& status,
    const std::string& reason = {},
    const std::string& error_code = {}
  ) {
    RuntimeEvent event;
    event.type = NativeEventType::SessionLifecycle;
    event.request_id = command.request_id;
    event.session_id = command.session_id;
    event.generation = command.generation;
    event.kind = "screen_audio";
    event.status = status == "failed" ? "error" : status;
    event.detail = reason;
    if (!error_code.empty()) {
      event.error = NativeError{
        error_code,
        reason.empty() ? error_code : reason,
        "screenAudioCapture",
        true,
        command.session_id,
        command.generation,
      };
    }
    emitter_.emit(std::move(event));
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
    if (candidate->kind == AttemptKind::Start) {
      candidate->publication_lifecycle_started = true;
      observeVideoPublication(
          candidate->command, ScreenVideoPublicationPhase::Started);
    }
    try {
      const auto self = shared_from_this();
      candidate->worker =
          std::thread([self, candidate] { self->runAttempt(candidate); });
    } catch (...) {
      auto failed = std::move(candidate_);
      finishVideoPublication(failed, ScreenVideoPublicationPhase::Failed);
      if (failed->obsolete) prepared_ = std::move(failed->obsolete);
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
      auto owner_call = requireSessionPortValue(
        voice_session_->bindCurrentOwner(
          command.session_id,
          command.generation,
          std::chrono::duration_cast<std::chrono::milliseconds>(
            attempt->operation.deadline() - SessionPortCall::Clock::now()
          )
        )
      );
      owner_call.deadline = attempt->operation.deadline();
      requireSessionPortSuccess(voice_session_->lifecycle().require(owner_call));
      resources.owner_epoch = owner_call.expected_epoch;
      resources.command = trackCommand(command);
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
      finishVideoPublication(attempt, ScreenVideoPublicationPhase::Failed);
      attempt->error = error.what();
      // Deadline expiry is a terminal failure for the current generation, not
      // stale work. Only explicit cancellation or a superseded generation may
      // suppress the attempt's terminal projection.
      attempt->stale =
        shutdown_requested_.load(std::memory_order_acquire) ||
        attempt->operation.cancelled() ||
        !is_current_->current(
          attempt->command.session_id,
          attempt->command.generation);
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
      finishVideoPublication(attempt, ScreenVideoPublicationPhase::Failed);
      attempt->error = "unknown screen publication failure";
      attempt->stale = attempt->operation.cancelled();
      if (attempt->resources) cleanupResources(*attempt->resources);
      attempt->succeeded = false;
    }
    attempt->obsolete.reset();
    attempt->finished.store(true);
    MediaCommand internal;
    internal.type = attempt->succeeded
      ? NativeCommandType::ScreenAttemptReady
      : NativeCommandType::ScreenAttemptFailed;
    internal.session_id = attempt->command.session_id;
    internal.generation = attempt->command.generation;
    internal.internal_message = attempt->error;
    if (!shutdown_requested_.load(std::memory_order_acquire)) {
      post_->post(std::move(internal));
    }
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
    try {
      resources.encoder_lease = requireVideoResourceAdmission(
          *resource_budget_,
          VideoResourceRequest{
              .owner = VideoResourceOwner::ScreenEncoder,
              .owner_id = "screen:encoder:" + command.session_id + ":" +
                  std::to_string(command.generation),
              .hardware_encoder_sessions = 1,
          });
    } catch (const VideoResourceSaturationError& error) {
      const auto& saturation = error.saturation();
      logScreen(
          "screen_video_resource_saturated",
          {
              {"owner", videoResourceOwnerName(saturation.owner)},
              {"ownerId", saturation.owner_id},
              {"resourceClass",
               videoResourceClassName(saturation.resource_class)},
              {"current", saturation.current},
              {"requested", saturation.requested},
              {"limit", saturation.limit},
              {"fallback", "fail_closed"},
          });
      throw std::runtime_error(
          "gpu_encoder_session_saturated: " +
          saturation.message());
    }
    if (!isCurrent(attempt)) {
      throw std::runtime_error("stale screen capture generation");
    }
    resources.capturer = prepare_capture_(command, description);
    if (!resources.capturer) {
      throw std::runtime_error(
        "gpu_capture_unavailable: capture preflight returned no capturer");
    }
    logScreen(
      "screen_capture_preflight_ready",
      {{"sessionId", command.session_id}, {"generation", command.generation}}
    );
    if (!isCurrent(attempt)) {
      throw std::runtime_error("stale screen capture generation");
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
    video_options.frame_metadata_features.emplace();
    video_options.frame_metadata_features->user_timestamp = true;
    video_options.frame_metadata_features->frame_id = true;
    video_options.video_encoding = livekit::VideoEncodingOptions{
      static_cast<std::uint64_t>(description.bitrate),
      static_cast<double>(description.fps),
    };
    logScreen(
      "screen_publish_start",
      {{"sessionId", command.session_id}, {"generation", command.generation}}
    );
    auto publication_call = SessionPortCall::forOwner(resources.owner_epoch);
    publication_call.deadline = attempt->operation.deadline();
    resources.video_publication_sid = requireSessionPortValue(
      voice_session_->publication().publishVideoTrack(
        publication_call, resources.video_track, video_options
      )
    );
    if (resources.video_publication_sid.empty()) {
      throw std::runtime_error("LiveKit screen publication SID is empty");
    }
    if (after_video_published_) {
      after_video_published_(command, resources.video_publication_sid);
    }
    logScreen(
      "screen_publish_ack",
      {{"sessionId", command.session_id}, {"generation", command.generation}}
    );
    if (!isCurrent(attempt)) throw std::runtime_error("stale screen publish generation");
    // LiveKit installs the sender frame transformer while completing
    // publication. Starting capture earlier can initialize the encoder before
    // that transformer exists, permanently bypassing packet-trailer metadata.
    resources.video_running = std::make_shared<std::atomic_bool>(true);
    start_video_capture_worker_(
      command,
      description,
      resources.video_source,
      resources.video_track,
      resources.capturer,
      resources.video_running,
      [self = shared_from_this(), attempt] {
        return self->isCurrent(attempt);
      },
      resources.video_thread
    );
    // Published is terminal for teardown only after capture has started.
    finishVideoPublication(attempt, ScreenVideoPublicationPhase::Published);
  }

  void observeVideoPublication(
    const MediaCommand& command,
    ScreenVideoPublicationPhase phase
  ) noexcept {
    try {
      if (video_publication_observer_) {
        video_publication_observer_(command, phase);
      }
    } catch (...) {
      // A diagnostic observer must not change publication ownership.
    }
  }

  void finishVideoPublication(
    const std::shared_ptr<AttemptState>& attempt,
    ScreenVideoPublicationPhase phase
  ) {
    if (!attempt || !attempt->publication_lifecycle_started ||
        attempt->publication_lifecycle_terminal.exchange(
          true, std::memory_order_acq_rel)) {
      return;
    }
    observeVideoPublication(attempt->command, phase);
  }

  void reconcileAudio(
    const MediaCommand& command,
    ScreenResources& resources,
    const ScreenPublicationDescription& description
  ) {
    resources.description.publish_audio = description.publish_audio;
    resources.description.audio_mode = description.audio_mode;
    resources.description.loopback_mode = description.loopback_mode;
    resources.description.audio_target_process_id =
      description.audio_target_process_id;
    if (!description.publish_audio) {
      if (audio_candidate_ &&
          audio_candidate_->command.session_id == command.session_id &&
          audio_candidate_->command.generation == command.generation) {
        retireAudioAttempt(std::move(audio_candidate_));
      }
      if (resources.audio) {
        retireAudioResources(std::move(resources.audio));
        emitAudioLifecycle(command, "stopped", "audio_disabled");
      }
      return;
    }
    if (resources.audio || audio_candidate_) return;
    reapAudioRetirements();
    if (audio_retiring_.size() >= kMaximumAudioQuarantines) {
      emitAudioLifecycle(
        command,
        "failed",
        "screen audio cleanup capacity is occupied",
        "audio_capture_failed"
      );
      return;
    }
    launchAudioAttempt(command, description);
  }

  void launchAudioAttempt(
    const MediaCommand& command,
    const ScreenPublicationDescription& description
  ) {
    auto attempt = std::make_shared<AudioAttemptState>();
    attempt->command = trackCommand(command);
    attempt->description = description;
    attempt->epoch = ++next_audio_epoch_;
    attempt->started_at = now_();
    attempt->resources = std::make_unique<ScreenAudioResources>();
    attempt->resources->command = trackCommand(command);
    attempt->resources->description = description;
    attempt->resources->epoch = attempt->epoch;
    audio_candidate_ = attempt;
    emitAudioLifecycle(command, "starting", "audio_publish_start");
    try {
      const auto self = shared_from_this();
      attempt->worker = std::thread(
        [self, attempt] { self->runAudioAttempt(attempt); });
    } catch (...) {
      audio_candidate_.reset();
      emitAudioLifecycle(
        command,
        "failed",
        "failed to start screen audio publication worker",
        "audio_capture_failed"
      );
    }
  }

  void runAudioAttempt(const std::shared_ptr<AudioAttemptState>& attempt) {
    try {
      auto& resources = *attempt->resources;
      const auto& command = attempt->command;
      auto owner_call = requireSessionPortValue(
        voice_session_->bindCurrentOwner(
          command.session_id,
          command.generation,
          std::chrono::duration_cast<std::chrono::milliseconds>(
            attempt->operation.deadline() - SessionPortCall::Clock::now()
          )
        )
      );
      owner_call.deadline = attempt->operation.deadline();
      requireSessionPortSuccess(voice_session_->lifecycle().require(owner_call));
      resources.owner_epoch = owner_call.expected_epoch;
      resources.source = std::make_shared<livekit::AudioSource>(48'000, 2);
      resources.track = livekit::LocalAudioTrack::createLocalAudioTrack(
        "screen-audio",
        resources.source
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
        {
          {"sessionId", command.session_id},
          {"generation", command.generation},
          {"epoch", attempt->epoch}
        }
      );
      auto publication_call = SessionPortCall::forOwner(resources.owner_epoch);
      publication_call.deadline = attempt->operation.deadline();
      resources.publication_sid = requireSessionPortValue(
        voice_session_->publication().publishAudioTrack(
          publication_call, resources.track, audio_options
        )
      );
      if (resources.publication_sid.empty()) {
        throw std::runtime_error("audio_capture_failed: empty publication SID");
      }
      if (!isCurrent(attempt)) {
        throw std::runtime_error("stale_generation: screen audio publish");
      }
      resources.running = std::make_shared<std::atomic_bool>(true);
      resources.stop =
        std::make_shared<syrnike::voice::ScreenAudioStopSignal>();
      auto worker_command = command;
      worker_command.internal_epoch = attempt->epoch;
      start_audio_capture_worker_(
        worker_command,
        attempt->description,
        resources.source,
        resources.running,
        resources.stop,
        resources.worker
      );
      if (!isCurrent(attempt)) {
        throw std::runtime_error("stale_generation: screen audio start");
      }
      attempt->succeeded = true;
    } catch (const std::exception& error) {
      attempt->error = error.what();
      attempt->stale =
        shutdown_requested_.load(std::memory_order_acquire) ||
        attempt->operation.cancelled() ||
        !is_current_->current(
          attempt->command.session_id,
          attempt->command.generation
        );
      attempt->succeeded = false;
    } catch (...) {
      attempt->error = "audio_capture_failed: unknown screen audio failure";
      attempt->stale = attempt->operation.cancelled();
      attempt->succeeded = false;
    }
    attempt->finished.store(true, std::memory_order_release);
    if (shutdown_requested_.load(std::memory_order_acquire)) return;
    MediaCommand internal;
    internal.type = attempt->succeeded
      ? NativeCommandType::ScreenAudioAttemptReady
      : NativeCommandType::ScreenAudioAttemptFailed;
    internal.session_id = attempt->command.session_id;
    internal.generation = attempt->command.generation;
    internal.internal_epoch = attempt->epoch;
    internal.internal_message = attempt->error;
    post_->post(std::move(internal));
  }

  void finishAudioAttempt(const MediaCommand& command) {
    if (!audio_candidate_ ||
        audio_candidate_->command.session_id != command.session_id ||
        audio_candidate_->command.generation != command.generation ||
        audio_candidate_->epoch != command.internal_epoch) {
      return;
    }
    auto attempt = std::move(audio_candidate_);
    if (attempt->worker.joinable()) attempt->worker.join();
    const bool current = active_ && matches(*active_, attempt->command) &&
      is_current_->current(
        attempt->command.session_id,
        attempt->command.generation
      );
    const bool promoted = attempt->succeeded && current &&
      !attempt->terminal_cancelled && !attempt->operation.cancelled() &&
      !attempt->operation.expired();
    if (promoted) {
      active_->audio = std::move(attempt->resources);
      emitAudioLifecycle(attempt->command, "running", "audio_capture_ready");
      return;
    }
    if (attempt->resources) {
      retireAudioResources(std::move(attempt->resources));
    }
    const bool stale = attempt->stale || !current ||
      attempt->operation.cancelled();
    if (stale && !attempt->terminal_cancelled) return;
    const auto reason = attempt->terminal_cancelled
      ? attempt->terminal_reason
      : (attempt->operation.expired()
          ? std::string("native_operation_timeout")
          : attempt->error);
    emitAudioLifecycle(
      attempt->command,
      "failed",
      reason.empty() ? "screen audio capture failed" : reason,
      screenAudioFailureCode(reason)
    );
  }

  void handleAudioTerminal(const MediaCommand& command) {
    if (audio_candidate_ &&
        audio_candidate_->command.session_id == command.session_id &&
        audio_candidate_->command.generation == command.generation &&
        (command.internal_epoch == 0 ||
         audio_candidate_->epoch == command.internal_epoch)) {
      auto attempt = std::move(audio_candidate_);
      attempt->terminal_cancelled = true;
      attempt->terminal_reason = command.internal_message;
      retireAudioAttempt(std::move(attempt));
      emitAudioLifecycle(
        command,
        "failed",
        command.internal_message,
        screenAudioFailureCode(command.internal_message)
      );
      return;
    }
    if (!active_ || !active_->audio || !matches(*active_, command) ||
        (command.internal_epoch != 0 &&
         active_->audio->epoch != command.internal_epoch)) {
      return;
    }
    auto resources = std::move(active_->audio);
    retireAudioResources(std::move(resources));
    emitAudioLifecycle(
      command,
      "failed",
      command.internal_message,
      screenAudioFailureCode(command.internal_message)
    );
  }

  void finishAttempt(const std::string& session_id, std::uint64_t generation) {
    if (!candidate_ || candidate_->command.session_id != session_id ||
        candidate_->command.generation != generation) return;
    auto attempt = std::move(candidate_);
    if (attempt->worker.joinable()) attempt->worker.join();
    const bool terminal_failure = attempt->terminal_cancelled &&
      is_current_->current(
          attempt->command.session_id, attempt->command.generation);
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
      stale = !is_current_->current(
          attempt->command.session_id, attempt->command.generation);
    }
    if (terminal_failure) stale = false;
    if (!attempt->succeeded || !promoted) {
      if (attempt->resources) {
        retireResources(std::move(attempt->resources));
      }
      const auto failure_code = terminal_failure
        ? std::string("screen_runtime_lost")
        : (stale
            ? std::string("stale_generation")
            : (expired
                ? std::string("native_operation_timeout")
                : screenFailureCode(attempt->error)));
      emitter_.emit(failedReply(
        attempt->command,
        failure_code,
        terminal_failure
          ? (attempt->terminal_reason.empty()
              ? "screen runtime ended during publication"
              : attempt->terminal_reason)
          : (expired ? "screen publication deadline expired" :
              (attempt->error.empty()
              ? (stale ? "stale screen publication generation" : "screen publication failed")
              : attempt->error)),
        terminal_failure ||
          (!stale && screenFailureRetryable(failure_code))
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
    emitStarted(
      attempt->command,
      *active_,
      true
    );
    reconcileAudio(
      attempt->command,
      *active_,
      active_->description
    );
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
    emitter_.emit(result);
    if (emit_session_started) {
      RuntimeEvent started = result;
      started.type = NativeEventType::SessionStarted;
      emitter_.emit(std::move(started));
    }
    RuntimeEvent running;
    running.type = NativeEventType::SessionLifecycle;
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
    event.type = NativeEventType::SessionStopped;
    event.session_id = session_id;
    event.generation = generation;
    event.reason = reason;
    emitter_.emit(std::move(event));
  }

  void cleanupAudioResources(ScreenAudioResources& resources) noexcept {
    if (resources.running) resources.running->store(false);
    if (resources.stop) resources.stop->signal();
    if (resources.worker.joinable()) {
      try {
        resources.worker.join();
      } catch (...) {
        std::terminate();
      }
    }
    auto publication_sid = std::move(resources.publication_sid);
    if (!publication_sid.empty()) {
      try {
        requireSessionPortSuccess(voice_session_->publication().unpublishTrack(
          SessionPortCall::forOwner(resources.owner_epoch),
          publication_sid
        ));
      } catch (...) {
      }
    }
    resources.track.reset();
    resources.source.reset();
    resources.running.reset();
    resources.stop.reset();
  }

  void finalizeAudioRetirement(
    const std::shared_ptr<AudioRetiringState>& state
  ) noexcept {
    if (!state ||
        state->cleanup_started.exchange(true, std::memory_order_acq_rel)) {
      return;
    }
    if (state->attempt) {
      if (state->attempt->worker.joinable()) {
        try {
          state->attempt->worker.join();
        } catch (...) {
          std::terminate();
        }
      }
      if (!state->resources) {
        state->resources = std::move(state->attempt->resources);
      }
      state->attempt.reset();
    }
    if (state->resources) cleanupAudioResources(*state->resources);
    state->resources.reset();
    state->finished.store(true, std::memory_order_release);
  }

  void finalizeAttemptRetirement(
    const std::shared_ptr<AttemptRetiringState>& state
  ) noexcept {
    if (!state ||
        state->cleanup_started.exchange(true, std::memory_order_acq_rel)) {
      return;
    }
    if (state->attempt) {
      if (state->attempt->worker.joinable()) {
        try {
          state->attempt->worker.join();
        } catch (...) {
          std::terminate();
        }
      }
      if (state->attempt->resources) {
        cleanupResources(*state->attempt->resources);
      }
      if (state->attempt->obsolete) {
        cleanupResources(*state->attempt->obsolete);
      }
      state->attempt.reset();
    }
    state->finished.store(true, std::memory_order_release);
  }

  static void cleanupAttemptRetirement(
    const std::shared_ptr<void>& owner,
    const std::shared_ptr<void>& retained_state
  ) noexcept {
    const auto implementation = std::static_pointer_cast<Implementation>(owner);
    const auto retirement =
      std::static_pointer_cast<AttemptRetiringState>(retained_state);
    implementation->finalizeAttemptRetirement(retirement);
  }

  std::shared_ptr<AttemptRetiringState> quarantineAttempt(
    std::shared_ptr<AttemptState> attempt
  ) noexcept {
    if (!attempt) return {};
    try {
      auto state = std::make_shared<AttemptRetiringState>();
      state->session_id = attempt->command.session_id;
      state->generation = attempt->command.generation;
      state->attempt = std::move(attempt);
      auto task = std::make_shared<ScreenRetireCleanupTask>();
      auto job = std::make_shared<CleanupJob>(cleanup_start_probe_);
      task->configure(
        shared_from_this(), state, &Implementation::cleanupAttemptRetirement);
      job->prepare(
        task,
        reinterpret_cast<CleanupResourceKey>(state->attempt.get()),
        [](void* context) {
          static_cast<ScreenRetireCleanupTask*>(context)->run();
        }
      );
      state->cleanup_job = job;
      runCleanupEnqueueProbe(cleanup_enqueue_probe_);
      cleanup_supervisor_->submitOrEscalate(job, "screen_publication_attempt");
      return state;
    } catch (...) {
      logScreen("screen_attempt_quarantine_submit_failed");
      std::terminate();
    }
  }

  static void cleanupAudioRetirement(
    const std::shared_ptr<void>& owner,
    const std::shared_ptr<void>& retained_state
  ) noexcept {
    const auto implementation = std::static_pointer_cast<Implementation>(owner);
    const auto retirement =
      std::static_pointer_cast<AudioRetiringState>(retained_state);
    implementation->finalizeAudioRetirement(retirement);
  }

  void submitAudioRetirement(
    const std::shared_ptr<AudioRetiringState>& state
  ) noexcept {
    try {
      auto task = std::make_shared<ScreenRetireCleanupTask>();
      auto job = std::make_shared<CleanupJob>(cleanup_start_probe_);
      task->configure(
        shared_from_this(),
        state,
        &Implementation::cleanupAudioRetirement
      );
      job->prepare(
        task,
        reinterpret_cast<CleanupResourceKey>(voice_session_.get()),
        [](void* context) {
          static_cast<ScreenRetireCleanupTask*>(context)->run();
        }
      );
      state->cleanup_job = job;
      audio_retiring_.push_back(state);
      runCleanupEnqueueProbe(cleanup_enqueue_probe_);
      cleanup_supervisor_->submitOrEscalate(job, "screen_audio_publication");
    } catch (...) {
      logScreen("screen_audio_retire_submit_failed");
      std::terminate();
    }
  }

  void retireAudioResources(
    std::unique_ptr<ScreenAudioResources> resources
  ) noexcept {
    if (!resources) return;
    if (resources->running) resources->running->store(false);
    if (resources->stop) resources->stop->signal();
    auto state = std::make_shared<AudioRetiringState>();
    state->id = "audio-" + std::to_string(++next_audio_retire_id_);
    state->started_at = now_();
    state->resources = std::move(resources);
    submitAudioRetirement(state);
  }

  void retireAudioAttempt(
    std::shared_ptr<AudioAttemptState> attempt
  ) noexcept {
    if (!attempt) return;
    attempt->operation.requestCancel();
    auto state = std::make_shared<AudioRetiringState>();
    state->id = "audio-attempt-" +
      std::to_string(++next_audio_retire_id_);
    state->started_at = now_();
    state->attempt = std::move(attempt);
    submitAudioRetirement(state);
  }

  void reapAudioRetirements() {
    for (auto iterator = audio_retiring_.begin();
         iterator != audio_retiring_.end();) {
      if (!(*iterator)->finished.load(std::memory_order_acquire)) {
        ++iterator;
        continue;
      }
      iterator = audio_retiring_.erase(iterator);
    }
  }

  void drainAudioRetirements(
    std::chrono::steady_clock::time_point deadline
  ) noexcept {
    for (const auto& retirement : audio_retiring_) {
      if (!retirement || !retirement->cleanup_job ||
          retirement->cleanup_job->waitUntil(deadline)) {
        continue;
      }
      logScreen(
        "screen_audio_retire_unfinished_at_shutdown",
        {{"retireId", retirement->id}}
      );
    }
    audio_retiring_.clear();
  }

  void cleanupResources(ScreenResources& resources) noexcept {
    if (resources.video_running) resources.video_running->store(false);
    if (resources.audio) cleanupAudioResources(*resources.audio);
    if (resources.video_thread.joinable()) {
      try {
        resources.video_thread.join();
      } catch (...) {
        std::terminate();
      }
    }
    resources.capturer.reset();

    auto video_sid = std::move(resources.video_publication_sid);
    const auto session_id = resources.command.session_id;
    try {
      if (before_resource_cleanup_) before_resource_cleanup_();
    } catch (...) {
    }
    if (!video_sid.empty()) {
      try {
        requireSessionPortSuccess(voice_session_->publication().unpublishTrack(
          SessionPortCall::forOwner(resources.owner_epoch), video_sid
        ));
      } catch (...) {
      }
    }
    resources.video_track.reset();
    resources.video_source.reset();
    resources.encoder_lease.reset();
    resources.video_running.reset();
    resources.audio.reset();
  }

  void finalizeRetirement(
      const std::shared_ptr<RetiringState>& state) noexcept {
    if (!state ||
        state->cleanup_started.exchange(true, std::memory_order_acq_rel)) {
      return;
    }
    try {
      if (state->resources) {
        cleanupResources(*state->resources);
      }
    } catch (...) {
    }
    state->resources.reset();
    state->finished.store(true, std::memory_order_release);
  }

  static void cleanupRetirement(
      const std::shared_ptr<void>& owner,
      const std::shared_ptr<void>& retained_state) noexcept {
    const auto implementation =
        std::static_pointer_cast<Implementation>(owner);
    const auto retirement =
        std::static_pointer_cast<RetiringState>(retained_state);
    implementation->finalizeRetirement(retirement);
  }

  static void cleanupRetirementAndPost(
      const std::shared_ptr<void>& owner,
      const std::shared_ptr<void>& retained_state) noexcept {
    const auto implementation =
        std::static_pointer_cast<Implementation>(owner);
    const auto retirement =
        std::static_pointer_cast<RetiringState>(retained_state);
    implementation->finalizeRetirement(retirement);
    try {
      const auto retry_warning_at =
          std::chrono::steady_clock::now() + std::chrono::seconds(5);
      bool warned = false;
      while (!implementation->shutdown_requested_.load(
          std::memory_order_acquire)) {
        MediaCommand done;
        done.type = NativeCommandType::ScreenRetireDone;
        done.internal_message = retirement->id;
        if (implementation->post_->post(std::move(done))) return;
        if (!warned &&
            std::chrono::steady_clock::now() >= retry_warning_at) {
          warned = true;
          logScreen(
              "screen_retire_completion_retry_delayed",
              {{"retireId", retirement->id}});
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }
    } catch (...) {
    }
  }

  void submitRetirement(
      const std::shared_ptr<RetiringState>& state,
      bool post_completion,
      std::shared_ptr<ScreenRetireCleanupTask> task = {},
      std::shared_ptr<CleanupJob> job = {}) noexcept {
    try {
      if (!task) task = std::make_shared<ScreenRetireCleanupTask>();
      if (!job) job = std::make_shared<CleanupJob>(cleanup_start_probe_);
      task->configure(
          shared_from_this(),
          state,
          post_completion
              ? &Implementation::cleanupRetirementAndPost
              : &Implementation::cleanupRetirement);
      job->prepare(
          task,
          reinterpret_cast<CleanupResourceKey>(voice_session_.get()),
          [](void* context) {
            static_cast<ScreenRetireCleanupTask*>(context)->run();
          });
      runCleanupEnqueueProbe(cleanup_enqueue_probe_);
      cleanup_supervisor_->submitOrEscalate(job, "screen_publication");
      state->cleanup_job = std::move(job);
    } catch (...) {
      logScreen(
          "screen_retire_submit_failed",
          {{"reason", "runtime_loss"}});
      std::terminate();
    }
  }

  void retireResources(std::unique_ptr<ScreenResources> resources) noexcept {
    try {
      if (!resources) return;
      if (resources->video_running) resources->video_running->store(false);
      if (resources->audio) {
        if (resources->audio->running) resources->audio->running->store(false);
        if (resources->audio->stop) resources->audio->stop->signal();
      }
      if (resources->retire_requested_at ==
          LiveKitConnectPolicy::Clock::time_point{}) {
        resources->retire_requested_at = now_();
      }
      if (retiring_) {
        if (deferred_retire_) {
          auto overflow = std::make_shared<RetiringState>();
          overflow->id = "overflow-" + std::to_string(++next_retire_id_);
          overflow->resources = std::move(resources);
          overflow->session_id = overflow->resources->command.session_id;
          overflow->generation = overflow->resources->command.generation;
          overflow->started_at = overflow->resources->retire_requested_at;
          try {
            overflow_retiring_.push_back(overflow);
          } catch (...) {
            submitRetirement(overflow, false);
            return;
          }
          submitRetirement(overflow, false);
          try {
            logScreen("screen_retire_overflow_forced");
          } catch (...) {
          }
          return;
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
      retiring_ = std::move(retiring);
      submitRetirement(retiring_, true);
    } catch (...) {
      logScreen(
          "screen_retire_prepare_failed",
          {{"reason", "runtime_loss"}});
      std::terminate();
    }
  }

  void finishRetire(const std::string& id) {
    if (!retiring_ || retiring_->id != id) return;
    retiring_.reset();
    logScreen("screen_retire_done", {{"retireId", id}});
    startDeferredRetire();
  }

  void startDeferredRetire() {
    if (!retiring_ && deferred_retire_) {
      auto next = std::move(deferred_retire_);
      retireResources(std::move(next));
    }
  }

  void reapFinishedWork() {
    if (candidate_ && candidate_->finished.load()) {
      finishAttempt(candidate_->command.session_id, candidate_->command.generation);
    }
    if (audio_candidate_ &&
        audio_candidate_->finished.load(std::memory_order_acquire)) {
      MediaCommand finished;
      finished.type = audio_candidate_->succeeded
        ? NativeCommandType::ScreenAudioAttemptReady
        : NativeCommandType::ScreenAudioAttemptFailed;
      finished.session_id = audio_candidate_->command.session_id;
      finished.generation = audio_candidate_->command.generation;
      finished.internal_epoch = audio_candidate_->epoch;
      finishAudioAttempt(finished);
    }
    if (retiring_ && retiring_->finished.load()) {
      const auto id = retiring_->id;
      finishRetire(id);
    }
    if (!retiring_ && deferred_retire_) startDeferredRetire();
    for (auto iterator = overflow_retiring_.begin();
         iterator != overflow_retiring_.end();) {
      if (!(*iterator)->finished.load(std::memory_order_acquire)) {
        ++iterator;
        continue;
      }
      iterator = overflow_retiring_.erase(iterator);
    }
    reapAudioRetirements();
  }

  void drainRetirements(
      std::chrono::steady_clock::time_point deadline) noexcept {
    if (deferred_retire_) {
      auto state = std::move(shutdown_retiring_state_);
      state->resources = std::move(deferred_retire_);
      state->generation = state->resources->command.generation;
      state->started_at = state->resources->retire_requested_at;
      shutdown_retiring_in_flight_ = state;
      submitRetirement(
          state,
          false,
          std::move(shutdown_cleanup_task_),
          std::move(shutdown_cleanup_job_));
    }

    auto wait_state = [&](const std::shared_ptr<RetiringState>& state) {
      if (!state || !state->cleanup_job ||
          state->cleanup_job->waitUntil(deadline)) {
        return;
      }
      const auto cleanup = cleanup_supervisor_->snapshot();
      logScreen(
        "screen_retire_unfinished_at_shutdown",
        {
          {"retireId", state->id},
          {"activeJobs", static_cast<std::uint64_t>(cleanup.active_jobs)},
          {"backlogJobs", static_cast<std::uint64_t>(cleanup.backlog_jobs)},
          {"ownedJobs", static_cast<std::uint64_t>(cleanup.owned_jobs)}
        }
      );
    };

    if (retiring_) wait_state(retiring_);
    for (const auto& overflow : overflow_retiring_) wait_state(overflow);
    if (shutdown_retiring_in_flight_) {
      wait_state(shutdown_retiring_in_flight_);
    }
    retiring_.reset();
    overflow_retiring_.clear();
    shutdown_retiring_in_flight_.reset();
  }

  SequencedEmitter& emitter_;
  std::shared_ptr<ScreenPostGate> post_;
  std::shared_ptr<ScreenCurrentGate> is_current_;
  std::shared_ptr<LiveKitVoiceSession> voice_session_;
  CommitIfCurrent commit_if_current_;
  Now now_;
  DescribePublication describe_publication_;
  PrepareCapture prepare_capture_;
  StartVideoCaptureWorker start_video_capture_worker_;
  StartAudioCaptureWorker start_audio_capture_worker_;
  CapturePromoted capture_promoted_;
  AfterVideoPublished after_video_published_;
  ScreenVideoPublicationObserver video_publication_observer_;
  QueryEncoderCapability query_encoder_capability_;
  CreateVideoSource create_video_source_;
  BeforeResourceCleanup before_resource_cleanup_;
  CleanupSupervisor* cleanup_supervisor_;
  CleanupStartProbe cleanup_start_probe_;
  CleanupEnqueueProbe cleanup_enqueue_probe_;
  VideoResourceAdmissionBudget* resource_budget_ = nullptr;
  std::shared_ptr<ScreenRetireCleanupTask> shutdown_cleanup_task_;
  std::shared_ptr<CleanupJob> shutdown_cleanup_job_;
  std::shared_ptr<RetiringState> shutdown_retiring_state_;
  std::shared_ptr<RetiringState> shutdown_retiring_in_flight_;
  std::unique_ptr<ScreenResources> prepared_;
  std::unique_ptr<ScreenResources> active_;
  std::shared_ptr<AttemptState> candidate_;
  std::shared_ptr<AudioAttemptState> audio_candidate_;
  std::shared_ptr<RetiringState> retiring_;
  std::unique_ptr<ScreenResources> deferred_retire_;
  std::vector<std::shared_ptr<RetiringState>> overflow_retiring_;
  std::vector<std::shared_ptr<AudioRetiringState>> audio_retiring_;
  std::atomic_bool shutdown_requested_{false};
  std::uint64_t next_retire_id_ = 0;
  std::uint64_t next_audio_epoch_ = 0;
  std::uint64_t next_audio_retire_id_ = 0;
  static constexpr std::size_t kMaximumAudioQuarantines = 2;
  bool shutdown_ = false;
};

ScreenPublicationController::ScreenPublicationController(
  SequencedEmitter& emitter,
  InternalPost post,
  IsCurrent is_current,
  std::shared_ptr<LiveKitVoiceSession> voice_session,
  CommitIfCurrent commit_if_current,
  Now now,
  DescribePublication describe_publication,
  PrepareCapture prepare_capture,
  StartVideoCaptureWorker start_video_capture_worker,
  StartAudioCaptureWorker start_audio_capture_worker,
  CapturePromoted capture_promoted,
  QueryEncoderCapability query_encoder_capability,
  CreateVideoSource create_video_source,
  CleanupStartProbe cleanup_start_probe,
  CleanupEnqueueProbe cleanup_enqueue_probe,
  BeforeResourceCleanup before_resource_cleanup,
  VideoResourceAdmissionBudget* resource_budget,
  AfterVideoPublished after_video_published,
  ScreenVideoPublicationObserver video_publication_observer
) : implementation_(std::make_shared<Implementation>(
      emitter,
      std::move(post),
      std::move(is_current),
      std::move(voice_session),
      std::move(commit_if_current),
      std::move(now),
      std::move(describe_publication),
      std::move(prepare_capture),
      std::move(start_video_capture_worker),
      std::move(start_audio_capture_worker),
      std::move(capture_promoted),
      std::move(after_video_published),
      std::move(video_publication_observer),
      std::move(query_encoder_capability),
      std::move(create_video_source),
      std::move(cleanup_start_probe),
      std::move(cleanup_enqueue_probe),
      std::move(before_resource_cleanup),
      resource_budget
    )) {}

ScreenPublicationController::~ScreenPublicationController() {
  if (implementation_) implementation_->shutdown();
}

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
void ScreenPublicationController::shutdown(
    std::chrono::steady_clock::time_point deadline) {
  implementation_->shutdown(deadline);
}

}  // namespace syrnike::desktop_native::media
