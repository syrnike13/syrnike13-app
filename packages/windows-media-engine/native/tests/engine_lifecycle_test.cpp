#include <atomic>
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
#include "core/room_owner.hpp"

namespace syrnike::windows_media::tests {
void runRoomOwnerTests();
}

namespace {

using syrnike::windows_media::ApplyDesiredStateResult;
using syrnike::windows_media::CredentialLease;
using syrnike::windows_media::DiagnosticEvent;
using syrnike::windows_media::Engine;
using syrnike::windows_media::EngineDesiredState;
using syrnike::windows_media::EngineFailure;
using syrnike::windows_media::EngineOptions;
using syrnike::windows_media::EngineResult;
using syrnike::windows_media::EngineState;
using syrnike::windows_media::FatalEngineFailureEvent;
using syrnike::windows_media::LifecycleEvent;
using syrnike::windows_media::PublicEvent;
using syrnike::windows_media::RemoteVideoDemand;
using syrnike::windows_media::RoomConnectRequest;
using syrnike::windows_media::RoomIntent;
using syrnike::windows_media::RoomOperationCompletion;
using syrnike::windows_media::RoomStateChangedEvent;
using syrnike::windows_media::RoomTransport;
using syrnike::windows_media::TrackStateChangedEvent;

void require(bool condition, const std::string &message) {
  if (!condition)
    throw std::runtime_error(message);
}

void requireOk(const EngineResult &result, const std::string &operation) {
  if (!result.ok) {
    throw std::runtime_error(
        operation + " failed: " +
        (result.failure ? result.failure->code : "missing_failure"));
  }
}

class EngineRoomTransport final : public RoomTransport {
public:
  void setConnectionEventCallback(syrnike::windows_media::RoomConnectionEventCallback callback) override {
    connection_callback = std::move(callback);
  }
  syrnike::windows_media::RoomConnectionEventCallback connection_callback;
  void startConnect(std::uint64_t generation, RoomConnectRequest request,
                    RoomOperationCompletion completion) override {
    std::lock_guard lock(mutex_);
    generation_ = generation;
    request_ = std::move(request);
    connect_ = std::move(completion);
    ++connect_starts_;
    changed_.notify_all();
  }

  bool cancelConnect(std::uint64_t) noexcept override {
    std::lock_guard lock(mutex_);
    return cancel_accepted_;
  }

  void startDisconnect(std::uint64_t generation,
                       RoomOperationCompletion completion) override {
    bool complete_inline = false;
    {
      std::lock_guard lock(mutex_);
      generation_ = generation;
      complete_inline = complete_disconnect_inline_;
      if (!complete_inline)
        disconnect_ = completion;
      changed_.notify_all();
    }
    if (complete_inline)
      completion(generation, EngineResult::success());
  }

  void completeConnect(EngineResult result = EngineResult::success()) {
    RoomOperationCompletion completion;
    std::uint64_t generation = 0;
    {
      std::lock_guard lock(mutex_);
      completion = std::move(connect_);
      generation = generation_;
    }
    completion(generation, std::move(result));
  }

  void completeDisconnect(EngineResult result = EngineResult::success()) {
    RoomOperationCompletion completion;
    std::uint64_t generation = 0;
    {
      std::lock_guard lock(mutex_);
      completion = std::move(disconnect_);
      generation = generation_;
    }
    completion(generation, std::move(result));
  }

  std::string lastToken() const {
    std::lock_guard lock(mutex_);
    return request_.token;
  }

  RoomConnectRequest lastRequest() const {
    std::lock_guard lock(mutex_);
    return request_;
  }

  std::size_t connectStarts() const {
    std::lock_guard lock(mutex_);
    return connect_starts_;
  }

  void waitForDisconnect() {
    std::unique_lock lock(mutex_);
    require(changed_.wait_for(lock, std::chrono::seconds(1),
                              [this] { return bool(disconnect_); }),
            "room disconnect did not start");
  }

  void completeDisconnectInline() {
    std::lock_guard lock(mutex_);
    complete_disconnect_inline_ = true;
  }

