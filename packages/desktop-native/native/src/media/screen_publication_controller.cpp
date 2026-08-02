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

  void retainBefore(std::shared_ptr<ScreenRetireCleanupTask> next) noexcept {
    retained_next_ = std::move(next);
  }

  std::shared_ptr<ScreenRetireCleanupTask> takeRetainedNext() noexcept {
    return std::move(retained_next_);
  }

 private:
  std::atomic_bool started_{false};
  std::shared_ptr<void> owner_;
  std::shared_ptr<void> state_;
  CleanupThunk cleanup_ = nullptr;
  std::shared_ptr<ScreenRetireCleanupTask> retained_next_;
};

class ScreenRetireFallbackDispatcher final {
 public:
  using Task = std::shared_ptr<ScreenRetireCleanupTask>;

  explicit ScreenRetireFallbackDispatcher(
      ScreenPublicationController::LaunchRetireWorker launcher,
      ScreenPublicationController::BeforeRetireEnqueue before_enqueue)
      : state_(std::make_shared<State>()) {
    if (!launcher) {
      launcher = [](std::function<void()> work) {
        return std::thread(std::move(work));
      };
    }
    state_->launcher = std::move(launcher);
    state_->before_enqueue = std::move(before_enqueue);
    management_thread_ = std::thread([state = state_] {
      runManagement(std::move(state));
    });
  }

  ~ScreenRetireFallbackDispatcher() {
    close(std::chrono::steady_clock::now() + kNativeShutdownBudget);
  }

  void submit(Task task) {
    {
      std::lock_guard lock(state_->mutex);
      bool force_retained = false;
      try {
        if (state_->before_enqueue) state_->before_enqueue();
      } catch (...) {
        force_retained = true;
      }
      if (!force_retained && state_->ready.size() < kReadyCapacity) {
        try {
          state_->ready.push_back(task);
        } catch (...) {
          task->retainBefore(std::move(state_->retained_overflow));
          state_->retained_overflow = std::move(task);
        }
      } else {
        task->retainBefore(std::move(state_->retained_overflow));
        state_->retained_overflow = std::move(task);
      }
    }
    state_->changed.notify_all();
  }

  void close(std::chrono::steady_clock::time_point deadline) noexcept {
    if (!management_thread_.joinable()) return;
    {
      std::lock_guard lock(state_->mutex);
      state_->closing = true;
    }
    state_->changed.notify_all();
    bool finished = false;
    {
      std::unique_lock lock(state_->mutex);
      state_->finished_changed.wait_until(
          lock, deadline, [&] { return state_->finished; });
      finished = state_->finished;
    }
    if (finished) {
      management_thread_.join();
    } else {
      management_thread_.detach();
      logScreen(
        "screen_retire_dispatcher_detached",
        {{"reason", "shutdown_deadline"}}
      );
    }
  }

 private:
  static constexpr std::size_t kReadyCapacity = 8;

  struct State {
    std::mutex mutex;
    std::condition_variable changed;
    std::condition_variable finished_changed;
    std::deque<Task> ready;
    Task retained_overflow;
    ScreenPublicationController::LaunchRetireWorker launcher;
    ScreenPublicationController::BeforeRetireEnqueue before_enqueue;
    bool closing = false;
    bool finished = false;
  };

  static void runManagement(std::shared_ptr<State> state) noexcept {
    for (;;) {
      Task task;
      {
        std::unique_lock lock(state->mutex);
        state->changed.wait(lock, [&] {
          return state->closing || !state->ready.empty() ||
              state->retained_overflow != nullptr;
        });
        if (state->ready.empty() && state->retained_overflow) {
          task = std::move(state->retained_overflow);
          state->retained_overflow = task->takeRetainedNext();
        } else if (!state->ready.empty()) {
          task = state->ready.front();
        }
        if (!task) {
          state->finished = true;
          state->finished_changed.notify_all();
          return;
        }
      }

      try {
        auto worker = state->launcher([task] { task->run(); });
        worker.detach();
        std::lock_guard lock(state->mutex);
        if (!state->ready.empty() &&
            state->ready.front() == task) {
          state->ready.pop_front();
        }
      } catch (...) {
        {
          std::lock_guard lock(state->mutex);
          if (state->ready.empty() ||
              state->ready.front() != task) {
            task->retainBefore(std::move(state->retained_overflow));
            state->retained_overflow = task;
          }
        }
        try {
          logScreen(
            "screen_retire_dispatcher_worker_failed",
            {{"reason", "worker_launch_failed"}}
          );
        } catch (...) {
        }
        std::unique_lock lock(state->mutex);
        state->changed.wait_for(lock, std::chrono::milliseconds(25));
      }
    }
  }

