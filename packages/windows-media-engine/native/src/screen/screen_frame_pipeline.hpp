#pragma once

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>

#include "capture/monitor_capture.hpp"

namespace syrnike::windows_media::screen {

// The capture wrappers already bound WGC-owned frames to three. The reference
// pipeline retains only the newest pending lease, so one converting frame plus
// one pending frame cannot create an age-growing backlog.
inline constexpr std::size_t kScreenFramePipelineCapacity = 1;
inline constexpr auto kScreenFrameMaximumAge = std::chrono::milliseconds{250};

struct ScreenFramePipelineStats {
  std::uint64_t submitted = 0;
  std::uint64_t accepted = 0;
  std::uint64_t superseded = 0;
  std::uint64_t dropped = 0;
  std::uint64_t too_old = 0;
  std::uint64_t released = 0;
  std::size_t maximum_depth = 0;
  std::size_t pending = 0;
  std::size_t active = 0;
  std::uint64_t current_generation = 0;
};

class ScreenPipelineFrame final {
 public:
  ScreenPipelineFrame() = default;
  ~ScreenPipelineFrame();
  ScreenPipelineFrame(ScreenPipelineFrame&& other) noexcept;
  ScreenPipelineFrame& operator=(ScreenPipelineFrame&& other) noexcept;
  ScreenPipelineFrame(const ScreenPipelineFrame&) = delete;
  ScreenPipelineFrame& operator=(const ScreenPipelineFrame&) = delete;

  explicit operator bool() const noexcept;
  const capture::FrameMetadata& metadata() const;
  [[nodiscard]] std::optional<capture::D3d11FrameView> d3d11View() const;
  void copyBgraTo(std::span<std::uint8_t> destination,
                  std::size_t destination_stride) const;
  void release() noexcept;

 private:
  struct PipelineState;
  ScreenPipelineFrame(capture::FrameLease lease,
                      capture::FrameMetadata metadata,
                      std::weak_ptr<PipelineState> pipeline);

  capture::FrameLease lease_;
  capture::FrameMetadata metadata_;
  std::weak_ptr<PipelineState> pipeline_;
  bool released_ = true;
  friend class ScreenFramePipeline;
};

class ScreenFramePipeline final {
 public:
  explicit ScreenFramePipeline(
      std::chrono::milliseconds maximum_age = kScreenFrameMaximumAge);
  ~ScreenFramePipeline();
  ScreenFramePipeline(const ScreenFramePipeline&) = delete;
  ScreenFramePipeline& operator=(const ScreenFramePipeline&) = delete;

  bool submit(capture::FrameLease lease) noexcept;
  std::optional<ScreenPipelineFrame> waitForFrame(
      std::chrono::milliseconds timeout);
  bool discardIfUnpublishable(ScreenPipelineFrame& frame) noexcept;
  bool stop(std::chrono::steady_clock::time_point deadline) noexcept;
  bool restart() noexcept;
  ScreenFramePipelineStats stats() const noexcept;

 private:
  std::shared_ptr<ScreenPipelineFrame::PipelineState> state_;
};

std::int64_t screenSteadyTimestamp100ns() noexcept;
std::uint64_t captureTimestampEpochMilliseconds(
    std::int64_t capture_timestamp_100ns) noexcept;

}  // namespace syrnike::windows_media::screen
