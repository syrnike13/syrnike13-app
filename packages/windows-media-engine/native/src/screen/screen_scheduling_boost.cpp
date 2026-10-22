#include "screen/screen_scheduling_boost.hpp"

#include <avrt.h>
#include <dxgi.h>

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
// The documented range of IDXGIDevice::SetGPUThreadPriority.
constexpr INT kBoostedGpuThreadPriority = 7;
}  // namespace

ScreenSchedulingBoost::ScreenSchedulingBoost(ID3D11Device* device) noexcept {
  if (device) (void)device->QueryInterface(IID_PPV_ARGS(&dxgi_device_));
}

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
  if (api.get && api.set && api.get(GetCurrentProcess(), &previous) == 0) {
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

  INT thread_previous = 0;
  if (dxgi_device_ && SUCCEEDED(dxgi_device_->GetGPUThreadPriority(&thread_previous)) &&
      thread_previous < kBoostedGpuThreadPriority &&
      SUCCEEDED(dxgi_device_->SetGPUThreadPriority(kBoostedGpuThreadPriority))) {
    previous_thread_priority_ = thread_previous;
    stats_.gpu_thread_priority = kBoostedGpuThreadPriority;
  }
}

void ScreenSchedulingBoost::revert() noexcept {
  if (previous_thread_priority_ && dxgi_device_)
    (void)dxgi_device_->SetGPUThreadPriority(*previous_thread_priority_);
  previous_thread_priority_.reset();
  stats_.gpu_thread_priority.reset();
  const auto& api = gpuPriorityApi();
  if (previous_process_priority_ && api.set)
    (void)api.set(GetCurrentProcess(), *previous_process_priority_);
  previous_process_priority_.reset();
  stats_.gpu_process_priority.reset();
  if (mmcss_) AvRevertMmThreadCharacteristics(mmcss_);
  mmcss_ = nullptr;
  stats_.mmcss_registered = false;
}

}  // namespace syrnike::windows_media::screen
