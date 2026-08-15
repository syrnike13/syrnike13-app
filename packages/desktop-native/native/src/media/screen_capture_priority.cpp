#include "screen_capture_priority.hpp"

#include <avrt.h>

#include <algorithm>
#include <array>
#include <stdexcept>

#include "../common/diagnostic_log.hpp"

namespace syrnike::voice {
namespace {

constexpr std::array<ScreenMediaPriorityPolicy, 3> kPolicies{{
    {
        "normal",
        THREAD_PRIORITY_NORMAL,
        false,
        0,
        0,
    },
    {
        "capture",
        THREAD_PRIORITY_NORMAL,
        true,
        1,
        0,
    },
    {
        "legacy-high",
        THREAD_PRIORITY_HIGHEST,
        true,
        3,
        2,
    },
}};

class WindowsScreenPriorityPlatform final
    : public ScreenPriorityPlatformAdapter {
 public:
  int getThreadPriority(HANDLE thread) noexcept override {
    return GetThreadPriority(thread);
  }

  bool setThreadPriority(HANDLE thread, int priority) noexcept override {
    return SetThreadPriority(thread, priority) != FALSE;
  }

  HANDLE registerMmcss(
      const wchar_t* task_name,
      DWORD* task_index) noexcept override {
    return AvSetMmThreadCharacteristicsW(task_name, task_index);
  }

  bool unregisterMmcss(HANDLE handle) noexcept override {
    return AvRevertMmThreadCharacteristics(handle) != FALSE;
  }

  HRESULT setGpuPriority(
      IDXGIDevice* device,
      int priority) noexcept override {
    return device ? device->SetGPUThreadPriority(priority) : E_POINTER;
  }

  HRESULT getGpuPriority(
      IDXGIDevice* device,
      int* priority) noexcept override {
    return device ? device->GetGPUThreadPriority(priority) : E_POINTER;
  }

  DWORD lastError() noexcept override { return GetLastError(); }
};

std::string_view roleName(ScreenD3dPriorityRole role) noexcept {
  return role == ScreenD3dPriorityRole::Publication
    ? "publication"
    : "preview";
}

void logCapturePriority(const ScreenCapturePriorityOutcome& outcome) noexcept {
  auto& logger =
      syrnike::desktop_native::diagnostics::DiagnosticLog::instance();
  if (!logger.enabled()) return;
  logger.write(
      "screen_capture_priority",
      {
          {"policy", outcome.policy},
          {"threadRequested", static_cast<std::int64_t>(
              outcome.thread.requested)},
          {"threadApplied", static_cast<std::int64_t>(
              outcome.thread.applied)},
          {"threadSucceeded", outcome.thread.succeeded},
          {"threadWin32Error", static_cast<std::uint64_t>(
              outcome.thread.win32_error)},
          {"mmcssRequested", outcome.mmcss.requested},
          {"mmcssRegistered", outcome.mmcss.registered},
          {"mmcssWin32Error", static_cast<std::uint64_t>(
              outcome.mmcss.win32_error)},
      });
}

void logD3dPriority(const ScreenD3dPriorityOutcome& outcome) noexcept {
  auto& logger =
      syrnike::desktop_native::diagnostics::DiagnosticLog::instance();
  if (!logger.enabled()) return;
  logger.write(
      "screen_d3d_priority",
      {
          {"policy", configuredScreenMediaPriorityPolicy().name},
          {"role", roleName(outcome.role)},
          {"requested", static_cast<std::int64_t>(outcome.requested)},
          {"applied", static_cast<std::int64_t>(outcome.applied)},
          {"hresult", static_cast<std::int64_t>(outcome.hresult)},
      });
}
}  // namespace

const ScreenMediaPriorityPolicy& screenMediaPriorityPolicy(
    std::string_view name) {
  const auto found = std::find_if(
      kPolicies.begin(), kPolicies.end(), [name](const auto& policy) {
        return policy.name == name;
      });
  if (found == kPolicies.end()) {
    throw std::invalid_argument("unknown screen media priority policy");
  }
  return *found;
}

const ScreenMediaPriorityPolicy& configuredScreenMediaPriorityPolicy() {
  static const auto* configured = [] {
    std::array<char, 64> buffer{};
    const auto size = GetEnvironmentVariableA(
        "SYRNIKE_MEDIA_PRIORITY_POLICY",
        buffer.data(),
        static_cast<DWORD>(buffer.size()));
    if (size == 0) return &screenMediaPriorityPolicy("legacy-high");
    if (size >= buffer.size()) {
      throw std::invalid_argument("screen media priority policy is too long");
    }
    return &screenMediaPriorityPolicy(
        std::string_view(buffer.data(), static_cast<std::size_t>(size)));
  }();
  return *configured;
}

ScreenPriorityPlatformAdapter& windowsScreenPriorityPlatform() noexcept {
  static WindowsScreenPriorityPlatform platform;
  return platform;
}

ScreenCapturePriorityScope::ScreenCapturePriorityScope()
    : ScreenCapturePriorityScope(
          configuredScreenMediaPriorityPolicy(),
          windowsScreenPriorityPlatform()) {}

ScreenCapturePriorityScope::ScreenCapturePriorityScope(
    const ScreenMediaPriorityPolicy& policy,
    ScreenPriorityPlatformAdapter& platform)
    : platform_(&platform) {
  outcome_.policy = policy.name;
  old_thread_priority_ = platform_->getThreadPriority(thread_);
  old_thread_priority_valid_ =
      old_thread_priority_ != THREAD_PRIORITY_ERROR_RETURN;

  outcome_.thread.requested = policy.capture_thread_priority;
  const auto thread_set =
      platform_->setThreadPriority(thread_, policy.capture_thread_priority);
  const auto thread_error = thread_set ? ERROR_SUCCESS : platform_->lastError();
  outcome_.thread.applied = platform_->getThreadPriority(thread_);
  outcome_.thread.succeeded =
      thread_set &&
      outcome_.thread.applied == outcome_.thread.requested;
  outcome_.thread.win32_error = outcome_.thread.succeeded
      ? ERROR_SUCCESS
      : thread_error != ERROR_SUCCESS ? thread_error : ERROR_INVALID_DATA;

  outcome_.mmcss.requested = policy.capture_mmcss;
  if (policy.capture_mmcss) {
    mmcss_handle_ =
        platform_->registerMmcss(L"Capture", &mmcss_task_index_);
    outcome_.mmcss.registered = mmcss_handle_ != nullptr;
    outcome_.mmcss.win32_error = outcome_.mmcss.registered
        ? ERROR_SUCCESS
        : platform_->lastError();
  }

  logCapturePriority(outcome_);
}

ScreenCapturePriorityScope::~ScreenCapturePriorityScope() {
  if (mmcss_handle_) {
    static_cast<void>(platform_->unregisterMmcss(mmcss_handle_));
  }
  if (old_thread_priority_valid_) {
    static_cast<void>(
        platform_->setThreadPriority(thread_, old_thread_priority_));
  }
}

ScreenD3dPriorityOutcome setD3dGpuThreadPriority(
    IDXGIDevice* device,
    int priority,
    ScreenD3dPriorityRole role,
    ScreenPriorityPlatformAdapter& platform) {
  ScreenD3dPriorityOutcome outcome;
  outcome.role = role;
  outcome.requested = priority;
  if (priority < -7 || priority > 7) {
    outcome.hresult = E_INVALIDARG;
    logD3dPriority(outcome);
    return outcome;
  }
  const auto set_result = platform.setGpuPriority(device, priority);
  if (FAILED(set_result)) {
    outcome.hresult = set_result;
    logD3dPriority(outcome);
    return outcome;
  }
  int applied = 0;
  const auto get_result = platform.getGpuPriority(device, &applied);
  outcome.applied = applied;
  outcome.hresult = FAILED(get_result)
      ? get_result
      : applied == priority ? S_OK : E_UNEXPECTED;
  logD3dPriority(outcome);
  return outcome;
}

}  // namespace syrnike::voice
