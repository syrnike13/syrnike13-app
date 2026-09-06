#pragma once
#include <array>
#include <cstdint>
#include <optional>

namespace syrnike::windows_media::capture {
enum class CaptureBackendKind { wgc, dxgi };
enum class CaptureSourceKind { monitor, window };
enum class BackendObservation {
  start,
  tick,
  no_content,
  healthy_frame,
  prepare_failed,
  unsupported,
  access_lost,
  device_removed,
  source_unavailable,
  first_frame_timeout,
  secure_desktop,
  desktop_available,
  display_changed,
  force_backend,
  retirement_started,
  retirement_drained,
};
enum class BackendSelectionAction {
  keep,
  start_candidate,
  commit_candidate,
  discard_candidate,
  pause,
  terminal
};
inline constexpr std::int64_t kBackendCandidateDeadlineMs = 3000;
inline constexpr std::int64_t kBackendAttemptIntervalMs = 1000;
inline constexpr std::size_t kBackendAttemptsPerMinute = 6;
inline constexpr unsigned kBackendConsecutiveFailures = 3;
struct BackendGeneration {
  CaptureBackendKind kind = CaptureBackendKind::wgc;
  std::uint64_t generation = 0;
  bool operator==(const BackendGeneration&) const = default;
};
struct BackendSelectionState {
  CaptureSourceKind source = CaptureSourceKind::monitor;
  std::optional<CaptureBackendKind> forced;
  std::optional<BackendGeneration> active, candidate;
  std::optional<CaptureBackendKind> last_attempt;
  bool active_healthy = false, paused = false, terminal = false, pending = false;
  bool retirement_pending = false;
  bool wgc_available = true, dxgi_available = true;
  unsigned consecutive_failures = 0;
  std::uint64_t next_generation = 1, committed_switches = 0;
  std::int64_t candidate_started_ms = 0, last_input_ms = -1;
  std::array<std::int64_t, kBackendAttemptsPerMinute> attempts{};
  std::size_t attempt_count = 0;
  std::optional<BackendObservation> last_failure;
};
struct BackendSelectionInput {
  BackendObservation observation = BackendObservation::tick;
  std::int64_t now_ms = 0;
  BackendGeneration origin;
  std::optional<CaptureBackendKind> forced;
};
struct BackendSelectionResult {
  BackendSelectionState state;
  BackendSelectionAction action = BackendSelectionAction::keep;
};
// Pure transition: fixed state, no resources, callbacks, timers, or SDK types.
BackendSelectionResult selectCaptureBackend(BackendSelectionState, const BackendSelectionInput&);
const char* toString(CaptureBackendKind) noexcept;
const char* toString(BackendObservation) noexcept;
const char* toString(BackendSelectionAction) noexcept;
}  // namespace syrnike::windows_media::capture
