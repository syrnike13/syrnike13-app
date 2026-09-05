#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "capture/window_capture.hpp"

namespace {

using namespace syrnike::windows_media::capture;
using namespace syrnike::windows_media::sources;
using namespace std::chrono_literals;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

class FakeResource final : public FrameResource {
 public:
  explicit FakeResource(std::uint64_t hash) : hash_(hash) {}
  std::uint64_t sampledHash() override { return hash_; }

 private:
  std::uint64_t hash_;
};

class FakeEnumerator final : public SourceEnumerator {
 public:
  SourceKind kind = SourceKind::Window;
  ResolveStatus status = ResolveStatus::Available;
  std::uintptr_t target_value = 91;

  EnumerationBatch enumerate(const EnumerationOptions&) override {
    EnumerationBatch batch;
    SourceCandidate value;
    value.kind = kind;
    value.identity = kind == SourceKind::Window ? "window-a" : "monitor-a";
    value.title = "Fixture";
    value.label = "fixture.exe";
    batch.candidates = {std::move(value)};
    return batch;
  }

  ResolveStatus validate(SourceKind, const std::string&) override {
    return status;
  }

  WindowTargetResult resolveWindowTarget(
      const std::string& identity) override {
    if (status != ResolveStatus::Available || identity != "window-a") {
      return {status, std::nullopt};
    }
    return {ResolveStatus::Available,
            WindowTargetToken{target_value, identity}};
  }
};

class FakeBackend final : public WindowCaptureBackend {
 public:
  BackendStartResult start(const WindowTargetToken& target,
                           FrameCallback on_frame,
                           EventCallback on_event,
                           TerminalCallback on_terminal) override {
    ++starts;
    target_valid = target.valid();
    frame = std::move(on_frame);
    event = std::move(on_event);
    terminal = std::move(on_terminal);
    event(WindowBackendEvent{WindowBackendEventKind::Started, 1, 640, 360, 1});
    if (on_start) on_start();
    return start_result;
  }

  CaptureStopResult stop(
      std::chrono::steady_clock::time_point) noexcept override {
    ++stops;
    std::unique_lock lock(stop_mutex);
    stop_entered = true;
    stop_condition.notify_all();
    stop_condition.wait(lock, [&] { return !block_stop; });
    return {};
  }

  void finalizeStop() noexcept override { ++finalizes; }

  void waitForStopEntry() {
    std::unique_lock lock(stop_mutex);
    stop_condition.wait(lock, [&] { return stop_entered; });
  }

  void releaseStop() {
    std::lock_guard lock(stop_mutex);
    block_stop = false;
    stop_condition.notify_all();
  }

  void emit(std::uint64_t generation, std::int64_t timestamp,
            std::uint64_t hash, std::uint32_t width = 640,
            std::uint32_t height = 360) {
    frame(BackendFrame{timestamp, width, height, FramePixelFormat::Bgra8,
                       std::make_shared<FakeResource>(hash), generation});
  }

  void resizePending(std::uint32_t width, std::uint32_t height) {
    event(WindowBackendEvent{WindowBackendEventKind::ResizePending, 1, width,
                             height, 2});
  }

  void resizeCancelled(std::uint32_t width, std::uint32_t height) {
    event(WindowBackendEvent{WindowBackendEventKind::ResizeCancelled, 1, width,
                             height, 0});
  }

  void resized(std::uint64_t generation, std::uint32_t width,
               std::uint32_t height) {
    event(WindowBackendEvent{WindowBackendEventKind::Resized, generation,
                             width, height, 3});
  }

  void noContent(bool active) {
    event(WindowBackendEvent{
        active ? WindowBackendEventKind::TemporarilyNoContent
               : WindowBackendEventKind::ContentRestored,
        1, 640, 360, 4});
  }

  void close() {
    terminal(CaptureFailure{"source_closed", "fixture closed"});
  }

  FrameCallback frame;
  EventCallback event;
  TerminalCallback terminal;
  std::function<void()> on_start;
  BackendStartResult start_result;
  std::mutex stop_mutex;
  std::condition_variable stop_condition;
  bool block_stop = false;
  bool stop_entered = false;
  int starts = 0;
  int stops = 0;
  int finalizes = 0;
  bool target_valid = false;
};

struct Fixture {
  Fixture() {
    auto enumerator = std::make_unique<FakeEnumerator>();
    enumerator_state = enumerator.get();
    registry = std::make_unique<SourceRegistry>(std::move(enumerator));
    source_id = registry->enumerate().sources.at(0).id;
    auto created_backend = std::make_unique<FakeBackend>();
    backend = created_backend.get();
    capture = std::make_unique<WindowCapture>(
        *registry, source_id, std::move(created_backend));
  }

