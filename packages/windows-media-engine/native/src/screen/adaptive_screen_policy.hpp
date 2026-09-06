#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>

namespace syrnike::windows_media::screen {

// Exact user presets; automatic control only changes bitrate within the range.
struct AdaptiveScreenProfile {
  const char* name;
  std::uint32_t width, height, fps, target_bitrate, max_bitrate;
  std::uint32_t frame_age_budget_ms;
  std::uint32_t min_bitrate;
};
inline constexpr std::array<AdaptiveScreenProfile, 5> kAdaptiveScreenProfiles{{
    {"540p30", 960, 540, 30, 625'000, 625'000, 150, 250'000},
    {"720p30", 1280, 720, 30, 2'000'000, 2'000'000, 150, 500'000},
    {"720p60", 1280, 720, 60, 4'000'000, 4'000'000, 150, 750'000},
    {"1080p30", 1920, 1080, 30, 6'000'000, 6'000'000, 150, 1'000'000},
    {"1080p60", 1920, 1080, 60, 8'000'000, 8'000'000, 150, 1'500'000},
}};
inline constexpr std::size_t kAdaptiveMaxChangesPerMinute = 6;

enum class AdaptiveReason {
  healthy, insufficient_measurements, network, encoder, gpu, frame_age,
  backpressure, capability, cooldown, change_limit, minimum_bitrate,
};
enum class AdaptiveAction {
  keep, update_bitrate,
};
struct AdaptiveMeasurements {
  std::uint64_t now_ms = 0;
  std::uint64_t interval_ms = 500;
  std::size_t selected_preset = 0;
  std::uint32_t applied_bitrate = 0;
  bool live_update_available = true;
  std::optional<std::uint64_t> available_outgoing_bitrate;
  bool network_measurement_fresh = false;
  bool network_poor = false;
  std::uint64_t encoder_inputs = 0, encoder_outputs = 0;
  std::uint32_t capture_age_ms = 0, convert_age_ms = 0, publish_age_ms = 0;
  std::uint32_t backpressure_permille = 0;
  std::uint32_t publication_gpu_pressure_permille = 0;
  bool update_pending = false;
  bool local_measurements_fresh = false;
};
struct AdaptivePolicyState {
  std::optional<std::uint64_t> last_sample_ms;
  std::optional<std::uint64_t> healthy_since_ms;
  AdaptiveReason previous_pressure = AdaptiveReason::healthy;
  std::uint32_t pressure_samples = 0;
  std::array<std::uint64_t, kAdaptiveMaxChangesPerMinute> changes_ms{};
  std::size_t change_count = 0;
  bool warning = false;
};
struct AdaptiveDecision {
  AdaptiveAction action = AdaptiveAction::keep;
  AdaptiveReason reason = AdaptiveReason::healthy;
  std::uint32_t target_bitrate = 0;
  bool emergency = false;
  AdaptivePolicyState next;
};

// No clocks, mutable resource reads, allocation, sorting or side effects.
[[nodiscard]] AdaptiveDecision evaluateAdaptiveScreenPolicy(
    const AdaptiveMeasurements&, const AdaptivePolicyState&) noexcept;
// Record real attempts, including rejected commands, without assuming success.
[[nodiscard]] AdaptivePolicyState recordAdaptiveBitrateAttempt(
    const AdaptivePolicyState&, std::uint64_t now_ms) noexcept;

}  // namespace syrnike::windows_media::screen
