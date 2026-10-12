#pragma once
#include <cstdint>

namespace syrnike::windows_media::screen {
// Keep a phase deadline instead of spacing each accepted capture by a full
// interval. A 144 Hz source feeding 60 Hz otherwise drops to 48 Hz; small
// timestamp jitter at 60 Hz can halve the output cadence.
class ScreenFrameCadence final {
 public:
  bool due(std::int64_t timestamp_us, std::int64_t interval_us) const noexcept {
    return next_us_ == 0 || timestamp_us + interval_us / 8 >= next_us_;
  }
  void accepted(std::int64_t timestamp_us, std::int64_t interval_us) noexcept {
    next_us_ = next_us_ == 0 || timestamp_us - next_us_ >= interval_us ? timestamp_us + interval_us
                                                                       : next_us_ + interval_us;
  }
  void reset() noexcept { next_us_ = 0; }

 private:
  std::int64_t next_us_ = 0;
};
}  // namespace syrnike::windows_media::screen
