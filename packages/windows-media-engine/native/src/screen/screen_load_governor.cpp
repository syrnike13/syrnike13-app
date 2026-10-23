#include "screen/screen_load_governor.hpp"

#include <algorithm>

namespace syrnike::windows_media::screen {

ScreenLoadLevel ScreenLoadGovernor::observe(std::uint64_t now, bool measured,
                                            bool local_pressure,
                                            bool frame_rate_reducible) noexcept {
  if (!measured || now < level_since_ms_ || (last_measured_ms_ && now < *last_measured_ms_))
    return level_;
  const auto step = last_measured_ms_ ? (std::min)(now - *last_measured_ms_, kLoadMaximumQuietStepMs)
                                      : 0;
  last_measured_ms_ = now;
  if (local_pressure) {
    quiet_ms_ = 0;
    pressure_samples_ = (std::min)(pressure_samples_ + 1, kLoadBoostPressureSamples);
    if (level_ == ScreenLoadLevel::normal && pressure_samples_ >= kLoadBoostPressureSamples) {
      level_ = ScreenLoadLevel::boosted;
      level_since_ms_ = now;
    } else if (level_ == ScreenLoadLevel::boosted && frame_rate_reducible &&
               now - level_since_ms_ >= kLoadReduceAfterBoostMs) {
      if (restored_at_ms_ && now - *restored_at_ms_ < kLoadPrematureRestoreMs)
        restore_hold_ms_ = (std::min)(restore_hold_ms_ * 2, kLoadMaximumRestoreFrameRateMs);
      restored_at_ms_.reset();
      level_ = ScreenLoadLevel::reduced_frame_rate;
      level_since_ms_ = now;
    }
    return level_;
  }
  pressure_samples_ = 0;
  quiet_ms_ += step;
  if (level_ == ScreenLoadLevel::reduced_frame_rate && quiet_ms_ >= restore_hold_ms_) {
    level_ = ScreenLoadLevel::boosted;
    level_since_ms_ = now;
    restored_at_ms_ = now;
    quiet_ms_ = 0;
  } else if (level_ == ScreenLoadLevel::boosted && quiet_ms_ >= kLoadRelaxBoostMs) {
    // Load is gone entirely: an old premature restore no longer predicts it.
    level_ = ScreenLoadLevel::normal;
    level_since_ms_ = now;
    quiet_ms_ = 0;
    restore_hold_ms_ = kLoadRestoreFrameRateMs;
  }
  return level_;
}

}  // namespace syrnike::windows_media::screen
