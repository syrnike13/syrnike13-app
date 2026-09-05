#pragma once
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <livekit/room.h>
#include "core/network_observation.hpp"

namespace syrnike::windows_media {
// One instance per Room transport, surviving all track/profile replacements.
// Sampling runs on the existing SDK lane, without an additional task/thread.
class LiveKitNetworkSampler final {
 public:
  void sampleOnSdkLane(const std::shared_ptr<livekit::Room>& room) noexcept;
  [[nodiscard]] OutgoingNetworkObservation snapshot() const noexcept;
 private:
  mutable std::mutex mutex_;
  OutgoingNetworkObservation observation_;
  // Only the SDK lane touches these members. An unresolved future prevents
  // further requests, even across profile replacements or Room disconnects.
  std::optional<std::future<livekit::SessionStats>> pending_;
  std::weak_ptr<livekit::Room> requested_room_;
  std::uint64_t requested_at_ms_ = 0;
};
}