  std::unique_ptr<SourceRegistry> registry;
  FakeEnumerator* enumerator_state = nullptr;
  std::string source_id;
  FakeBackend* backend = nullptr;
  std::unique_ptr<WindowCapture> capture;
};

void generationFenceAndQueueAreBounded() {
  Fixture fixture;
  require(fixture.capture->start().ok && fixture.backend->target_valid,
          "window capture did not start with a validated target");
  const auto running = fixture.capture->waitForEvent(10ms);
  require(running && running->kind == WindowCaptureEventKind::Running,
          "running event was not delivered");

  fixture.backend->emit(1, 10, 10);
  auto old_lease = fixture.capture->waitForFrame(10ms);
  require(old_lease && old_lease->metadata().generation == 1,
          "initial generation frame was absent");
  fixture.backend->resizePending(960, 540);
  fixture.backend->emit(1, 11, 11);
  require(!fixture.capture->waitForFrame(1ms),
          "old generation frame escaped a pending resize");
  old_lease->release();
  fixture.backend->resized(2, 960, 540);
  fixture.backend->emit(2, 12, 12, 960, 540);
  auto resized_lease = fixture.capture->waitForFrame(10ms);
  require(resized_lease && resized_lease->metadata().generation == 2 &&
              resized_lease->metadata().width == 960 &&
              resized_lease->metadata().height == 540,
          "new generation metadata was not fenced from the old size");
  resized_lease->release();

  for (std::uint64_t value = 0; value < 8; ++value) {
    fixture.backend->emit(2, 20 + static_cast<std::int64_t>(value), value,
                          960, 540);
  }
  const auto stats = fixture.capture->stats();
  require(stats.frames.maximum_queue_depth <= kMaximumWindowFrames &&
              stats.frames.dropped_frames >= 6 && stats.resize_count == 1 &&
              stats.generation == 2,
          "window queue or generation accounting exceeded its bound");
  require(fixture.capture->stop(100ms).ok,
          "bounded window capture did not stop");
}

void cancelledResizeRestoresFramesWithoutPublicTransition() {
  Fixture fixture;
  require(fixture.capture->start().ok, "window capture did not start");
  fixture.backend->resizePending(800, 450);
  fixture.backend->emit(1, 1, 1);
  require(!fixture.capture->waitForFrame(1ms),
          "frame escaped while resize was pending");
  fixture.backend->resizeCancelled(640, 360);
  fixture.backend->emit(1, 2, 2);
  require(fixture.capture->waitForFrame(10ms).has_value(),
          "cancelled resize did not restore frame delivery");
  auto event = fixture.capture->waitForEvent(1ms);
  require(event && event->kind == WindowCaptureEventKind::Running,
          "cancelled resize created a false public transition");
  require(fixture.capture->stats().resize_count == 0,
          "cancelled resize incremented the public resize count");
}

void noContentAndCloseAreExplicitAndExactlyOnce() {
  Fixture fixture;
  require(fixture.capture->start().ok, "window capture did not start");
  (void)fixture.capture->waitForEvent(10ms);
  fixture.backend->noContent(true);
  fixture.backend->noContent(true);
  fixture.backend->noContent(false);
  const auto no_content = fixture.capture->waitForEvent(10ms);
  const auto restored = fixture.capture->waitForEvent(10ms);
  require(no_content && restored &&
              no_content->kind ==
                  WindowCaptureEventKind::TemporarilyNoContent &&
              restored->kind == WindowCaptureEventKind::ContentRestored &&
              fixture.capture->stats().no_content_intervals == 1,
          "no-content transitions were duplicated or collapsed");

  fixture.enumerator_state->status = ResolveStatus::Removed;
  fixture.backend->close();
  fixture.backend->close();
  const auto closed = fixture.capture->waitForEvent(10ms);
  require(closed && closed->kind == WindowCaptureEventKind::SourceClosed &&
              fixture.capture->state() == CaptureState::Stopped &&
              fixture.capture->terminalFailure() &&
              fixture.capture->terminalFailure()->code == "source_closed",
          "window close did not produce one typed terminal result");
  require(fixture.capture->stop(100ms).ok &&
              fixture.capture->stop(100ms).ok && fixture.backend->stops == 1,
          "close/stop race did not preserve exactly-once backend teardown");
}

void closeRacingFrameDeliveryIsTerminalOnce() {
  Fixture fixture;
  require(fixture.capture->start().ok, "window capture did not start");
  (void)fixture.capture->waitForEvent(10ms);
  std::atomic<bool> go{false};
  std::thread deliver([&] {
    while (!go.load()) std::this_thread::yield();
    for (std::uint64_t frame = 1; frame <= 100; ++frame) {
      fixture.backend->emit(1, static_cast<std::int64_t>(frame), frame);
    }
  });
  std::thread close([&] {
    go.store(true);
    fixture.enumerator_state->status = ResolveStatus::Removed;
    fixture.backend->close();
  });
  deliver.join();
  close.join();
  std::size_t close_events = 0;
  while (const auto event = fixture.capture->waitForEvent(1ms)) {
    if (event->kind == WindowCaptureEventKind::SourceClosed) ++close_events;
  }
  require(close_events == 1 && !fixture.capture->waitForFrame(1ms) &&
              fixture.capture->state() == CaptureState::Stopped &&
              fixture.capture->stop(100ms).ok &&
              fixture.backend->stops == 1,
          "frame callback/close race produced a duplicate terminal result");
}

void unresolvedAndWrongKindSourcesAreRejected() {
  auto unavailable = std::make_unique<FakeEnumerator>();
  auto* unavailable_state = unavailable.get();
  SourceRegistry registry(std::move(unavailable));
  const auto id = registry.enumerate().sources.at(0).id;
  unavailable_state->status = ResolveStatus::Stale;
  auto backend = std::make_unique<FakeBackend>();
  WindowCapture replaced(registry, id, std::move(backend));
  const auto result = replaced.start();
  require(!result.ok && result.failure &&
              result.failure->code == "source_replaced",
          "stale window identity was not rejected as source_replaced");

  auto monitor = std::make_unique<FakeEnumerator>();
  monitor->kind = SourceKind::Monitor;
  SourceRegistry monitor_registry(std::move(monitor));
  const auto monitor_id = monitor_registry.enumerate().sources.at(0).id;
  auto monitor_backend = std::make_unique<FakeBackend>();
  WindowCapture wrong_kind(monitor_registry, monitor_id,
                           std::move(monitor_backend));
  const auto mismatch = wrong_kind.start();
  require(!mismatch.ok && mismatch.failure &&
              mismatch.failure->code == "source_kind_mismatch",
          "monitor source entered window capture");
}

void outstandingLeaseHasBoundedStopFailure() {
  Fixture fixture;
  require(fixture.capture->start().ok, "window capture did not start");
  fixture.backend->emit(1, 1, 1);
  auto lease = fixture.capture->waitForFrame(10ms);
  require(lease.has_value(), "outstanding lease was absent");
  const auto stopped = fixture.capture->stop(1ms);
  require(!stopped.ok && stopped.failure &&
              stopped.failure->code == "frame_lease_deadline_exceeded",
          "outstanding window lease did not return a typed deadline");
  lease->release();
}

void lateReleaseAndOwnerDestructionAreSafe() {
  Fixture fixture;
  require(fixture.capture->start().ok, "window capture did not start");
  fixture.backend->emit(1, 1, 91);
  auto lease = fixture.capture->waitForFrame(10ms);
  require(lease.has_value(), "late-release lease was absent");
  CaptureStopResult stopped;
  std::thread stopper([&] { stopped = fixture.capture->stop(200ms); });
  std::this_thread::sleep_for(10ms);
  require(lease->sampledHash() == 91,
          "live lease resource changed before release");
  lease->release();
  stopper.join();
  require(stopped.ok, "lease released before deadline did not unblock stop");

  Fixture destroyed;
  require(destroyed.capture->start().ok, "destruction capture did not start");
  destroyed.backend->emit(1, 1, 92);
  auto surviving = destroyed.capture->waitForFrame(10ms);
  require(surviving.has_value(), "destruction lease was absent");
  destroyed.capture.reset();
  require(surviving->sampledHash() == 92,
          "owner destruction invalidated the bounded frame lease");
  surviving->release();
}

void stopRacingResizeIgnoresLateGeneration() {
  Fixture fixture;
  require(fixture.capture->start().ok, "window capture did not start");
  std::thread resize([&] {
    fixture.backend->resizePending(800, 450);
    fixture.backend->resized(2, 800, 450);
    fixture.backend->emit(2, 2, 2, 800, 450);
  });
  const auto stopped = fixture.capture->stop(100ms);
  resize.join();
  require(stopped.ok && fixture.capture->state() == CaptureState::Stopped &&
              fixture.backend->stops == 1,
          "stop/resize race did not finish exactly once");
  require(!fixture.capture->waitForFrame(1ms),
          "late resize frame escaped terminal stop");
}

void removedBeforeStartIsTypedClosed() {
  auto enumerator = std::make_unique<FakeEnumerator>();
  auto* state = enumerator.get();
  SourceRegistry registry(std::move(enumerator));
  const auto id = registry.enumerate().sources.at(0).id;
  state->status = ResolveStatus::Removed;
  auto backend = std::make_unique<FakeBackend>();
  WindowCapture capture(registry, id, std::move(backend));
  const auto result = capture.start();
  require(!result.ok && result.failure &&
              result.failure->code == "source_closed",
          "window removed before start was not typed source_closed");
}

void handleReuseDuringStartIsRejected() {
  auto enumerator = std::make_unique<FakeEnumerator>();
  auto* state = enumerator.get();
  SourceRegistry registry(std::move(enumerator));
  const auto id = registry.enumerate().sources.at(0).id;
  auto backend = std::make_unique<FakeBackend>();
  auto* backend_state = backend.get();
  backend_state->on_start = [state] { state->target_value = 92; };
  WindowCapture capture(registry, id, std::move(backend));
  const auto result = capture.start();
  require(!result.ok && result.failure &&
              result.failure->code == "source_replaced" &&
              backend_state->stops == 1 && !capture.waitForFrame(1ms) &&
              !capture.waitForEvent(1ms),
          "HWND reuse during WGC startup escaped post-validation");
}

void backendStartFailureUsesPostValidationType() {
  auto enumerator = std::make_unique<FakeEnumerator>();
  auto* state = enumerator.get();
  SourceRegistry registry(std::move(enumerator));
  const auto id = registry.enumerate().sources.at(0).id;
  auto backend = std::make_unique<FakeBackend>();
  auto* backend_state = backend.get();
  backend_state->on_start = [state] { state->status = ResolveStatus::Removed; };
  backend_state->start_result = {
      false, CaptureFailure{"wgc_start_failed", "fixture platform failure"}};
  WindowCapture capture(registry, id, std::move(backend));
  const auto result = capture.start();
  require(!result.ok && result.failure &&
              result.failure->code == "source_closed" &&
              backend_state->stops == 1,
          "close during backend start was not post-validated as source_closed");
}

void terminalSignalRevalidatesWindowIdentity() {
  Fixture fixture;
  require(fixture.capture->start().ok, "window capture did not start");
  (void)fixture.capture->waitForEvent(10ms);
  fixture.enumerator_state->status = ResolveStatus::Stale;
  fixture.backend->close();
  const auto closed = fixture.capture->waitForEvent(10ms);
  require(closed && closed->kind == WindowCaptureEventKind::SourceClosed &&
              fixture.capture->terminalFailure() &&
              fixture.capture->terminalFailure()->code == "source_replaced",
          "terminal source signal did not revalidate a recycled identity");
  require(fixture.capture->stop(100ms).ok,
          "replaced window capture did not stop cleanly");
}

void concurrentStopsSerializeFinalize() {
  Fixture fixture;
  require(fixture.capture->start().ok, "window capture did not start");
  fixture.backend->block_stop = true;
  CaptureStopResult first;
  std::thread owner([&] { first = fixture.capture->stop(500ms); });
  fixture.backend->waitForStopEntry();
  const auto second = fixture.capture->stop(5ms);
  require(!second.ok && second.failure &&
              second.failure->code ==
                  "capture_stop_in_progress_deadline_exceeded" &&
              fixture.backend->finalizes == 0,
          "concurrent stop finalized a backend still being cleaned");
  fixture.backend->releaseStop();
  owner.join();
  require(first.ok && fixture.backend->finalizes == 1,
          "stop owner did not finalize exactly once");
}

}  // namespace

int main() try {
  generationFenceAndQueueAreBounded();
  cancelledResizeRestoresFramesWithoutPublicTransition();
  noContentAndCloseAreExplicitAndExactlyOnce();
  closeRacingFrameDeliveryIsTerminalOnce();
  unresolvedAndWrongKindSourcesAreRejected();
  outstandingLeaseHasBoundedStopFailure();
  lateReleaseAndOwnerDestructionAreSafe();
  stopRacingResizeIgnoresLateGeneration();
  removedBeforeStartIsTypedClosed();
  handleReuseDuringStartIsRejected();
  backendStartFailureUsesPostValidationType();
  terminalSignalRevalidatesWindowIdentity();
  concurrentStopsSerializeFinalize();
  std::cout << "window-capture-tests:ok\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << "window-capture-tests:failed " << error.what() << '\n';
  return 1;
}
