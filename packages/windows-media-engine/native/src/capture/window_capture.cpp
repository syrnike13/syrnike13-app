#include "capture/window_capture.hpp"

#include <algorithm>
#include <condition_variable>
#include <deque>
#include <stdexcept>
#include <utility>

namespace syrnike::windows_media::capture {
namespace {

constexpr auto kBackendRollbackDeadline = std::chrono::seconds{5};

CaptureFailure sourceFailure(sources::ResolveStatus status) {
  switch (status) {
    case sources::ResolveStatus::Removed:
      return {"source_closed", "window source was closed"};
    case sources::ResolveStatus::Stale:
      return {"source_replaced", "window source identity changed"};
    case sources::ResolveStatus::Failed:
      return {"source_resolution_failed", "window source resolution failed"};
    case sources::ResolveStatus::Unknown:
      return {"source_unavailable", "window source is unavailable"};
    case sources::ResolveStatus::Available:
      break;
  }
  return {"source_unavailable", "window source is unavailable"};
}

class ScopeExit final {
 public:
  explicit ScopeExit(std::function<void()> cleanup)
      : cleanup_(std::move(cleanup)) {}
  ~ScopeExit() { cleanup_(); }

 private:
  std::function<void()> cleanup_;
};

}  // namespace

struct WindowCapture::SharedState {
  struct QueuedFrame {
    FrameMetadata metadata;
    std::shared_ptr<FrameResource> resource;
  };

  mutable std::mutex mutex;
  std::condition_variable condition;
  std::deque<QueuedFrame> queue;
  std::deque<WindowCaptureEvent> events;
  std::deque<WindowCaptureEvent> pending_start_events;
  std::optional<WindowCaptureEvent> pending_running_event;
  CaptureState state = CaptureState::Idle;
  WindowCaptureStats stats;
  std::optional<CaptureFailure> terminal_failure;
  std::uint64_t next_sequence = 1;
  std::optional<std::int64_t> last_timestamp;
  bool accepting_frames = false;
  bool stop_requested = false;
  bool backend_start_invoked = false;
  bool backend_stop_called = false;
  bool start_in_flight = false;
  bool temporarily_no_content = false;
  bool resize_pending = false;
  std::optional<CaptureFailure> backend_stop_failure;

