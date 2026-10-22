#include "screen/screen_scheduling_boost.hpp"

#include <avrt.h>

namespace syrnike::windows_media::screen {
namespace {
// Exported by gdi32 without an SDK header; NTSTATUS 0 is success.
using GetPriorityClass = LONG(APIENTRY*)(HANDLE, std::int32_t*);
using SetPriorityClass = LONG(APIENTRY*)(HANDLE, std::int32_t);
struct GpuPriorityApi {
  GetPriorityClass get = nullptr;
  SetPriorityClass set = nullptr;
};
const GpuPriorityApi& gpuPriorityApi() noexcept {
  static const GpuPriorityApi api = [] {
    GpuPriorityApi value;
    if (const auto gdi = LoadLibraryExW(L"gdi32.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32)) {
      value.get = reinterpret_cast<GetPriorityClass>(
          GetProcAddress(gdi, "D3DKMTGetProcessSchedulingPriorityClass"));
      value.set = reinterpret_cast<SetPriorityClass>(
          GetProcAddress(gdi, "D3DKMTSetProcessSchedulingPriorityClass"));
    }
    return value;
  }();
  return api;
}
}  // namespace

ScreenSchedulingBoost::~ScreenSchedulingBoost() { set(false); }

void ScreenSchedulingBoost::set(bool active) noexcept {
  if (active == stats_.active) return;
  if (active) apply();
  else revert();
  stats_.active = active;
}

void ScreenSchedulingBoost::apply() noexcept {
  DWORD task = 0;
  mmcss_ = AvSetMmThreadCharacteristicsW(L"Capture", &task);
  stats_.mmcss_registered = mmcss_ != nullptr;

  const auto& api = gpuPriorityApi();
  std::int32_t previous = 0;
  if (!api.get || !api.set || api.get(GetCurrentProcess(), &previous) != 0) return;
  // Windows may refuse high to an unelevated process; above normal is the
  // fallback. The applied class is reported in screen_load_metrics.
  for (const auto wanted : {GpuSchedulingPriorityClass::high,
                            GpuSchedulingPriorityClass::above_normal}) {
    if (static_cast<std::int32_t>(wanted) <= previous) break;
    if (api.set(GetCurrentProcess(), static_cast<std::int32_t>(wanted)) == 0) {
      previous_process_priority_ = previous;
      stats_.gpu_process_priority = wanted;
      break;
    }
  }
}

void ScreenSchedulingBoost::revert() noexcept {
  const auto& api = gpuPriorityApi();
  std::int32_t current = 0;
  // Restore only our own change: a class set since by someone else stays.
  if (previous_process_priority_ && stats_.gpu_process_priority && api.get && api.set &&
      api.get(GetCurrentProcess(), &current) == 0 &&
      current == static_cast<std::int32_t>(*stats_.gpu_process_priority))
    (void)api.set(GetCurrentProcess(), *previous_process_priority_);
  previous_process_priority_.reset();
  stats_.gpu_process_priority.reset();
  if (mmcss_) AvRevertMmThreadCharacteristics(mmcss_);
  mmcss_ = nullptr;
  stats_.mmcss_registered = false;
}

}  // namespace syrnike::windows_media::screen
