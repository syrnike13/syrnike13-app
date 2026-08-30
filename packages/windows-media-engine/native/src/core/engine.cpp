#include "core/engine.hpp"

#include <atomic>
#include <condition_variable>
#include <deque>
#include <exception>
#include <future>
#include <mutex>
#include <thread>
#include <utility>

namespace syrnike::windows_media {

namespace {

EngineFailure failure(
  std::string code,
  std::string message,
  std::string stage,
  bool retryable = false
) {
  const auto bounded = [](std::string value, std::size_t maximum) {
    if (value.empty()) value = "unknown";
    if (value.size() > maximum) value.resize(maximum);
    return value;
  };
  return EngineFailure{
    bounded(std::move(code), 128),
    bounded(std::move(message), 4096),
    bounded(std::move(stage), 128),
    retryable,
  };
}

enum class CommandType {
  Start,
  ApplyDesiredState,
  QuerySnapshot,
  Ping,
  Shutdown,
};

struct ControlReply {
  EngineResult status;
  std::uint64_t accepted_revision = 0;
  bool duplicate = false;
  std::optional<EngineSnapshot> snapshot;
};

struct Command {
  explicit Command(
    CommandType value,
    std::chrono::steady_clock::time_point expires,
    std::optional<EngineDesiredState> state = std::nullopt
  ) : type(value), expires_at(expires), desired_state(std::move(state)) {}

  CommandType type;
  std::chrono::steady_clock::time_point expires_at;
  std::optional<EngineDesiredState> desired_state;
  std::promise<ControlReply> completion;
  std::mutex commit_mutex;
  bool cancelled = false;
  bool committed = false;
};

ControlReply controlReply(EngineResult status) {
  return ControlReply{std::move(status)};
}

bool validIdentifier(const std::string& value) {
  if (value.empty() || value.size() > kMaximumIdentifierLength) return false;
  for (const unsigned char character : value) {
    if (character < 0x21 || character > 0x7e) return false;
  }
  return true;
}

std::optional<EngineFailure> validateDesiredState(
  const EngineDesiredState& desired_state
) {
  if (desired_state.revision == 0 ||
      desired_state.revision > kMaximumProtocolInteger) {
    return failure(
      "desired_state_invalid",
      "Desired state revision must be positive",
      "apply_desired_state"
    );
  }
  if (desired_state.room &&
      (!validIdentifier(desired_state.room->room_id) ||
       !validIdentifier(desired_state.room->participant_identity))) {
    return failure(
      "desired_state_invalid",
      "Room intent contains an invalid bounded identifier",
      "apply_desired_state"
    );
  }
  if (desired_state.remote_video_demand.size() >
      kMaximumRemoteVideoDemands) {
    return failure(
      "desired_state_invalid",
      "Remote video demand exceeds the bounded entry limit",
      "apply_desired_state"
    );
  }
  for (const auto& demand : desired_state.remote_video_demand) {
    if (!validIdentifier(demand.participant_identity) ||
        !validIdentifier(demand.publication_id)) {
      return failure(
        "desired_state_invalid",
        "Remote video demand contains an invalid bounded identifier",
        "apply_desired_state"
      );
    }
  }
  return std::nullopt;
}

}  // namespace

EngineResult EngineResult::success() {
  return EngineResult{true, std::nullopt};
}

EngineResult EngineResult::fail(EngineFailure value) {
  return EngineResult{false, std::move(value)};
}

const char* engineStateName(EngineState state) noexcept {
  switch (state) {
    case EngineState::Stopped:
      return "stopped";
    case EngineState::Starting:
      return "starting";
    case EngineState::Running:
      return "running";
    case EngineState::Stopping:
      return "stopping";
    case EngineState::Failed:
      return "failed";
  }
  return "failed";
}

const char* trackKindName(TrackKind track) noexcept {
  switch (track) {
    case TrackKind::Microphone:
      return "microphone";
    case TrackKind::Camera:
      return "camera";
    case TrackKind::Screen:
      return "screen";
    case TrackKind::Output:
      return "output";
  }
  return "microphone";
}

class Engine::Implementation final {
 public:
  explicit Implementation(EngineOptions options)
    : options_(options), control_thread_([this] { controlLoop(); }) {}

