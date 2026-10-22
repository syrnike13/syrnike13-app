#include "screen/adaptive_screen_policy.hpp"
#include <algorithm>
#include <cmath>

namespace syrnike::windows_media::screen {
namespace {
std::uint32_t roundedBitrate(std::uint64_t value, std::uint64_t minimum,
                             std::uint64_t maximum) noexcept {
  return static_cast<std::uint32_t>(std::clamp(value / 25'000 * 25'000, minimum, maximum));
}
std::uint32_t presetBitrate(std::uint64_t value, const AdaptiveScreenProfile& preset) noexcept {
  return roundedBitrate(value, preset.min_bitrate, preset.max_bitrate);
}
// Below the floor the command may drop to an eighth of it.
std::uint32_t commandBitrate(std::uint64_t value, const AdaptiveScreenProfile& preset) noexcept {
  return roundedBitrate(value, preset.min_bitrate / 8 / 25'000 * 25'000, preset.max_bitrate);
}
// What the network allows this stream now. Unknown when stale or missing.
std::optional<std::uint64_t> networkBudget(const AdaptiveMeasurements& m,
                                           const AdaptiveScreenProfile& preset) noexcept {
  if (!m.network_measurement_fresh) return std::nullopt;
  // WebRTC never estimates beyond the declared maxima, so a budget near the
  // video maximum (the rest went to audio) is capped, not constrained: the
  // full preset needs no overshoot margin.
  if (m.sender_bitrate_allocation)
    return *m.sender_bitrate_allocation * 1000 >=
               static_cast<std::uint64_t>(preset.max_bitrate) * kAdaptiveFullBudgetPermille
        ? (std::max)(*m.sender_bitrate_allocation, static_cast<std::uint64_t>(preset.max_bitrate))
        : *m.sender_bitrate_allocation * kAdaptiveAllocationPermille / 1000;
  if (m.available_outgoing_bitrate)
    return *m.available_outgoing_bitrate * kAdaptiveLinkPermille / 1000;
  return std::nullopt;
}
}  // namespace

std::uint32_t adaptiveMinimumFrameRate(const AdaptiveScreenProfile& preset) noexcept {
  return (std::min)(30U, preset.fps);
}

std::uint32_t adaptiveStartBitrate(const AdaptiveScreenProfile& preset) noexcept {
  return presetBitrate(static_cast<std::uint64_t>(preset.max_bitrate) *
                           kAdaptiveStartPermille / 1000, preset);
}

AdaptivePolicyState recordAdaptiveBitrateAttempt(
    const AdaptivePolicyState& previous, std::uint64_t now) noexcept {
  auto next = previous;
  next.last_change_ms = now;
  return next;
}

AdaptiveDecision evaluateAdaptiveScreenPolicy(
    const AdaptiveMeasurements& m, const AdaptivePolicyState& previous) noexcept {
  AdaptiveDecision d;
  d.next = previous;
  d.target_bitrate = m.applied_bitrate;
  if (m.selected_preset >= kAdaptiveScreenProfiles.size()) {
    d.reason = AdaptiveReason::capability;
    d.next.warning = true;
    d.next.healthy_since_ms.reset();
    return d;
  }
  const auto& preset = kAdaptiveScreenProfiles[m.selected_preset];
  const auto current_fps = m.frame_rate ? m.frame_rate : preset.fps;
  d.frame_rate = current_fps;
  const auto network = networkBudget(m, preset);
  if (network)
    d.network_target = static_cast<std::uint32_t>((std::min)(
        *network, static_cast<std::uint64_t>(preset.max_bitrate)));
  if (!m.live_update_available) {
    d.reason = AdaptiveReason::capability;
    d.next.warning = true;
    d.next.healthy_since_ms.reset();
    // Admission does not depend on encoder control: with the command fixed,
    // admitted frames alone keep the stream inside the budget.
    if (network && m.applied_bitrate)
      d.frame_rate = *network >= m.applied_bitrate ? preset.fps
          : std::clamp(static_cast<std::uint32_t>(std::lround(
                static_cast<double>(preset.fps) * *network / m.applied_bitrate)),
                adaptiveMinimumFrameRate(preset), preset.fps);
    return d;
  }
  // A paused share sends nothing; its (possibly zero) budget says nothing.
  if (m.paused) {
    d.next.healthy_since_ms.reset();
    d.next.pressure_samples = 0;
    d.reason = AdaptiveReason::insufficient_measurements;
    return d;
  }
  if (previous.last_sample_ms && (m.now_ms <= *previous.last_sample_ms ||
      m.now_ms - *previous.last_sample_ms < 500)) {
    d.reason = AdaptiveReason::insufficient_measurements;
    return d;
  }
  d.next.last_sample_ms = m.now_ms;
  if (m.update_pending || m.interval_ms < 250 || m.interval_ms > 1500 ||
      (previous.last_sample_ms && m.now_ms - *previous.last_sample_ms > 1500)) {
    d.next.healthy_since_ms.reset();
    d.next.pressure_samples = 0;
    d.reason = AdaptiveReason::insufficient_measurements;
    return d;
  }

  // Local resources: bounded cuts on sustained evidence, slow verified recovery.
  const auto age = (std::max)({m.capture_age_ms, m.convert_age_ms, m.publish_age_ms});
  // Local (GPU, encoder, frame age) load of this sample, judged even when the
  // network also suffers: a lossy link must not hide a GPU starved by a game
  // from the load governor, which schedules the share and trades frame rate.
  AdaptiveReason local_pressure = AdaptiveReason::healthy;
  if (m.local_measurements_fresh) {
    if (m.publication_gpu_pressure_permille >= 850) local_pressure = AdaptiveReason::gpu;
    else if (m.encoder_inputs >= 4 && m.encoder_outputs * 10 < m.encoder_inputs * 7)
      local_pressure = AdaptiveReason::encoder;
    else if (age > preset.frame_age_budget_ms) local_pressure = AdaptiveReason::frame_age;
  }
  d.local_measured = m.local_measurements_fresh;
  d.local_pressure = local_pressure;
  // Pacer queueing is not local starvation: it follows after the local check.
  AdaptiveReason pressure = local_pressure;
  if (m.local_measurements_fresh && pressure == AdaptiveReason::healthy &&
      m.backpressure_permille >= 250)
    pressure = AdaptiveReason::backpressure;
  if (pressure != AdaptiveReason::healthy) {
    const bool emergency = age >= 300 || m.publication_gpu_pressure_permille >= 980;
    d.next.healthy_since_ms.reset();
    d.next.pressure_samples = pressure == previous.previous_pressure
        ? (std::min)(previous.pressure_samples + 1, 3U) : 1;
    d.next.previous_pressure = pressure;
    if (d.next.pressure_samples >= (emergency ? 2U : 3U)) {
      const auto base = (std::min)(previous.local_ceiling.value_or(m.applied_bitrate),
                                   m.applied_bitrate);
      d.next.local_ceiling = presetBitrate(static_cast<std::uint64_t>(base) * 3 / 4, preset);
      d.next.local_reason = pressure;
      d.next.pressure_samples = 0;  // A further cut needs fresh evidence.
    }
  } else {
    d.next.pressure_samples = 0;
    d.next.previous_pressure = AdaptiveReason::healthy;
    const bool local_healthy = m.local_measurements_fresh && age < 75 &&
        m.publication_gpu_pressure_permille < 600 && m.backpressure_permille < 50 &&
        m.encoder_inputs >= 4 && m.encoder_outputs * 10 >= m.encoder_inputs * 9;
    if (!local_healthy || !previous.local_ceiling) {
      d.next.healthy_since_ms.reset();
    } else if (!previous.healthy_since_ms) {
      d.next.healthy_since_ms = m.now_ms;
    } else if (m.now_ms - *previous.healthy_since_ms >= kAdaptiveLocalRecoveryMs) {
      const auto ceiling = *previous.local_ceiling;
      const auto raised = presetBitrate(ceiling + (std::max)(25'000U, ceiling / 4), preset);
      if (raised >= preset.max_bitrate) d.next.local_ceiling.reset();
      else d.next.local_ceiling = raised;
      d.next.healthy_since_ms = m.now_ms;  // Each step needs its own interval.
    }
  }

  std::uint32_t target = m.applied_bitrate, target_fps = preset.fps;
  bool local_limits = false;
  const bool below_floor = network && *network < preset.min_bitrate;
  if (below_floor) {
    // Below the preset floor the stream must still fit WebRTC's budget, or the
    // pacer queue keeps the estimate from ever recovering. Smooth motion goes
    // last: per-frame quality falls first, to half the floor at the full rate;
    // then the frame rate, holding that quality, down to its minimum; only then
    // per-frame quality again.
    const auto clarity_floor = preset.min_bitrate / 2;
    target_fps = *network >= clarity_floor ? preset.fps
        : std::clamp(static_cast<std::uint32_t>(std::lround(
              static_cast<double>(preset.fps) * *network / clarity_floor)),
              adaptiveMinimumFrameRate(preset), preset.fps);
    // The encoder budgets per configured frame, so the admitted frames need a
    // proportionally larger command to carry the whole stream budget.
    target = commandBitrate(*network * preset.fps / target_fps, preset);
  } else if (network) {
    auto wanted = *network;
    local_limits = d.next.local_ceiling && *d.next.local_ceiling < wanted;
    if (local_limits) wanted = *d.next.local_ceiling;
    target = presetBitrate(wanted, preset);
  } else {
    // An unknown network never raises; a local cap can still lower.
    target_fps = current_fps;
    local_limits = d.next.local_ceiling && *d.next.local_ceiling < target;
    if (local_limits) target = *d.next.local_ceiling;
  }
  // What reaches the network: the command scaled by admitted frames.
  const auto stream = static_cast<std::uint64_t>(target) * target_fps / preset.fps;
  const auto current_stream = static_cast<std::uint64_t>(m.applied_bitrate) * current_fps / preset.fps;
  d.next.warning = d.next.local_ceiling.has_value() || below_floor;
  d.reason = pressure != AdaptiveReason::healthy ? pressure
      : local_limits ? d.next.local_reason
      : !network ? AdaptiveReason::insufficient_measurements
      : *network < current_stream ? AdaptiveReason::network : AdaptiveReason::healthy;

  const bool at_minimum = target_fps == adaptiveMinimumFrameRate(preset) &&
                          target == commandBitrate(0, preset);
  if (target == m.applied_bitrate && target_fps == current_fps) {
    if ((target == preset.min_bitrate && (below_floor || local_limits)) || at_minimum)
      d.reason = AdaptiveReason::minimum_bitrate;
    return d;
  }
  const bool decrease = stream < current_stream;
  // Small corrections are not worth a platform call, except reaching a bound.
  const auto difference = decrease ? current_stream - stream : stream - current_stream;
  if (target_fps == current_fps && difference < current_stream / 20 &&
      target != preset.max_bitrate && target != preset.min_bitrate)
    return d;
  if (previous.last_change_ms && m.now_ms - *previous.last_change_ms <
      (decrease ? kAdaptiveDecreaseIntervalMs : kAdaptiveIncreaseIntervalMs)) {
    d.reason = AdaptiveReason::cooldown;
    return d;
  }
  d.action = AdaptiveAction::update_bitrate;
  d.target_bitrate = target;
  d.frame_rate = target_fps;
  d.reason = !decrease ? AdaptiveReason::healthy
      : local_limits ? d.next.local_reason : AdaptiveReason::network;
  return d;
}
}  // namespace syrnike::windows_media::screen
