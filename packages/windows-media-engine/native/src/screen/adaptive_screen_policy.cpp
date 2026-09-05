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
bool withinCeiling(const AdaptiveMeasurements& m, std::size_t profile) noexcept {
  const auto& value = kAdaptiveScreenProfiles[profile];
  const auto& maximum = kAdaptiveScreenProfiles[m.user_maximum];
  return profile <= m.user_maximum && value.width <= maximum.width &&
         value.height <= maximum.height && value.fps <= maximum.fps;
}
bool supported(const AdaptiveMeasurements& m, std::size_t profile) noexcept {
  return withinCeiling(m, profile) &&
         (m.supported_profiles & (1U << profile)) != 0;
}
AdaptiveAction reduction(std::size_t from, std::size_t to) noexcept {
  const auto& a = kAdaptiveScreenProfiles[from];
  const auto& b = kAdaptiveScreenProfiles[to];
  if (b.width < a.width) return AdaptiveAction::reduce_resolution;
  if (b.fps < a.fps) return AdaptiveAction::reduce_fps;
  return AdaptiveAction::reduce_bitrate;
}
}

AdaptivePolicyState recordAdaptiveProfileAttempt(
    const AdaptivePolicyState& previous, std::uint64_t now) noexcept {
  auto next = previous;
  expire(next, now);
  if (next.change_count < next.changes_ms.size())
    next.changes_ms[next.change_count++] = now;
  next.healthy_since_ms.reset();
  next.pressure_samples = 0;
  next.previous_pressure = AdaptiveReason::healthy;
  return next;
}