  ~Implementation() noexcept {
    if (!control_thread_.joinable()) return;
    const auto result = shutdown(kShutdownDeadline);
    if (!result.ok && control_thread_.joinable()) {
      // A non-cooperative control thread cannot be safely abandoned. The
      // utility process is the escalation boundary, so fail immediately
      // instead of hiding an unbounded wait in the destructor.
      std::terminate();
    }
  }

  EngineResult registerEventCallback(PublicEventCallback callback) {
    if (!callback) {
      return EngineResult::fail(failure(
        "invalid_event_callback",
        "Lifecycle event callback must be callable",
        "register_event_callback"
      ));
    }
    if (started_once_.load() || shutdown_requested_.load()) {
      return EngineResult::fail(failure(
        "callback_registration_closed",
        "Lifecycle callback must be registered before startup",
        "register_event_callback"
      ));
    }
    std::lock_guard lock(callback_mutex_);
    if (callback_) {
      return EngineResult::fail(failure(
        "callback_already_registered",
        "Only one lifecycle callback may be registered",
        "register_event_callback"
      ));
    }
    callback_ = std::move(callback);
    return EngineResult::success();
  }

  EngineResult registerDiagnosticEventCallback(DiagnosticEventCallback callback) {
    if (!callback) {
      return EngineResult::fail(failure(
        "invalid_diagnostic_callback",
        "Diagnostic event callback must be callable",
        "register_diagnostic_callback"
      ));
    }
    if (started_once_.load() || shutdown_requested_.load()) {
      return EngineResult::fail(failure(
        "callback_registration_closed",
        "Diagnostic callback must be registered before startup",
        "register_diagnostic_callback"
      ));
    }
    std::lock_guard lock(diagnostic_callback_mutex_);
    if (diagnostic_callback_) {
      return EngineResult::fail(failure(
        "callback_already_registered",
        "Only one diagnostic callback may be registered",
        "register_diagnostic_callback"
      ));
    }
    diagnostic_callback_ = std::move(callback);
    return EngineResult::success();
  }

  EngineResult start(std::chrono::milliseconds deadline) {
    if (started_once_.exchange(true)) {
      return EngineResult::fail(failure(
        "engine_instance_consumed",
        "A stopped Engine instance cannot be started again",
        "start"
      ));
    }
    const auto result = submit(CommandType::Start, deadline, "start").status;
    if (!result.ok && result.failure &&
        result.failure->code == "control_deadline_exceeded") {
      shutdown_requested_.store(true);
      startup_gate_.notify_all();
    }
    return result;
  }

  EngineResult ping(std::chrono::milliseconds deadline) {
    if (shutdown_requested_.load()) {
      return EngineResult::fail(failure(
        "engine_stopping",
        "Engine shutdown has already started",
        "ping",
        true
      ));
    }
    return submit(CommandType::Ping, deadline, "ping").status;
  }

  ApplyDesiredStateResult applyDesiredState(
    EngineDesiredState desired_state,
    std::chrono::milliseconds deadline
  ) {
    auto reply = submit(
      CommandType::ApplyDesiredState,
      deadline,
      "apply_desired_state",
      std::move(desired_state)
    );
    return ApplyDesiredStateResult{
      reply.status.ok,
      reply.accepted_revision,
      reply.duplicate,
      std::move(reply.status.failure),
    };
  }

  QuerySnapshotResult querySnapshot(std::chrono::milliseconds deadline) {
    auto reply = submit(CommandType::QuerySnapshot, deadline, "query_snapshot");
    return QuerySnapshotResult{
      reply.status.ok,
      std::move(reply.snapshot),
      std::move(reply.status.failure),
    };
  }

  EngineResult shutdown(std::chrono::milliseconds deadline) {
    std::lock_guard shutdown_lock(shutdown_api_mutex_);
    if (shutdown_complete_.load()) {
      joinControlThread();
      return EngineResult::success();
    }
    shutdown_requested_.store(true);
    startup_gate_.notify_all();
    const auto result = submit(CommandType::Shutdown, deadline, "shutdown").status;
    if (result.ok) joinControlThread();
    return result;
  }

  EngineState state() const noexcept {
    return state_.load();
  }