  void rejectCancellationAsTooLate() {
    std::lock_guard lock(mutex_);
    cancel_accepted_ = false;
  }

private:
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::uint64_t generation_ = 0;
  RoomConnectRequest request_;
  RoomOperationCompletion connect_;
  RoomOperationCompletion disconnect_;
  std::size_t connect_starts_ = 0;
  bool complete_disconnect_inline_ = false;
  bool cancel_accepted_ = true;
};

void transitionTable() {
  std::vector<LifecycleEvent> events;
  std::mutex mutex;
  Engine engine;
  requireOk(engine.registerEventCallback([&](const PublicEvent &event) {
    const auto *lifecycle = std::get_if<LifecycleEvent>(&event);
    if (!lifecycle)
      return;
    std::lock_guard lock(mutex);
    events.push_back(*lifecycle);
  }),
            "register callback");
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
    require(events[index].previous == expected[index].first &&
                events[index].state == expected[index].second,
            "illegal lifecycle transition");
    require(events[index].sequence == index + 1,
            "event sequence is not monotonic");
  }
  const auto restarted = engine.start();
  require(!restarted.ok && restarted.failure &&
              restarted.failure->code == "engine_instance_consumed",
          "one-shot Engine restarted");
}

void shutdownDuringStarting() {
  Engine engine(EngineOptions{.test_block_start_until_shutdown = true});
  std::mutex mutex;
  std::condition_variable changed;
  bool starting = false;
  requireOk(engine.registerEventCallback([&](const PublicEvent &event) {
    const auto *lifecycle = std::get_if<LifecycleEvent>(&event);
    if (!lifecycle || lifecycle->state != EngineState::Starting)
      return;
    {
      std::lock_guard lock(mutex);
      starting = true;
    }
    changed.notify_all();
  }),
            "register callback");

  EngineResult start_result;
  std::thread starter(
      [&] { start_result = engine.start(std::chrono::seconds(2)); });
  {
    std::unique_lock lock(mutex);
    require(changed.wait_for(lock, std::chrono::seconds(1),
                             [&] { return starting; }),
            "Engine never entered Starting");
  }
  const auto shutdown_result = engine.shutdown(std::chrono::seconds(1));
  starter.join();
  requireOk(shutdown_result, "shutdown during Starting");
  require(!start_result.ok && start_result.failure &&
              start_result.failure->code == "startup_cancelled",
          "startup cancellation was not typed");
  require(engine.state() == EngineState::Stopped,
          "cancelled Engine did not stop");
}

bool acceptablePingResult(const EngineResult &result) {
  if (result.ok)
    return true;
  if (!result.failure)
    return false;
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
    require(acceptablePingResult(ping_result),
            "concurrent ping returned invalid result: " +
                (ping_result.failure ? ping_result.failure->code
                                     : "missing_failure"));
    requireOk(shutdown_result, "concurrent shutdown");
  }
}

void lateEventAfterShutdown() {
  std::size_t event_count = 0;
  Engine engine;
  requireOk(
      engine.registerEventCallback([&](const PublicEvent &) { ++event_count; }),
      "register callback");
  requireOk(engine.start(), "late-event start");
  requireOk(engine.shutdown(), "late-event shutdown");
  const auto count_at_shutdown = event_count;
  const auto ping = engine.ping();
  require(!ping.ok, "ping after terminal shutdown succeeded");
  require(event_count == count_at_shutdown,
          "late event escaped terminal shutdown");
}

void deterministicStartupRollback() {
  std::size_t fatal_events = 0;
  Engine engine(EngineOptions{.fail_start = true});
  requireOk(engine.registerEventCallback([&](const PublicEvent &event) {
    if (std::holds_alternative<FatalEngineFailureEvent>(event))
      ++fatal_events;
  }),
            "failed startup public callback");
  const auto start = engine.start();
  require(!start.ok && start.failure && start.failure->code == "startup_failed",
          "startup failure was not deterministic");
  require(engine.state() == EngineState::Failed,
          "failed startup state changed");
  require(fatal_events == 1, "failed startup did not emit one fatal event");
  requireOk(engine.shutdown(), "failed startup rollback");
  requireOk(engine.shutdown(), "failed startup repeated shutdown");
}

EngineDesiredState desiredState(std::uint64_t revision, std::string room_id) {
  return EngineDesiredState{
      revision,
      RoomIntent{std::move(room_id), "participant-1", "lease-1"},
      {},
      {},
      {},
      {},
      {RemoteVideoDemand{"participant-2", "publication-1"}},
  };
}

