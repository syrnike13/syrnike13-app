/*
 * Copyright 2025 LiveKit
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an “AS IS” BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#pragma once

#include <atomic>
#include <mutex>

#include "livekit/track_publication.h"
#include "livekit/visibility.h"

namespace livekit {

namespace proto {
class OwnedTrackPublication;
}

/// @brief A track published by a remote participant.
class LIVEKIT_API RemoteTrackPublication : public TrackPublication {
public:
  /// Note, this RemoteTrackPublication is constructed internally only;
  /// safe to accept proto::OwnedTrackPublication.
  explicit RemoteTrackPublication(const proto::OwnedTrackPublication& owned);

  /// @brief Returns whether the FFI layer has attached a remote track.
  bool subscribed() const noexcept { return subscribed_.load(std::memory_order_acquire); }

  /// @brief Requests a subscription state change from the FFI layer.
  void setSubscribed(bool subscribed);

private:
  friend class Room;
#ifdef LIVEKIT_TEST_ACCESS
  friend class RoomCallbackTest;
#endif

  bool subscriptionDesired() const noexcept { return subscription_desired_.load(std::memory_order_acquire); }
  void setSubscriptionState(bool subscribed) noexcept { subscribed_.store(subscribed, std::memory_order_release); }

  std::mutex subscription_command_lock_;
  std::atomic_bool subscription_desired_{false};
  std::atomic_bool subscribed_{false};
};

} // namespace livekit
