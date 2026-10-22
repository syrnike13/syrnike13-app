#pragma once

#include <cstdint>
#include <optional>

namespace syrnike::windows_media::screen {

// How hard the share competes with the rest of the machine (usually a game).
// Escalation never changes the resolution: frame rate is the only quality the
// governor trades, and only while local load persists.
enum class ScreenLoadLevel : std::uint8_t {
  normal,              // No scheduling changes.
  boosted,             // GPU priority and MMCSS for the share worker.
  reduced_frame_rate,  // Boosted, and half of a 60 fps preset's frames.
};

inline constexpr std::uint32_t kLoadBoostPressureSamples = 3;
inline constexpr std::uint64_t kLoadReduceAfterBoostMs = 3'000;
inline constexpr std::uint64_t kLoadRelaxBoostMs = 30'000;
inline constexpr std::uint64_t kLoadRestoreFrameRateMs = 30'000;
inline constexpr std::uint64_t kLoadMaximumRestoreFrameRateMs = 120'000;
// Load returning this soon after the full frame rate came back means the
// restore was premature: the next one waits twice as long.
inline constexpr std::uint64_t kLoadPrematureRestoreMs = 10'000;
inline constexpr std::uint64_t kLoadMaximumQuietStepMs = 1'000;

// Pure: no clocks or side effects. One observation per adaptive policy sample.
class ScreenLoadGovernor final {
 public:
  // `measured` is false when the sample could not judge local load; such a
  // sample neither escalates nor counts as quiet time.
  ScreenLoadLevel observe(std::uint64_t now_ms, bool measured, bool local_pressure,
                          bool frame_rate_reducible) noexcept;
  [[nodiscard]] ScreenLoadLevel level() const noexcept { return level_; }
  [[nodiscard]] std::uint64_t restoreHoldMs() const noexcept { return restore_hold_ms_; }

 private:
  ScreenLoadLevel level_ = ScreenLoadLevel::normal;
  std::uint32_t pressure_samples_ = 0;
  std::uint64_t level_since_ms_ = 0;
  // Quiet time is accumulated from measured samples only, each counting for
  // at most one policy interval, so a gap without measurements is not quiet.
  std::uint64_t quiet_ms_ = 0;
  std::optional<std::uint64_t> last_measured_ms_;
  std::optional<std::uint64_t> restored_at_ms_;
  std::uint64_t restore_hold_ms_ = kLoadRestoreFrameRateMs;
};

}  // namespace syrnike::windows_media::screen
