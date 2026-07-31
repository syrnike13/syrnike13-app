#pragma once

#include <atomic>
#include <chrono>
#include <limits>

#include "livekit_connect_policy.hpp"

namespace syrnike::desktop_native::media {

// Shared lifetime policy for every blocking native media operation. The actor
// owns the state; workers only observe cancellation and the absolute deadline.
class MediaOperation final {
 public:
  using Clock = std::chrono::steady_clock;

  explicit MediaOperation(
    Clock::time_point started_at = Clock::now(),
    Clock::duration budget = LiveKitConnectPolicy::kNativeOperationDeadline
  ) : started_at_(started_at), deadline_(started_at + budget) {}

  [[nodiscard]] Clock::time_point startedAt() const noexcept { return started_at_; }
  [[nodiscard]] Clock::time_point deadline() const noexcept { return deadline_; }
  [[nodiscard]] bool expired(Clock::time_point now = Clock::now()) const noexcept {
    return now >= deadline_;
  }
  [[nodiscard]] bool cancelled() const noexcept {
    return cancel_requested_at_ticks_.load(std::memory_order_acquire) != kNotCancelled;
  }
  bool requestCancel(Clock::time_point now = Clock::now()) noexcept {
    auto expected = kNotCancelled;
    return cancel_requested_at_ticks_.compare_exchange_strong(
      expected,
      now.time_since_epoch().count(),
      std::memory_order_release,
      std::memory_order_relaxed
    );
  }
  [[nodiscard]] bool cancellationExpired(
    Clock::time_point now = Clock::now()
  ) const noexcept {
    const auto ticks = cancel_requested_at_ticks_.load(std::memory_order_acquire);
    if (ticks == kNotCancelled) return false;
    return now.time_since_epoch().count() - ticks >=
      std::chrono::duration_cast<Clock::duration>(
        LiveKitConnectPolicy::kCleanupBudget
      ).count();
  }

 private:
  Clock::time_point started_at_;
  Clock::time_point deadline_;
  static constexpr auto kNotCancelled =
    std::numeric_limits<Clock::duration::rep>::lowest();
  std::atomic<Clock::duration::rep> cancel_requested_at_ticks_{kNotCancelled};
};

}  // namespace syrnike::desktop_native::media
