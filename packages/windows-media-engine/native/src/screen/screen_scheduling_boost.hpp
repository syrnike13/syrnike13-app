#pragma once

#include <windows.h>

#include <cstdint>
#include <optional>

namespace syrnike::windows_media::screen {

// Values of D3DKMT_SCHEDULINGPRIORITYCLASS.
enum class GpuSchedulingPriorityClass : std::int32_t {
  idle = 0, below_normal = 1, normal = 2, above_normal = 3, high = 4, realtime = 5,
};

struct ScreenSchedulingBoostStats {
  bool active = false;
  bool mmcss_registered = false;
  // What the media process actually got; unset when Windows refused both
  // classes or the process already ran at least as high.
  std::optional<GpuSchedulingPriorityClass> gpu_process_priority;
};

// Scheduling help for the share while a game competes for the GPU. The GPU
// scheduling class belongs to the whole media utility process (never the UI):
// its camera, preview and decoding work is raised with the share, and the
// game pays with frame rate, so it is held only while the load governor asks
// for it. Realtime is never requested: drivers have frozen under it. Owned
// and switched by the pipeline worker thread, because MMCSS registration
// belongs to the calling thread.
class ScreenSchedulingBoost final {
 public:
  ScreenSchedulingBoost() = default;
  ~ScreenSchedulingBoost();
  ScreenSchedulingBoost(const ScreenSchedulingBoost&) = delete;
  ScreenSchedulingBoost& operator=(const ScreenSchedulingBoost&) = delete;

  void set(bool active) noexcept;
  [[nodiscard]] const ScreenSchedulingBoostStats& stats() const noexcept { return stats_; }

 private:
  void apply() noexcept;
  void revert() noexcept;

  ScreenSchedulingBoostStats stats_;
  HANDLE mmcss_ = nullptr;
  std::optional<std::int32_t> previous_process_priority_;
};

}  // namespace syrnike::windows_media::screen