  void pushEvent(WindowCaptureEvent event) {
    if (events.size() >= kMaximumWindowEvents) {
      events.pop_front();
      ++stats.dropped_events;
    }
    events.push_back(std::move(event));
    condition.notify_all();
  }
};

WindowCapture::WindowCapture(sources::SourceRegistry& registry,
                             std::string source_id,
                             std::unique_ptr<WindowCaptureBackend> backend)
    : registry_(registry),
      source_id_(std::move(source_id)),
      backend_(std::move(backend)),
      shared_(std::make_shared<SharedState>()) {
  if (!backend_) throw std::invalid_argument("WindowCaptureBackend is required");
}

WindowCapture::~WindowCapture() {
  bool start_in_flight = false;
  {
    std::lock_guard lock(shared_->mutex);
    start_in_flight = shared_->start_in_flight;
  }
  (void)stop(start_in_flight
                 ? std::chrono::duration_cast<std::chrono::milliseconds>(
                       kBackendRollbackDeadline)
                 : std::chrono::milliseconds{0});
}

CaptureStartResult WindowCapture::start() {
  {
    std::lock_guard lock(shared_->mutex);
    if (shared_->state != CaptureState::Idle) {
      return {false, CaptureFailure{"capture_already_started",
                                    "window capture is not idle"}};
    }
    shared_->state = CaptureState::Starting;
    shared_->accepting_frames = true;
    shared_->start_in_flight = true;
  }
  const auto operation_state = shared_;
  ScopeExit operation([operation_state] {
    std::lock_guard lock(operation_state->mutex);
    operation_state->start_in_flight = false;
    operation_state->condition.notify_all();
  });
  const auto fail_start = [shared = shared_](CaptureFailure failure) {
    std::lock_guard lock(shared->mutex);
    shared->accepting_frames = false;
    if (shared->stop_requested) {
      shared->state = CaptureState::Stopped;
      return CaptureStartResult{
          false, CaptureFailure{"start_cancelled",
                                "capture was stopped during start"}};
    }
    shared->state = CaptureState::Failed;
    shared->terminal_failure = failure;
    shared->pushEvent(WindowCaptureEvent{
        WindowCaptureEventKind::CaptureFailed, shared->stats.generation, 0, 0,
        0, failure});
    return CaptureStartResult{false, std::move(failure)};
  };

  const auto resolved = registry_.resolve(source_id_);
  if (resolved.status != sources::ResolveStatus::Available) {
    return fail_start(sourceFailure(resolved.status));
  }
  if (resolved.kind != sources::SourceKind::Window) {
    return fail_start(
        CaptureFailure{"source_kind_mismatch", "source is not a window"});
  }
  const auto target = registry_.resolveWindowTarget(source_id_);
  if (target.status != sources::ResolveStatus::Available || !target.target) {
    return fail_start(sourceFailure(target.status));
  }

  {
    std::lock_guard lock(shared_->mutex);
    if (shared_->stop_requested) {
      shared_->accepting_frames = false;
      shared_->state = CaptureState::Stopped;
      return {false, CaptureFailure{"start_cancelled",
                                    "capture was stopped during start"}};
    }
    shared_->backend_start_invoked = true;
  }

  const std::weak_ptr weak = shared_;
  auto* const registry = &registry_;
  const auto terminal_source_id = source_id_;
  auto backend_result = backend_->start(
      *target.target,
      [weak](BackendFrame frame) {
        const auto shared = weak.lock();
        if (!shared || !frame.resource || frame.width == 0 ||
            frame.height == 0 || frame.generation == 0) {
          return;
        }
        std::lock_guard lock(shared->mutex);
        if (!shared->accepting_frames ||
            (shared->state != CaptureState::Starting &&
             shared->state != CaptureState::Running)) {
          return;
        }
        if (shared->resize_pending) {
          ++shared->stats.frames.dropped_frames;
          return;
        }
        if (frame.generation < shared->stats.generation) {
          ++shared->stats.frames.dropped_frames;
          return;
        }
        if (frame.generation > shared->stats.generation) {
          shared->queue.clear();
          shared->stats.generation = frame.generation;
        }
        ++shared->stats.frames.received_frames;
        if (shared->last_timestamp &&
            frame.capture_timestamp_100ns < *shared->last_timestamp) {
          shared->stats.frames.timestamps_monotonic = false;
        }
        shared->last_timestamp = frame.capture_timestamp_100ns;
        FrameMetadata metadata{shared->next_sequence++,
                               frame.capture_timestamp_100ns,
                               frame.width,
                               frame.height,
                               frame.format,
                               frame.generation};
        if (shared->queue.size() +
                shared->stats.frames.outstanding_leases >=
            kMaximumWindowFrames) {
          if (shared->queue.empty()) {
            ++shared->stats.frames.dropped_frames;
            return;
          }
          shared->queue.pop_front();
          ++shared->stats.frames.dropped_frames;
        }
        shared->queue.push_back(
            SharedState::QueuedFrame{metadata, std::move(frame.resource)});
        shared->stats.frames.maximum_queue_depth =
            (std::max)(shared->stats.frames.maximum_queue_depth,
                       shared->queue.size());
        shared->condition.notify_all();
      },
      [weak](WindowBackendEvent event) {
        const auto shared = weak.lock();
        if (!shared) return;
        std::lock_guard lock(shared->mutex);
        if (!shared->accepting_frames) return;
        if (event.kind == WindowBackendEventKind::ResizePending) {
          shared->resize_pending = true;
          shared->queue.clear();
          shared->condition.notify_all();
          return;
        }
        WindowCaptureEventKind public_kind = WindowCaptureEventKind::Running;
        switch (event.kind) {
          case WindowBackendEventKind::Started:
            public_kind = WindowCaptureEventKind::Running;
            break;
          case WindowBackendEventKind::Resized:
            if (event.generation < shared->stats.generation) return;
            shared->queue.clear();
            shared->resize_pending = false;
            shared->stats.generation = event.generation;
            ++shared->stats.resize_count;
            public_kind = WindowCaptureEventKind::Resized;
            break;
          case WindowBackendEventKind::ResizeCancelled:
            shared->resize_pending = false;
            shared->condition.notify_all();
            return;
          case WindowBackendEventKind::TemporarilyNoContent:
            if (shared->temporarily_no_content) return;
            shared->temporarily_no_content = true;
            ++shared->stats.no_content_intervals;
            public_kind = WindowCaptureEventKind::TemporarilyNoContent;
            break;
          case WindowBackendEventKind::ContentRestored:
            if (!shared->temporarily_no_content) return;
            shared->temporarily_no_content = false;
            public_kind = WindowCaptureEventKind::ContentRestored;
            break;
          case WindowBackendEventKind::ResizePending:
            return;
        }
        WindowCaptureEvent public_event{
            public_kind, event.generation, event.width, event.height,
            event.timestamp_100ns, std::nullopt};
        if (shared->state == CaptureState::Starting) {
          if (public_kind == WindowCaptureEventKind::Running) {
            shared->pending_running_event = std::move(public_event);
          } else {
            if (shared->pending_start_events.size() >= kMaximumWindowEvents) {
              shared->pending_start_events.pop_front();
              ++shared->stats.dropped_events;
            }
            shared->pending_start_events.push_back(std::move(public_event));
          }
          return;
        }
        shared->pushEvent(std::move(public_event));
      },
      [weak, registry, terminal_source_id](CaptureFailure failure) {
        const auto shared = weak.lock();
        if (!shared) return;
        {
          std::lock_guard lock(shared->mutex);
          if (!shared->accepting_frames) return;
        }
        if (failure.code == "source_closed") {
          const auto identity =
              registry->resolveWindowTarget(terminal_source_id);
          if (identity.status == sources::ResolveStatus::Stale) {
            failure = {"source_replaced",
                       "window identity changed at terminal signal"};
          } else if (identity.status == sources::ResolveStatus::Failed) {
            failure = {"source_resolution_failed",
                       "window identity could not be checked at terminal signal"};
          } else if (identity.status == sources::ResolveStatus::Available) {
            failure = {"wgc_item_closed",
                       "WGC item closed while window identity remained live"};
          }
        }
        std::lock_guard lock(shared->mutex);
        if (!shared->accepting_frames) return;
        shared->accepting_frames = false;
        shared->queue.clear();
        shared->pending_start_events.clear();
        shared->pending_running_event.reset();
        shared->terminal_failure = failure;
        const bool closed = failure.code == "source_closed" ||
                            failure.code == "source_replaced";
        shared->state = closed ? CaptureState::Stopped : CaptureState::Failed;
        shared->pushEvent(WindowCaptureEvent{
            closed ? WindowCaptureEventKind::SourceClosed
                   : WindowCaptureEventKind::CaptureFailed,
            shared->stats.generation, 0, 0, 0, std::move(failure)});
      });

  {
    const auto confirmed = registry_.resolveWindowTarget(source_id_);
    if (confirmed.status != sources::ResolveStatus::Available ||
        !confirmed.target) {
      backend_result = {false, sourceFailure(confirmed.status)};
    } else if (confirmed.target->platformValue() !=
                   target.target->platformValue() ||
               confirmed.target->cacheKey() != target.target->cacheKey()) {
      backend_result = {
          false,
          CaptureFailure{"source_replaced",
                         "window identity changed during WGC startup"}};
    }
  }

  bool stop_backend = false;
  std::optional<CaptureFailure> start_failure;
  {
    std::lock_guard lock(shared_->mutex);
    if (!backend_result.ok) {
      shared_->accepting_frames = false;
      shared_->queue.clear();
      shared_->events.clear();
      shared_->pending_start_events.clear();
      shared_->pending_running_event.reset();
      if (shared_->stop_requested) {
        shared_->state = CaptureState::Stopped;
        start_failure = CaptureFailure{"start_cancelled",
                                       "capture was stopped during start"};
      } else {
        shared_->state = CaptureState::Failed;
        shared_->terminal_failure = backend_result.failure.value_or(
            CaptureFailure{"capture_start_failed", "capture backend failed"});
        start_failure = shared_->terminal_failure;
      }
      if (!shared_->backend_stop_called) {
        shared_->backend_stop_called = true;
        stop_backend = true;
      }
    } else if (shared_->state == CaptureState::Failed ||
               shared_->state == CaptureState::Stopped) {
      shared_->accepting_frames = false;
      start_failure = shared_->terminal_failure.value_or(
          CaptureFailure{"capture_start_failed",
                         "capture terminated while backend was starting"});
      if (!shared_->backend_stop_called) {
        shared_->backend_stop_called = true;
        stop_backend = true;
      }
    } else if (shared_->stop_requested) {
      shared_->accepting_frames = false;
      shared_->state = CaptureState::Stopped;
    } else if (shared_->state == CaptureState::Starting) {
      shared_->state = CaptureState::Running;
      if (shared_->pending_running_event) {
        shared_->pushEvent(std::move(*shared_->pending_running_event));
        shared_->pending_running_event.reset();
      }
      while (!shared_->pending_start_events.empty()) {
        shared_->pushEvent(std::move(shared_->pending_start_events.front()));
        shared_->pending_start_events.pop_front();
      }
    }
  }
  if (stop_backend) {
    const auto stopped = backend_->stop(std::chrono::steady_clock::now() +
                                        kBackendRollbackDeadline);
    if (!stopped.ok) {
      const auto failure = stopped.failure.value_or(CaptureFailure{
          "capture_backend_stop_failed", "capture backend rollback failed"});
      {
        std::lock_guard lock(shared_->mutex);
        shared_->backend_stop_failure = failure;
      }
      if (!start_failure) start_failure = failure;
    }
  }
  if (start_failure) return {false, start_failure};
  return {};
}

std::optional<FrameLease> WindowCapture::waitForFrame(
    std::chrono::milliseconds timeout) {
  std::unique_lock lock(shared_->mutex);
  shared_->condition.wait_for(lock, timeout, [this] {
    return (shared_->state == CaptureState::Running &&
            !shared_->queue.empty()) ||
           shared_->state == CaptureState::Stopped ||
           shared_->state == CaptureState::Failed;
  });
  if (shared_->state != CaptureState::Running || shared_->queue.empty()) {
    return std::nullopt;
  }
  auto frame = std::move(shared_->queue.front());
  shared_->queue.pop_front();
  ++shared_->stats.frames.outstanding_leases;
  const std::weak_ptr weak = shared_;
  return FrameLease::create(
      frame.metadata, std::move(frame.resource), [weak] {
        const auto shared = weak.lock();
        if (!shared) return;
        std::lock_guard lock(shared->mutex);
        if (shared->stats.frames.outstanding_leases > 0) {
          --shared->stats.frames.outstanding_leases;
        }
        shared->condition.notify_all();
      });
}

std::optional<WindowCaptureEvent> WindowCapture::waitForEvent(
    std::chrono::milliseconds timeout) {
  std::unique_lock lock(shared_->mutex);
  shared_->condition.wait_for(lock, timeout, [this] {
    return !shared_->events.empty() || shared_->state == CaptureState::Stopped ||
           shared_->state == CaptureState::Failed;
  });
  if (shared_->events.empty()) return std::nullopt;
  auto event = std::move(shared_->events.front());
  shared_->events.pop_front();
  return event;
}

CaptureStopResult WindowCapture::stop(
    std::chrono::milliseconds lease_deadline) {
  const auto duration = (std::max)(lease_deadline, std::chrono::milliseconds{0});
  const auto deadline = std::chrono::steady_clock::now() + duration;
  std::unique_lock<std::timed_mutex> stop_owner(stop_mutex_, std::defer_lock);
  const bool owns_stop = duration == std::chrono::milliseconds{0}
                             ? stop_owner.try_lock()
                             : stop_owner.try_lock_until(deadline);
  if (!owns_stop) {
    return {false,
            CaptureFailure{"capture_stop_in_progress_deadline_exceeded",
                           "another stop operation exceeded this deadline"}};
  }
  bool stop_backend = false;
  std::optional<CaptureFailure> backend_failure;
  {
    std::lock_guard lock(shared_->mutex);
    shared_->stop_requested = true;
    shared_->accepting_frames = false;
    shared_->queue.clear();
    if (shared_->backend_start_invoked && !shared_->backend_stop_called) {
      shared_->backend_stop_called = true;
      stop_backend = true;
    }
    if (shared_->state != CaptureState::Failed) {
      shared_->state = CaptureState::Stopped;
    }
    shared_->condition.notify_all();
  }
  if (stop_backend) {
    const auto stopped = backend_->stop(deadline);
    if (!stopped.ok) {
      backend_failure = stopped.failure.value_or(CaptureFailure{
          "capture_backend_stop_failed", "capture backend stop failed"});
      std::lock_guard lock(shared_->mutex);
      shared_->backend_stop_failure = backend_failure;
    }
  }

  std::unique_lock lock(shared_->mutex);
  if (!shared_->condition.wait_until(lock, deadline, [this] {
        return !shared_->start_in_flight &&
               shared_->stats.frames.outstanding_leases == 0;
      })) {
    const bool start_pending = shared_->start_in_flight;
    CaptureFailure failure{
        start_pending ? "capture_start_deadline_exceeded"
                      : "frame_lease_deadline_exceeded",
        start_pending ? "capture start exceeded stop deadline"
                      : "outstanding frame lease exceeded stop deadline"};
    shared_->state = CaptureState::Failed;
    shared_->terminal_failure = failure;
    return {false, failure};
  }
  lock.unlock();
  if (!backend_failure) {
    std::lock_guard failure_lock(shared_->mutex);
    backend_failure = shared_->backend_stop_failure;
  }
  if (backend_failure) {
    std::lock_guard failure_lock(shared_->mutex);
    shared_->state = CaptureState::Failed;
    shared_->terminal_failure = backend_failure;
    return {false, backend_failure};
  }
  backend_->finalizeStop();
  return {};
}

CaptureState WindowCapture::state() const {
  std::lock_guard lock(shared_->mutex);
  return shared_->state;
}

WindowCaptureStats WindowCapture::stats() const {
  std::lock_guard lock(shared_->mutex);
  return shared_->stats;
}

std::optional<CaptureFailure> WindowCapture::terminalFailure() const {
  std::lock_guard lock(shared_->mutex);
  return shared_->terminal_failure;
}

const char* toString(WindowCaptureEventKind value) noexcept {
  switch (value) {
    case WindowCaptureEventKind::Running: return "running";
    case WindowCaptureEventKind::Resized: return "resized";
    case WindowCaptureEventKind::TemporarilyNoContent:
      return "temporarily_no_content";
    case WindowCaptureEventKind::ContentRestored: return "content_restored";
    case WindowCaptureEventKind::SourceClosed: return "source_closed";
    case WindowCaptureEventKind::CaptureFailed: return "capture_failed";
  }
  return "capture_failed";
}

}  // namespace syrnike::windows_media::capture
