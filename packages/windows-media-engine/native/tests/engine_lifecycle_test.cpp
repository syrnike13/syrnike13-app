#include <chrono>
#include <condition_variable>
#include <iostream>
#include <latch>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "core/engine.hpp"

namespace {

using syrnike::windows_media::Engine;
using syrnike::windows_media::EngineDesiredState;
using syrnike::windows_media::EngineOptions;
using syrnike::windows_media::EngineResult;
using syrnike::windows_media::EngineState;
using syrnike::windows_media::DiagnosticEvent;
using syrnike::windows_media::LifecycleEvent;
using syrnike::windows_media::PublicEvent;
using syrnike::windows_media::RoomStateChangedEvent;
using syrnike::windows_media::TrackStateChangedEvent;
using syrnike::windows_media::FatalEngineFailureEvent;
using syrnike::windows_media::RemoteVideoDemand;
using syrnike::windows_media::RoomIntent;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

void requireOk(const EngineResult& result, const std::string& operation) {
  if (!result.ok) {
    throw std::runtime_error(
      operation + " failed: " +
      (result.failure ? result.failure->code : "missing_failure")
    );
  }
}

void transitionTable() {
  std::vector<LifecycleEvent> events;
  std::mutex mutex;
  Engine engine;
  requireOk(engine.registerEventCallback([&](const PublicEvent& event) {
    const auto* lifecycle = std::get_if<LifecycleEvent>(&event);
    if (!lifecycle) return;
    std::lock_guard lock(mutex);
    events.push_back(*lifecycle);
  }), "register callback");
  requireOk(engine.start(), "start");
  requireOk(engine.shutdown(), "shutdown");
  requireOk(engine.shutdown(), "idempotent shutdown");
  const std::vector<std::pair<EngineState, EngineState>> expected{
    {EngineState::Stopped, EngineState::Starting},
    {EngineState::Starting, EngineState::Running},
    {EngineState::Running, EngineState::Stopping},
    {EngineState::Stopping, EngineState::Stopped},
  };
  std::lock_guard lock(mutex);
  require(events.size() == expected.size(), "transition event count changed");
  for (std::size_t index = 0; index < expected.size(); ++index) {
    require(
      events[index].previous == expected[index].first &&
        events[index].state == expected[index].second,
      "illegal lifecycle transition"
    );
    require(events[index].sequence == index + 1, "event sequence is not monotonic");
  }
  const auto restarted = engine.start();
  require(
    !restarted.ok && restarted.failure &&
      restarted.failure->code == "engine_instance_consumed",
    "one-shot Engine restarted"
  );
}

void shutdownDuringStarting() {
  Engine engine(EngineOptions{.test_block_start_until_shutdown = true});
  std::mutex mutex;
  std::condition_variable changed;
  bool starting = false;
  requireOk(engine.registerEventCallback([&](const PublicEvent& event) {
    const auto* lifecycle = std::get_if<LifecycleEvent>(&event);
    if (!lifecycle || lifecycle->state != EngineState::Starting) return;
    {
      std::lock_guard lock(mutex);
      starting = true;
    }
    changed.notify_all();
  }), "register callback");

  EngineResult start_result;
  std::thread starter([&] {
    start_result = engine.start(std::chrono::seconds(2));
  });
  {
    std::unique_lock lock(mutex);
    require(
      changed.wait_for(lock, std::chrono::seconds(1), [&] { return starting; }),
      "Engine never entered Starting"
    );
  }
  const auto shutdown_result = engine.shutdown(std::chrono::seconds(1));
  starter.join();
  requireOk(shutdown_result, "shutdown during Starting");
  require(
    !start_result.ok && start_result.failure &&
      start_result.failure->code == "startup_cancelled",
    "startup cancellation was not typed"
  );
  require(engine.state() == EngineState::Stopped, "cancelled Engine did not stop");
}

bool acceptablePingResult(const EngineResult& result) {
  if (result.ok) return true;
  if (!result.failure) return false;
  return result.failure->code == "engine_stopping" ||
    result.failure->code == "engine_not_running";
}

void concurrentPingAndShutdown() {
  for (int cycle = 0; cycle < 100; ++cycle) {
    Engine engine;
    requireOk(engine.start(), "concurrent start");
    std::latch start_line(3);
    EngineResult ping_result;
    EngineResult shutdown_result;
    std::thread ping([&] {
      start_line.arrive_and_wait();
      ping_result = engine.ping();
    });
    std::thread shutdown([&] {
      start_line.arrive_and_wait();
      shutdown_result = engine.shutdown();
    });
    start_line.arrive_and_wait();
    ping.join();
    shutdown.join();
    require(
      acceptablePingResult(ping_result),
      "concurrent ping returned invalid result: " +
        (ping_result.failure ? ping_result.failure->code : "missing_failure")
    );
    requireOk(shutdown_result, "concurrent shutdown");
  }
}

void lateEventAfterShutdown() {
  std::size_t event_count = 0;
  Engine engine;
  requireOk(engine.registerEventCallback([&](const PublicEvent&) {
    ++event_count;
  }), "register callback");
  requireOk(engine.start(), "late-event start");
  requireOk(engine.shutdown(), "late-event shutdown");
  const auto count_at_shutdown = event_count;
  const auto ping = engine.ping();
  require(!ping.ok, "ping after terminal shutdown succeeded");
  require(event_count == count_at_shutdown, "late event escaped terminal shutdown");
}

void deterministicStartupRollback() {
  std::size_t fatal_events = 0;
  Engine engine(EngineOptions{.fail_start = true});
  requireOk(engine.registerEventCallback([&](const PublicEvent& event) {
    if (std::holds_alternative<FatalEngineFailureEvent>(event)) ++fatal_events;
  }), "failed startup public callback");
  const auto start = engine.start();
  require(
    !start.ok && start.failure && start.failure->code == "startup_failed",
    "startup failure was not deterministic"
  );
  require(engine.state() == EngineState::Failed, "failed startup state changed");
  require(fatal_events == 1, "failed startup did not emit one fatal event");
  requireOk(engine.shutdown(), "failed startup rollback");
  requireOk(engine.shutdown(), "failed startup repeated shutdown");
}

EngineDesiredState desiredState(std::uint64_t revision, std::string room_id) {
  return EngineDesiredState{
    revision,
    RoomIntent{std::move(room_id), "participant-1"},
    {RemoteVideoDemand{"participant-2", "publication-1"}},
  };
}

void desiredStateRevisionMatrix() {
  std::vector<PublicEvent> events;
  Engine engine;
  requireOk(engine.registerEventCallback([&](const PublicEvent& event) {
    events.push_back(event);
  }), "desired-state public callback");
  requireOk(engine.start(), "desired-state start");

  const auto accepted = engine.applyDesiredState(desiredState(2, "room-a"));
  require(accepted.ok && accepted.accepted_revision == 2 && !accepted.duplicate,
    "new desired state was not accepted");

  const auto duplicate = engine.applyDesiredState(desiredState(2, "room-a"));
  require(duplicate.ok && duplicate.accepted_revision == 2 && duplicate.duplicate,
    "identical revision was not idempotent");

  const auto conflict = engine.applyDesiredState(desiredState(2, "room-b"));
  require(!conflict.ok && conflict.failure &&
    conflict.failure->code == "revision_conflict",
    "same revision with different state was not rejected");

  const auto stale = engine.applyDesiredState(desiredState(1, "room-old"));
  require(!stale.ok && stale.failure && stale.failure->code == "stale_revision",
    "stale revision was not rejected");

  const auto gapped = engine.applyDesiredState(desiredState(9, "room-c"));
  require(gapped.ok && gapped.accepted_revision == 9,
    "gapped newer revision was not accepted");

  std::size_t room_events = 0;
  std::size_t track_events = 0;
  for (const auto& event : events) {
    if (std::holds_alternative<RoomStateChangedEvent>(event)) ++room_events;
    if (std::holds_alternative<TrackStateChangedEvent>(event)) ++track_events;
  }
  require(room_events == 1, "initial desired state did not emit a room event");
  require(track_events == 4, "initial desired state did not emit track events");

  const auto snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
    snapshot.snapshot->accepted_revision == 9 &&
    snapshot.snapshot->desired_state &&
    snapshot.snapshot->desired_state->room &&
    snapshot.snapshot->desired_state->room->room_id == "room-c",
    "querySnapshot did not return the coherent accepted state");
  requireOk(engine.shutdown(), "desired-state shutdown");
}

