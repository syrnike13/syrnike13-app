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
  return EngineFailure{
    std::move(code),
    std::move(message),
    std::move(stage),
    retryable,
  };
}

enum class CommandType {
  Start,
  Ping,
  Shutdown,
};

struct Command {
  explicit Command(CommandType value) : type(value) {}

  CommandType type;
  std::promise<EngineResult> completion;
};

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

  EngineResult registerEventCallback(LifecycleEventCallback callback) {
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

  EngineResult start(std::chrono::milliseconds deadline) {
    if (started_once_.exchange(true)) {
      return EngineResult::fail(failure(
        "engine_instance_consumed",
        "A stopped Engine instance cannot be started again",
        "start"
      ));
    }
    const auto result = submit(CommandType::Start, deadline, "start");
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
    return submit(CommandType::Ping, deadline, "ping");
  }

  EngineResult shutdown(std::chrono::milliseconds deadline) {
    std::lock_guard shutdown_lock(shutdown_api_mutex_);
    if (shutdown_complete_.load()) {
      joinControlThread();
      return EngineResult::success();
    }
    shutdown_requested_.store(true);
    startup_gate_.notify_all();
    const auto result = submit(CommandType::Shutdown, deadline, "shutdown");
    if (result.ok) joinControlThread();
    return result;
  }

  EngineState state() const noexcept {
    return state_.load();
  }

 private:
  EngineResult submit(
    CommandType type,
    std::chrono::milliseconds deadline,
    const char* stage
  ) {
    try {
      auto command = std::make_shared<Command>(type);
      auto completed = command->completion.get_future();
      {
        std::lock_guard lock(queue_mutex_);
        if (type != CommandType::Shutdown && shutdown_requested_.load()) {
          return EngineResult::fail(failure(
            "engine_stopping",
            "Engine shutdown has already started",
            stage,
            true
          ));
        }
        if (control_exited_) {
          return type == CommandType::Shutdown
            ? EngineResult::success()
            : EngineResult::fail(failure(
                "engine_stopped",
                "Engine control thread has stopped",
                stage
              ));
        }
        const auto capacity = type == CommandType::Shutdown
          ? kControlQueueCapacity
          : kControlQueueCapacity - 1;
        if (commands_.size() >= capacity) {
          return EngineResult::fail(failure(
            "control_queue_full",
            "Engine control queue is full",
            stage,
            true
          ));
        }
        commands_.push_back(std::move(command));
      }
      queue_changed_.notify_one();
      if (completed.wait_for(deadline) != std::future_status::ready) {
        return EngineResult::fail(failure(
          "control_deadline_exceeded",
          "Engine control operation exceeded its deadline",
          stage,
          true
        ));
      }
      return completed.get();
    } catch (const std::exception& error) {
      return EngineResult::fail(failure(
        "control_submission_failed",
        error.what(),
        stage
      ));
    } catch (...) {
      return EngineResult::fail(failure(
        "control_submission_failed",
        "Unknown control submission failure",
        stage
      ));
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

      EngineResult result;
      try {
        result = handle(command->type);
      } catch (const std::exception& error) {
        transition(
          EngineState::Failed,
          failure("control_exception", error.what(), "control_thread")
        );
        result = EngineResult::fail(failure(
          "control_exception",
          error.what(),
          "control_thread"
        ));
      } catch (...) {
        transition(
          EngineState::Failed,
          failure(
            "control_exception",
            "Unknown exception on the Engine control thread",
            "control_thread"
          )
        );
        result = EngineResult::fail(failure(
          "control_exception",
          "Unknown exception on the Engine control thread",
          "control_thread"
        ));
      }
      command->completion.set_value(std::move(result));
      if (command->type == CommandType::Shutdown) break;
    }
    {
      std::lock_guard lock(queue_mutex_);
      control_exited_ = true;
    }
  }

  EngineResult handle(CommandType type) {
    switch (type) {
      case CommandType::Start:
        return handleStart();
      case CommandType::Ping:
        return handlePing();
      case CommandType::Shutdown:
        return handleShutdown();
    }
    return EngineResult::fail(failure(
      "unknown_control_command",
      "Engine received an unknown control command",
      "control_thread"
    ));
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
    shutdown_complete_.store(true);
    return EngineResult::success();
  }

  void transition(
    EngineState next,
    std::optional<EngineFailure> transition_failure = std::nullopt
  ) {
    const auto previous = state_.exchange(next);
    LifecycleEventCallback callback;
    {
      std::lock_guard lock(callback_mutex_);
      callback = callback_;
    }
    if (!callback) return;
    callback(LifecycleEvent{
      ++event_sequence_,
      previous,
      next,
      std::move(transition_failure),
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
  LifecycleEventCallback callback_;
  std::uint64_t event_sequence_ = 0;
  std::mutex startup_mutex_;
  std::condition_variable startup_gate_;
  std::mutex hang_mutex_;
  std::condition_variable hang_gate_;
};

Engine::Engine(EngineOptions options)
  : implementation_(std::make_unique<Implementation>(options)) {}

Engine::~Engine() noexcept = default;

EngineResult Engine::registerEventCallback(LifecycleEventCallback callback) {
  return implementation_->registerEventCallback(std::move(callback));
}

EngineResult Engine::start(std::chrono::milliseconds deadline) {
  return implementation_->start(deadline);
}

EngineResult Engine::ping(std::chrono::milliseconds deadline) {
  return implementation_->ping(deadline);
}

EngineResult Engine::shutdown(std::chrono::milliseconds deadline) {
  return implementation_->shutdown(deadline);
}

EngineState Engine::state() const noexcept {
  return implementation_->state();
}

}  // namespace syrnike::windows_media
