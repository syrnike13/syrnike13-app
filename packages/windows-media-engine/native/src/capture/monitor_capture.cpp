#include "capture/monitor_capture.hpp"

#include <atomic>
#include <condition_variable>
#include <deque>
#include <stdexcept>
#include <utility>

namespace syrnike::windows_media::capture {
namespace {

CaptureFailure sourceFailure(sources::ResolveStatus status) {
  if (status == sources::ResolveStatus::Failed) {
    return {"source_resolution_failed", "monitor source resolution failed"};
  }
  return {"source_unavailable", "monitor source is no longer available"};
}

constexpr auto kBackendRollbackDeadline = std::chrono::seconds{5};

}  // namespace

void FrameResource::copyBgraTo(std::span<std::uint8_t>, std::size_t) {
  throw std::logic_error("frame resource does not support CPU readback");
}

std::optional<D3d11FrameView> FrameResource::d3d11View() {
  return std::nullopt;
}

struct FrameLease::State {
  std::mutex mutex;
  FrameMetadata metadata;
  std::shared_ptr<FrameResource> resource;
  std::function<void()> on_release;
  std::atomic<bool> released{false};
};

struct MonitorCapture::SharedState {
  struct QueuedFrame {
    FrameMetadata metadata;
    std::shared_ptr<FrameResource> resource;
  };

  mutable std::mutex mutex;
  std::condition_variable condition;
  std::deque<QueuedFrame> queue;
  CaptureState state = CaptureState::Idle;
  CaptureStats stats;
  std::optional<CaptureFailure> terminal_failure;
  std::uint64_t next_sequence = 1;
  std::optional<std::int64_t> last_timestamp;
  bool accepting_frames = false;
  bool stop_requested = false;
  bool backend_start_invoked = false;
  bool backend_stop_called = false;
  bool start_in_flight = false;
  std::optional<CaptureFailure> backend_stop_failure;
};

class ScopeExit final {
 public:
  explicit ScopeExit(std::function<void()> cleanup)
      : cleanup_(std::move(cleanup)) {}
  ~ScopeExit() { cleanup_(); }

