#include "capture/backend_selection_policy.hpp"

namespace syrnike::windows_media::capture {
namespace {
bool failure(BackendObservation observation) {
  return observation == BackendObservation::prepare_failed ||
         observation == BackendObservation::unsupported ||
         observation == BackendObservation::access_lost ||
         observation == BackendObservation::device_removed ||
         observation == BackendObservation::source_unavailable ||
         observation == BackendObservation::first_frame_timeout;
}
bool available(const BackendSelectionState& state, CaptureBackendKind kind) {
  if (state.source == CaptureSourceKind::window && kind == CaptureBackendKind::dxgi) return false;
  return kind == CaptureBackendKind::wgc ? state.wgc_available : state.dxgi_available;
}
CaptureBackendKind other(CaptureBackendKind kind) {
  return kind == CaptureBackendKind::wgc ? CaptureBackendKind::dxgi : CaptureBackendKind::wgc;
}
BackendSelectionResult beginCandidate(BackendSelectionState state, std::int64_t now) {
  if (state.paused || state.terminal || state.retirement_pending || state.candidate ||
      !state.pending)
    return {state};
  if (state.consecutive_failures >= kBackendConsecutiveFailures) {
    state.terminal = true;
    state.pending = false;
    return {state, BackendSelectionAction::terminal};
  }
  while (state.attempt_count && now - state.attempts[0] >= 60'000) {
    for (std::size_t i = 1; i < state.attempt_count; ++i) state.attempts[i - 1] = state.attempts[i];
    --state.attempt_count;
  }
  if (state.attempt_count == state.attempts.size() ||
      (state.attempt_count &&
       now - state.attempts[state.attempt_count - 1] < kBackendAttemptIntervalMs))
    return {state};
  const auto preferred = state.last_failure && state.last_attempt ? other(*state.last_attempt)
                         : state.active                           ? state.active->kind
                                                                  : CaptureBackendKind::wgc;
  auto selected = state.forced.value_or(preferred);
  if (!available(state, selected) && !state.forced) selected = other(selected);
  if (!available(state, selected)) {
    state.pending = false;
    state.last_failure = BackendObservation::unsupported;
    if (state.active_healthy) return {state};
    state.terminal = true;
    return {state, BackendSelectionAction::terminal};
  }
  state.candidate = BackendGeneration{selected, state.next_generation++};
  state.last_attempt = selected;
  state.candidate_started_ms = now;
  state.attempts[state.attempt_count++] = now;
  state.pending = false;
  return {state, BackendSelectionAction::start_candidate};
}
}  // namespace
BackendSelectionResult selectCaptureBackend(BackendSelectionState state,
                                            const BackendSelectionInput& input) {
  if (input.now_ms < 0 || input.now_ms < state.last_input_ms) return {state};
  state.last_input_ms = input.now_ms;
  const auto observation = input.observation;
  if (observation == BackendObservation::retirement_started) {
    state.retirement_pending = true;
    return {state};
  }
  if (observation == BackendObservation::retirement_drained) {
    state.retirement_pending = false;
    return {state};
  }
  if (observation == BackendObservation::secure_desktop) {
    if (input.origin.generation && state.active != input.origin && state.candidate != input.origin)
      return {state};
    if (state.candidate == input.origin && state.active_healthy) {
      state.candidate.reset();
      state.pending = false;
      ++state.consecutive_failures;
      state.last_failure = observation;
      return {state, BackendSelectionAction::discard_candidate};
    }
    if (state.paused) return {state};
    state.paused = true;
    state.active_healthy = false;
    state.candidate.reset();
    state.pending = false;
    return {state, BackendSelectionAction::pause};
  }
  if (observation == BackendObservation::desktop_available) {
    if (!state.paused) return {state};
    state.paused = false;
    state.terminal = false;
    state.pending = true;
    state.consecutive_failures = 0;
    return beginCandidate(state, input.now_ms);
  }
  if (observation == BackendObservation::force_backend) {
    // An explicit new desired backend is a new attempt episode, but cannot
    // bypass the process-wide rolling attempt budget.
    state.forced = input.forced;
    state.terminal = false;
    state.consecutive_failures = 0;
    if (state.paused) return {state};
    if (state.candidate) {
      if (state.forced && *state.forced == state.candidate->kind) return {state};
      state.candidate.reset();
      state.pending =
          !state.active_healthy || (state.forced && *state.forced != state.active->kind);
      return {state, BackendSelectionAction::discard_candidate};
    }
    if (state.active_healthy && (!state.forced || *state.forced == state.active->kind)) {
      state.pending = false;
      return {state};
    }
    state.pending = true;
    return beginCandidate(state, input.now_ms);
  }
  if (state.paused) return {state};
  if (observation == BackendObservation::source_unavailable && !input.origin.generation) {
    const bool already_terminal = state.terminal;
    state.active_healthy = false;
    state.terminal = true;
    state.pending = false;
    state.candidate.reset();
    state.last_failure = observation;
    return {state,
            already_terminal ? BackendSelectionAction::keep : BackendSelectionAction::terminal};
  }
  if (observation == BackendObservation::display_changed) {
    state.terminal = false;
    state.consecutive_failures = 0;
    state.wgc_available = state.dxgi_available = true;
    // Keep a healthy generation until the API reports an actual failure. A
    // display notification is not proof that the active capture is broken.
    if (state.active_healthy || state.candidate) return {state};
    state.pending = true;
    return beginCandidate(state, input.now_ms);
  }
  if (state.terminal) return {state};
  if (observation == BackendObservation::start && !state.active && !state.candidate)
    state.pending = true;
  const bool from_candidate = state.candidate && *state.candidate == input.origin;
  const bool from_active = state.active && *state.active == input.origin;
  // Preserve an active failure even when a candidate expires on the same
  // observation. Otherwise the discarded candidate can hide a dead active.
  if (from_active && failure(observation)) {
    state.active_healthy = false;
    state.last_failure = observation;
    state.pending = true;
    if (observation == BackendObservation::source_unavailable ||
        observation == BackendObservation::device_removed) {
      state.terminal = true;
      state.pending = false;
      return {state, BackendSelectionAction::terminal};
    }
  }
  const bool candidate_expired =
      state.candidate && input.now_ms - state.candidate_started_ms >= kBackendCandidateDeadlineMs;
  if (candidate_expired || (from_candidate && failure(observation))) {
    state.last_failure = candidate_expired ? BackendObservation::first_frame_timeout : observation;
    if (!candidate_expired && observation == BackendObservation::unsupported) {
      if (input.origin.kind == CaptureBackendKind::wgc)
        state.wgc_available = false;
      else
        state.dxgi_available = false;
    }
    ++state.consecutive_failures;
    state.candidate.reset();
    state.pending = !state.active_healthy;
    return {state, BackendSelectionAction::discard_candidate};
  }
  if (from_candidate && observation == BackendObservation::healthy_frame) {
    state.retirement_pending = state.active.has_value();
    if (state.active) ++state.committed_switches;
    state.active = state.candidate;
    state.candidate.reset();
    state.active_healthy = true;
    state.consecutive_failures = 0;
    state.last_failure.reset();
    state.pending = false;
    return {state, BackendSelectionAction::commit_candidate};
  }
  // No-content and stale-generation observations never manufacture a failure.
  return beginCandidate(state, input.now_ms);
}
const char* toString(CaptureBackendKind kind) noexcept {
  return kind == CaptureBackendKind::wgc ? "wgc" : "dxgi";
}
const char* toString(BackendObservation value) noexcept {
  switch (value) {
    case BackendObservation::start:
      return "start";
    case BackendObservation::tick:
      return "tick";
    case BackendObservation::no_content:
      return "no_content";
    case BackendObservation::healthy_frame:
      return "healthy_frame";
    case BackendObservation::prepare_failed:
      return "prepare_failed";
    case BackendObservation::unsupported:
      return "unsupported";
    case BackendObservation::access_lost:
      return "access_lost";
    case BackendObservation::device_removed:
      return "device_removed";
    case BackendObservation::source_unavailable:
      return "source_unavailable";
    case BackendObservation::first_frame_timeout:
      return "first_frame_timeout";
    case BackendObservation::secure_desktop:
      return "secure_desktop";
    case BackendObservation::desktop_available:
      return "desktop_available";
    case BackendObservation::display_changed:
      return "display_changed";
    case BackendObservation::force_backend:
      return "force_backend";
    case BackendObservation::retirement_started:
      return "retirement_started";
    case BackendObservation::retirement_drained:
      return "retirement_drained";
  }
  return "unknown";
}
const char* toString(BackendSelectionAction action) noexcept {
  switch (action) {
    case BackendSelectionAction::keep:
      return "keep";
    case BackendSelectionAction::start_candidate:
      return "start_candidate";
    case BackendSelectionAction::commit_candidate:
      return "commit_candidate";
    case BackendSelectionAction::discard_candidate:
      return "discard_candidate";
    case BackendSelectionAction::pause:
      return "pause";
    case BackendSelectionAction::terminal:
      return "terminal";
  }
  return "terminal";
}
}  // namespace syrnike::windows_media::capture
