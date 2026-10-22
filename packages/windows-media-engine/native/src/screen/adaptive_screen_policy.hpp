#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>

namespace syrnike::windows_media::screen {

// Exact user presets; adaptive control only changes bitrate within the range.
// The load governor may additionally halve a preset's frame rate; nothing
// automatic ever changes its resolution.
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
    {"1080p60", 1920, 1080, 60, 8'000'000, 8'000'000, 150, 2'000'000},
}};

enum class AdaptiveReason {
  healthy, insufficient_measurements, network, encoder, gpu, frame_age,
  backpressure, capability, cooldown, minimum_bitrate,
};
enum class AdaptiveAction {
  keep, update_bitrate,
};
struct AdaptiveMeasurements {
  std::uint64_t now_ms = 0;
  std::uint64_t interval_ms = 500;
  std::size_t selected_preset = 0;
  std::uint32_t applied_bitrate = 0;
  // Frames per second capture admission currently passes; 0 means the preset's.
  std::uint32_t frame_rate = 0;
  bool live_update_available = true;
  std::optional<std::uint64_t> available_outgoing_bitrate;
  // WebRTC's budget for this sender, already net of audio and capped at the
  // publication's declared maximum. The encoder follows it like an ordinary
  // WebRTC encoder follows its target rate.
  std::optional<std::uint64_t> sender_bitrate_allocation;
  bool network_measurement_fresh = false;
  std::uint64_t encoder_inputs = 0, encoder_outputs = 0;
  std::uint32_t capture_age_ms = 0, convert_age_ms = 0, publish_age_ms = 0;
  std::uint32_t backpressure_permille = 0;
  std::uint32_t publication_gpu_pressure_permille = 0;
  bool update_pending = false;
  bool local_measurements_fresh = false;
  // The shared window is minimized or hidden and the track is muted.
  bool paused = false;
};
struct AdaptivePolicyState {
  std::optional<std::uint64_t> last_sample_ms;
  // Local (GPU, encoder, frame age, backpressure) pressure and its recovery.
  std::optional<std::uint64_t> healthy_since_ms;
  AdaptiveReason previous_pressure = AdaptiveReason::healthy;
  std::uint32_t pressure_samples = 0;
  // Cap from local pressure; none means only the network and preset bound.
  std::optional<std::uint32_t> local_ceiling;
  AdaptiveReason local_reason = AdaptiveReason::healthy;
  std::optional<std::uint64_t> last_change_ms;
  bool warning = false;
};
struct AdaptiveDecision {
  AdaptiveAction action = AdaptiveAction::keep;
  AdaptiveReason reason = AdaptiveReason::healthy;
  // Encoder command. The hardware encoder budgets per configured (preset)
  // frame, so the stream carries target_bitrate * frame_rate / preset fps.
  std::uint32_t target_bitrate = 0;
  // Capture admission rate to pair with the command. Without live encoder
  // control it may change on its own while action stays keep.
  std::uint32_t frame_rate = 0;
  // Bitrate the network allows now, before local pressure; 0 when unknown.
  std::uint32_t network_target = 0;
  // Local (GPU, encoder, frame age) load of this sample, independent of the
  // network verdict. Unset when the sample had no fresh local measurement.
  bool local_measured = false;
  AdaptiveReason local_pressure = AdaptiveReason::healthy;
  AdaptivePolicyState next;
};

// A WebRTC CBR stream overshoots its target around keyframes and upward steps;
// following 95% of the sender budget keeps that inside the pacer. Before the
// first budget, the uncapped link estimate needs a wider margin.
inline constexpr std::uint32_t kAdaptiveAllocationPermille = 950;
// WebRTC caps its estimate at the declared maxima: video plus audio. A budget
// this close to the video maximum means the link was not the limit.
inline constexpr std::uint32_t kAdaptiveFullBudgetPermille = 970;
inline constexpr std::uint32_t kAdaptiveLinkPermille = 850;
// The SDK starts WebRTC's estimate at 90% of the declared maximum. Starting
// the encoder below it avoids an initial pacer queue and capture drops.
inline constexpr std::uint32_t kAdaptiveStartPermille = 600;
inline constexpr std::uint64_t kAdaptiveDecreaseIntervalMs = 500;
inline constexpr std::uint64_t kAdaptiveIncreaseIntervalMs = 1000;
inline constexpr std::uint64_t kAdaptiveLocalRecoveryMs = 20'000;

[[nodiscard]] std::uint32_t adaptiveStartBitrate(const AdaptiveScreenProfile& preset) noexcept;
// Lowest admitted frame rate under a budget below the preset floor: 30, so a
// 30 fps preset never loses frames; below it only per-frame quality drops.
[[nodiscard]] std::uint32_t adaptiveMinimumFrameRate(const AdaptiveScreenProfile& preset) noexcept;
// No clocks, mutable resource reads, allocation, sorting or side effects.
[[nodiscard]] AdaptiveDecision evaluateAdaptiveScreenPolicy(
    const AdaptiveMeasurements&, const AdaptivePolicyState&) noexcept;
// Record real attempts, including rejected commands, without assuming success.
[[nodiscard]] AdaptivePolicyState recordAdaptiveBitrateAttempt(
    const AdaptivePolicyState&, std::uint64_t now_ms) noexcept;

}  // namespace syrnike::windows_media::screen
