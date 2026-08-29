#include <windows.h>

#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string_view>

#include "media/screen_capture_priority.hpp"

namespace {
using syrnike::voice::ScreenCapturePriorityScope;
using syrnike::voice::ScreenD3dPriorityRole;
using syrnike::voice::ScreenPriorityPlatformAdapter;
using syrnike::voice::configuredScreenMediaPriorityPolicy;
using syrnike::voice::screenMediaPriorityPolicy;
using syrnike::voice::setD3dGpuThreadPriority;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

class FakePriorityPlatform final : public ScreenPriorityPlatformAdapter {
 public:
  int getThreadPriority(HANDLE) noexcept override { return thread_priority; }

  bool setThreadPriority(HANDLE, int priority) noexcept override {
    ++thread_set_calls;
    if (!thread_set_succeeds) return false;
    thread_priority = priority;
    return true;
  }

  HANDLE registerMmcss(const wchar_t*, DWORD* task_index) noexcept override {
    ++mmcss_register_calls;
    if (!mmcss_succeeds) return nullptr;
    *task_index = 7;
    return reinterpret_cast<HANDLE>(static_cast<std::uintptr_t>(1));
  }

  bool unregisterMmcss(HANDLE) noexcept override {
    mmcss_reverted = true;
    return true;
  }

  HRESULT setGpuPriority(IDXGIDevice*, int priority) noexcept override {
    ++gpu_set_calls;
    if (FAILED(gpu_result)) return gpu_result;
    gpu_priority = priority;
    return S_OK;
  }

  HRESULT getGpuPriority(IDXGIDevice*, int* priority) noexcept override {
    if (FAILED(gpu_result)) return gpu_result;
    *priority = gpu_priority;
    return S_OK;
  }

  DWORD lastError() noexcept override { return error; }

  int thread_priority = THREAD_PRIORITY_BELOW_NORMAL;
  int gpu_priority = 0;
  DWORD error = ERROR_SUCCESS;
  HRESULT gpu_result = S_OK;
  bool thread_set_succeeds = true;
  bool mmcss_succeeds = true;
  bool mmcss_reverted = false;
  int thread_set_calls = 0;
  int mmcss_register_calls = 0;
  int gpu_set_calls = 0;
};

void unsetPolicyEnvironment() {
  SetEnvironmentVariableA("SYRNIKE_MEDIA_PRIORITY_POLICY", nullptr);
}

void fallbackIsNormalWhenEnvironmentIsUnset() {
  unsetPolicyEnvironment();
  const auto& fallback = configuredScreenMediaPriorityPolicy();
  require(fallback.name == "normal",
          "native media priority fallback is not normal");
  require(fallback.capture_thread_priority == THREAD_PRIORITY_NORMAL,
          "normal fallback changed capture thread priority");
  require(!fallback.capture_mmcss,
          "normal fallback unexpectedly enabled MMCSS");
  require(fallback.publication_gpu_priority == 0,
          "normal fallback changed publication GPU priority");
  require(fallback.preview_gpu_priority == 0,
          "normal fallback changed preview GPU priority");
}

void policyTableKeepsCurrentAndLowerCandidatesExplicit() {
  const auto& normal = screenMediaPriorityPolicy("normal");
  require(normal.capture_thread_priority == THREAD_PRIORITY_NORMAL,
          "normal policy changed capture thread priority");
  require(!normal.capture_mmcss, "normal policy unexpectedly enabled MMCSS");
  require(normal.publication_gpu_priority == 0,
          "normal policy changed publication GPU priority");
  require(normal.preview_gpu_priority == 0,
          "normal policy changed preview GPU priority");

  const auto& capture = screenMediaPriorityPolicy("capture");
  require(capture.capture_thread_priority == THREAD_PRIORITY_NORMAL,
          "capture policy raised the Win32 thread priority");
  require(capture.capture_mmcss, "capture policy did not request MMCSS");
  require(capture.publication_gpu_priority == 1,
          "capture policy changed publication GPU priority");
  require(capture.preview_gpu_priority == 0,
          "capture policy raised preview GPU priority");

  const auto& legacy = screenMediaPriorityPolicy("legacy-high");
  require(legacy.capture_thread_priority == THREAD_PRIORITY_HIGHEST,
          "legacy policy no longer represents the current thread priority");
  require(legacy.capture_mmcss, "legacy policy no longer represents MMCSS");
  require(legacy.publication_gpu_priority == 3,
          "legacy policy no longer represents publication GPU priority");
  require(legacy.preview_gpu_priority == 2,
          "legacy policy no longer represents preview GPU priority");
}

void successfulApplicationIsObservableAndRestored() {
  FakePriorityPlatform platform;
  {
    ScreenCapturePriorityScope scope(
        screenMediaPriorityPolicy("capture"), platform);
    const auto& outcome = scope.outcome();
    require(outcome.thread.succeeded,
            "successful thread priority was reported as failed");
    require(outcome.thread.applied == THREAD_PRIORITY_NORMAL,
            "applied thread priority was not observed");
    require(outcome.mmcss.registered,
            "successful MMCSS registration was not observed");
    require(platform.thread_set_calls == 1,
            "thread priority application retried unexpectedly");
    require(platform.mmcss_register_calls == 1,
            "MMCSS registration retried unexpectedly");
  }
  require(platform.thread_priority == THREAD_PRIORITY_BELOW_NORMAL,
          "capture thread priority was not restored");
  require(platform.mmcss_reverted, "MMCSS registration was not reverted");
}

void settingFailuresRemainOneShotCapabilityOutcomes() {
  FakePriorityPlatform platform;
  platform.thread_set_succeeds = false;
  platform.mmcss_succeeds = false;
  platform.error = ERROR_ACCESS_DENIED;
  ScreenCapturePriorityScope scope(
      screenMediaPriorityPolicy("capture"), platform);
  const auto& outcome = scope.outcome();
  require(!outcome.thread.succeeded,
          "failed thread priority was reported as successful");
  require(outcome.thread.win32_error == ERROR_ACCESS_DENIED,
          "thread priority Win32 failure was lost");
  require(!outcome.mmcss.registered,
          "failed MMCSS registration was reported as registered");
  require(outcome.mmcss.win32_error == ERROR_ACCESS_DENIED,
          "MMCSS Win32 failure was lost");
  require(platform.thread_set_calls == 1,
          "failed thread priority was retried");
  require(platform.mmcss_register_calls == 1,
          "failed MMCSS registration was retried");

  platform.gpu_result = DXGI_ERROR_NOT_CURRENTLY_AVAILABLE;
  const auto gpu = setD3dGpuThreadPriority(
      reinterpret_cast<IDXGIDevice*>(static_cast<std::uintptr_t>(1)),
      1,
      ScreenD3dPriorityRole::Publication,
      platform);
  require(gpu.hresult == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE,
          "D3D priority HRESULT was lost");
  require(platform.gpu_set_calls == 1, "D3D priority was retried");
}
}  // namespace

int main() try {
  fallbackIsNormalWhenEnvironmentIsUnset();
  policyTableKeepsCurrentAndLowerCandidatesExplicit();
  successfulApplicationIsObservableAndRestored();
  settingFailuresRemainOneShotCapabilityOutcomes();
  std::cout << "Screen capture priority tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << "Screen capture priority tests failed: " << error.what()
            << '\n';
  return 1;
}