  std::shared_ptr<State> state_;
  std::thread management_thread_;
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
    std::shared_ptr<LiveKitPublicationClient> livekit_client,
    CommitIfCurrent commit_if_current,
    Now now,
    DescribePublication describe_publication,
    PrepareCapture prepare_capture,
    StartCaptureWorkers start_capture_workers,
    CapturePromoted capture_promoted,
    QueryEncoderCapability query_encoder_capability,
    CreateVideoSource create_video_source,
    LaunchRetireWorker launch_retire_worker,
    BeforeRetireEnqueue before_retire_enqueue,
    BeforeResourceCleanup before_resource_cleanup
  ) : emitter_(emitter),
      post_(std::make_shared<ScreenPostGate>(std::move(post))),
      is_current_(std::make_shared<ScreenCurrentGate>(
          std::move(is_current))),
      livekit_client_(std::move(livekit_client)),
      commit_if_current_(std::move(commit_if_current)),
      now_(std::move(now)),
      describe_publication_(std::move(describe_publication)),
      prepare_capture_(std::move(prepare_capture)),
      start_capture_workers_(std::move(start_capture_workers)),
      capture_promoted_(std::move(capture_promoted)),
      query_encoder_capability_(std::move(query_encoder_capability)),
      create_video_source_(std::move(create_video_source)),
      before_resource_cleanup_(std::move(before_resource_cleanup)),
      launch_retire_worker_(
          launch_retire_worker
            ? std::move(launch_retire_worker)
            : LaunchRetireWorker([](std::function<void()> work) {
                return std::thread(std::move(work));
              })),
      shutdown_cleanup_task_(
          std::make_shared<ScreenRetireCleanupTask>()),
      shutdown_retiring_state_(std::make_shared<RetiringState>()),
      retire_dispatcher_(
          std::make_shared<ScreenRetireFallbackDispatcher>(
              launch_retire_worker_,
              std::move(before_retire_enqueue))) {
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
    if ((command.type == "disconnectScreen" || command.terminal || command.force) &&
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
      candidate_->operation.requestCancel();
      while (!candidate_->finished.load(std::memory_order_acquire) &&
             std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      if (candidate_->worker.joinable()) {
        if (candidate_->finished.load(std::memory_order_acquire)) {
          candidate_->worker.join();
        } else {
          candidate_->worker.detach();
          logScreen("screen_attempt_detached_at_shutdown");
        }
      }
      candidate_.reset();
    }
    if (active_) {
      try { retireResources(std::move(active_)); } catch (...) {}
    }
    if (prepared_) {
      try { retireResources(std::move(prepared_)); } catch (...) {}
    }
    drainRetirements(deadline);
    logScreen("screen_shutdown_done");
  }

 private:
  enum class AttemptKind { Prepare, Start };
  struct ScreenResources {
    MediaCommand command;
    std::unique_ptr<LiveKitTrackPublication> publication;
    ScreenPublicationDescription description;
    std::shared_ptr<std::atomic_bool> capture_running;
    std::shared_ptr<syrnike::voice::ScreenAudioStopSignal> audio_stop;
    std::thread capture_thread;
    std::thread audio_thread;
    std::shared_ptr<livekit::D3D11H264VideoSource> video_source;
    std::shared_ptr<livekit::LocalVideoTrack> video_track;
    std::shared_ptr<ScreenGpuCapturer> capturer;
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
    std::atomic_bool cleanup_started{false};
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
    return resources.publication &&
      resources.command.session_id == command.session_id &&
      resources.command.participant_identity == command.participant_identity;
  }

  bool isCurrent(const std::shared_ptr<AttemptState>& attempt) const {
    return !shutdown_requested_.load(std::memory_order_acquire) &&
      !attempt->operation.cancelled() &&
      !attempt->operation.expired() &&
      is_current_->current(
          attempt->command.session_id, attempt->command.generation);
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
      const auto self = shared_from_this();
      candidate->worker =
          std::thread([self, candidate] { self->runAttempt(candidate); });
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
    resources.audio_stop =
      std::make_shared<syrnike::voice::ScreenAudioStopSignal>();
    start_capture_workers_(
      command,
      description,
      resources.video_source,
      resources.video_track,
      resources.audio_source,
      resources.capturer,
      resources.capture_running,
      resources.audio_stop,
      [self = shared_from_this(), attempt] {
        return self->isCurrent(attempt);
      },
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
      if (attempt->resources && attempt->resources->publication) {
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

  void cleanupResources(ScreenResources& resources) noexcept {
    if (resources.capture_running) resources.capture_running->store(false);
    if (resources.audio_stop) resources.audio_stop->signal();
    auto finish_thread = [](std::thread& worker) noexcept {
      if (!worker.joinable()) return;
      try {
        worker.join();
      } catch (...) {
        try {
          if (worker.joinable()) worker.detach();
        } catch (...) {
        }
      }
    };
    finish_thread(resources.capture_thread);
    finish_thread(resources.audio_thread);
    resources.capturer.reset();

    auto publication = std::move(resources.publication);
    auto video_sid = std::move(resources.video_publication_sid);
    auto audio_sid = std::move(resources.audio_publication_sid);
    try {
      if (before_resource_cleanup_) before_resource_cleanup_();
    } catch (...) {
    }
    if (publication && !video_sid.empty()) {
      try {
        publication->unpublishTrack(video_sid);
      } catch (...) {
      }
    }
    if (publication && !audio_sid.empty()) {
      try {
        publication->unpublishTrack(audio_sid);
      } catch (...) {
      }
    }
    publication.reset();
    resources.video_track.reset();
    resources.audio_track.reset();
    resources.video_source.reset();
    resources.audio_source.reset();
    resources.capture_running.reset();
    resources.audio_stop.reset();
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

  void retainRetirement(
      const std::shared_ptr<RetiringState>& state,
      std::shared_ptr<ScreenRetireCleanupTask> task) noexcept {
    const auto self = shared_from_this();
    task->configure(
      self,
      state,
      [](
          const std::shared_ptr<void>& owner,
          const std::shared_ptr<void>& retained_state) noexcept {
        const auto implementation =
          std::static_pointer_cast<Implementation>(owner);
        const auto retirement =
          std::static_pointer_cast<RetiringState>(retained_state);
        implementation->finalizeRetirement(retirement);
      }
    );
    retire_dispatcher_->submit(std::move(task));
  }

  void retireResources(std::unique_ptr<ScreenResources> resources) noexcept {
    try {
      if (!resources) return;
      if (resources->capture_running) resources->capture_running->store(false);
      if (resources->audio_stop) resources->audio_stop->signal();
      if (resources->retire_requested_at ==
          LiveKitConnectPolicy::Clock::time_point{}) {
        resources->retire_requested_at = now_();
      }
      if (retiring_) {
        if (deferred_retire_) {
          auto cleanup_task = std::make_shared<ScreenRetireCleanupTask>();
          auto overflow = std::make_shared<RetiringState>();
          overflow->id = "overflow-" + std::to_string(++next_retire_id_);
          overflow->resources = std::move(resources);
          overflow->session_id = overflow->resources->command.session_id;
          overflow->generation = overflow->resources->command.generation;
          overflow->started_at = overflow->resources->retire_requested_at;
          try {
            overflow_retiring_.push_back(overflow);
          } catch (...) {
            retainRetirement(overflow, std::move(cleanup_task));
            return;
          }
          try {
            const auto state = overflow;
            const auto self = shared_from_this();
            overflow->worker = launch_retire_worker_([self, state] {
              self->finalizeRetirement(state);
            });
          } catch (...) {
            overflow_retiring_.pop_back();
            retainRetirement(overflow, std::move(cleanup_task));
            try {
              logScreen("screen_retire_overflow_worker_start_failed");
            } catch (...) {
            }
            return;
          }
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
      const auto state = retiring;
      try {
        const auto self = shared_from_this();
        retiring->worker = launch_retire_worker_(
          [self, state]() mutable {
            self->finalizeRetirement(state);
            try {
              const auto retry_warning_at =
                std::chrono::steady_clock::now() + std::chrono::seconds(5);
              bool warned = false;
              while (!self->shutdown_requested_.load(
                  std::memory_order_acquire)) {
                MediaCommand done;
                done.type = "__screenRetireDone";
                done.internal_message = state->id;
                if (self->post_->post(std::move(done))) return;
                if (!warned &&
                    std::chrono::steady_clock::now() >= retry_warning_at) {
                  warned = true;
                  try {
                    logScreen(
                      "screen_retire_completion_retry_delayed",
                      {{"retireId", state->id}}
                    );
                  } catch (...) {
                  }
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
              }
            } catch (...) {
            }
          }
        );
      } catch (...) {
        deferred_retire_ = std::move(retiring->resources);
        logScreen("screen_retire_worker_start_failed");
        return;
      }
      retiring_ = std::move(retiring);
    } catch (...) {
      // This function is called from terminal/disconnect paths. Allocation or
      // logging failures must not escape them or terminate the utility host.
      try {
        if (resources) cleanupResources(*resources);
      } catch (...) {
      }
    }
  }

  void finishRetire(const std::string& id) {
    if (!retiring_ || retiring_->id != id) return;
    if (retiring_->worker.joinable()) retiring_->worker.join();
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
      if ((*iterator)->worker.joinable()) (*iterator)->worker.join();
      iterator = overflow_retiring_.erase(iterator);
    }
  }

  void drainRetirements(
      std::chrono::steady_clock::time_point deadline) noexcept {
    if (deferred_retire_) {
      auto state = std::move(shutdown_retiring_state_);
      state->resources = std::move(deferred_retire_);
      state->generation = state->resources->command.generation;
      state->started_at = state->resources->retire_requested_at;
      shutdown_retiring_in_flight_ = state;
      try {
        const auto self = shared_from_this();
        state->worker = launch_retire_worker_([self, state] {
          self->finalizeRetirement(state);
        });
      } catch (...) {
        shutdown_retiring_in_flight_.reset();
        // The management dispatcher owns this exact cleanup and retries worker
        // launch independently of any later actor command. SDK teardown never
        // runs on the management thread, so one hung unpublish cannot stall
        // subsequent retained retirements.
        auto task = std::move(shutdown_cleanup_task_);
        retainRetirement(state, std::move(task));
        try {
          logScreen("screen_shutdown_deferred_retire_launch_failed");
        } catch (...) {
        }
      }
    }

    auto wait_state = [&](const std::shared_ptr<RetiringState>& state) {
      while (!state->finished.load(std::memory_order_acquire) &&
             std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      if (!state->worker.joinable()) return;
      if (state->finished.load(std::memory_order_acquire)) {
        state->worker.join();
      } else {
        state->worker.detach();
        logScreen(
          "screen_retire_detached_at_shutdown",
          {{"retireId", state->id}}
        );
      }
    };

    if (retiring_) wait_state(retiring_);
    for (const auto& overflow : overflow_retiring_) wait_state(overflow);
    if (shutdown_retiring_in_flight_) {
      wait_state(shutdown_retiring_in_flight_);
    }
    retiring_.reset();
    overflow_retiring_.clear();
    shutdown_retiring_in_flight_.reset();
    retire_dispatcher_->close(deadline);
  }

  SequencedEmitter& emitter_;
  std::shared_ptr<ScreenPostGate> post_;
  std::shared_ptr<ScreenCurrentGate> is_current_;
  std::shared_ptr<LiveKitPublicationClient> livekit_client_;
  CommitIfCurrent commit_if_current_;
  Now now_;
  DescribePublication describe_publication_;
  PrepareCapture prepare_capture_;
  StartCaptureWorkers start_capture_workers_;
  CapturePromoted capture_promoted_;
  QueryEncoderCapability query_encoder_capability_;
  CreateVideoSource create_video_source_;
  BeforeResourceCleanup before_resource_cleanup_;
  LaunchRetireWorker launch_retire_worker_;
  std::shared_ptr<ScreenRetireCleanupTask> shutdown_cleanup_task_;
  std::shared_ptr<RetiringState> shutdown_retiring_state_;
  std::shared_ptr<RetiringState> shutdown_retiring_in_flight_;
  std::shared_ptr<ScreenRetireFallbackDispatcher> retire_dispatcher_;
  std::unique_ptr<ScreenResources> prepared_;
  std::unique_ptr<ScreenResources> active_;
  std::shared_ptr<AttemptState> candidate_;
  std::shared_ptr<RetiringState> retiring_;
  std::unique_ptr<ScreenResources> deferred_retire_;
  std::vector<std::shared_ptr<RetiringState>> overflow_retiring_;
  std::atomic_bool shutdown_requested_{false};
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
  PrepareCapture prepare_capture,
  StartCaptureWorkers start_capture_workers,
  CapturePromoted capture_promoted,
  QueryEncoderCapability query_encoder_capability,
  CreateVideoSource create_video_source,
  LaunchRetireWorker launch_retire_worker,
  BeforeRetireEnqueue before_retire_enqueue,
  BeforeResourceCleanup before_resource_cleanup
) : implementation_(std::make_shared<Implementation>(
      emitter,
      std::move(post),
      std::move(is_current),
      std::move(livekit_client),
      std::move(commit_if_current),
      std::move(now),
      std::move(describe_publication),
      std::move(prepare_capture),
      std::move(start_capture_workers),
      std::move(capture_promoted),
      std::move(query_encoder_capability),
      std::move(create_video_source),
      std::move(launch_retire_worker),
      std::move(before_retire_enqueue),
      std::move(before_resource_cleanup)
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
