#pragma once

#include "gpu_completion_slot_policy.hpp"

namespace syrnike::desktop_native::media {

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
    // The completed frame is stale, but its resources are reusable again.
    return {RemoteVideoTextureSlotPhase::Available, false, true};
  }
  return {RemoteVideoTextureSlotPhase::Ready};
}

}  // namespace syrnike::desktop_native::media
