#pragma once

#include <windows.h>
#include <dxgi.h>

namespace syrnike::voice {

class ScreenCapturePriorityScope {
public:
  ScreenCapturePriorityScope();
  ~ScreenCapturePriorityScope();

  ScreenCapturePriorityScope(const ScreenCapturePriorityScope&) = delete;
  ScreenCapturePriorityScope& operator=(const ScreenCapturePriorityScope&) = delete;

  bool mmcss_enabled() const { return mmcss_handle_ != nullptr; }

private:
  HANDLE thread_ = GetCurrentThread();
  int old_thread_priority_ = THREAD_PRIORITY_NORMAL;
  DWORD mmcss_task_index_ = 0;
  HANDLE mmcss_handle_ = nullptr;
};

void setD3dGpuThreadPriority(IDXGIDevice* device, int priority);

}  // namespace syrnike::voice
