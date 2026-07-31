#include "camera_actor.hpp"

#include "media_operation.hpp"
#include "media_runtime_support.hpp"
#include "../common/diagnostic_log.hpp"

#include <mfapi.h>
#include <livekit/d3d11_h264_video_source.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <latch>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

namespace syrnike::desktop_native::media {
namespace {

RuntimeEvent cameraReply(const MediaCommand& command) {
  RuntimeEvent event;
  event.type = "reply";
  event.request_id = command.request_id;
  event.session_id = command.session_id;
  event.generation = command.generation;
  event.ok = true;
  return event;
}

RuntimeEvent cancelledReply(const MediaCommand& command) {
  auto event = cameraReply(command);
  event.ok = false;
  event.error = NativeError{"stale_generation", "Camera connection attempt was superseded",
    "connectCamera", false, command.session_id, command.generation};
  return event;
}

MediaCommand trackCommand(MediaCommand command) {
  command.livekit_url.clear();
  command.livekit_token.clear();
  return command;
}

class CameraTextureLease final : public livekit::D3D11TextureLease {
 public:
  CameraTextureLease(
      std::shared_ptr<CameraCapture> capture,
      CameraFrame frame)
      : capture_(std::move(capture)), frame_(std::move(frame)) {
    texture_.shared_handle = frame_.shared_texture_handle;
    texture_.adapter_luid = frame_.adapter_luid;
    texture_.acquire_key = 1;
    texture_.release_key = 0;
    texture_.width = frame_.width;
    texture_.height = frame_.height;
  }

  ~CameraTextureLease() override {
    if (!accepted_) release();
  }

  const livekit::D3D11SharedTexture& texture() const noexcept override {
    return texture_;
  }

  void accepted() noexcept override { accepted_ = true; }

  void release() noexcept override {
    if (released_) return;
    released_ = true;
    auto capture = std::move(capture_);
    if (capture) capture->discard(frame_);
  }

 private:
  std::shared_ptr<CameraCapture> capture_;
  CameraFrame frame_;
  livekit::D3D11SharedTexture texture_;
  bool accepted_ = false;
  bool released_ = false;
};

class CameraTerminalPostGate final {
 public:
  CameraTerminalPostGate(
      CameraActor::InternalPost post,
      CameraActor::BeforeTerminalPost before_post)
      : post_(std::move(post)), before_post_(std::move(before_post)) {}

  bool post(MediaCommand command) {
    CameraActor::InternalPost post;
    CameraActor::BeforeTerminalPost before_post;
    {
      std::lock_guard lock(mutex_);
      if (!enabled_) return false;
      post = post_;
      before_post = before_post_;
      ++in_flight_;
    }
    bool posted = false;
    try {
      if (before_post) before_post();
      posted = post && post(std::move(command));
    } catch (...) {
    }
    {
      std::lock_guard lock(mutex_);
      --in_flight_;
      if (in_flight_ == 0) changed_.notify_all();
    }
    return posted;
  }

  void disable() noexcept {
    std::unique_lock lock(mutex_);
    enabled_ = false;
    changed_.wait(lock, [&] { return in_flight_ == 0; });
    post_ = {};
    before_post_ = {};
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  bool enabled_ = true;
  std::size_t in_flight_ = 0;
  CameraActor::InternalPost post_;
  CameraActor::BeforeTerminalPost before_post_;
};

class CameraBorrowedCallbackGate final {
 public:
  CameraBorrowedCallbackGate(
      SequencedEmitter& emitter,
      CameraActor::IsCurrent is_current)
      : emitter_(&emitter), is_current_(std::move(is_current)) {}

  bool isCurrent(const std::string& session_id, std::uint64_t generation) {
    CameraActor::IsCurrent is_current;
    {
      std::lock_guard lock(mutex_);
      if (!enabled_) return false;
      is_current = is_current_;
      ++in_flight_;
    }
    bool current = false;
    try {
      current = is_current && is_current(session_id, generation);
    } catch (...) {
      leave();
      throw;
    }
    leave();
    return current;
  }

  bool emit(RuntimeEvent event) {
    SequencedEmitter* emitter = nullptr;
    {
      std::lock_guard lock(mutex_);
      if (!enabled_) return false;
      emitter = emitter_;
      ++in_flight_;
    }
    try {
      emitter->emit(std::move(event));
    } catch (...) {
      leave();
      throw;
    }
    leave();
    return true;
  }

  void disable() noexcept {
    std::unique_lock lock(mutex_);
    enabled_ = false;
    changed_.wait(lock, [&] { return in_flight_ == 0; });
    emitter_ = nullptr;
    is_current_ = {};
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
  SequencedEmitter* emitter_ = nullptr;
  CameraActor::IsCurrent is_current_;
};

class CameraPublicationRetireTask final {
 public:
  CameraPublicationRetireTask(
      std::shared_ptr<LiveKitPublicationClient> client,
      std::unique_ptr<LiveKitTrackPublication> publication,
      std::string publication_sid)
      : client_(std::move(client)),
        publication_(std::move(publication)),
        publication_sid_(std::move(publication_sid)) {}

  void run() noexcept {
    if (started_.exchange(true, std::memory_order_acq_rel)) return;
    try {
      client_->stopLocalCameraPreview(publication_sid_);
    } catch (...) {
    }
    if (publication_) {
      try {
        publication_->unpublishTrack(publication_sid_);
      } catch (...) {
      }
    }
    publication_.reset();
    client_.reset();
    {
      std::lock_guard lock(mutex_);
      finished_ = true;
    }
    changed_.notify_all();
  }

