#include "screen/screen_frame_pipeline.hpp"

#include <algorithm>
#include <utility>

namespace syrnike::windows_media::screen {
namespace {

using HundredNanoseconds =
    std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>;
constexpr auto kCaptureClockFutureTolerance = std::chrono::milliseconds{100};

struct PendingFrame {
  capture::FrameLease lease;
  capture::FrameMetadata metadata;
};

bool tooOld(const capture::FrameMetadata& metadata,
            std::chrono::milliseconds maximum_age) noexcept {
  const auto now = screenSteadyTimestamp100ns();
  if (metadata.capture_timestamp_100ns <= 0) return true;
  if (metadata.capture_timestamp_100ns > now) {
    return HundredNanoseconds{metadata.capture_timestamp_100ns - now} >
           kCaptureClockFutureTolerance;
  }
  const auto age = HundredNanoseconds{
      now - metadata.capture_timestamp_100ns};
  return age > maximum_age;
}

}  // namespace

struct ScreenPipelineFrame::PipelineState {
  mutable std::mutex mutex;
  std::condition_variable changed;
  std::optional<PendingFrame> pending;
  ScreenFramePipelineStats stats;
  std::chrono::milliseconds maximum_age;
  bool accepting = true;
};

ScreenPipelineFrame::ScreenPipelineFrame(
    capture::FrameLease lease, capture::FrameMetadata metadata,
    std::weak_ptr<PipelineState> pipeline)
    : lease_(std::move(lease)),
      metadata_(metadata),
      pipeline_(std::move(pipeline)),
      released_(false) {}

ScreenPipelineFrame::~ScreenPipelineFrame() { release(); }

ScreenPipelineFrame::ScreenPipelineFrame(ScreenPipelineFrame&& other) noexcept
    : lease_(std::move(other.lease_)),
      metadata_(other.metadata_),
      pipeline_(std::move(other.pipeline_)),
      released_(other.released_) {
  other.released_ = true;
}

ScreenPipelineFrame& ScreenPipelineFrame::operator=(
    ScreenPipelineFrame&& other) noexcept {
  if (this == &other) return *this;
  release();
  lease_ = std::move(other.lease_);
  metadata_ = other.metadata_;
  pipeline_ = std::move(other.pipeline_);
  released_ = other.released_;
  other.released_ = true;
  return *this;
}

ScreenPipelineFrame::operator bool() const noexcept {
  return !released_ && static_cast<bool>(lease_);
}

const capture::FrameMetadata& ScreenPipelineFrame::metadata() const {
  if (!*this) throw std::logic_error("screen pipeline frame was released");
  return metadata_;
}

std::optional<capture::D3d11FrameView> ScreenPipelineFrame::d3d11View() const {
  if (!*this) return std::nullopt;
  return lease_.d3d11View();
}

void ScreenPipelineFrame::copyBgraTo(
    std::span<std::uint8_t> destination,
    std::size_t destination_stride) const {
  if (!*this) throw std::logic_error("screen pipeline frame was released");
  lease_.copyBgraTo(destination, destination_stride);
}

void ScreenPipelineFrame::release() noexcept {
  if (released_) return;
  released_ = true;
  lease_.release();
  if (const auto pipeline = pipeline_.lock()) {
    std::lock_guard lock(pipeline->mutex);
    if (pipeline->stats.active > 0) --pipeline->stats.active;
    ++pipeline->stats.released;
    pipeline->changed.notify_all();
  }
}

ScreenFramePipeline::ScreenFramePipeline(
    std::chrono::milliseconds maximum_age)
    : state_(std::make_shared<ScreenPipelineFrame::PipelineState>()) {
  state_->maximum_age =
      (std::max)(maximum_age, std::chrono::milliseconds{1});
}

ScreenFramePipeline::~ScreenFramePipeline() {
  (void)stop(std::chrono::steady_clock::now());
}

bool ScreenFramePipeline::submit(capture::FrameLease lease) noexcept {
  if (!lease) return false;
  {
    std::lock_guard lock(state_->mutex);
    ++state_->stats.submitted;
  }
  capture::FrameMetadata metadata;
  try {
    metadata = lease.metadata();
  } catch (...) {
    lease.release();
    std::lock_guard lock(state_->mutex);
    ++state_->stats.dropped;
    ++state_->stats.released;
    return false;
  }

  std::optional<PendingFrame> displaced;
  bool accepted = false;
  {
    std::lock_guard lock(state_->mutex);
    if (!state_->accepting || metadata.generation == 0 ||
        (state_->stats.current_generation != 0 &&
         metadata.generation < state_->stats.current_generation)) {
      ++state_->stats.dropped;
    } else {
      if (metadata.generation > state_->stats.current_generation) {
        state_->stats.current_generation = metadata.generation;
      }
      if (state_->pending) {
        displaced = std::move(state_->pending);
        state_->pending.reset();
        ++state_->stats.superseded;
        ++state_->stats.dropped;
      }
      state_->pending.emplace(PendingFrame{std::move(lease), metadata});
      ++state_->stats.accepted;
      state_->stats.pending = 1;
      state_->stats.maximum_depth = 1;
      accepted = true;
      state_->changed.notify_one();
    }
  }

  if (displaced) {
    displaced->lease.release();
    std::lock_guard lock(state_->mutex);
    ++state_->stats.released;
  }
  if (!accepted) {
    lease.release();
    std::lock_guard lock(state_->mutex);
    ++state_->stats.released;
  }
  return accepted;
}

std::optional<ScreenPipelineFrame> ScreenFramePipeline::waitForFrame(
    std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() +
                        (std::max)(timeout, std::chrono::milliseconds{0});
  while (true) {
    PendingFrame pending;
    {
      std::unique_lock lock(state_->mutex);
      state_->changed.wait_until(lock, deadline, [this] {
        return state_->pending.has_value() || !state_->accepting;
      });
      if (!state_->pending) return std::nullopt;
      pending = std::move(*state_->pending);
      state_->pending.reset();
      state_->stats.pending = 0;
      ++state_->stats.active;
    }
    ScreenPipelineFrame frame{std::move(pending.lease), pending.metadata,
                              state_};
    if (!discardIfUnpublishable(frame)) return frame;
    if (std::chrono::steady_clock::now() >= deadline) return std::nullopt;
  }
}

bool ScreenFramePipeline::discardIfUnpublishable(
    ScreenPipelineFrame& frame) noexcept {
  if (!frame) return true;
  bool discard = false;
  bool expired = false;
  {
    std::lock_guard lock(state_->mutex);
    expired = tooOld(frame.metadata_, state_->maximum_age);
    discard = expired || !state_->accepting ||
              frame.metadata_.generation != state_->stats.current_generation;
    if (discard) {
      ++state_->stats.dropped;
      if (expired) ++state_->stats.too_old;
    }
  }
  if (discard) frame.release();
  return discard;
}

bool ScreenFramePipeline::stop(
    std::chrono::steady_clock::time_point deadline) noexcept {
  std::optional<PendingFrame> pending;
  {
    std::lock_guard lock(state_->mutex);
    state_->accepting = false;
    if (state_->pending) {
      pending = std::move(state_->pending);
      state_->pending.reset();
      state_->stats.pending = 0;
      ++state_->stats.dropped;
    }
    state_->changed.notify_all();
  }
  if (pending) {
    pending->lease.release();
    std::lock_guard lock(state_->mutex);
    ++state_->stats.released;
    state_->changed.notify_all();
  }
  std::unique_lock lock(state_->mutex);
  return state_->changed.wait_until(
      lock, deadline, [this] { return state_->stats.active == 0; });
}

bool ScreenFramePipeline::restart() noexcept {
  std::lock_guard lock(state_->mutex);
  if (state_->accepting || state_->pending || state_->stats.pending != 0 ||
      state_->stats.active != 0) {
    return false;
  }
  state_->accepting = true;
  state_->changed.notify_all();
  return true;
}

ScreenFramePipelineStats ScreenFramePipeline::stats() const noexcept {
  std::lock_guard lock(state_->mutex);
  return state_->stats;
}

std::int64_t screenSteadyTimestamp100ns() noexcept {
  return std::chrono::duration_cast<HundredNanoseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

std::uint64_t captureTimestampEpochMilliseconds(
    std::int64_t capture_timestamp_100ns) noexcept {
  const auto steady_now = screenSteadyTimestamp100ns();
  const auto system_now =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch())
          .count();
  if (capture_timestamp_100ns <= 0 || capture_timestamp_100ns > steady_now)
    return static_cast<std::uint64_t>((std::max)(system_now, std::int64_t{0}));
  const auto age_ms = (steady_now - capture_timestamp_100ns) / 10'000;
  return static_cast<std::uint64_t>(
      (std::max)(system_now - age_ms, std::int64_t{0}));
}

}  // namespace syrnike::windows_media::screen