void desiredStateRevisionMatrix() {
  std::vector<PublicEvent> events;
  Engine engine;
  requireOk(engine.registerEventCallback(
                [&](const PublicEvent &event) { events.push_back(event); }),
            "desired-state public callback");
  requireOk(engine.start(), "desired-state start");

  const auto accepted = engine.applyDesiredState(desiredState(2, "room-a"));
  require(accepted.ok && accepted.accepted_revision == 2 && !accepted.duplicate,
          "new desired state was not accepted");

  const auto duplicate = engine.applyDesiredState(desiredState(2, "room-a"));
  require(duplicate.ok && duplicate.accepted_revision == 2 &&
              duplicate.duplicate,
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
  for (const auto &event : events) {
    if (std::holds_alternative<RoomStateChangedEvent>(event))
      ++room_events;
    if (std::holds_alternative<TrackStateChangedEvent>(event))
      ++track_events;
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
      RemoteVideoDemand{"participant", "publication"});
  const auto bounded = engine.applyDesiredState(std::move(too_many));
  require(!bounded.ok && bounded.failure &&
              bounded.failure->code == "desired_state_invalid",
          "one-over remote demand array was accepted");
  requireOk(engine.shutdown(), "invalid-state shutdown");
}

void diagnosticsCannotMutateState() {
  Engine engine;
  std::vector<DiagnosticEvent> diagnostics;
  requireOk(
      engine.registerDiagnosticEventCallback(
          [&](const DiagnosticEvent &event) { diagnostics.push_back(event); }),
      "register diagnostics");
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
      .test_before_apply_commit =
          [] { std::this_thread::sleep_for(std::chrono::milliseconds(50)); },
  });
  std::size_t diagnostic_count = 0;
  requireOk(engine.registerDiagnosticEventCallback(
                [&](const DiagnosticEvent &) { ++diagnostic_count; }),
            "expired apply diagnostic callback");
  requireOk(engine.start(), "expired apply start");
  const auto expired = engine.applyDesiredState(desiredState(1, "room-expired"),
                                                std::chrono::milliseconds(10));
  require(!expired.ok && expired.failure &&
              expired.failure->code == "control_deadline_exceeded",
          "in-flight apply did not respect its deadline");
  const auto snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
              !snapshot.snapshot->desired_state &&
              snapshot.snapshot->accepted_revision == 0,
          "expired apply mutated the coherent snapshot");
  require(diagnostic_count == 0,
          "expired apply committed after its reply timeout");
  requireOk(engine.shutdown(), "expired apply shutdown");
}

void expiredCredentialLeaseNeverCommitsLate() {
  auto transport = std::make_shared<EngineRoomTransport>();
  Engine engine(EngineOptions{
      .test_before_credential_commit =
          [] { std::this_thread::sleep_for(std::chrono::milliseconds(50)); },
      .room_transport = transport,
  });
  requireOk(engine.start(), "expired credential start");
  const auto expired = engine.installCredentialLease(
      CredentialLease{"lease-expired", "ws://127.0.0.1:7880", "private-token"},
      std::chrono::milliseconds(10));
  require(!expired.ok && expired.failure &&
              expired.failure->code == "control_deadline_exceeded",
          "in-flight credential install did not respect its deadline");
  require(engine.applyDesiredState(desiredState(1, "room-expired")).ok,
          "expired credential desired state was not accepted");
  const auto snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
              snapshot.snapshot->room_state ==
                  RoomStateChangedEvent::State::Failed &&
              snapshot.snapshot->room_failure &&
              snapshot.snapshot->room_failure->code ==
                  "credential_lease_missing",
          "expired credential lease was committed after its reply timeout");
  requireOk(engine.shutdown(), "expired credential shutdown");
}

