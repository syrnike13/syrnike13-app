#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>

namespace syrnike::windows_media::screen {

// Ordered product ceilings; profiles also obey the project SFU's screen limits.
struct AdaptiveScreenProfile {
  const char* name;
  std::uint32_t width, height, fps, target_bitrate, max_bitrate;
  std::uint32_t frame_age_budget_ms;
};
inline constexpr std::array<AdaptiveScreenProfile, 5> kAdaptiveScreenProfiles{{
    {"540p30", 960, 540, 30, 625'000, 625'000, 150},
    {"720p30", 1280, 720, 30, 2'000'000, 2'000'000, 150},
    {"720p60", 1280, 720, 60, 4'000'000, 4'000'000, 150},
    {"1080p30", 1920, 1080, 30, 6'000'000, 6'000'000, 150},
    {"1080p60", 1920, 1080, 60, 8'000'000, 8'000'000, 150},
}};
inline constexpr std::size_t kAdaptiveMaxChangesPerMinute = 6;

enum class AdaptiveReason {
  healthy, insufficient_measurements, network, encoder, gpu, frame_age,
  backpressure, user_maximum, capability, cooldown, change_limit,
};
enum class AdaptiveAction {
  keep, reduce_fps, reduce_resolution, reduce_bitrate, increase,
  terminal_capability_failure,
};
struct AdaptiveMeasurements {
  std::uint64_t now_ms = 0;
  std::uint64_t interval_ms = 500;
  std::size_t current_profile = 0;
  std::size_t user_maximum = 4;
  // Each bit means hardware H264 + GPU conversion + publication budget were
  // admitted for that exact profile. Preview allocations are excluded.
  std::uint32_t supported_profiles = 0;
  std::optional<std::uint64_t> available_outgoing_bitrate;
  bool network_measurement_fresh = false;
  bool network_poor = false;
  std::uint64_t encoder_inputs = 0, encoder_outputs = 0;
  std::uint32_t capture_age_ms = 0, convert_age_ms = 0, publish_age_ms = 0;
  std::uint32_t backpressure_permille = 0;
  std::uint32_t publication_gpu_pressure_permille = 0;
  bool reconfiguration_pending = false;
};
struct AdaptivePolicyState {
  std::optional<std::uint64_t> last_sample_ms;
  std::optional<std::uint64_t> healthy_since_ms;
  AdaptiveReason previous_pressure = AdaptiveReason::healthy;
  std::uint32_t pressure_samples = 0;
  std::array<std::uint64_t, kAdaptiveMaxChangesPerMinute> changes_ms{};
  std::size_t change_count = 0;
};
struct AdaptiveDecision {
  AdaptiveAction action = AdaptiveAction::keep;
  AdaptiveReason reason = AdaptiveReason::healthy;
  std::size_t target_profile = 0;
  bool emergency = false;
  AdaptivePolicyState next;
};

// No clocks, mutable resource reads, allocation, sorting or side effects.
[[nodiscard]] AdaptiveDecision evaluateAdaptiveScreenPolicy(
    const AdaptiveMeasurements&, const AdaptivePolicyState&) noexcept;
// Called only when the control owner actually begins a profile transition.
// Failed/superseded attempts consume the same bounded reconfiguration budget.
[[nodiscard]] AdaptivePolicyState recordAdaptiveProfileAttempt(
    const AdaptivePolicyState&, std::uint64_t now_ms) noexcept;

}  // namespace syrnike::windows_media::screen