AdaptiveDecision evaluateAdaptiveScreenPolicy(
    const AdaptiveMeasurements& m, const AdaptivePolicyState& previous) noexcept {
  AdaptiveDecision d;
  d.next = previous;
  d.target_profile = m.current_profile;
  if (m.current_profile >= kAdaptiveScreenProfiles.size() ||
      m.user_maximum >= kAdaptiveScreenProfiles.size()) {
    d.action = AdaptiveAction::terminal_capability_failure;
    d.reason = AdaptiveReason::capability;
    return d;
  }
  // Duplicate/out-of-order/over-frequent samples cannot build hysteresis.
  const bool constrained = !supported(m, m.current_profile);
  if (!constrained && previous.last_sample_ms && (m.now_ms <= *previous.last_sample_ms ||
      m.now_ms - *previous.last_sample_ms < 500)) {
    d.reason = AdaptiveReason::insufficient_measurements;
    return d;
  }
  const bool gap = previous.last_sample_ms &&
      m.now_ms - *previous.last_sample_ms > 1500;
  expire(d.next, m.now_ms);
  d.next.last_sample_ms = m.now_ms;
  if (m.reconfiguration_pending || (!constrained &&
      (gap || m.interval_ms < 250 || m.interval_ms > 1500))) {
    d.next.healthy_since_ms.reset();
    d.next.pressure_samples = 0;
    d.next.previous_pressure = AdaptiveReason::healthy;
    d.reason = AdaptiveReason::insufficient_measurements;
    return d;
  }
  std::optional<std::size_t> ceiling;
  for (std::size_t i = 0; i <= m.user_maximum; ++i)
    if (supported(m, i)) ceiling = i;
  if (!ceiling) {
    d.action = AdaptiveAction::terminal_capability_failure;
    d.reason = AdaptiveReason::capability;
    return d;
  }
  const auto& current = kAdaptiveScreenProfiles[m.current_profile];
  const auto age = (std::max)({m.capture_age_ms, m.convert_age_ms, m.publish_age_ms});
  const bool network_known = m.network_measurement_fresh &&
      m.available_outgoing_bitrate.has_value();
  AdaptiveReason pressure = AdaptiveReason::healthy;
  if (m.network_measurement_fresh && (m.network_poor ||
      (network_known && *m.available_outgoing_bitrate < current.target_bitrate * 9ULL / 10)))
    pressure = AdaptiveReason::network;
  else if (m.publication_gpu_pressure_permille >= 850)
    pressure = AdaptiveReason::gpu;
  else if (m.encoder_inputs >= 4 && m.encoder_outputs * 10 < m.encoder_inputs * 7)
    pressure = AdaptiveReason::encoder;
  else if (age > current.frame_age_budget_ms)
    pressure = AdaptiveReason::frame_age;
  else if (m.backpressure_permille >= 250)
    pressure = AdaptiveReason::backpressure;
  d.emergency = age >= 2 * current.frame_age_budget_ms ||
      (network_known && *m.available_outgoing_bitrate < current.target_bitrate / 2) ||
      m.publication_gpu_pressure_permille >= 980;
  if (pressure != AdaptiveReason::healthy) {
    d.next.healthy_since_ms.reset();
    d.next.pressure_samples = pressure == previous.previous_pressure
        ? (std::min)(previous.pressure_samples + 1, 3U) : 1;
    d.next.previous_pressure = pressure;
  } else {
    d.next.pressure_samples = 0;
    d.next.previous_pressure = AdaptiveReason::healthy;
  }
  const bool downgrade = constrained || (pressure != AdaptiveReason::healthy &&
      d.next.pressure_samples >= (d.emergency ? 2U : 3U));
  if (downgrade) {
    d.reason = constrained ? (!withinCeiling(m, m.current_profile)
        ? AdaptiveReason::user_maximum : AdaptiveReason::capability) : pressure;
    if (constrained) {
      std::optional<std::size_t> lower;
      for (std::size_t i = 0; i < m.current_profile; ++i)
        if (supported(m, i)) lower = i;
      if (!lower) {
        d.action = AdaptiveAction::terminal_capability_failure;
        return d;
      }
      d.target_profile = *lower;
    }
    else for (std::size_t i = 0; i < m.current_profile; ++i) {
      if (!supported(m, i)) continue;
      if (kAdaptiveScreenProfiles[i].fps > current.fps) continue;
      if (pressure == AdaptiveReason::network && network_known &&
          kAdaptiveScreenProfiles[i].target_bitrate > *m.available_outgoing_bitrate * 8 / 10 &&
          d.target_profile != m.current_profile) continue;
      d.target_profile = i;
    }
    if (d.target_profile == m.current_profile) return d;
    // A full rate budget cannot authorize exceeding the user's ceiling or
    // continuing on lost capability. Caller must stop on terminal failure.
    if (d.next.change_count == kAdaptiveMaxChangesPerMinute) {
      d.target_profile = m.current_profile;
      d.reason = AdaptiveReason::change_limit;
      if (constrained) d.action = AdaptiveAction::terminal_capability_failure;
      return d;
    }
    if (!constrained && !d.emergency && d.next.change_count &&
        m.now_ms - d.next.changes_ms[d.next.change_count - 1] < 5000) {
      d.target_profile = m.current_profile;
      d.reason = AdaptiveReason::cooldown;
      return d;
    }
    d.action = reduction(m.current_profile, d.target_profile);
    return d;
  }
  std::optional<std::size_t> upgrade;
  for (std::size_t i = m.current_profile + 1; i <= *ceiling; ++i) {
    if (supported(m, i)) { upgrade = i; break; }
  }
  const bool upgrade_headroom = upgrade && network_known &&
      *m.available_outgoing_bitrate >= kAdaptiveScreenProfiles[*upgrade].max_bitrate * 11ULL / 10;
  const bool healthy = pressure == AdaptiveReason::healthy && upgrade_headroom &&
      !m.network_poor && age < current.frame_age_budget_ms / 2 &&
      m.publication_gpu_pressure_permille < 600 && m.backpressure_permille < 50 &&
      m.encoder_inputs >= 4 && m.encoder_outputs * 10 >= m.encoder_inputs * 9;
  if (!healthy) {
    d.next.healthy_since_ms.reset();
    d.reason = pressure == AdaptiveReason::healthy
        ? AdaptiveReason::insufficient_measurements : pressure;
    return d;
  }
  if (!d.next.healthy_since_ms) d.next.healthy_since_ms = m.now_ms;
  if (m.now_ms - *d.next.healthy_since_ms < 20'000) return d;
  // Keep one attempt available for emergency downgrade.
  if (d.next.change_count >= kAdaptiveMaxChangesPerMinute - 1) {
    d.reason = AdaptiveReason::change_limit;
    return d;
  }
  d.action = AdaptiveAction::increase;
  d.target_profile = *upgrade;
  return d;
}
}  // namespace syrnike::windows_media::screen
