#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <future>
#include <latch>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "core/engine.hpp"
#include "core/room_owner.hpp"
#include "core/media_runtime.hpp"

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

  bool disconnectStarted() const {
    std::lock_guard lock(mutex_);
    return bool(disconnect_);
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

class ManualMediaRuntime final : public syrnike::windows_media::MediaRuntime {
 public:
  void apply(const EngineDesiredState& desired, std::optional<std::uint64_t> room) override {
    std::lock_guard lock(mutex);
    room_generation = room;
    current.stopped = false;
    if (room) current.publications_stopped = false;
    for (auto& path : current.paths) path.revision = desired.revision;
  }
  void beginStop() override { stop_requested.count_down(); }
  syrnike::windows_media::MediaRuntimeSnapshot snapshot() const override {
    std::lock_guard lock(mutex);
    return current;
  }
  void release(bool all) {
    std::lock_guard lock(mutex);
    current.publications_stopped = true;
    current.stopped = all;
  }
  void failMicrophone() {
    std::lock_guard lock(mutex);
    current.paths[0].state = syrnike::windows_media::MediaPathState::Failed;
    current.paths[0].failure = EngineFailure{"input_unavailable", "Input unavailable", "microphone", true};
  }
  void requireRestart() {
    std::lock_guard lock(mutex);
    current.failure = EngineFailure{"screen_audio_requires_restart", "SDK work still pending", "screenAudio", true};
  }
  void setAudioMetrics(bool active) {
    std::lock_guard lock(mutex);
    if (!active) { current.screen_audio_metrics.reset(); return; }
    current.screen_audio_metrics.emplace();
    for (auto& metric : *current.screen_audio_metrics) metric = {"captured", 42};
  }
  bool hasRoom() const {
    std::lock_guard lock(mutex);
    return room_generation.has_value();
  }
  std::latch stop_requested{1};
 private:
  mutable std::mutex mutex;
  std::optional<std::uint64_t> room_generation;
  syrnike::windows_media::MediaRuntimeSnapshot current;
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
      "renderer-1",
  };
}

void mediaQuiescesBeforeRoomTeardown() {
  auto transport = std::make_shared<EngineRoomTransport>();
  auto media = std::make_shared<ManualMediaRuntime>();
  Engine engine(EngineOptions{.room_transport = transport, .media_runtime = media});
  requireOk(engine.start(), "media Engine start");
  require(engine.installCredentialLease({"lease-1", "ws://localhost", "token"}).ok, "lease failed");
  require(engine.applyDesiredState(desiredState(1, "room-a")).ok, "media intent failed");
  require(!media->hasRoom(), "Media received an unconnected Room generation");
  transport->completeConnect();
  require(engine.querySnapshot().snapshot->room_state == RoomStateChangedEvent::State::Connected,
          "Room did not connect");
  require(media->hasRoom(), "Connected generation was not delivered");
  media->failMicrophone();
  const auto failed_path = engine.querySnapshot().snapshot;
  require(failed_path->tracks[0].failure && failed_path->room_state == RoomStateChangedEvent::State::Connected,
          "Media failure changed Room membership or was not projected");
  auto off = desiredState(2, "room-a");
  off.room.reset();
  require(engine.applyDesiredState(off).ok, "Off intent blocked on media stop");
  requireOk(engine.ping(), "Control blocked on media stop");
  require(!media->hasRoom() && !transport->disconnectStarted(),
          "Room disconnected before publication release");
  media->release(false);
  transport->waitForDisconnect();
  transport->completeDisconnect();
  require(engine.querySnapshot().snapshot->room_state == RoomStateChangedEvent::State::Off,
          "Room off did not settle after publication release");
  auto shutdown = std::async(std::launch::async, [&] { return engine.shutdown(); });
  media->stop_requested.wait();
  require(shutdown.wait_for(std::chrono::milliseconds(30)) == std::future_status::timeout,
          "Shutdown completed while capture/decoder owners remained alive");
  media->release(true);
  requireOk(shutdown.get(), "Media owner shutdown");
}

