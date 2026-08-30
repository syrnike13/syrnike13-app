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
using syrnike::windows_media::EngineOptions;
using syrnike::windows_media::EngineResult;
using syrnike::windows_media::EngineState;
using syrnike::windows_media::LifecycleEvent;

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
  requireOk(engine.registerEventCallback([&](const LifecycleEvent& event) {
    std::lock_guard lock(mutex);
    events.push_back(event);
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
  requireOk(engine.registerEventCallback([&](const LifecycleEvent& event) {
    if (event.state != EngineState::Starting) return;
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
  requireOk(engine.registerEventCallback([&](const LifecycleEvent&) {
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
  Engine engine(EngineOptions{.fail_start = true});
  const auto start = engine.start();
  require(
    !start.ok && start.failure && start.failure->code == "startup_failed",
    "startup failure was not deterministic"
  );
  require(engine.state() == EngineState::Failed, "failed startup state changed");
  requireOk(engine.shutdown(), "failed startup rollback");
  requireOk(engine.shutdown(), "failed startup repeated shutdown");
}

}  // namespace

int main() try {
  transitionTable();
  shutdownDuringStarting();
  concurrentPingAndShutdown();
  lateEventAfterShutdown();
  deterministicStartupRollback();
  std::cout << "media-core-tests:ok\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