  bool waitUntil(std::chrono::steady_clock::time_point deadline) {
    std::unique_lock lock(mutex_);
    changed_.wait_until(lock, deadline, [&] { return finished_; });
    return finished_;
  }

  void retainAfter(std::shared_ptr<CameraPublicationRetireTask> next) noexcept {
    retained_next_ = std::move(next);
  }

  std::shared_ptr<CameraPublicationRetireTask> takeRetainedNext() noexcept {
    return std::move(retained_next_);
  }

 private:
  std::atomic_bool started_{false};
  std::mutex mutex_;
  std::condition_variable changed_;
  bool finished_ = false;
  std::shared_ptr<LiveKitPublicationClient> client_;
  std::unique_ptr<LiveKitTrackPublication> publication_;
  std::string publication_sid_;
  std::shared_ptr<CameraPublicationRetireTask> retained_next_;
};

class CameraCaptureStopTask final {
 public:
  explicit CameraCaptureStopTask(std::shared_ptr<CameraCapture> capture)
      : capture_(std::move(capture)) {}

  void run() noexcept {
    if (started_.exchange(true, std::memory_order_acq_rel)) return;
    try {
      if (capture_) capture_->stop();
    } catch (...) {
    }
    capture_.reset();
    {
      std::lock_guard lock(mutex_);
      finished_ = true;
    }
    changed_.notify_all();
  }

  bool waitUntil(std::chrono::steady_clock::time_point deadline) {
    std::unique_lock lock(mutex_);
    changed_.wait_until(lock, deadline, [&] { return finished_; });
    return finished_;
  }

  void retainAfter(std::shared_ptr<CameraCaptureStopTask> next) noexcept {
    retained_next_ = std::move(next);
  }

  std::shared_ptr<CameraCaptureStopTask> takeRetainedNext() noexcept {
    return std::move(retained_next_);
  }

 private:
  std::atomic_bool started_{false};
  std::mutex mutex_;
  std::condition_variable changed_;
  bool finished_ = false;
  std::shared_ptr<CameraCapture> capture_;
  std::shared_ptr<CameraCaptureStopTask> retained_next_;
};

template <typename TaskType>
class CameraCleanupDispatcher final {
 public:
  using Task = std::shared_ptr<TaskType>;

  explicit CameraCleanupDispatcher(
      CameraActor::LaunchRetireWorker launcher,
      CameraActor::BeforeCleanupEnqueue before_enqueue = {}) {
    if (!launcher) {
      launcher = [](std::function<void()> work) {
        return std::thread(std::move(work));
      };
    }
    state_ = std::make_shared<State>();
    state_->launcher = std::move(launcher);
    state_->before_enqueue = std::move(before_enqueue);
    try {
      management_thread_ = std::thread([state = state_] {
        runManagement(std::move(state));
      });
    } catch (...) {
      throw CameraCaptureError(
          "camera_retire_dispatcher_init_failed",
          "Camera publication retirement dispatcher could not start");
    }
  }

  ~CameraCleanupDispatcher() {
    close(std::chrono::steady_clock::now() + kNativeShutdownBudget);
  }

  void submit(
      Task task,
      const std::string& session_id,
      std::uint64_t generation) {
    try {
      if (state_->before_enqueue) state_->before_enqueue();
    } catch (...) {
      diagnostics::DiagnosticLog::instance().write(
          "camera_cleanup_enqueue_injected_failure",
          {{"sessionId", session_id}, {"generation", generation}});
    }
    {
      std::lock_guard lock(state_->mutex);
      if (state_->tail) {
        state_->tail->retainAfter(task);
      } else {
        state_->head = task;
      }
      state_->tail = std::move(task);
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
      diagnostics::DiagnosticLog::instance().write(
          "camera_publication_retire_dispatcher_detached",
          {{"reason", "shutdown_deadline"}});
    }
  }

 private:
  struct State {
    std::mutex mutex;
    std::condition_variable changed;
    std::condition_variable finished_changed;
    Task head;
    Task tail;
    CameraActor::LaunchRetireWorker launcher;
    CameraActor::BeforeCleanupEnqueue before_enqueue;
    bool closing = false;
    bool finished = false;
  };

  static void runManagement(std::shared_ptr<State> state) noexcept {
    for (;;) {
      Task task;
      {
        std::unique_lock lock(state->mutex);
        state->changed.wait(lock, [&] {
          return state->closing || state->head != nullptr;
        });
        if (!state->head) {
          if (!state->closing) continue;
          state->finished = true;
          state->finished_changed.notify_all();
          return;
        }
        task = state->head;
      }

      try {
        auto worker = state->launcher([task] { task->run(); });
        worker.detach();
        std::lock_guard lock(state->mutex);
        if (state->head == task) {
          state->head = task->takeRetainedNext();
          if (!state->head) state->tail.reset();
        }
      } catch (...) {
        diagnostics::DiagnosticLog::instance().write(
            "camera_publication_retire_worker_failed",
            {{"reason", "worker_launch_failed"}});
        std::unique_lock lock(state->mutex);
        state->changed.wait_for(lock, std::chrono::milliseconds(25));
      }
    }
  }