 private:
  std::function<void()> cleanup_;
};

FrameLease::FrameLease(std::shared_ptr<State> state) : state_(std::move(state)) {}

FrameLease FrameLease::create(FrameMetadata metadata,
                              std::shared_ptr<FrameResource> resource,
                              std::function<void()> on_release) {
  auto state = std::make_shared<State>();
  state->metadata = std::move(metadata);
  state->resource = std::move(resource);
  state->on_release = std::move(on_release);
  return FrameLease{std::move(state)};
}

FrameLease::~FrameLease() { release(); }

FrameLease::FrameLease(FrameLease&& other) noexcept
    : state_(std::move(other.state_)) {}

FrameLease& FrameLease::operator=(FrameLease&& other) noexcept {
  if (this == &other) return *this;
  release();
  state_ = std::move(other.state_);
  return *this;
}

FrameLease::operator bool() const noexcept {
  return state_ && !state_->released.load();
}

const FrameMetadata& FrameLease::metadata() const {
  if (!*this) throw std::logic_error("frame lease was released");
  return state_->metadata;
}

std::uint64_t FrameLease::sampledHash() const {
  if (!*this) {
    throw std::logic_error("frame lease was released");
  }
  std::lock_guard lock(state_->mutex);
  if (!state_->resource) throw std::logic_error("frame lease was released");
  return state_->resource->sampledHash();
}

std::optional<D3d11FrameView> FrameLease::d3d11View() const {
  if (!*this) throw std::logic_error("frame lease was released");
  std::lock_guard lock(state_->mutex);
  if (!state_->resource) throw std::logic_error("frame lease was released");
  return state_->resource->d3d11View();
}

void FrameLease::copyBgraTo(std::span<std::uint8_t> destination,
                            std::size_t destination_stride) const {
  if (!*this) throw std::logic_error("frame lease was released");
  std::lock_guard lock(state_->mutex);
  if (!state_->resource) throw std::logic_error("frame lease was released");
  state_->resource->copyBgraTo(destination, destination_stride);
}

LeaseReleaseStatus FrameLease::release() noexcept {
  if (!state_) return LeaseReleaseStatus::AlreadyReleased;
  bool expected = false;
  if (!state_->released.compare_exchange_strong(expected, true)) {
    return LeaseReleaseStatus::AlreadyReleased;
  }
  {
    std::lock_guard lock(state_->mutex);
    state_->resource.reset();
  }
  if (state_->on_release) state_->on_release();
  return LeaseReleaseStatus::Released;
}

MonitorCapture::MonitorCapture(sources::SourceRegistry& registry,
                               std::string source_id,
                               std::unique_ptr<MonitorCaptureBackend> backend)
    : registry_(registry),
      source_id_(std::move(source_id)),
      backend_(std::move(backend)),
      shared_(std::make_shared<SharedState>()) {
  if (!backend_) throw std::invalid_argument("MonitorCaptureBackend is required");
}

MonitorCapture::~MonitorCapture() {
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

CaptureStartResult MonitorCapture::start() {
  {
    std::lock_guard lock(shared_->mutex);
    if (shared_->state != CaptureState::Idle) {
      return {false, CaptureFailure{"capture_already_started",
                                    "monitor capture is not idle"}};
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
    return CaptureStartResult{false, std::move(failure)};
  };

  const auto resolved = registry_.resolve(source_id_);
  if (resolved.status != sources::ResolveStatus::Available) {
    return fail_start(sourceFailure(resolved.status));
  }
  if (resolved.kind != sources::SourceKind::Monitor) {
    return fail_start(
        CaptureFailure{"source_kind_mismatch", "source is not a monitor"});
  }

  const auto target = registry_.resolveMonitorTarget(source_id_);
  if (target.status != sources::ResolveStatus::Available || !target.target) {
    return fail_start(sourceFailure(target.status));
  }

  {
    std::lock_guard lock(shared_->mutex);
    if (shared_->stop_requested) {
      const CaptureFailure failure{"start_cancelled",
                                   "capture was stopped during start"};
      shared_->accepting_frames = false;
      shared_->state = CaptureState::Stopped;
      return {false, failure};
    }
    shared_->backend_start_invoked = true;
  }

  const std::weak_ptr weak = shared_;
  auto backend_result = backend_->start(
      *target.target,
      [weak](BackendFrame frame) {
        const auto shared = weak.lock();
        if (!shared || !frame.resource || frame.width == 0 ||
            frame.height == 0) {
          return;
        }
        std::lock_guard lock(shared->mutex);
        if (!shared->accepting_frames ||
            (shared->state != CaptureState::Starting &&
             shared->state != CaptureState::Running)) {
          return;
        }
        ++shared->stats.received_frames;
        if (shared->last_timestamp &&
            frame.capture_timestamp_100ns < *shared->last_timestamp) {
          shared->stats.timestamps_monotonic = false;
        }
        shared->last_timestamp = frame.capture_timestamp_100ns;
        FrameMetadata metadata{shared->next_sequence++,
                               frame.capture_timestamp_100ns, frame.width,
                               frame.height, frame.format};
        if (shared->queue.size() + shared->stats.outstanding_leases >=
            kMaximumMonitorFrames) {
          if (shared->queue.empty()) {
            ++shared->stats.dropped_frames;
            return;
          }
          shared->queue.pop_front();
          ++shared->stats.dropped_frames;
        }
        shared->queue.push_back(
            SharedState::QueuedFrame{metadata, std::move(frame.resource)});
        shared->stats.maximum_queue_depth =
            (std::max)(shared->stats.maximum_queue_depth,
                       shared->queue.size());
        shared->condition.notify_one();
      },
      [weak](CaptureFailure failure) {
        const auto shared = weak.lock();
        if (!shared) return;
        std::lock_guard lock(shared->mutex);
        if (!shared->accepting_frames) return;
        shared->accepting_frames = false;
        shared->queue.clear();
        shared->state = CaptureState::Failed;
        shared->terminal_failure = std::move(failure);
        shared->condition.notify_all();
      });

  bool stop_backend = false;
  std::optional<CaptureFailure> start_failure;
  {
    std::lock_guard lock(shared_->mutex);
    if (!backend_result.ok) {
      shared_->accepting_frames = false;
      shared_->queue.clear();
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
    } else if (shared_->state == CaptureState::Failed) {
      shared_->accepting_frames = false;
      start_failure = shared_->terminal_failure.value_or(
          CaptureFailure{"capture_start_failed",
                         "capture failed while backend was starting"});
      if (!shared_->backend_stop_called) {
        shared_->backend_stop_called = true;
        stop_backend = true;
      }
    } else if (shared_->stop_requested) {
      shared_->accepting_frames = false;
      shared_->state = CaptureState::Stopped;
    } else if (shared_->state == CaptureState::Starting) {
      shared_->state = CaptureState::Running;
    }
  }
  if (stop_backend) {
    const auto rollback_deadline =
        std::chrono::steady_clock::now() + kBackendRollbackDeadline;
    const auto stopped = backend_->stop(rollback_deadline);
    if (!stopped.ok) {
      const auto rollback_failure = stopped.failure.value_or(CaptureFailure{
          "capture_backend_stop_failed", "capture backend rollback failed"});
      {
        std::lock_guard lock(shared_->mutex);
        shared_->backend_stop_failure = rollback_failure;
      }
      if (!start_failure) start_failure = rollback_failure;
    }
  }
  if (start_failure) return {false, start_failure};
  {
    std::lock_guard lock(shared_->mutex);
    if (shared_->stop_requested) {
      return {false, CaptureFailure{"start_cancelled",
                                    "capture was stopped during start"}};
    }
    if (shared_->state == CaptureState::Failed) {
      return {false, shared_->terminal_failure};
    }
  }
  return {};
}

std::optional<FrameLease> MonitorCapture::waitForFrame(
    std::chrono::milliseconds timeout) {
  std::unique_lock lock(shared_->mutex);
  shared_->condition.wait_for(lock, timeout, [this] {
    return !shared_->queue.empty() || shared_->state == CaptureState::Stopped ||
           shared_->state == CaptureState::Failed;
  });
  if (shared_->queue.empty()) return std::nullopt;
  auto frame = std::move(shared_->queue.front());
  shared_->queue.pop_front();
  ++shared_->stats.outstanding_leases;
  auto lease = std::make_shared<FrameLease::State>();
  lease->metadata = frame.metadata;
  lease->resource = std::move(frame.resource);
  const std::weak_ptr weak = shared_;
  lease->on_release = [weak] {
    const auto shared = weak.lock();
    if (!shared) return;
    std::lock_guard release_lock(shared->mutex);
    if (shared->stats.outstanding_leases > 0) {
      --shared->stats.outstanding_leases;
    }
    shared->condition.notify_all();
  };
  return FrameLease{std::move(lease)};
}

CaptureStopResult MonitorCapture::stop(
    std::chrono::milliseconds lease_deadline) {
  const auto duration = (std::max)(lease_deadline, std::chrono::milliseconds{0});
  const auto deadline = std::chrono::steady_clock::now() + duration;
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
               shared_->stats.outstanding_leases == 0;
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

CaptureState MonitorCapture::state() const {
  std::lock_guard lock(shared_->mutex);
  return shared_->state;
}

CaptureStats MonitorCapture::stats() const {
  std::lock_guard lock(shared_->mutex);
  return shared_->stats;
}

std::optional<CaptureFailure> MonitorCapture::terminalFailure() const {
  std::lock_guard lock(shared_->mutex);
  return shared_->terminal_failure;
}

const char* toString(CaptureState value) noexcept {
  switch (value) {
    case CaptureState::Idle: return "idle";
    case CaptureState::Starting: return "starting";
    case CaptureState::Running: return "running";
    case CaptureState::Stopped: return "stopped";
    case CaptureState::Failed: return "failed";
  }
  return "failed";
}

const char* toString(FramePixelFormat value) noexcept {
  return value == FramePixelFormat::Bgra8 ? "bgra8" : "unknown";
}

}  // namespace syrnike::windows_media::capture