void roomCompletionBurstPreservesTerminalState() {
  auto transport = std::make_shared<EngineRoomTransport>();
  transport->completeDisconnectInline();
  std::mutex gate_mutex;
  std::condition_variable gate_changed;
  std::atomic_int apply_count = 0;
  bool second_apply_blocked = false;
  bool release_second_apply = false;
  Engine engine(EngineOptions{
      .test_before_apply_commit =
          [&] {
            if (apply_count.fetch_add(1) != 1)
              return;
            std::unique_lock lock(gate_mutex);
            second_apply_blocked = true;
            gate_changed.notify_all();
            gate_changed.wait(lock, [&] { return release_second_apply; });
          },
      .room_transport = transport,
  });
  requireOk(engine.start(), "completion burst start");
  require(engine
              .installCredentialLease(CredentialLease{
                  "lease-1", "ws://127.0.0.1:7880", "private-token"})
              .ok,
          "completion burst lease install failed");
  require(engine.applyDesiredState(desiredState(1, "room-a")).ok,
          "completion burst connect intent failed");

  EngineDesiredState off = desiredState(2, "room-a");
  off.room.reset();
  ApplyDesiredStateResult off_result;
  std::thread apply_off(
      [&] { off_result = engine.applyDesiredState(std::move(off)); });
  {
    std::unique_lock lock(gate_mutex);
    require(gate_changed.wait_for(lock, std::chrono::seconds(1),
                                  [&] { return second_apply_blocked; }),
            "second apply never reached its commit gate");
  }
  transport->completeConnect();
  {
    std::lock_guard lock(gate_mutex);
    release_second_apply = true;
  }
  gate_changed.notify_all();
  apply_off.join();
  require(off_result.ok, "completion burst off intent failed");
  const auto snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
              snapshot.snapshot->room_state ==
                  RoomStateChangedEvent::State::Off,
          "back-to-back room completions lost the terminal off state");
  requireOk(engine.shutdown(), "completion burst shutdown");
}

void tooLateCancellationDisconnectsCommittedRoom() {
  auto transport = std::make_shared<EngineRoomTransport>();
  transport->rejectCancellationAsTooLate();
  Engine engine(EngineOptions{.room_transport = transport});
  requireOk(engine.start(), "too-late cancellation Engine start");
  require(engine
              .installCredentialLease(CredentialLease{
                  "lease-1", "ws://127.0.0.1:7880", "private-token"})
              .ok,
          "too-late cancellation lease install failed");
  require(engine.applyDesiredState(desiredState(1, "room-a")).ok,
          "too-late cancellation connect intent failed");
  auto off = desiredState(2, "room-a");
  off.room.reset();
  require(engine.applyDesiredState(std::move(off)).ok,
          "too-late cancellation off intent failed");
  transport->completeConnect();
  transport->waitForDisconnect();
  transport->completeDisconnect();
  const auto snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
              snapshot.snapshot->room_state ==
                  RoomStateChangedEvent::State::Off,
          "committed Room survived a too-late cancellation");
  requireOk(engine.shutdown(), "too-late cancellation shutdown");
}

void failedDisconnectDoesNotStartReplacementRoom() {
  auto transport = std::make_shared<EngineRoomTransport>();
  Engine engine(EngineOptions{.room_transport = transport});
  requireOk(engine.start(), "disconnect failure Engine start");
  require(engine
              .installCredentialLease(CredentialLease{
                  "lease-1", "ws://127.0.0.1:7880", "old-token"})
              .ok,
          "disconnect failure initial lease install failed");
  require(engine.applyDesiredState(desiredState(1, "room-a")).ok,
          "disconnect failure initial desired state failed");
  transport->completeConnect();
  require(engine
              .installCredentialLease(CredentialLease{
                  "lease-1", "ws://127.0.0.1:7880", "replacement-token"})
              .ok,
          "disconnect failure replacement lease install failed");
  require(engine.applyDesiredState(desiredState(2, "room-b")).ok,
          "disconnect failure replacement desired state failed");
  transport->completeDisconnect(EngineResult::fail(
      EngineFailure{"livekit_disconnect_failed", "disconnect failed",
                    "room_disconnect", true}));
  const auto snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
              snapshot.snapshot->room_state ==
                  RoomStateChangedEvent::State::Failed &&
              snapshot.snapshot->room_failure &&
              snapshot.snapshot->room_failure->code ==
                  "livekit_disconnect_failed",
          "disconnect failure was not retained in the coherent snapshot");
  require(transport->connectStarts() == 1 &&
              transport->lastToken() == "old-token",
          "replacement Room started before the old Room disconnected");

  EngineResult shutdown_result;
  std::thread shutdown(
      [&] { shutdown_result = engine.shutdown(std::chrono::seconds(2)); });
  transport->waitForDisconnect();
  transport->completeDisconnect();
  shutdown.join();
  requireOk(shutdown_result, "disconnect failure shutdown retry");
}

