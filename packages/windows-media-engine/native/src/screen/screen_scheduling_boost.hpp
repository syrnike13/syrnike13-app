#pragma once

#include <windows.h>
#include <d3d11.h>
#include <wrl/client.h>

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
  // What the media process actually got; unset when Windows refused both.
  std::optional<GpuSchedulingPriorityClass> gpu_process_priority;
  std::optional<std::int32_t> gpu_thread_priority;
};

// Scheduling help for the share while a game competes for the GPU. GPU
// priority is process-wide (this is the media utility process, never the UI)
// and the share pays for it with the game's frame rate, so it is held only
// while the load governor asks for it. Realtime is never requested: drivers
// have frozen under it. Owned and switched by the pipeline worker thread,
// because MMCSS registration belongs to the calling thread.
class ScreenSchedulingBoost final {
 public:
  explicit ScreenSchedulingBoost(ID3D11Device* device) noexcept;
  ~ScreenSchedulingBoost();
  ScreenSchedulingBoost(const ScreenSchedulingBoost&) = delete;
  ScreenSchedulingBoost& operator=(const ScreenSchedulingBoost&) = delete;

  void set(bool active) noexcept;
  [[nodiscard]] const ScreenSchedulingBoostStats& stats() const noexcept { return stats_; }

 private:
  void apply() noexcept;
  void revert() noexcept;

  Microsoft::WRL::ComPtr<IDXGIDevice> dxgi_device_;
  ScreenSchedulingBoostStats stats_;
  HANDLE mmcss_ = nullptr;
  std::optional<std::int32_t> previous_process_priority_;
  std::optional<INT> previous_thread_priority_;
};

}  // namespace syrnike::windows_media::screen
