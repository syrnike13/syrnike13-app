#pragma once
#include "capture/monitor_capture.hpp"

namespace syrnike::windows_media::capture {
inline constexpr std::size_t kDxgiFrameSlots = 3;
inline constexpr std::uint32_t kDxgiMaximumCursorDimension = 512;
inline constexpr std::uint64_t kDxgiDuplicationHoldBudgetUs = 50'000;
struct DxgiCaptureDiagnostics {
  std::uint64_t acquired_frames = 0, released_frames = 0, delivered_frames = 0;
  std::uint64_t no_content = 0, unavailable_slots = 0, pointer_updates = 0;
  std::uint64_t context_contention_waits = 0;
  std::uint64_t maximum_duplication_hold_us = 0;
  // Phase durations belonging to the single maximum-hold frame.
  std::uint64_t maximum_hold_before_copy_us = 0, maximum_hold_copy_us = 0,
                maximum_hold_release_us = 0;
  std::size_t active_leases = 0, peak_leases = 0, allocated_textures = 0;
  std::uint32_t width = 0, height = 0, rotation = 0;
};
class DxgiMonitorCaptureBackend : public MonitorCaptureBackend {
 public:
  virtual DxgiCaptureDiagnostics diagnostics() const = 0;
};
std::unique_ptr<DxgiMonitorCaptureBackend> createDxgiMonitorCaptureBackend(
    bool request_debug = false);
}  // namespace syrnike::windows_media::capture