void failedCancellationTeardownDoesNotStartReplacementRoom() {
  auto transport = std::make_shared<EngineRoomTransport>();
  Engine engine(EngineOptions{.room_transport = transport});
  requireOk(engine.start(), "cancellation failure Engine start");
  require(engine
              .installCredentialLease(CredentialLease{
                  "lease-1", "ws://127.0.0.1:7880", "old-token"})
              .ok,
          "cancellation failure initial lease install failed");
  require(engine.applyDesiredState(desiredState(1, "room-a")).ok,
          "cancellation failure initial desired state failed");
  require(engine
              .installCredentialLease(CredentialLease{
                  "lease-1", "ws://127.0.0.1:7880", "replacement-token"})
              .ok,
          "cancellation failure replacement lease install failed");
  require(engine.applyDesiredState(desiredState(2, "room-b")).ok,
          "cancellation failure replacement desired state failed");
  transport->completeConnect(EngineResult::fail(
      EngineFailure{"room_cancel_teardown_failed", "teardown failed",
                    "room_disconnect", true}));
  const auto snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
              snapshot.snapshot->room_state ==
                  RoomStateChangedEvent::State::Failed &&
              snapshot.snapshot->room_failure &&
              snapshot.snapshot->room_failure->code ==
                  "room_cancel_teardown_failed",
          "cancellation teardown failure was not retained in the snapshot");
  require(transport->connectStarts() == 1 &&
              transport->lastToken() == "old-token",
          "replacement Room started after failed cancellation teardown");

  EngineResult shutdown_result;
  std::thread shutdown(
      [&] { shutdown_result = engine.shutdown(std::chrono::seconds(2)); });
  transport->waitForDisconnect();
  transport->completeDisconnect();
  shutdown.join();
  requireOk(shutdown_result, "cancellation failure shutdown retry");
}

void authorityMismatchRetiresEngineEpoch() {
  auto transport = std::make_shared<EngineRoomTransport>();
  std::mutex mutex;
  std::condition_variable changed;
  std::optional<EngineFailure> fatal_failure;
  Engine engine(EngineOptions{.room_transport = transport});
  requireOk(engine.registerEventCallback([&](const PublicEvent &event) {
    const auto *fatal = std::get_if<FatalEngineFailureEvent>(&event);
    if (!fatal)
      return;
    {
      std::lock_guard lock(mutex);
      fatal_failure = fatal->failure;
    }
    changed.notify_all();
  }),
            "authority mismatch callback");
  requireOk(engine.start(), "authority mismatch Engine start");
  require(engine
              .installCredentialLease(CredentialLease{
                  "lease-1", "ws://127.0.0.1:7880", "wrong-authority-token"})
              .ok,
          "authority mismatch lease install failed");
  require(engine.applyDesiredState(desiredState(1, "room-a")).ok,
          "authority mismatch desired state failed");
  transport->completeConnect(EngineResult::fail(EngineFailure{
      "room_authority_mismatch",
      "Connected LiveKit authority does not match the desired room intent",
      "room_authority", false}));
  {
    std::unique_lock lock(mutex);
    require(changed.wait_for(lock, std::chrono::seconds(1), [&] {
              return fatal_failure.has_value();
            }),
            "authority mismatch did not emit a fatal Engine event");
    require(fatal_failure->code == "room_authority_mismatch" &&
                !fatal_failure->retryable,
            "authority mismatch fatal event lost its typed failure");
  }
  require(engine.state() == EngineState::Failed,
          "authority mismatch left the Engine reusable");
  requireOk(engine.shutdown(), "authority mismatch shutdown");
}

