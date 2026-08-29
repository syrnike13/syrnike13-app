#pragma once

#include <cstddef>

#include "gpu_completion_slot_policy.hpp"

namespace syrnike::desktop_native::media {

enum class RemoteVideoGpuRolloverCause {
  CapacityExhausted,
  DeviceFailure,
};

enum class RemoteVideoGpuDeviceDisposition {
  ReuseCurrent,
  CreateFresh,
};

struct RemoteVideoGpuDeviceRolloverPlan {
  RemoteVideoGpuDeviceDisposition device;
  std::size_t overlapping_devices = 0;
  std::size_t overlapping_generations = 0;
  bool requires_multithread_protection = false;
};

inline constexpr RemoteVideoGpuDeviceRolloverPlan
decideRemoteVideoGpuDeviceRollover(RemoteVideoGpuRolloverCause cause) noexcept {
  if (cause == RemoteVideoGpuRolloverCause::DeviceFailure) {
    return {
        RemoteVideoGpuDeviceDisposition::CreateFresh,
        2,
        2,
        false,
    };
  }
  return {
      RemoteVideoGpuDeviceDisposition::ReuseCurrent,
      1,
      2,
      true,
  };
}

enum class RemoteVideoTextureSlotPhase {
  Available,
  Uploading,
  Quarantined,
  Ready,
  Delivered,
};

enum class RemoteVideoGpuPollClass {
  Pending,
  Completed,
  TimedOut,
  Failed,
};

struct RemoteVideoSlotTransition {
  RemoteVideoTextureSlotPhase next;
  bool newly_quarantined = false;
  bool recovered = false;
  bool device_failed = false;
};

inline RemoteVideoSlotTransition decideRemoteVideoSlotTransition(
    RemoteVideoTextureSlotPhase current,
    RemoteVideoGpuPollClass result) noexcept {
  if (current != RemoteVideoTextureSlotPhase::Uploading &&
      current != RemoteVideoTextureSlotPhase::Quarantined) {
    return {current};
  }
  const auto generic = decideGpuCompletionSlotTransition(
      current == RemoteVideoTextureSlotPhase::Quarantined
          ? GpuCompletionSlotState::Quarantined
          : GpuCompletionSlotState::Pending,
      result == RemoteVideoGpuPollClass::Pending
          ? GpuCompletionPollClass::Pending
          : result == RemoteVideoGpuPollClass::TimedOut
              ? GpuCompletionPollClass::TimedOut
              : result == RemoteVideoGpuPollClass::Failed
                  ? GpuCompletionPollClass::DeviceFailed
                  : GpuCompletionPollClass::Completed);
  if (generic.device_failed) {
    return {
      RemoteVideoTextureSlotPhase::Available,
      false,
      false,
      true,
    };
  }
  if (generic.keep_pending) {
    return {
        generic.next == GpuCompletionSlotState::Quarantined
            ? RemoteVideoTextureSlotPhase::Quarantined
            : RemoteVideoTextureSlotPhase::Uploading,
        generic.newly_quarantined,
    };
  }
  if (generic.recovered_stale) {
    // A late remote frame is still useful when the publisher is static. Keep
    // it eligible for latest-wins selection; take() will discard it if a newer
    // completed frame already exists.
    return {RemoteVideoTextureSlotPhase::Ready, false, true};
  }
  return {RemoteVideoTextureSlotPhase::Ready};
}

}  // namespace syrnike::desktop_native::media
