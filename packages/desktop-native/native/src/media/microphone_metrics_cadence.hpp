#pragma once

#include <chrono>

namespace syrnike::desktop_native::media {

class MicrophoneMetricsCadence {
 public:
  using Clock = std::chrono::steady_clock;

  explicit MicrophoneMetricsCadence(Clock::time_point started_at)
    : next_emit_at_(started_at + interval) {}

  bool shouldEmit(Clock::time_point now) {
    if (now < next_emit_at_) return false;
    const auto missed_intervals = (now - next_emit_at_) / interval;
    next_emit_at_ += interval * (missed_intervals + 1);
    return true;
  }

 private:
  static constexpr auto interval = std::chrono::milliseconds(50);
  Clock::time_point next_emit_at_;
};

}  // namespace syrnike::desktop_native::media
