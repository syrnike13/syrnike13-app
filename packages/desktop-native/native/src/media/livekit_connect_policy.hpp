#pragma once

#include <algorithm>
#include <chrono>

#include <livekit/room.h>

namespace syrnike::desktop_native::media {

class LiveKitConnectPolicy {
 public:
  using Clock = std::chrono::steady_clock;

  static constexpr auto kOuterRequestDeadline = std::chrono::seconds(20);
  static constexpr auto kTrackPublicationBudget = std::chrono::seconds(10);
  static constexpr auto kCleanupBudget = std::chrono::seconds(2);
  static constexpr auto kPostConnectSettleBudget = std::chrono::seconds(1);
  static constexpr auto kConnectBudget =
    kOuterRequestDeadline - kTrackPublicationBudget - kCleanupBudget -
    kPostConnectSettleBudget;

  static livekit::RoomOptions roomOptions(
    std::chrono::milliseconds connect_timeout
  ) {
    livekit::RoomOptions options;
    options.auto_subscribe = false;
    options.single_peer_connection = false;
    options.join_retries = 0;
    options.connect_timeout = connect_timeout;
    return options;
  }

  static std::chrono::milliseconds remainingConnectTimeout(
    Clock::time_point started_at,
    Clock::time_point now
  ) {
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - started_at);
    const auto connect_budget = std::chrono::duration_cast<std::chrono::milliseconds>(
      kConnectBudget
    );
    if (elapsed >= connect_budget) return std::chrono::milliseconds(0);
    return connect_budget - elapsed;
  }

  static std::chrono::milliseconds remainingPostConnectWait(
    Clock::time_point started_at,
    Clock::time_point now
  ) {
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - started_at);
    const auto max_elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      kOuterRequestDeadline - kTrackPublicationBudget - kCleanupBudget
    );
    if (elapsed >= max_elapsed) return std::chrono::milliseconds(0);
    const auto remaining_before_cleanup = max_elapsed - elapsed;
    return std::min(
      std::chrono::duration_cast<std::chrono::milliseconds>(kPostConnectSettleBudget),
      remaining_before_cleanup
    );
  }
};

}  // namespace syrnike::desktop_native::media