void mediaQuiesceDeadlineRetiresEngine() {
  auto transport = std::make_shared<EngineRoomTransport>();
  transport->completeDisconnectInline();
  auto media = std::make_shared<ManualMediaRuntime>();
  Engine engine(EngineOptions{.room_transport = transport, .media_runtime = media,
      .room_operation_deadlines = {.disconnect = std::chrono::milliseconds(50)}});
  requireOk(engine.start(), "quiesce deadline start");
  require(engine.installCredentialLease({"lease-1", "ws://localhost", "token"}).ok, "lease failed");
  require(engine.applyDesiredState(desiredState(1, "room-a")).ok, "intent failed");
  transport->completeConnect();
  (void)engine.querySnapshot();
  auto off = desiredState(2, "room-a");
  off.room.reset();
  require(engine.applyDesiredState(off).ok, "off failed");
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (engine.state() == EngineState::Running && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  require(engine.state() == EngineState::Failed, "Publication quiesce had no bounded failure");
  media->release(true);
  requireOk(engine.shutdown(), "quiesce deadline cleanup");
}

void unsafeMediaOwnerRetiresEngine() {
  auto media = std::make_shared<ManualMediaRuntime>();
  std::atomic<unsigned> failures{0};
  std::promise<void> terminal_event;
  auto delivered = terminal_event.get_future();
  Engine engine(EngineOptions{.media_runtime = media});
  requireOk(engine.registerEventCallback([&](const PublicEvent& event) {
    const auto* fatal = std::get_if<syrnike::windows_media::FatalEngineFailureEvent>(&event);
    if (!fatal || fatal->failure.code != "screen_audio_requires_restart") return;
    if (failures.fetch_add(1) == 0) terminal_event.set_value();
  }), "media failure callback");
  requireOk(engine.start(), "media owner failure start");
  media->requireRestart();
  // State is published before its event. Synchronize with delivery, then join
  // shutdown before checking the final count so late duplicates cannot escape.
  const bool event_delivered = delivered.wait_for(std::chrono::seconds(1)) == std::future_status::ready;
  const bool retired = engine.state() == EngineState::Failed;
  media->release(true);
  requireOk(engine.shutdown(), "media owner failure cleanup");
  require(event_delivered && retired && failures == 1,
          "unsafe owner did not retire the engine exactly once");
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
  require(track_events == syrnike::windows_media::kMediaPathCount,
          "initial desired state did not emit independent path events");

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

void activeMediaIntentIsAtomicAndBounded() {
  using namespace syrnike::windows_media;
  Engine engine;
  requireOk(engine.start(), "media-intent start");
  auto desired = desiredState(1, "room-a");
  desired.microphone.state = MicrophoneIntentState::on;
  desired.microphone.muted = true;
  desired.microphone.input_volume = 1;
  desired.microphone.gate_threshold_db = -50;
  desired.camera.state = CameraIntentState::on;
  desired.camera.profile = CameraIntentProfile::hd1080p30;
  desired.camera.publication = true;
  desired.screen.state = ScreenIntentState::on;
  desired.screen.source_id = "source-1";
  desired.screen.width = 1920;
  desired.screen.height = 1080;
  desired.screen.fps = 60;
  desired.screen.bitrate = 8'000'000;
  desired.screen.audio_bitrate = 128'000;
  desired.output.state = OutputIntentState::on;
  desired.output.users.push_back({"participant-2", 0.5, false});
  require(engine.applyDesiredState(desired).ok, "active media intent rejected");
  auto invalid = desired;
  invalid.revision = 2;
  invalid.microphone.input_volume = 4.01;
  require(!engine.applyDesiredState(invalid).ok, "invalid DSP volume accepted");
  invalid = desired;
  invalid.revision = 3;
  invalid.screen.fps = 0;
  require(!engine.applyDesiredState(invalid).ok, "zero target FPS accepted");
  invalid = desired;
  invalid.revision = 4;
  invalid.output.users.resize(1025, {"participant", 1, false});
  require(!engine.applyDesiredState(invalid).ok, "unbounded audio settings accepted");
  const auto snapshot = engine.querySnapshot();
  require(snapshot.ok && snapshot.snapshot &&
              snapshot.snapshot->desired_state == desired,
          "invalid media update partially changed accepted intent");
  requireOk(engine.shutdown(), "media-intent shutdown");
}

void supersededCredentialsDoNotExhaustThePrivateStore() {
  Engine engine;
  requireOk(engine.start(), "credential churn start");
  for (unsigned index = 0; index < 100; ++index) {
    require(engine.installCredentialLease({
      "superseded-" + std::to_string(index), "ws://localhost", "private-token",
    }).ok, "superseded credentials exhausted the lease budget");
  }
  require(engine.installCredentialLease({"latest", "ws://localhost", "private-token"}).ok,
          "latest credential rejected after churn");
  requireOk(engine.shutdown(), "credential churn shutdown");
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

void mediaDiagnosticsAreBoundedAndOptional() {
  auto media = std::make_shared<ManualMediaRuntime>();
  Engine engine(EngineOptions{.media_runtime = media});
  std::mutex mutex;
  std::condition_variable changed;
  std::size_t samples = 0;
  bool valid = true;
  requireOk(engine.registerDiagnosticEventCallback([&](const DiagnosticEvent& event) {
    if (event.code != "screen_audio_metrics") return;
    std::lock_guard lock(mutex);
    valid = valid && event.metrics.size() == 12 && event.metrics[0].value == 42;
    ++samples;
    changed.notify_one();
  }), "register media diagnostics");
  requireOk(engine.start(), "media diagnostic start");
  media->setAudioMetrics(true);
  {
    std::unique_lock lock(mutex);
    require(changed.wait_for(lock, std::chrono::seconds{1}, [&] { return samples == 1; }),
            "media diagnostic was not emitted");
    require(!changed.wait_for(lock, std::chrono::milliseconds{200}, [&] { return samples > 1; }),
            "media diagnostics flooded the callback");
    require(valid, "media diagnostics lost their bounded cached values");
  }
  media->setAudioMetrics(false);
  requireOk(engine.ping(), "diagnostics kept the control lane responsive");
  requireOk(engine.shutdown(), "media diagnostic shutdown");
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
  std::uint64_t room_sequence = 0;
  std::uint64_t room_cause = 0;
  std::uint64_t engine_cause = 0;
  double diagnostic_cause = 0;
  Engine engine(EngineOptions{.room_transport = transport});
  requireOk(engine.registerDiagnosticEventCallback([&](const DiagnosticEvent &event) {
    if (event.code != "room_authority_mismatch") return;
    std::lock_guard lock(mutex);
    for (const auto &metric : event.metrics)
      if (metric.name == "cause_sequence") diagnostic_cause = metric.value;
  }), "authority mismatch diagnostic callback");
  requireOk(engine.registerEventCallback([&](const PublicEvent &event) {
    std::lock_guard lock(mutex);
    if (const auto *room = std::get_if<RoomStateChangedEvent>(&event);
        room && room->failure) {
      room_sequence = room->sequence;
      room_cause = room->failure->cause_sequence;
    }
    if (const auto *lifecycle = std::get_if<syrnike::windows_media::LifecycleEvent>(&event);
        lifecycle && lifecycle->failure) engine_cause = lifecycle->failure->cause_sequence;
    const auto *fatal = std::get_if<FatalEngineFailureEvent>(&event);
    if (!fatal)
      return;
    fatal_failure = fatal->failure;
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
    require(room_cause != 0 && room_cause == room_sequence &&
                engine_cause == room_cause && fatal_failure->cause_sequence == room_cause &&
                diagnostic_cause == static_cast<double>(room_cause),
            "terminal native projections lost their originating cause");
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
  mediaQuiescesBeforeRoomTeardown();
  mediaQuiesceDeadlineRetiresEngine();
  for (unsigned cycle = 0; cycle < 100; ++cycle) unsafeMediaOwnerRetiresEngine();
  unexpectedRoomLossReachesEngineSnapshot();
  transitionTable();
  shutdownDuringStarting();
  concurrentPingAndShutdown();
  lateEventAfterShutdown();
  deterministicStartupRollback();
  desiredStateRevisionMatrix();
  invalidStateDoesNotPartiallyApply();
  activeMediaIntentIsAtomicAndBounded();
  supersededCredentialsDoNotExhaustThePrivateStore();
  diagnosticsCannotMutateState();
  mediaDiagnosticsAreBoundedAndOptional();
  expiredApplyNeverCommitsLate();
  expiredCredentialLeaseNeverCommitsLate();
  roomCompletionBurstPreservesTerminalState();
  tooLateCancellationDisconnectsCommittedRoom();
  failedDisconnectDoesNotStartReplacementRoom();
  failedCancellationTeardownDoesNotStartReplacementRoom();
  for (unsigned cycle = 0; cycle < 100; ++cycle) authorityMismatchRetiresEngineEpoch();
  desiredRoomUsesProductionCoordinatorPath();
  syrnike::windows_media::tests::runRoomOwnerTests();
  std::cout << "media-core-tests:ok\n";
  return 0;
} catch (const std::exception &error) {
  std::cerr << error.what() << '\n';
  return 1;
}
