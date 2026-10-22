#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace syrnike::windows_media::screen {

// Timestamps of the most recent events, for "at most N per window" limits.
// A plain value: copyable policy state, no clocks or allocation.
template <std::size_t Capacity>
class RollingEventWindow final {
 public:
  // Forgets events at least `window_ms` old, and any from the future.
  void expire(std::uint64_t now_ms, std::uint64_t window_ms) noexcept {
    std::size_t kept = 0;
    for (std::size_t i = 0; i < count_; ++i)
      if (events_ms_[i] <= now_ms && now_ms - events_ms_[i] < window_ms)
        events_ms_[kept++] = events_ms_[i];
    count_ = kept;
  }
  // Records an event, forgetting the oldest one when already full.
  void record(std::uint64_t now_ms) noexcept {
    if (count_ == Capacity) {
      for (std::size_t i = 1; i < count_; ++i) events_ms_[i - 1] = events_ms_[i];
      --count_;
    }
    events_ms_[count_++] = now_ms;
  }
  [[nodiscard]] std::size_t size() const noexcept { return count_; }
  [[nodiscard]] std::uint64_t latest() const noexcept { return count_ ? events_ms_[count_ - 1] : 0; }

 private:
  std::array<std::uint64_t, Capacity> events_ms_{};
  std::size_t count_ = 0;
};

}  // namespace syrnike::windows_media::screen