 private:
  ControlReply submit(
    CommandType type,
    std::chrono::milliseconds deadline,
    const char* stage,
    std::optional<EngineDesiredState> desired_state = std::nullopt
  ) {
    try {
      auto command = std::make_shared<Command>(
        type,
        std::chrono::steady_clock::now() + deadline,
        std::move(desired_state)
      );
      auto completed = command->completion.get_future();
      {
        std::lock_guard lock(queue_mutex_);
        if (type != CommandType::Shutdown && shutdown_requested_.load()) {
          return controlReply(EngineResult::fail(failure(
            "engine_stopping",
            "Engine shutdown has already started",
            stage,
            true
          )));
        }
        if (control_exited_) {
          return type == CommandType::Shutdown
            ? controlReply(EngineResult::success())
            : controlReply(EngineResult::fail(failure(
                "engine_stopped",
                "Engine control thread has stopped",
                stage
              )));
        }
        const auto capacity = type == CommandType::Shutdown
          ? kControlQueueCapacity
          : kControlQueueCapacity - 1;
        if (commands_.size() >= capacity) {
          return controlReply(EngineResult::fail(failure(
            "control_queue_full",
            "Engine control queue is full",
            stage,
            true
          )));
        }
        commands_.push_back(command);
      }
      queue_changed_.notify_one();
      if (completed.wait_until(command->expires_at) != std::future_status::ready) {
        if (type == CommandType::ApplyDesiredState) {
          std::unique_lock commit_lock(command->commit_mutex);
          if (command->committed) {
            commit_lock.unlock();
            completed.wait();
            return completed.get();
          }
          command->cancelled = true;
        }
        return controlReply(EngineResult::fail(failure(
          "control_deadline_exceeded",
          "Engine control operation exceeded its deadline",
          stage,
          true
        )));
      }
      return completed.get();
    } catch (const std::exception& error) {
      return controlReply(EngineResult::fail(failure(
        "control_submission_failed",
        error.what(),
        stage
      )));
    } catch (...) {
      return controlReply(EngineResult::fail(failure(
        "control_submission_failed",
        "Unknown control submission failure",
        stage
      )));
    }
  }

  void controlLoop() noexcept {
    while (true) {
      std::shared_ptr<Command> command;
      {
        std::unique_lock lock(queue_mutex_);
        queue_changed_.wait(lock, [this] { return !commands_.empty(); });
        command = std::move(commands_.front());
        commands_.pop_front();
      }

      ControlReply result;
      try {
        result = handle(*command);
      } catch (const std::exception& error) {
        transition(
          EngineState::Failed,
          failure("control_exception", error.what(), "control_thread")
        );
        result = controlReply(EngineResult::fail(failure(
          "control_exception",
          error.what(),
          "control_thread"
        )));
      } catch (...) {
        transition(
          EngineState::Failed,
          failure(
            "control_exception",
            "Unknown exception on the Engine control thread",
            "control_thread"
          )
        );
        result = controlReply(EngineResult::fail(failure(
          "control_exception",
          "Unknown exception on the Engine control thread",
          "control_thread"
        )));
      }
      command->completion.set_value(std::move(result));
      if (command->type == CommandType::Shutdown) break;
    }
    {
      std::lock_guard lock(queue_mutex_);
      control_exited_ = true;
    }
  }

  ControlReply handle(Command& command) {
    if (command.type != CommandType::Shutdown &&
        std::chrono::steady_clock::now() >= command.expires_at) {
      return controlReply(EngineResult::fail(failure(
        "control_deadline_exceeded",
        "Expired control operation was not executed",
        "control_thread",
        true
      )));
    }
    switch (command.type) {
      case CommandType::Start:
        return controlReply(handleStart());
      case CommandType::ApplyDesiredState:
        return handleApplyDesiredState(command);
      case CommandType::QuerySnapshot:
        return handleQuerySnapshot();
      case CommandType::Ping:
        return controlReply(handlePing());
      case CommandType::Shutdown:
        return controlReply(handleShutdown());
    }
    return controlReply(EngineResult::fail(failure(
      "unknown_control_command",
      "Engine received an unknown control command",
      "control_thread"
    )));
  }

