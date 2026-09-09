#include "capture/backend_selection_policy.hpp"
#include "fault_evidence.hpp"
#include <iostream>
#include <stdexcept>
#include <string>
#include <sstream>

using namespace syrnike::windows_media::capture;
namespace {
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
struct Driver {
  BackendSelectionState state;
  BackendSelectionAction send(BackendObservation event, std::int64_t now,
                              BackendGeneration origin = {},
                              std::optional<CaptureBackendKind> force = {}) {
    auto result = selectCaptureBackend(state, {event, now, origin, force});
    state = result.state;
    return result.action;
  }
  void startWgc() {
    require(send(BackendObservation::start, 0) == BackendSelectionAction::start_candidate,
            "initial prepare missing");
    require(state.candidate->kind == CaptureBackendKind::wgc && !state.active,
            "initial candidate published before proof");
    require(send(BackendObservation::healthy_frame, 1, *state.candidate) ==
                BackendSelectionAction::commit_candidate,
            "healthy WGC did not commit");
  }
};
void staticAndWindowRules() {
  Driver driver;
  driver.state.source = CaptureSourceKind::window;
  driver.startWgc();
  for (std::int64_t now = 100; now <= 60'000; now += 100)
    require(driver.send(BackendObservation::no_content, now) == BackendSelectionAction::keep,
            "static content triggered recovery");
  require(driver.state.committed_switches == 0 && driver.state.attempt_count == 1,
          "static content created an attempt");
  driver.send(BackendObservation::force_backend, 61'000, {}, CaptureBackendKind::dxgi);
  require(!driver.state.candidate && driver.state.active_healthy &&
              driver.state.active->kind == CaptureBackendKind::wgc,
          "window admitted DXGI or destroyed WGC");
  Driver unavailable;
  unavailable.state.source = CaptureSourceKind::window;
  unavailable.state.forced = CaptureBackendKind::dxgi;
  require(unavailable.send(BackendObservation::start, 0) == BackendSelectionAction::terminal,
          "forced window DXGI was advertised as supported");
}
void failedCandidatePreservesActiveAndFencesLateFrame() {
  Driver driver;
  driver.startWgc();
  const auto active = driver.state.active;
  require(driver.send(BackendObservation::force_backend, 1000, {}, CaptureBackendKind::dxgi) ==
              BackendSelectionAction::start_candidate,
          "DXGI candidate missing");
  const auto failed = *driver.state.candidate;
  require(driver.send(BackendObservation::prepare_failed, 1001, failed) ==
              BackendSelectionAction::discard_candidate,
          "failed candidate not discarded");
  require(driver.state.active == active && driver.state.active_healthy && !driver.state.pending,
          "failure destroyed healthy active");
  driver.send(BackendObservation::healthy_frame, 1002, failed);
  require(driver.state.active == active && !driver.state.candidate, "late failed frame committed");
}
void prepareFallbackAndBoundedRetries() {
  Driver driver;
  driver.send(BackendObservation::start, 0);
  auto first = *driver.state.candidate;
  driver.send(BackendObservation::prepare_failed, 1, first);
  require(driver.send(BackendObservation::tick, 500) == BackendSelectionAction::keep,
          "retry ignored backoff");
  driver.send(BackendObservation::tick, 1000);
  require(driver.state.candidate && driver.state.candidate->kind == CaptureBackendKind::dxgi,
          "WGC prepare failure did not propose DXGI");
  auto second = *driver.state.candidate;
  driver.send(BackendObservation::first_frame_timeout, 1001, second);
  driver.send(BackendObservation::tick, 2000);
  auto third = *driver.state.candidate;
  driver.send(BackendObservation::prepare_failed, 2001, third);
  require(driver.send(BackendObservation::tick, 3000) == BackendSelectionAction::terminal,
          "three failed attempts restarted forever");
  for (int index = 0; index < 100; ++index)
    driver.send(BackendObservation::tick, 4000 + index * 1000);
  require(driver.state.attempt_count == 3 && !driver.state.candidate,
          "terminal state retried without new input");
}
void secureDesktopPausesAndResumeIsBounded() {
  Driver driver;
  driver.startWgc();
  require(driver.send(BackendObservation::secure_desktop, 1000) == BackendSelectionAction::pause,
          "secure desktop did not pause");
  for (int i = 0; i < 600; ++i) {
    driver.send(BackendObservation::no_content, 1001 + i * 100);
    require(!driver.state.candidate && driver.state.paused, "secure desktop ping-ponged");
  }
  require(driver.send(BackendObservation::desktop_available, 62'000) ==
              BackendSelectionAction::start_candidate,
          "desktop return did not allow recovery");
  require(driver.state.candidate->kind == CaptureBackendKind::wgc,
          "desktop return arbitrarily changed healthy backend preference");
}
void rollingBudgetAndDeadline() {
  Driver driver;
  driver.startWgc();
  for (int attempt = 1; attempt < 6; ++attempt) {
    const auto kind = attempt % 2 ? CaptureBackendKind::dxgi : CaptureBackendKind::wgc;
    require(driver.send(BackendObservation::force_backend, attempt * 1000, {}, kind) ==
                BackendSelectionAction::start_candidate,
            "budget rejected permitted attempt");
    driver.send(BackendObservation::healthy_frame, attempt * 1000 + 1, *driver.state.candidate);
    driver.send(BackendObservation::retirement_drained, attempt * 1000 + 1);
  }
  require(driver.send(BackendObservation::force_backend, 6000, {}, CaptureBackendKind::wgc) ==
              BackendSelectionAction::keep,
          "six-attempt rolling budget bypassed");
  require(driver.state.attempt_count == 6 && !driver.state.candidate,
          "budget admitted another generation");
  require(driver.send(BackendObservation::tick, 60'000) == BackendSelectionAction::start_candidate,
          "expired history never released budget");
  const auto late = *driver.state.candidate;
  require(driver.send(BackendObservation::healthy_frame, 63'000, late) ==
              BackendSelectionAction::discard_candidate,
          "late first frame committed after deadline");
  require(driver.state.active_healthy, "candidate deadline discarded healthy active");
}
void concurrentFailureAndPermissionFences() {
  Driver driver;
  driver.startWgc();
  const auto active = *driver.state.active;
  driver.send(BackendObservation::force_backend, 1000, {}, CaptureBackendKind::dxgi);
  const auto candidate = *driver.state.candidate;
  require(driver.send(BackendObservation::secure_desktop, 1001, candidate) ==
              BackendSelectionAction::discard_candidate,
          "candidate access denial destroyed healthy active");
  require(driver.state.active_healthy && !driver.state.paused,
          "candidate permission outcome paused active");
  driver.send(BackendObservation::secure_desktop, 1002, candidate);
  require(driver.state.active_healthy && !driver.state.paused,
          "late permission failure crossed generation fence");
  driver.send(BackendObservation::force_backend, 2000, {}, CaptureBackendKind::dxgi);
  require(driver.send(BackendObservation::access_lost, 5000, active) ==
              BackendSelectionAction::discard_candidate,
          "simultaneous candidate deadline was not drained");
  require(!driver.state.active_healthy && driver.state.pending,
          "candidate deadline swallowed active access loss");
}
std::string goldenTrace() {
  struct Row {
    BackendObservation event;
    std::int64_t time;
    BackendGeneration origin;
    std::optional<CaptureBackendKind> forced;
    BackendSelectionAction expected;
  };
  using O = BackendObservation;
  using A = BackendSelectionAction;
  using K = CaptureBackendKind;
  const Row rows[]{
      {O::start, 0, {}, {}, A::start_candidate},
      {O::healthy_frame, 1, {K::wgc, 1}, {}, A::commit_candidate},
      {O::force_backend, 1000, {}, K::dxgi, A::start_candidate},
      {O::prepare_failed, 1001, {K::dxgi, 2}, {}, A::discard_candidate},
      {O::healthy_frame, 1002, {K::dxgi, 2}, {}, A::keep},
      {O::force_backend, 2000, {}, K::dxgi, A::start_candidate},
      {O::healthy_frame, 2001, {K::dxgi, 3}, {}, A::commit_candidate},
      {O::force_backend, 3000, {}, K::wgc, A::keep},
      {O::retirement_drained, 3001, {}, {}, A::keep},
      {O::tick, 3002, {}, {}, A::start_candidate},
      {O::secure_desktop, 3500, {}, {}, A::pause},
      {O::no_content, 63500, {}, {}, A::keep},
      {O::desktop_available, 64000, {}, {}, A::start_candidate},
      {O::healthy_frame, 64001, {K::wgc, 5}, {}, A::commit_candidate},
      {O::retirement_drained, 64002, {}, {}, A::keep},
      {O::access_lost, 65000, {K::wgc, 5}, {}, A::start_candidate},
      {O::first_frame_timeout, 68000, {K::wgc, 6}, {}, A::discard_candidate},
      {O::tick, 69000, {}, {}, A::start_candidate},
      {O::prepare_failed, 69001, {K::wgc, 7}, {}, A::discard_candidate},
      {O::tick, 70000, {}, {}, A::start_candidate},
      {O::prepare_failed, 70001, {K::wgc, 8}, {}, A::discard_candidate},
      {O::tick, 71000, {}, {}, A::terminal},
  };
  Driver driver;
  std::ostringstream output;
  output << "{\"schemaVersion\":1,\"steps\":[";
  bool comma = false;
  for (const auto& row : rows) {
    const auto action = driver.send(row.event, row.time, row.origin, row.forced);
    require(action == row.expected, "recorded backend golden decision changed");
    if (comma) output << ',';
    comma = true;
    output << "{\"event\":\"" << toString(row.event) << "\",\"timeMs\":" << row.time
           << ",\"originBackend\":\"" << toString(row.origin.kind)
           << "\",\"originGeneration\":" << row.origin.generation << ",\"forced\":";
    if (row.forced)
      output << '"' << toString(*row.forced) << '"';
    else
      output << "null";
    output << ",\"action\":\"" << toString(action) << "\",\"activeGeneration\":"
           << (driver.state.active ? driver.state.active->generation : 0)
           << ",\"candidateGeneration\":"
           << (driver.state.candidate ? driver.state.candidate->generation : 0)
           << ",\"attemptCount\":" << driver.state.attempt_count << '}';
  }
  output << "]}";
  return output.str();
}
}  // namespace
int main(int argc, char** argv) {
  try {
    staticAndWindowRules();
    failedCandidatePreservesActiveAndFencesLateFrame();
    prepareFallbackAndBoundedRetries();
    secureDesktopPausesAndResumeIsBounded();
    rollingBudgetAndDeadline();
    concurrentFailureAndPermissionFences();
    const auto trace = goldenTrace();
    require(trace == goldenTrace(), "backend trace replay was nondeterministic");
    if (argc == 2 && std::string_view(argv[1]) == "--golden") {
      std::cout << trace << '\n';
      return 0;
    }
    syrnike::windows_media::tests::repeatFault("capture-candidate-failure", failedCandidatePreservesActiveAndFencesLateFrame);
    syrnike::windows_media::tests::repeatFault("capture-retry-exhaustion", prepareFallbackAndBoundedRetries);
    syrnike::windows_media::tests::repeatFault("capture-rolling-attempt-budget", rollingBudgetAndDeadline);
    syrnike::windows_media::tests::repeatFault("capture-concurrent-failure-fences", concurrentFailureAndPermissionFences);
    std::cout << "Backend selection policy passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