void invalidStateDoesNotPartiallyApply() {
  Engine engine;
  requireOk(engine.start(), "invalid-state start");
  require(engine.applyDesiredState(desiredState(1, "room-valid")).ok,
    "valid baseline state was rejected");
  auto invalid = desiredState(2, std::string(257, 'x'));
  const auto rejected = engine.applyDesiredState(std::move(invalid));
  require(!rejected.ok && rejected.failure &&
    rejected.failure->code == "desired_state_invalid",
    "oversized desired state was accepted");
  const auto snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
    snapshot.snapshot->accepted_revision == 1 &&
    snapshot.snapshot->desired_state->room->room_id == "room-valid",
    "invalid desired state was partially applied");
  auto too_many = desiredState(3, "room-valid");
  too_many.remote_video_demand.assign(
    syrnike::windows_media::kMaximumRemoteVideoDemands + 1,
    RemoteVideoDemand{"participant", "publication"}
  );
  const auto bounded = engine.applyDesiredState(std::move(too_many));
  require(!bounded.ok && bounded.failure &&
    bounded.failure->code == "desired_state_invalid",
    "one-over remote demand array was accepted");
  requireOk(engine.shutdown(), "invalid-state shutdown");
}

void diagnosticsCannotMutateState() {
  Engine engine;
  std::vector<DiagnosticEvent> diagnostics;
  requireOk(engine.registerDiagnosticEventCallback(
    [&](const DiagnosticEvent& event) { diagnostics.push_back(event); }
  ), "register diagnostics");
  requireOk(engine.start(), "diagnostic start");
  require(engine.applyDesiredState(desiredState(4, "room-diagnostic")).ok,
    "diagnostic apply failed");
  require(diagnostics.size() == 1 &&
    diagnostics[0].code == "desired_state_accepted" &&
    diagnostics[0].metrics.size() == 1,
    "bounded typed diagnostic was not emitted");
  const auto snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
    snapshot.snapshot->accepted_revision == 4,
    "diagnostic callback changed engine state");
  requireOk(engine.shutdown(), "diagnostic shutdown");
}