  ControlReply handleApplyDesiredState(Command& command) {
    const auto& desired_state = command.desired_state;
    if (state_.load() != EngineState::Running) {
      return controlReply(EngineResult::fail(failure(
        "engine_not_running",
        "Applying desired state requires the Running state",
        "apply_desired_state",
        true
      )));
    }
    if (!desired_state) {
      return controlReply(EngineResult::fail(failure(
        "desired_state_invalid",
        "Desired state payload is missing",
        "apply_desired_state"
      )));
    }
    if (auto invalid = validateDesiredState(*desired_state)) {
      return controlReply(EngineResult::fail(std::move(*invalid)));
    }
    if (options_.test_before_apply_commit) {
      options_.test_before_apply_commit();
    }
    std::lock_guard commit_lock(command.commit_mutex);
    if (command.cancelled ||
        std::chrono::steady_clock::now() >= command.expires_at) {
      return controlReply(EngineResult::fail(failure(
        "control_deadline_exceeded",
        "Expired desired state was not committed",
        "apply_desired_state",
        true
      )));
    }
    command.committed = true;
    if (accepted_desired_state_) {
      if (desired_state->revision < accepted_desired_state_->revision) {
        return controlReply(EngineResult::fail(failure(
          "stale_revision",
          "Desired state revision is older than the accepted revision",
          "apply_desired_state"
        )));
      }
      if (desired_state->revision == accepted_desired_state_->revision) {
        if (*desired_state != *accepted_desired_state_) {
          return controlReply(EngineResult::fail(failure(
            "revision_conflict",
            "Desired state revision was reused with different content",
            "apply_desired_state"
          )));
        }
        return ControlReply{
          EngineResult::success(),
          accepted_desired_state_->revision,
          true,
        };
      }
    }
    emitDesiredStateEvents(accepted_desired_state_, *desired_state);
    accepted_desired_state_ = *desired_state;
    emitDiagnostic(
      "desired_state_accepted",
      static_cast<double>(accepted_desired_state_->revision)
    );
    return ControlReply{
      EngineResult::success(),
      accepted_desired_state_->revision,
      false,
    };
  }

  ControlReply handleQuerySnapshot() const {
    if (state_.load() != EngineState::Running) {
      return controlReply(EngineResult::fail(failure(
        "engine_not_running",
        "Querying the snapshot requires the Running state",
        "query_snapshot",
        true
      )));
    }
    ControlReply reply{EngineResult::success()};
    reply.snapshot = EngineSnapshot{
      state_.load(),
      accepted_desired_state_ ? accepted_desired_state_->revision : 0,
      accepted_desired_state_,
    };
    return reply;
  }

  EngineResult handleStart() {
    transition(EngineState::Starting);
    if (options_.test_block_start_until_shutdown) {
      std::unique_lock lock(startup_mutex_);
      startup_gate_.wait(lock, [this] { return shutdown_requested_.load(); });
    }
    if (shutdown_requested_.load()) {
      auto cancelled = failure(
        "startup_cancelled",
        "Engine startup was cancelled by shutdown",
        "start",
        true
      );
      transition(EngineState::Failed, cancelled);
      return EngineResult::fail(std::move(cancelled));
    }
    if (options_.fail_start) {
      auto start_failure = failure(
        "startup_failed",
        "Deterministic Engine startup failure was requested",
        "start"
      );
      transition(EngineState::Failed, start_failure);
      return EngineResult::fail(std::move(start_failure));
    }
    transition(EngineState::Running);
    return EngineResult::success();
  }

  EngineResult handlePing() {
    if (state_.load() != EngineState::Running) {
      return EngineResult::fail(failure(
        "engine_not_running",
        "Engine ping requires the Running state",
        "ping",
        true
      ));
    }
    return EngineResult::success();
  }

  EngineResult handleShutdown() {
    transition(EngineState::Stopping);
    if (options_.test_hang_on_shutdown) {
      std::unique_lock lock(hang_mutex_);
      hang_gate_.wait(lock, [] { return false; });
    }
    transition(EngineState::Stopped);
    {
      std::lock_guard lock(callback_mutex_);
      callback_ = {};
    }
    {
      std::lock_guard lock(diagnostic_callback_mutex_);
      diagnostic_callback_ = {};
    }
    shutdown_complete_.store(true);
    return EngineResult::success();
  }

