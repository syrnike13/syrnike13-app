#include "screen_capture_priority.hpp"

#include <avrt.h>

#include <algorithm>

namespace syrnike::voice {

ScreenCapturePriorityScope::ScreenCapturePriorityScope() {
  old_thread_priority_ = GetThreadPriority(thread_);

  SetThreadPriority(thread_, THREAD_PRIORITY_HIGHEST);
  mmcss_handle_ = AvSetMmThreadCharacteristicsW(L"Capture", &mmcss_task_index_);
}

ScreenCapturePriorityScope::~ScreenCapturePriorityScope() {
  if (mmcss_handle_) AvRevertMmThreadCharacteristics(mmcss_handle_);
  SetThreadPriority(thread_, old_thread_priority_);
}

void setD3dGpuThreadPriority(IDXGIDevice* device, int priority) {
  if (!device) return;
  device->SetGPUThreadPriority(std::clamp(priority, -7, 7));
}

}  // namespace syrnike::voice
