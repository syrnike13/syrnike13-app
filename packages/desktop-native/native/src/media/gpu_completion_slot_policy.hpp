#pragma once

#include <d3d11.h>
#include <dxgi.h>

namespace syrnike::desktop_native::media {

enum class GpuCompletionSlotState {
  Pending,
  Quarantined,
};

enum class GpuCompletionPollClass {
  Pending,
  Completed,
  TimedOut,
  DeviceFailed,
};

struct GpuCompletionSlotTransition {
  GpuCompletionSlotState next = GpuCompletionSlotState::Pending;
  bool keep_pending = false;
  bool completed = false;
  bool newly_quarantined = false;
  bool recovered_stale = false;
  bool device_failed = false;
};

inline GpuCompletionPollClass classifyGpuCompletionPoll(
    HRESULT result) noexcept {
  if (result == S_FALSE) return GpuCompletionPollClass::Pending;
  if (result == DXGI_ERROR_WAIT_TIMEOUT) {
    return GpuCompletionPollClass::TimedOut;
  }
  if (FAILED(result)) return GpuCompletionPollClass::DeviceFailed;
  return GpuCompletionPollClass::Completed;
}

// A completion deadline is a freshness boundary, not a device-failure
// boundary. The timed-out query and every resource referenced by its command
// list remain owned by the slot until the query completes or the D3D device
// reports a terminal failure.
inline GpuCompletionSlotTransition decideGpuCompletionSlotTransition(
    GpuCompletionSlotState current,
    GpuCompletionPollClass result) noexcept {
  if (result == GpuCompletionPollClass::Pending) {
    return {current, true};
  }
  if (result == GpuCompletionPollClass::TimedOut) {
    return {
        GpuCompletionSlotState::Quarantined,
        true,
        false,
        current == GpuCompletionSlotState::Pending,
    };
  }
  if (result == GpuCompletionPollClass::DeviceFailed) {
    return {current, false, false, false, false, true};
  }
  return {
      current,
      false,
      true,
      false,
      current == GpuCompletionSlotState::Quarantined,
  };
}

}  // namespace syrnike::desktop_native::media
