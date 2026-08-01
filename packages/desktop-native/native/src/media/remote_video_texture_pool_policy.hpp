#pragma once

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
  if (result == RemoteVideoGpuPollClass::Pending) return {current};
  if (result == RemoteVideoGpuPollClass::TimedOut) {
    return {
      RemoteVideoTextureSlotPhase::Quarantined,
      current == RemoteVideoTextureSlotPhase::Uploading,
    };
  }
  if (result == RemoteVideoGpuPollClass::Failed) {
    return {
      RemoteVideoTextureSlotPhase::Available,
      false,
      false,
      true,
    };
  }
  if (current == RemoteVideoTextureSlotPhase::Quarantined) {
    // The completed frame is stale, but its resources are reusable again.
    return {RemoteVideoTextureSlotPhase::Available, false, true};
  }
  return {RemoteVideoTextureSlotPhase::Ready};
}

}  // namespace syrnike::desktop_native::media