  std::shared_ptr<State> state_;
  std::thread management_thread_;
};

using CameraPublicationRetireDispatcher =
    CameraCleanupDispatcher<CameraPublicationRetireTask>;
using CameraCaptureStopDispatcher =
    CameraCleanupDispatcher<CameraCaptureStopTask>;

}  // namespace

class CameraActor::Implementation
    : public std::enable_shared_from_this<CameraActor::Implementation> {
 public:
  Implementation(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitPublicationClient> client,
    std::shared_ptr<CameraCaptureFactory> factory,
    CameraActor::CreateGpuVideoSource create_gpu_video_source,
    CameraActor::LaunchRetireWorker launch_retire_worker,
    CameraActor::BeforeTerminalPost before_terminal_post,
    CameraActor::BeforeCleanupEnqueue before_cleanup_enqueue
  ) : post_(std::move(post)),
      callbacks_(std::make_shared<CameraBorrowedCallbackGate>(
          emitter, std::move(is_current))),
      client_(std::move(client)), factory_(std::move(factory)),
      create_gpu_video_source_(std::move(create_gpu_video_source)),
      before_terminal_post_(std::move(before_terminal_post)),
      cleanup_launcher_(
          launch_retire_worker
            ? std::move(launch_retire_worker)
            : CameraActor::LaunchRetireWorker(
                [](std::function<void()> work) {
                  return std::thread(std::move(work));
                })),
      retire_dispatcher_(std::make_shared<CameraPublicationRetireDispatcher>(
          cleanup_launcher_, before_cleanup_enqueue)),
      stop_dispatcher_(std::make_shared<CameraCaptureStopDispatcher>(
          cleanup_launcher_, std::move(before_cleanup_enqueue))) {
    if (!create_gpu_video_source_) {
      create_gpu_video_source_ = [](int width, int height) {
        return std::shared_ptr<livekit::D3D11H264VideoSource>(
          livekit::createD3D11H264VideoSource(width, height));
      };
    }
  }

  ~Implementation() { shutdown(); }

  void connect(const MediaCommand& command) {
    reapFinishedAttempts();
    if (shutdown_.load(std::memory_order_acquire)) {
      throw std::runtime_error("camera actor is shut down");
    }
    if (!callbacks_->isCurrent(command.session_id, command.generation)) {
      throw std::runtime_error("stale camera generation");
    }
    if (command.participant_identity.empty()) {
      throw std::invalid_argument("camera participantIdentity is required");
    }
    {
      std::lock_guard lock(mutex_);
      if (running_ && session_id_ == command.session_id && generation_ == command.generation) {
        callbacks_->emit(cameraReply(command));
        return;
      }
    }
    cancelAttempts(true);
    stopActive();
    if (unfinishedAttemptCount() >= 2) {
      throw std::runtime_error("camera publication capacity is still occupied");
    }

    auto state = std::make_shared<AttemptState>();
    state->command = trackCommand(command);
    auto worker = std::make_unique<Attempt>();
    worker->state = state;
    const auto self = shared_from_this();
    worker->thread = std::thread([self, state] {
      state->committed.wait();
      self->runAttempt(state);
    });
    try {
      std::lock_guard lock(mutex_);
      attempts_.push_back(std::move(worker));
      current_attempt_ = state;
      state->committed.count_down();
    } catch (...) {
      state->operation.requestCancel();
      state->committed.count_down();
      if (worker && worker->thread.joinable()) worker->thread.join();
      throw;
    }
  }

  void disconnect(const MediaCommand& command, bool emit_event) {
    if (shutdown_.load(std::memory_order_acquire)) return;
    cancelAttempts(true);
    stopActive();
    reapFinishedAttempts();
    if (!emit_event) return;
    callbacks_->emit(cameraReply(command));
    RuntimeEvent event;
    event.type = "sessionLifecycle";
    event.session_id = command.session_id;
    event.generation = command.generation;
    event.kind = "camera";
    event.status = "stopped";
    callbacks_->emit(std::move(event));
  }

  RuntimeEvent probe(const MediaCommand& command) {
    reapFinishedAttempts();
    RuntimeEvent result = cameraReply(command);
    result.state = "available";
    std::lock_guard lock(mutex_);
    for (const auto& attempt : attempts_) {
      if (attempt->state->finished.load()) continue;
      if (attempt->state->operation.expired()) {
        result.ok = false;
        result.error = NativeError{
          "actor_unresponsive",
          "camera publication worker exceeded its operation deadline",
          "probeCameraActor",
          true,
          attempt->state->command.session_id,
          attempt->state->command.generation,
        };
        return result;
      }
      result.state = "busy";
    }
    return result;
  }

  void releasePreviewFrame(const MediaCommand& command) {
    client_->releaseLocalCameraPreviewFrame(
      command.track_id,
      command.frame_sequence
    );
  }

  void handleTerminal(const MediaCommand& command) {
    if (shutdown_.load(std::memory_order_acquire)) return;
    {
      std::lock_guard lock(mutex_);
      if (command.session_id != session_id_ || command.generation != generation_) return;
    }
    stopActive();
    RuntimeEvent event;
    event.type = "cameraTerminal";
    event.session_id = command.session_id;
    event.generation = command.generation;
    event.kind = "camera";
    event.status = "error";
    const bool device_removed = command.internal_message == "device_removed";
    const bool read_stalled =
      command.internal_message == "camera_capture_timeout";
    event.error = NativeError{
      device_removed
        ? "device_removed"
        : (read_stalled ? "camera_read_stall" : "camera_capture_failed"),
      device_removed
        ? "Camera device was removed"
        : (read_stalled
          ? "Camera stopped delivering asynchronous samples"
          : (command.internal_message.empty()
            ? "Camera capture failed"
            : command.internal_message)),
      "connectCamera", true, command.session_id, command.generation};
    callbacks_->emit(std::move(event));
  }

  void shutdown(
      std::optional<std::chrono::steady_clock::time_point> stop_by =
          std::nullopt) {
    if (shutdown_.exchange(true, std::memory_order_acq_rel)) return;
    const auto deadline = stop_by.value_or(
        std::chrono::steady_clock::now() + kNativeShutdownBudget);
    callbacks_->disable();
    cancelAttempts(true);
    stopActive(deadline);
    std::vector<std::unique_ptr<Attempt>> attempts;
    {
      std::lock_guard lock(mutex_);
      attempts = std::move(attempts_);
      current_attempt_.reset();
    }
    for (auto& attempt : attempts) {
      if (!attempt->thread.joinable()) {
        continue;
      }
      if (attempt->thread.get_id() == std::this_thread::get_id()) {
        attempt->thread.detach();
        continue;
      }
      {
        std::unique_lock lock(attempt->state->finished_mutex);
        attempt->state->finished_changed.wait_until(
            lock, deadline, [&] {
              return attempt->state->finished.load(
                  std::memory_order_acquire);
            });
      }
      if (attempt->state->finished.load(std::memory_order_acquire)) {
        attempt->thread.join();
      } else {
        diagnostics::DiagnosticLog::instance().write(
            "camera_publication_worker_detached",
            {
                {"sessionId", attempt->state->command.session_id},
                {"generation", attempt->state->command.generation},
                {"reason", "shutdown_deadline"},
            });
        attempt->thread.detach();
      }
    }
    retire_dispatcher_->close(deadline);
    stop_dispatcher_->close(deadline);
  }

 private:
  struct AttemptState {
    MediaCommand command;
    MediaOperation operation;
    std::latch committed{1};
    std::atomic_bool finished{false};
    std::atomic_bool reply_emitted{false};
    std::mutex finished_mutex;
    std::condition_variable finished_changed;
  };

  struct Attempt {
    std::shared_ptr<AttemptState> state;
    std::thread thread;
  };

  struct CaptureWorkerState {
    std::atomic_bool finished{false};
    std::mutex mutex;
    std::condition_variable changed;
  };

  void stopActive(
      std::optional<std::chrono::steady_clock::time_point> stop_by =
          std::nullopt) {
    const auto deadline = stop_by.value_or(
        std::chrono::steady_clock::now() + kNativeShutdownBudget);
    std::thread thread;
    std::shared_ptr<CameraCapture> capture;
    std::shared_ptr<CaptureWorkerState> capture_state;
    std::shared_ptr<CameraTerminalPostGate> post_gate;
    std::unique_ptr<LiveKitTrackPublication> publication;
    std::string publication_sid;
    std::string session_id;
    std::uint64_t generation = 0;
    {
      std::lock_guard lock(mutex_);
      if (running_) running_->store(false);
      thread = std::move(capture_thread_);
      capture = std::move(active_capture_);
      capture_state = std::move(capture_worker_state_);
      post_gate = std::move(active_post_gate_);
      publication = std::move(publication_);
      publication_sid = std::move(publication_sid_);
      session_id = session_id_;
      generation = generation_;
      running_.reset();
      source_.reset();
      track_.reset();
      session_id_.clear();
      generation_ = 0;
    }
    stopCaptureWorker(
        std::move(capture),
        thread,
        std::move(capture_state),
        std::move(post_gate),
        session_id,
        generation,
        deadline);
    retireActivePublication(
        std::move(publication),
        std::move(publication_sid),
        session_id,
        generation,
        deadline);
  }

  void stopCaptureWorker(
      std::shared_ptr<CameraCapture> capture,
      std::thread& capture_thread,
      std::shared_ptr<CaptureWorkerState> capture_state,
      std::shared_ptr<CameraTerminalPostGate> post_gate,
      const std::string& session_id,
      std::uint64_t generation,
      std::optional<std::chrono::steady_clock::time_point> stop_by =
          std::nullopt) noexcept {
    const auto deadline = stop_by.value_or(
        std::chrono::steady_clock::now() + kNativeShutdownBudget);
    if (post_gate) post_gate->disable();
    if (capture) {
      try {
        auto stop_task =
            std::make_shared<CameraCaptureStopTask>(std::move(capture));
        stop_dispatcher_->submit(stop_task, session_id, generation);
        if (!stop_task->waitUntil(deadline)) {
          diagnostics::DiagnosticLog::instance().write(
              "camera_capture_stop_detached",
              {
                  {"sessionId", session_id},
                  {"generation", generation},
                  {"reason", "stop_deadline"},
              });
        }
      } catch (...) {
        diagnostics::DiagnosticLog::instance().write(
            "camera_capture_stop_worker_failed",
            {
                {"sessionId", session_id},
                {"generation", generation},
            });
      }
    }

    if (!capture_thread.joinable()) return;
    if (capture_thread.get_id() == std::this_thread::get_id()) {
      capture_thread.detach();
      return;
    }
    if (capture_state) {
      std::unique_lock lock(capture_state->mutex);
      capture_state->changed.wait_until(lock, deadline, [&] {
        return capture_state->finished.load(std::memory_order_acquire);
      });
    }
    if (capture_state &&
        capture_state->finished.load(std::memory_order_acquire)) {
      capture_thread.join();
      return;
    }
    capture_thread.detach();
    diagnostics::DiagnosticLog::instance().write(
        "camera_capture_worker_detached",
        {
            {"sessionId", session_id},
            {"generation", generation},
            {"reason", "stop_deadline"},
        });
  }

  void retireActivePublication(
      std::unique_ptr<LiveKitTrackPublication> publication,
      std::string publication_sid,
      const std::string& session_id,
      std::uint64_t generation,
      std::chrono::steady_clock::time_point deadline) noexcept {
    if (publication_sid.empty()) return;
    try {
      auto task = std::make_shared<CameraPublicationRetireTask>(
          client_, std::move(publication), std::move(publication_sid));
      retire_dispatcher_->submit(task, session_id, generation);
      if (task->waitUntil(deadline)) return;
    } catch (...) {
      diagnostics::DiagnosticLog::instance().write(
          "camera_active_publication_retire_submit_failed",
          {
              {"sessionId", session_id},
              {"generation", generation},
          });
      return;
    }
    diagnostics::DiagnosticLog::instance().write(
        "camera_active_publication_retire_detached",
        {
            {"sessionId", session_id},
            {"generation", generation},
            {"reason", "stop_deadline"},
        });
  }

  void cancelAttempts(bool emit_replies) {
    std::vector<MediaCommand> cancelled;
    {
      std::lock_guard lock(mutex_);
      for (auto& attempt : attempts_) {
        if (attempt->state->finished.load()) continue;
        attempt->state->operation.requestCancel();
        const bool first_reply =
            !attempt->state->reply_emitted.exchange(true);
        if (emit_replies && first_reply &&
            !attempt->state->command.request_id.empty()) {
          cancelled.push_back(attempt->state->command);
        }
      }
      current_attempt_.reset();
    }
    if (shutdown_.load(std::memory_order_acquire)) return;
    for (const auto& command : cancelled) {
      if (shutdown_.load(std::memory_order_acquire)) return;
      callbacks_->emit(cancelledReply(command));
    }
  }

  std::size_t unfinishedAttemptCount() {
    std::lock_guard lock(mutex_);
    return static_cast<std::size_t>(std::count_if(
      attempts_.begin(),
      attempts_.end(),
      [](const auto& attempt) { return !attempt->state->finished.load(); }
    ));
  }

  void reapFinishedAttempts() {
    std::vector<std::unique_ptr<Attempt>> finished;
    {
      std::lock_guard lock(mutex_);
      for (auto iterator = attempts_.begin(); iterator != attempts_.end();) {
        if (!(*iterator)->state->finished.load()) {
          ++iterator;
          continue;
        }
        finished.push_back(std::move(*iterator));
        iterator = attempts_.erase(iterator);
      }
    }
    for (auto& attempt : finished) {
      if (attempt->thread.joinable() && attempt->thread.get_id() != std::this_thread::get_id()) {
        attempt->thread.join();
      }
    }
  }

  bool attemptIsCurrent(const std::shared_ptr<AttemptState>& attempt) {
    if (shutdown_.load(std::memory_order_acquire) ||
        attempt->operation.cancelled() || attempt->operation.expired()) {
      return false;
    }
    if (!callbacks_->isCurrent(
            attempt->command.session_id, attempt->command.generation)) {
      return false;
    }
    std::lock_guard lock(mutex_);
    return !shutdown_.load(std::memory_order_acquire) &&
        current_attempt_ == attempt && !attempt->operation.cancelled() &&
        !attempt->operation.expired();
  }

  void cleanupFailedAttempt(
    LiveKitTrackPublication* publication,
    const std::string& publication_sid
  ) noexcept {
    if (publication_sid.empty()) return;
    try {
      client_->stopLocalCameraPreview(publication_sid);
    } catch (...) {
      // Preserve the original publication failure; preview cleanup is best effort.
    }
    if (!publication) return;
    try {
      publication->unpublishTrack(publication_sid);
    } catch (...) {
      // A failed unpublish must not escape the attempt thread or suppress its reply.
    }
  }

  bool stopCaptureBeforeReopen(
      std::shared_ptr<CameraCapture>& capture,
      const MediaCommand& command,
      std::chrono::steady_clock::time_point deadline) noexcept {
    try {
      auto stop_task =
          std::make_shared<CameraCaptureStopTask>(std::move(capture));
      stop_dispatcher_->submit(
          stop_task, command.session_id, command.generation);
      const bool finished = stop_task->waitUntil(deadline);
      capture.reset();
      if (finished) return true;
      diagnostics::DiagnosticLog::instance().write(
          "camera_gpu_fallback_stop_failed",
          {
              {"sessionId", command.session_id},
              {"generation", command.generation},
              {"reason", "stop_deadline"},
          });
      return false;
    } catch (...) {
      diagnostics::DiagnosticLog::instance().write(
          "camera_gpu_fallback_stop_failed",
          {
              {"sessionId", command.session_id},
              {"generation", command.generation},
              {"reason", "worker_launch_failed"},
          });
      return false;
    }
  }

  void runAttempt(const std::shared_ptr<AttemptState>& attempt) {
    const HRESULT com_result =
        CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool uninitialize_com = SUCCEEDED(com_result);
    const auto command = attempt->command;
    std::unique_ptr<LiveKitTrackPublication> publication;
    std::string publication_sid;
    try {
      diagnostics::DiagnosticLog::instance().write(
          "camera_startup_checkpoint",
          {
              {"generation", command.generation},
              {"stage", "publication_context_start"},
          });
      publication = client_->createCameraPublication(
        command.session_id, command.generation);
      if (!publication->isRoomConnected()) {
        throw std::runtime_error("LiveKit voice Room is not connected");
      }
      if (!attemptIsCurrent(attempt)) throw std::runtime_error("stale camera generation");
      const auto width = std::clamp(command.width, 16, 7680);
      const auto height = std::clamp(command.height, 16, 4320);
      const auto fps = std::clamp(command.fps, 1, 240);
      diagnostics::DiagnosticLog::instance().write(
          "camera_startup_checkpoint",
          {
              {"generation", command.generation},
              {"stage", "capture_open_start"},
          });
      auto capture = factory_->create(
          command.device_id,
          static_cast<std::uint32_t>(width),
          static_cast<std::uint32_t>(height),
          fps);
      auto capture_info = capture->info();
      if (capture_info.format.width == 0 ||
          capture_info.format.height == 0 ||
          capture_info.format.frame_rate_numerator == 0 ||
          capture_info.format.frame_rate_denominator == 0) {
        throw std::runtime_error("camera negotiated format is invalid");
      }
      diagnostics::DiagnosticLog::instance().write(
          "camera_startup_checkpoint",
          {
              {"generation", command.generation},
              {"stage", "capture_opened"},
              {"gpu", capture_info.gpu},
              {"width", static_cast<std::uint64_t>(
                  capture_info.format.width)},
              {"height", static_cast<std::uint64_t>(
                  capture_info.format.height)},
          });
      std::shared_ptr<livekit::VideoSource> source;
      std::shared_ptr<livekit::D3D11H264VideoSource> gpu_source;
      std::shared_ptr<livekit::LocalVideoTrack> track;
      if (capture_info.gpu) {
        gpu_source = create_gpu_video_source_(
            static_cast<int>(capture_info.format.width),
            static_cast<int>(capture_info.format.height));
        if (!gpu_source) {
          diagnostics::DiagnosticLog::instance().write(
              "camera_gpu_fallback",
              {
                  {"stage", "encoder_source"},
                  {"reason", "D3D11 H264 video source is unavailable"},
              });
          const auto fallback_stop_deadline =
              std::chrono::steady_clock::now() +
              kNativeShutdownBudget;
          if (!stopCaptureBeforeReopen(
                  capture, command, fallback_stop_deadline)) {
            throw CameraCaptureError(
                "camera_capture_stop_timeout",
                "Camera GPU capture did not stop before CPU fallback");
          }
          capture = factory_->create(
              command.device_id,
              static_cast<std::uint32_t>(width),
              static_cast<std::uint32_t>(height),
              fps,
              true);
          capture_info = capture->info();
          if (capture_info.gpu) {
            throw std::runtime_error(
                "forced CPU camera capture negotiated a GPU format");
          }
          if (capture_info.format.width == 0 ||
              capture_info.format.height == 0 ||
              capture_info.format.frame_rate_numerator == 0 ||
              capture_info.format.frame_rate_denominator == 0) {
            throw std::runtime_error(
                "forced CPU camera negotiated format is invalid");
          }
          source = std::make_shared<livekit::VideoSource>(
              static_cast<int>(capture_info.format.width),
              static_cast<int>(capture_info.format.height));
          track = livekit::LocalVideoTrack::createLocalVideoTrack(
              "camera", source);
        } else {
          source = gpu_source;
          track = livekit::LocalVideoTrack::createLocalVideoTrack(
              "camera", gpu_source);
        }
      } else {
        source = std::make_shared<livekit::VideoSource>(
            static_cast<int>(capture_info.format.width),
            static_cast<int>(capture_info.format.height));
        track = livekit::LocalVideoTrack::createLocalVideoTrack(
            "camera", source);
      }
      livekit::TrackPublishOptions options;
      options.source = livekit::TrackSource::SOURCE_CAMERA;
      options.stream = "camera";
      options.simulcast = false;
      options.video_encoding = livekit::VideoEncodingOptions{
        static_cast<std::uint64_t>(command.bitrate), static_cast<double>(fps)};
      diagnostics::DiagnosticLog::instance().write(
          "camera_startup_checkpoint",
          {
              {"generation", command.generation},
              {"stage", "publish_start"},
              {"gpu", capture_info.gpu},
          });
      publication_sid = publication->publishVideoTrack(track, options);
      if (publication_sid.empty()) throw std::runtime_error("LiveKit camera publication SID is empty");
      diagnostics::DiagnosticLog::instance().write(
          "camera_startup_checkpoint",
          {
              {"generation", command.generation},
              {"stage", "publish_complete"},
              {"gpu", capture_info.gpu},
          });
      if (!attemptIsCurrent(attempt)) {
        throw std::runtime_error("stale camera generation");
      }
      client_->startLocalCameraPreview(
        command.session_id,
        command.generation,
        publication_sid,
        command.participant_identity,
        track
      );

      auto running = std::make_shared<std::atomic_bool>(true);
      auto capture_committed = std::make_shared<std::latch>(1);
      auto capture_state = std::make_shared<CaptureWorkerState>();
      auto post_gate = std::make_shared<CameraTerminalPostGate>(
          post_, before_terminal_post_);
      auto runtime_lifetime = client_->runtimeLifetimeToken();
      auto capture_session_id = command.session_id;
      auto capture_thread = std::thread([
        command,
        source,
        gpu_source,
        capture,
        running,
        capture_committed,
        capture_state,
        post_gate,
        runtime_lifetime
      ] {
        capture_committed->wait();
        if (running->load()) {
          captureLoop(
              command, source, gpu_source, capture, running, post_gate);
        }
        (void)runtime_lifetime;
        capture_state->finished.store(true, std::memory_order_release);
        capture_state->changed.notify_all();
      });
      bool stale = false;
      {
        std::lock_guard lock(mutex_);
        stale = shutdown_.load(std::memory_order_acquire) ||
            current_attempt_ != attempt || attempt->operation.cancelled() ||
            attempt->operation.expired();
        if (!stale) {
          stale =
              !callbacks_->isCurrent(command.session_id, command.generation);
        }
        if (!stale) {
          session_id_ = std::move(capture_session_id);
          generation_ = command.generation;
          publication_ = std::move(publication);
          publication_sid_ = publication_sid;
          source_ = source;
          track_ = std::move(track);
          running_ = running;
          active_capture_ = capture;
          capture_worker_state_ = capture_state;
          active_post_gate_ = post_gate;
          capture_thread_ = std::move(capture_thread);
          current_attempt_.reset();
        }
        capture_committed->count_down();
      }
      if (stale) {
        running->store(false);
        stopCaptureWorker(
            capture,
            capture_thread,
            capture_state,
            post_gate,
            command.session_id,
            command.generation);
        throw std::runtime_error("stale camera generation");
      }
      if (shutdown_.load(std::memory_order_acquire) ||
          attempt->operation.cancelled()) {
        throw std::runtime_error("stale camera generation");
      }
      diagnostics::DiagnosticLog::instance().write(
          "camera_startup_checkpoint",
          {
              {"generation", command.generation},
              {"stage", "capture_worker_committed"},
              {"gpu", capture_info.gpu},
          });
      if (!attempt->reply_emitted.exchange(true) &&
          !command.request_id.empty()) {
        callbacks_->emit(cameraReply(command));
      }
      if (shutdown_.load(std::memory_order_acquire) ||
          attempt->operation.cancelled()) {
        throw std::runtime_error("stale camera generation");
      }
      RuntimeEvent event;
      event.type = "sessionLifecycle"; event.session_id = command.session_id;
      event.generation = command.generation; event.kind = "camera"; event.status = "running";
      event.device_id = command.device_id;
      event.width = static_cast<int>(capture_info.format.width);
      event.height = static_cast<int>(capture_info.format.height);
      event.fps = static_cast<int>(
          capture_info.format.frame_rate_numerator /
          capture_info.format.frame_rate_denominator);
      callbacks_->emit(std::move(event));
    } catch (const std::exception& error) {
      cleanupFailedAttempt(publication.get(), publication_sid);
      if (!attempt->reply_emitted.exchange(true) &&
          !shutdown_.load(std::memory_order_acquire) &&
          !command.request_id.empty()) {
        auto failed = cameraReply(command);
        failed.ok = false;
        bool cancelled = attempt->operation.cancelled();
        if (!cancelled &&
            !shutdown_.load(std::memory_order_acquire)) {
          cancelled =
              !callbacks_->isCurrent(
                  command.session_id, command.generation);
        }
        const bool expired = attempt->operation.expired();
        const auto* capture_error =
            dynamic_cast<const CameraCaptureError*>(&error);
        failed.error = NativeError{
          cancelled ? "stale_generation" :
            (expired ? "native_operation_timeout" :
              (capture_error ? capture_error->code() :
                "native_command_failed")),
          cancelled ? "Camera connection attempt was superseded" :
            (expired ? "Camera publication deadline expired" : error.what()),
          "connectCamera", !cancelled, command.session_id, command.generation};
        callbacks_->emit(std::move(failed));
      }
    } catch (...) {
      cleanupFailedAttempt(publication.get(), publication_sid);
      if (!attempt->reply_emitted.exchange(true) &&
          !shutdown_.load(std::memory_order_acquire) &&
          !command.request_id.empty()) {
        auto failed = cameraReply(command); failed.ok = false;
        failed.error = NativeError{"native_command_failed", "Camera publication failed",
          "connectCamera", true, command.session_id, command.generation};
        callbacks_->emit(std::move(failed));
      }
    }
    attempt->finished.store(true, std::memory_order_release);
    attempt->finished_changed.notify_all();
    if (uninitialize_com) CoUninitialize();
  }

  static void captureLoop(
    MediaCommand command,
    std::shared_ptr<livekit::VideoSource> source,
    std::shared_ptr<livekit::D3D11H264VideoSource> gpu_source,
    std::shared_ptr<CameraCapture> capture,
    std::shared_ptr<std::atomic_bool> running,
    const std::shared_ptr<CameraTerminalPostGate>& post_gate
  ) {
    const auto com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_ok = SUCCEEDED(com);
    try {
      CameraFrame captured;
      const auto started = std::chrono::steady_clock::now();
      auto cadence_started = started;
      auto cadence_next = started + std::chrono::seconds(1);
      std::uint64_t cadence_frames = 0;
      bool first_read = true;
      bool first_submit = true;
      while (running->load()) {
        if (first_read) {
          diagnostics::DiagnosticLog::instance().write(
              "camera_first_frame_checkpoint",
              {
                  {"generation", command.generation},
                  {"stage", "read_start"},
              });
        }
        if (!capture->read(captured, *running)) break;
        if (first_read) {
          diagnostics::DiagnosticLog::instance().write(
              "camera_first_frame_checkpoint",
              {
                  {"generation", command.generation},
                  {"stage", "read_complete"},
                  {"gpu", captured.gpu},
                  {"width", static_cast<std::uint64_t>(captured.width)},
                  {"height", static_cast<std::uint64_t>(captured.height)},
              });
          first_read = false;
        }
        if (!running->load()) continue;
        const auto timestamp = captured.timestamp_us != 0
            ? static_cast<std::int64_t>(captured.timestamp_us)
            : std::chrono::duration_cast<std::chrono::microseconds>(
                  std::chrono::steady_clock::now() - started)
                  .count();
        if (captured.gpu) {
          if (!gpu_source) {
            throw std::runtime_error(
                "camera produced a GPU frame for a CPU source");
          }
          if (first_submit) {
            diagnostics::DiagnosticLog::instance().write(
                "camera_first_frame_checkpoint",
                {
                    {"generation", command.generation},
                    {"stage", "gpu_submit_start"},
                });
          }
          gpu_source->capture(
              std::make_unique<CameraTextureLease>(
                  capture, std::move(captured)),
              timestamp);
          if (first_submit) {
            diagnostics::DiagnosticLog::instance().write(
                "camera_first_frame_checkpoint",
                {
                    {"generation", command.generation},
                    {"stage", "gpu_submit_complete"},
                });
            first_submit = false;
          }
        } else if (!captured.bgra.empty()) {
          livekit::VideoFrame frame(
              static_cast<int>(captured.width),
              static_cast<int>(captured.height),
              livekit::VideoBufferType::BGRA,
              std::move(captured.bgra));
          if (first_submit) {
            diagnostics::DiagnosticLog::instance().write(
                "camera_first_frame_checkpoint",
                {
                    {"generation", command.generation},
                    {"stage", "cpu_submit_start"},
                });
          }
          source->captureFrame(frame, timestamp);
          if (first_submit) {
            diagnostics::DiagnosticLog::instance().write(
                "camera_first_frame_checkpoint",
                {
                    {"generation", command.generation},
                    {"stage", "cpu_submit_complete"},
                });
            first_submit = false;
          }
        }
        ++cadence_frames;
        const auto now = std::chrono::steady_clock::now();
        if (now >= cadence_next) {
          const auto elapsed =
              std::chrono::duration<double>(now - cadence_started).count();
          diagnostics::DiagnosticLog::instance().write(
              "camera_capture_cadence",
              {
                  {"sessionId", command.session_id},
                  {"generation", command.generation},
                  {"actualFps", elapsed > 0.0
                       ? static_cast<double>(cadence_frames) / elapsed
                       : 0.0},
              });
          cadence_started = now;
          cadence_frames = 0;
          cadence_next = now + std::chrono::seconds(1);
        }
      }
    } catch (const CameraCaptureError& error) {
      if (error.code() == "camera_capture_timeout") {
        diagnostics::DiagnosticLog::instance().write(
            "camera_read_stall",
            {
                {"sessionId", command.session_id},
                {"generation", command.generation},
                {"stage", "async_source_reader"},
                {"context", error.what()},
            });
      }
      if (running->exchange(false)) {
        MediaCommand terminal;
        terminal.type = "__cameraTerminal";
        terminal.session_id = command.session_id;
        terminal.generation = command.generation;
        terminal.internal_message = error.code();
        post_gate->post(std::move(terminal));
      }
    } catch (const std::exception& error) {
      if (running->exchange(false)) {
        MediaCommand terminal;
        terminal.type = "__cameraTerminal";
        terminal.session_id = command.session_id;
        terminal.generation = command.generation;
        terminal.internal_message = error.what();
        post_gate->post(std::move(terminal));
      }
    } catch (...) {
      if (running->exchange(false)) {
        MediaCommand terminal;
        terminal.type = "__cameraTerminal";
        terminal.session_id = command.session_id;
        terminal.generation = command.generation;
        terminal.internal_message = "unknown camera capture failure";
        post_gate->post(std::move(terminal));
      }
    }
    if (com_ok) CoUninitialize();
  }

  InternalPost post_;
  std::shared_ptr<CameraBorrowedCallbackGate> callbacks_;
  std::shared_ptr<LiveKitPublicationClient> client_;
  std::shared_ptr<CameraCaptureFactory> factory_;
  CameraActor::CreateGpuVideoSource create_gpu_video_source_;
  CameraActor::BeforeTerminalPost before_terminal_post_;
  CameraActor::LaunchRetireWorker cleanup_launcher_;
  std::shared_ptr<CameraPublicationRetireDispatcher> retire_dispatcher_;
  std::shared_ptr<CameraCaptureStopDispatcher> stop_dispatcher_;
  std::mutex mutex_;
  std::string session_id_;
  std::uint64_t generation_ = 0;
  std::unique_ptr<LiveKitTrackPublication> publication_;
  std::string publication_sid_;
  std::shared_ptr<livekit::VideoSource> source_;
  std::shared_ptr<livekit::LocalVideoTrack> track_;
  std::shared_ptr<std::atomic_bool> running_;
  std::shared_ptr<CameraCapture> active_capture_;
  std::shared_ptr<CaptureWorkerState> capture_worker_state_;
  std::shared_ptr<CameraTerminalPostGate> active_post_gate_;
  std::thread capture_thread_;
  std::shared_ptr<AttemptState> current_attempt_;
  std::vector<std::unique_ptr<Attempt>> attempts_;
  std::atomic_bool shutdown_{false};
};

CameraActor::CameraActor(SequencedEmitter& emitter, InternalPost post, IsCurrent current,
  std::shared_ptr<LiveKitPublicationClient> client,
  std::shared_ptr<CameraCaptureFactory> factory,
  CreateGpuVideoSource create_gpu_video_source,
  LaunchRetireWorker launch_retire_worker,
  BeforeTerminalPost before_terminal_post,
  BeforeCleanupEnqueue before_cleanup_enqueue)
  : implementation_(std::make_shared<Implementation>(emitter, std::move(post),
      std::move(current), std::move(client), std::move(factory),
      std::move(create_gpu_video_source), std::move(launch_retire_worker),
      std::move(before_terminal_post), std::move(before_cleanup_enqueue))) {}
CameraActor::~CameraActor() {
  if (implementation_) implementation_->shutdown();
}
void CameraActor::connect(const MediaCommand& command) { implementation_->connect(command); }
RuntimeEvent CameraActor::probe(const MediaCommand& command) {
  return implementation_->probe(command);
}
void CameraActor::disconnect(const MediaCommand& command, bool emit) {
  implementation_->disconnect(command, emit);
}
void CameraActor::releasePreviewFrame(const MediaCommand& command) {
  implementation_->releasePreviewFrame(command);
}
void CameraActor::handleTerminal(const MediaCommand& command) {
  implementation_->handleTerminal(command);
}
void CameraActor::shutdown() { implementation_->shutdown(); }
void CameraActor::shutdown(std::chrono::steady_clock::time_point deadline) {
  implementation_->shutdown(deadline);
}

}  // namespace syrnike::desktop_native::media