void desiredRoomUsesProductionCoordinatorPath() {
  auto transport = std::make_shared<EngineRoomTransport>();
  Engine engine(EngineOptions{.room_transport = transport});
  std::vector<RoomStateChangedEvent> room_events;
  requireOk(engine.registerEventCallback([&](const PublicEvent &event) {
    if (const auto *room = std::get_if<RoomStateChangedEvent>(&event)) {
      room_events.push_back(*room);
    }
  }),
            "room path callback");
  requireOk(engine.start(), "room path start");
  const auto installed = engine.installCredentialLease(CredentialLease{
      "lease-1",
      "ws://127.0.0.1:7880",
      "private-token",
  });
  require(installed.ok && installed.lease_id == "lease-1",
          "credential lease was not installed");
  require(engine.applyDesiredState(desiredState(1, "room-a")).ok,
          "room desired state was not accepted");
  auto snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
              snapshot.snapshot->room_state ==
                  RoomStateChangedEvent::State::Connecting,
          "room intent did not start a non-blocking connection");
  require(transport->lastToken() == "private-token",
          "private credential did not reach the transport");
  const auto connect_request = transport->lastRequest();
  require(connect_request.expected_room_id == "room-a" &&
              connect_request.expected_participant_identity ==
                  "participant-1",
          "desired room authority did not reach the transport");
  transport->completeConnect();
  snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
              snapshot.snapshot->room_state ==
                  RoomStateChangedEvent::State::Connected,
          "room completion did not reach the Engine control thread");

  auto off = desiredState(2, "room-a");
  off.room.reset();
  require(engine.applyDesiredState(std::move(off)).ok,
          "room off intent was not accepted");
  snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
              snapshot.snapshot->room_state ==
                  RoomStateChangedEvent::State::Disconnecting,
          "room off intent did not start disconnect");
  transport->completeDisconnect();
  snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
              snapshot.snapshot->room_state ==
                  RoomStateChangedEvent::State::Off,
          "room disconnect did not settle off");

  require(engine.applyDesiredState(desiredState(3, "room-a")).ok,
          "room reconnect intent was not accepted");
  snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
              snapshot.snapshot->room_state ==
                  RoomStateChangedEvent::State::Failed &&
              snapshot.snapshot->room_failure &&
              snapshot.snapshot->room_failure->code ==
                  "credential_lease_missing",
          "consumed credential lease remained replayable");
  const auto replacement = engine.installCredentialLease(CredentialLease{
      "lease-1",
      "ws://127.0.0.1:7880",
      "replacement-token",
  });
  require(replacement.ok && transport->lastToken() == "replacement-token",
          "replacement credential lease did not resume the desired room");
  transport->completeConnect();
  EngineResult shutdown_result;
  std::thread shutdown(
      [&] { shutdown_result = engine.shutdown(std::chrono::seconds(2)); });
  transport->waitForDisconnect();
  transport->completeDisconnect();
  shutdown.join();
  requireOk(shutdown_result, "room path shutdown");
  require(room_events.size() >= 2 &&
              room_events[room_events.size() - 2].state ==
                  RoomStateChangedEvent::State::Disconnecting &&
              room_events.back().state == RoomStateChangedEvent::State::Off &&
              room_events[room_events.size() - 2].revision == 3 &&
              room_events.back().revision == 3,
          "shutdown emitted an invalid zero-revision room event");
}

} // namespace

void unexpectedRoomLossReachesEngineSnapshot() {
  auto transport = std::make_shared<EngineRoomTransport>();
  Engine engine(EngineOptions{.room_transport = transport});
  requireOk(engine.start(), "room loss start");
  require(engine.installCredentialLease(
      CredentialLease{"lease-1", "ws://localhost", "token"}).ok, "lease failed");
  require(engine.applyDesiredState(desiredState(1, "room-a")).ok, "intent failed");
  transport->completeConnect();
  (void)engine.querySnapshot();
  transport->connection_callback({1, syrnike::windows_media::RoomConnectionState::Disconnected,
      syrnike::windows_media::EngineFailure{
          "room_connection_lost", "lost", "room_connection", true}});
  const auto snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
      snapshot.snapshot->room_state == RoomStateChangedEvent::State::Failed &&
      snapshot.snapshot->room_failure &&
      snapshot.snapshot->room_failure->code == "room_connection_lost",
      "unexpected Room loss was hidden from public state");
  requireOk(engine.ping(), "engine must remain responsive after room loss");
  requireOk(engine.shutdown(), "room loss shutdown");
}

int main() try {
  unexpectedRoomLossReachesEngineSnapshot();
  transitionTable();
  shutdownDuringStarting();
  concurrentPingAndShutdown();
  lateEventAfterShutdown();
  deterministicStartupRollback();
  desiredStateRevisionMatrix();
  invalidStateDoesNotPartiallyApply();
  diagnosticsCannotMutateState();
  expiredApplyNeverCommitsLate();
  expiredCredentialLeaseNeverCommitsLate();
  roomCompletionBurstPreservesTerminalState();
  tooLateCancellationDisconnectsCommittedRoom();
  failedDisconnectDoesNotStartReplacementRoom();
  failedCancellationTeardownDoesNotStartReplacementRoom();
  authorityMismatchRetiresEngineEpoch();
  desiredRoomUsesProductionCoordinatorPath();
  syrnike::windows_media::tests::runRoomOwnerTests();
  std::cout << "media-core-tests:ok\n";
  return 0;
} catch (const std::exception &error) {
  std::cerr << error.what() << '\n';
  return 1;
}
