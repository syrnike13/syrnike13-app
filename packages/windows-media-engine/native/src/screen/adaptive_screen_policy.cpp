#include "screen/adaptive_screen_policy.hpp"
#include <algorithm>

namespace syrnike::windows_media::screen {
namespace {
void expire(AdaptivePolicyState& state, std::uint64_t now) noexcept {
  std::size_t count = 0;
  for (std::size_t i = 0; i < (std::min)(state.change_count, state.changes_ms.size()); ++i)
    if (state.changes_ms[i] <= now && now - state.changes_ms[i] < 60'000)
      state.changes_ms[count++] = state.changes_ms[i];
  state.change_count = count;
}
}
AdaptivePolicyState recordAdaptiveBitrateAttempt(
    const AdaptivePolicyState& previous, std::uint64_t now) noexcept {
  auto next = previous;
  expire(next, now);
  if (next.change_count < next.changes_ms.size()) next.changes_ms[next.change_count++] = now;
  next.healthy_since_ms.reset();
  next.pressure_samples = 0;
  next.previous_pressure = AdaptiveReason::healthy;
  return next;
}
AdaptiveDecision evaluateAdaptiveScreenPolicy(
    const AdaptiveMeasurements& m, const AdaptivePolicyState& previous) noexcept {
  AdaptiveDecision d;
  d.next = previous;
  d.target_bitrate = m.applied_bitrate;
  if (!m.live_update_available || m.selected_preset >= kAdaptiveScreenProfiles.size()) {
    d.reason = AdaptiveReason::capability;
    d.next.warning = true;
    d.next.healthy_since_ms.reset();
    return d;
  }
  const auto& preset = kAdaptiveScreenProfiles[m.selected_preset];
  if (previous.last_sample_ms && (m.now_ms <= *previous.last_sample_ms ||
      m.now_ms - *previous.last_sample_ms < 500)) {
    d.reason = AdaptiveReason::insufficient_measurements;
    return d;
  }
  expire(d.next, m.now_ms);
  d.next.last_sample_ms = m.now_ms;
  if (m.update_pending || m.interval_ms < 250 || m.interval_ms > 1500 ||
      (previous.last_sample_ms && m.now_ms - *previous.last_sample_ms > 1500)) {
    d.next.healthy_since_ms.reset();
    d.next.pressure_samples = 0;
    d.reason = AdaptiveReason::insufficient_measurements;
    return d;
  }
  const auto age = (std::max)({m.capture_age_ms, m.convert_age_ms, m.publish_age_ms});
  const bool network_known = m.network_measurement_fresh && m.available_outgoing_bitrate.has_value();
  AdaptiveReason pressure = AdaptiveReason::healthy;
  if (m.network_measurement_fresh && (m.network_poor ||
      (network_known && *m.available_outgoing_bitrate < m.applied_bitrate * 9ULL / 10)))
    pressure = AdaptiveReason::network;
  else if (m.local_measurements_fresh) {
    if (m.publication_gpu_pressure_permille >= 850) pressure = AdaptiveReason::gpu;
    else if (m.encoder_inputs >= 4 && m.encoder_outputs * 10 < m.encoder_inputs * 7)
      pressure = AdaptiveReason::encoder;
    else if (age > preset.frame_age_budget_ms) pressure = AdaptiveReason::frame_age;
    else if (m.backpressure_permille >= 250) pressure = AdaptiveReason::backpressure;
  }
  d.emergency = (m.local_measurements_fresh && (age >= 300 ||
      m.publication_gpu_pressure_permille >= 980)) ||
      (network_known && *m.available_outgoing_bitrate < m.applied_bitrate / 2);
  if (pressure != AdaptiveReason::healthy) {
    d.reason = pressure;
    d.next.healthy_since_ms.reset();
    d.next.pressure_samples = pressure == previous.previous_pressure
        ? (std::min)(previous.pressure_samples + 1, 3U) : 1;
    d.next.previous_pressure = pressure;
    if (d.next.pressure_samples < (d.emergency ? 2U : 3U)) return d;
    d.next.warning = true;
    auto target = m.applied_bitrate * 3ULL / 4;
    if (pressure == AdaptiveReason::network && network_known)
      target = (std::min)(target, *m.available_outgoing_bitrate * 8ULL / 10);
    target = std::clamp(target / 25'000 * 25'000,
        static_cast<unsigned long long>(preset.min_bitrate),
        static_cast<unsigned long long>(preset.max_bitrate));
    if (target >= m.applied_bitrate) { d.reason = AdaptiveReason::minimum_bitrate; return d; }
    if (d.next.change_count >= kAdaptiveMaxChangesPerMinute) {
      d.reason = AdaptiveReason::change_limit; return d;
    }
    // Emergency bypasses normal cooldown but never the 1s hard cadence.
    if (d.next.change_count && m.now_ms - d.next.changes_ms[d.next.change_count - 1] <
        (d.emergency ? 1000ULL : 5000ULL)) {
      d.reason = AdaptiveReason::cooldown; return d;
    }
    d.target_bitrate = static_cast<std::uint32_t>(target);
    d.action = AdaptiveAction::update_bitrate;
    return d;
  }
  d.next.pressure_samples = 0;
  d.next.previous_pressure = AdaptiveReason::healthy;
  const auto target = (std::min)(preset.max_bitrate,
      (m.applied_bitrate + (std::max)(25'000U, m.applied_bitrate / 4)) / 25'000 * 25'000);
  const bool healthy = network_known && !m.network_poor && m.local_measurements_fresh &&
      *m.available_outgoing_bitrate >= target * 11ULL / 10 && age < 75 &&
      m.publication_gpu_pressure_permille < 600 && m.backpressure_permille < 50 &&
      m.encoder_inputs >= 4 && m.encoder_outputs * 10 >= m.encoder_inputs * 9;
  if (!healthy) {
    d.next.healthy_since_ms.reset();
    d.reason = AdaptiveReason::insufficient_measurements;
    return d;
  }
  if (!d.next.healthy_since_ms) d.next.healthy_since_ms = m.now_ms;
  if (m.now_ms - *d.next.healthy_since_ms < 20'000) return d;
  d.next.warning = false;
  if (target <= m.applied_bitrate) return d;
  if (d.next.change_count >= kAdaptiveMaxChangesPerMinute - 1) {
    d.reason = AdaptiveReason::change_limit; return d;
  }
  d.action = AdaptiveAction::update_bitrate;
  d.target_bitrate = target;
  return d;
}
}  // namespace syrnike::windows_media::screen