  void transition(
    EngineState next,
    std::optional<EngineFailure> transition_failure = std::nullopt
  ) {
    const auto previous = state_.exchange(next);
    PublicEventCallback callback;
    {
      std::lock_guard lock(callback_mutex_);
      callback = callback_;
    }
    if (!callback) return;
    callback(PublicEvent{LifecycleEvent{
      ++event_sequence_,
      previous,
      next,
      transition_failure,
    }});
    if (next == EngineState::Failed && transition_failure &&
        transition_failure->code != "startup_cancelled") {
      callback(PublicEvent{FatalEngineFailureEvent{
        ++event_sequence_,
        std::move(*transition_failure),
      }});
    }
  }

  void emitDesiredStateEvents(
    const std::optional<EngineDesiredState>& previous,
    const EngineDesiredState& desired_state
  ) {
    PublicEventCallback callback;
    {
      std::lock_guard lock(callback_mutex_);
      callback = callback_;
    }
    if (!callback) return;
    const bool first_snapshot = !previous.has_value();
    if (first_snapshot ||
        previous->room.has_value() != desired_state.room.has_value()) {
      callback(PublicEvent{RoomStateChangedEvent{
        ++event_sequence_,
        desired_state.revision,
        desired_state.room.has_value(),
      }});
    }
    if (first_snapshot) {
      for (const auto track : {
        TrackKind::Microphone,
        TrackKind::Camera,
        TrackKind::Screen,
        TrackKind::Output,
      }) {
        callback(PublicEvent{TrackStateChangedEvent{
          ++event_sequence_,
          desired_state.revision,
          track,
        }});
      }
    }
  }

  void emitDiagnostic(const char* code, double revision) {
    DiagnosticEventCallback callback;
    {
      std::lock_guard lock(diagnostic_callback_mutex_);
      callback = diagnostic_callback_;
    }
    if (!callback) return;
    const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()
    ).count();
    callback(DiagnosticEvent{
      ++diagnostic_sequence_,
      static_cast<std::uint64_t>(now),
      "engine",
      "apply_desired_state",
      code,
      {DiagnosticMetric{"revision", revision}},
    });
  }

  void joinControlThread() noexcept {
    if (control_thread_.joinable() &&
        control_thread_.get_id() != std::this_thread::get_id()) {
      control_thread_.join();
    }
  }

  const EngineOptions options_;
  std::atomic<EngineState> state_{EngineState::Stopped};
  std::atomic_bool started_once_{false};
  std::atomic_bool shutdown_requested_{false};
  std::atomic_bool shutdown_complete_{false};
  std::mutex queue_mutex_;
  std::condition_variable queue_changed_;
  std::deque<std::shared_ptr<Command>> commands_;
  bool control_exited_ = false;
  std::thread control_thread_;
  std::mutex shutdown_api_mutex_;
  std::mutex callback_mutex_;
  PublicEventCallback callback_;
  std::uint64_t event_sequence_ = 0;
  std::mutex diagnostic_callback_mutex_;
  DiagnosticEventCallback diagnostic_callback_;
  std::uint64_t diagnostic_sequence_ = 0;
  std::optional<EngineDesiredState> accepted_desired_state_;
  std::mutex startup_mutex_;
  std::condition_variable startup_gate_;
  std::mutex hang_mutex_;
  std::condition_variable hang_gate_;
};

Engine::Engine(EngineOptions options)
  : implementation_(std::make_unique<Implementation>(options)) {}

Engine::~Engine() noexcept = default;

EngineResult Engine::registerEventCallback(PublicEventCallback callback) {
  return implementation_->registerEventCallback(std::move(callback));
}

EngineResult Engine::registerDiagnosticEventCallback(
  DiagnosticEventCallback callback
) {
  return implementation_->registerDiagnosticEventCallback(std::move(callback));
}

EngineResult Engine::start(std::chrono::milliseconds deadline) {
  return implementation_->start(deadline);
}

EngineResult Engine::ping(std::chrono::milliseconds deadline) {
  return implementation_->ping(deadline);
}

ApplyDesiredStateResult Engine::applyDesiredState(
  EngineDesiredState desired_state,
  std::chrono::milliseconds deadline
) {
  return implementation_->applyDesiredState(std::move(desired_state), deadline);
}

QuerySnapshotResult Engine::querySnapshot(std::chrono::milliseconds deadline) {
  return implementation_->querySnapshot(deadline);
}

EngineResult Engine::shutdown(std::chrono::milliseconds deadline) {
  return implementation_->shutdown(deadline);
}

EngineState Engine::state() const noexcept {
  return implementation_->state();
}

}  // namespace syrnike::windows_media
