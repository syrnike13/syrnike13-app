#pragma once

#include <windows.h>
#include <dxgi.h>

#include <string_view>

namespace syrnike::voice {

struct ScreenMediaPriorityPolicy {
  std::string_view name;
  int capture_thread_priority = THREAD_PRIORITY_NORMAL;
  bool capture_mmcss = false;
  int publication_gpu_priority = 0;
  int preview_gpu_priority = 0;
};

const ScreenMediaPriorityPolicy& screenMediaPriorityPolicy(
  std::string_view name
);
const ScreenMediaPriorityPolicy& configuredScreenMediaPriorityPolicy();

struct ScreenThreadPrioritySettingOutcome {
  int requested = THREAD_PRIORITY_NORMAL;
  int applied = THREAD_PRIORITY_NORMAL;
  bool succeeded = false;
  DWORD win32_error = ERROR_SUCCESS;
};

struct ScreenMmcssPriorityOutcome {
  bool requested = false;
  bool registered = false;
  DWORD win32_error = ERROR_SUCCESS;
};

struct ScreenCapturePriorityOutcome {
  std::string_view policy;
  ScreenThreadPrioritySettingOutcome thread;
  ScreenMmcssPriorityOutcome mmcss;
};

enum class ScreenD3dPriorityRole {
  Publication,
  Preview,
};

struct ScreenD3dPriorityOutcome {
  ScreenD3dPriorityRole role = ScreenD3dPriorityRole::Publication;
  int requested = 0;
  int applied = 0;
  HRESULT hresult = E_FAIL;
};

class ScreenPriorityPlatformAdapter {
 public:
  virtual ~ScreenPriorityPlatformAdapter() = default;
  virtual int getThreadPriority(HANDLE thread) noexcept = 0;
  virtual bool setThreadPriority(HANDLE thread, int priority) noexcept = 0;
  virtual HANDLE registerMmcss(
    const wchar_t* task_name,
    DWORD* task_index
  ) noexcept = 0;
  virtual bool unregisterMmcss(HANDLE handle) noexcept = 0;
  virtual HRESULT setGpuPriority(
    IDXGIDevice* device,
    int priority
  ) noexcept = 0;
  virtual HRESULT getGpuPriority(
    IDXGIDevice* device,
    int* priority
  ) noexcept = 0;
  virtual DWORD lastError() noexcept = 0;
};

ScreenPriorityPlatformAdapter& windowsScreenPriorityPlatform() noexcept;

class ScreenCapturePriorityScope {
 public:
  ScreenCapturePriorityScope();
  ScreenCapturePriorityScope(
    const ScreenMediaPriorityPolicy& policy,
    ScreenPriorityPlatformAdapter& platform
  );
  ~ScreenCapturePriorityScope();

  ScreenCapturePriorityScope(const ScreenCapturePriorityScope&) = delete;
  ScreenCapturePriorityScope& operator=(const ScreenCapturePriorityScope&) = delete;

  [[nodiscard]] bool mmcss_enabled() const {
    return outcome_.mmcss.registered;
  }
  [[nodiscard]] const ScreenCapturePriorityOutcome& outcome() const noexcept {
    return outcome_;
  }

 private:
  ScreenPriorityPlatformAdapter* platform_ = nullptr;
  HANDLE thread_ = GetCurrentThread();
  int old_thread_priority_ = THREAD_PRIORITY_NORMAL;
  bool old_thread_priority_valid_ = false;
  DWORD mmcss_task_index_ = 0;
  HANDLE mmcss_handle_ = nullptr;
  ScreenCapturePriorityOutcome outcome_;
};

ScreenD3dPriorityOutcome setD3dGpuThreadPriority(
  IDXGIDevice* device,
  int priority,
  ScreenD3dPriorityRole role,
  ScreenPriorityPlatformAdapter& platform = windowsScreenPriorityPlatform()
);

}  // namespace syrnike::voice