void expiredApplyNeverCommitsLate() {
  Engine engine(EngineOptions{
    .test_before_apply_commit = [] {
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    },
  });
  std::size_t diagnostic_count = 0;
  requireOk(engine.registerDiagnosticEventCallback(
    [&](const DiagnosticEvent&) { ++diagnostic_count; }
  ), "expired apply diagnostic callback");
  requireOk(engine.start(), "expired apply start");
  const auto expired = engine.applyDesiredState(
    desiredState(1, "room-expired"),
    std::chrono::milliseconds(10)
  );
  require(!expired.ok && expired.failure &&
    expired.failure->code == "control_deadline_exceeded",
    "in-flight apply did not respect its deadline");
  const auto snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
    !snapshot.snapshot->desired_state &&
    snapshot.snapshot->accepted_revision == 0,
    "expired apply mutated the coherent snapshot");
  require(diagnostic_count == 0, "expired apply committed after its reply timeout");
  requireOk(engine.shutdown(), "expired apply shutdown");
}

}  // namespace

int main() try {
  transitionTable();
  shutdownDuringStarting();
  concurrentPingAndShutdown();
  lateEventAfterShutdown();
  deterministicStartupRollback();
  desiredStateRevisionMatrix();
  invalidStateDoesNotPartiallyApply();
  diagnosticsCannotMutateState();
  expiredApplyNeverCommitsLate();
  std::cout << "media-core-tests:ok\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
