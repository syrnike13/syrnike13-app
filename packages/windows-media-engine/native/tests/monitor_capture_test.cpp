#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <future>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "capture/monitor_capture.hpp"

namespace syrnike::windows_media::capture::tests {
void processDeviceIsSharedAndVideoCapable();
}

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
  std::vector<SourceCandidate> candidates;
  bool target_available = true;

  EnumerationBatch enumerate(const EnumerationOptions&) override {
    EnumerationBatch batch;
    batch.candidates = candidates;
    return batch;
  }

  ResolveStatus validate(SourceKind, const std::string& identity) override {
    return target_available && identity == "monitor-a" ? ResolveStatus::Available
                                                       : ResolveStatus::Removed;
  }

  MonitorTargetResult resolveMonitorTarget(
      const std::string& identity) override {
    if (!target_available || identity != "monitor-a") {
      return {ResolveStatus::Removed, std::nullopt};
    }
    return {ResolveStatus::Available, MonitorTargetToken{41}};
  }
};

class FakeBackend final : public MonitorCaptureBackend {
 public:
  BackendStartResult start(const MonitorTargetToken& target,
                           FrameCallback on_frame,
                           TerminalCallback on_terminal) override {
    ++starts;
    target_valid = target.valid();
    frame = std::move(on_frame);
    terminal = std::move(on_terminal);
    if (terminal_during_start) {
      terminal(CaptureFailure{"source_removed", "removed during start"});
    }
    return start_result;
  }

  CaptureStopResult stop(
      std::chrono::steady_clock::time_point) noexcept override {
    ++stops;
    return {};
  }

  void emit(std::int64_t timestamp, std::uint64_t hash) {
    frame(BackendFrame{timestamp, 640, 360, FramePixelFormat::Bgra8,
                       std::make_shared<FakeResource>(hash)});
  }

  void fail(std::string code) {
    terminal(CaptureFailure{std::move(code), "fake terminal failure"});
  }

  BackendStartResult start_result;
  FrameCallback frame;
  TerminalCallback terminal;
  int starts = 0;
  int stops = 0;
  bool target_valid = false;
  bool terminal_during_start = false;
};

class BlockingTargetEnumerator final : public SourceEnumerator {
 public:
  EnumerationBatch enumerate(const EnumerationOptions&) override {
    EnumerationBatch batch;
    SourceCandidate value;
    value.kind = SourceKind::Monitor;
    value.identity = "monitor-a";
    value.title = "Display";
    value.label = "Display";
    value.monitor = MonitorMetadata{};
    batch.candidates = {std::move(value)};
    return batch;
  }

  ResolveStatus validate(SourceKind, const std::string&) override {
    return ResolveStatus::Available;
  }

  MonitorTargetResult resolveMonitorTarget(const std::string&) override {
    std::unique_lock lock(mutex);
    entered = true;
    changed.notify_all();
    changed.wait(lock, [this] { return released; });
    if (result_status != ResolveStatus::Available) {
      return {result_status, std::nullopt};
    }
    return {ResolveStatus::Available, MonitorTargetToken{41}};
  }

  void waitUntilEntered() {
    std::unique_lock lock(mutex);
    changed.wait(lock, [this] { return entered; });
  }

  void release() {
    {
      std::lock_guard lock(mutex);
      released = true;
    }
    changed.notify_all();
  }

  std::mutex mutex;
  std::condition_variable changed;
  bool entered = false;
  bool released = false;
  ResolveStatus result_status = ResolveStatus::Available;
};

class BlockingStartBackend final : public MonitorCaptureBackend {
 public:
  BackendStartResult start(const MonitorTargetToken&, FrameCallback,
                           TerminalCallback) override {
    std::unique_lock lock(mutex_);
    entered_ = true;
    condition_.notify_all();
    condition_.wait(lock, [this] { return stopped_; });
    return {};
  }

  CaptureStopResult stop(
      std::chrono::steady_clock::time_point) noexcept override {
    std::lock_guard lock(mutex_);
    stopped_ = true;
    condition_.notify_all();
    return {};
  }

  void waitUntilEntered() {
    std::unique_lock lock(mutex_);
    condition_.wait(lock, [this] { return entered_; });
  }

 private:
  std::mutex mutex_;
  std::condition_variable condition_;
  bool entered_ = false;
  bool stopped_ = false;
};

class DeadlineStopBackend final : public MonitorCaptureBackend {
 public:
  BackendStartResult start(const MonitorTargetToken&, FrameCallback,
                           TerminalCallback) override {
    return {};
  }

  CaptureStopResult stop(
      std::chrono::steady_clock::time_point deadline) noexcept override {
    std::mutex mutex;
    std::unique_lock lock(mutex);
    condition_.wait_until(lock, deadline);
    return {false,
            CaptureFailure{"wgc_callback_deadline_exceeded",
                           "simulated callback exceeded deadline"}};
  }

 private:
  std::condition_variable condition_;
};

SourceCandidate monitorCandidate() {
  SourceCandidate value;
  value.kind = SourceKind::Monitor;
  value.identity = "monitor-a";
  value.title = "Display";
  value.label = "Display";
  value.monitor = MonitorMetadata{};
  return value;
}

void sourceMustResolveAsAvailableMonitor() {
  auto enumerator = std::make_unique<FakeEnumerator>();
  auto* fake_enumerator = enumerator.get();
  fake_enumerator->candidates = {monitorCandidate()};
  SourceRegistry registry(std::move(enumerator));
  const auto source = registry.enumerate().sources.at(0);

  auto backend = std::make_unique<FakeBackend>();
  auto* fake_backend = backend.get();
  MonitorCapture capture(registry, source.id, std::move(backend));
  require(capture.start().ok && fake_backend->starts == 1 &&
              fake_backend->target_valid,
          "available monitor did not cross the validated target seam");
  require(capture.stop(100ms).ok, "clean capture stop failed");

  auto removed_enumerator = std::make_unique<FakeEnumerator>();
  removed_enumerator->candidates = {monitorCandidate()};
  auto* removed_fake = removed_enumerator.get();
  SourceRegistry removed_registry(std::move(removed_enumerator));
  const auto removed_id = removed_registry.enumerate().sources.at(0).id;
  removed_fake->target_available = false;
  auto unused_backend = std::make_unique<FakeBackend>();
  auto* unused = unused_backend.get();
  MonitorCapture removed_capture(removed_registry, removed_id,
                                 std::move(unused_backend));
  const auto failed = removed_capture.start();
  require(!failed.ok && failed.failure &&
              failed.failure->code == "source_unavailable" &&
              unused->starts == 0,
          "removed monitor reached the capture backend");
}

void latestWinsQueueAndLeaseAreBounded() {
  auto enumerator = std::make_unique<FakeEnumerator>();
  enumerator->candidates = {monitorCandidate()};
  SourceRegistry registry(std::move(enumerator));
  const auto source = registry.enumerate().sources.at(0);
  auto backend = std::make_unique<FakeBackend>();
  auto* fake = backend.get();
  MonitorCapture capture(registry, source.id, std::move(backend));
  require(capture.start().ok, "capture did not start");

  fake->emit(10, 10);
  fake->emit(20, 20);
  fake->emit(30, 30);
  fake->emit(40, 40);
  const auto stats = capture.stats();
  require(stats.received_frames == 4 && stats.dropped_frames == 1 &&
              stats.maximum_queue_depth == kMaximumMonitorFrames,
          "latest-wins queue exceeded capacity or hid supersession");

  auto first = capture.waitForFrame(0ms);
  auto second = capture.waitForFrame(0ms);
  auto third = capture.waitForFrame(0ms);
  require(first && second && third && first->metadata().sequence == 2 &&
              second->metadata().sequence == 3 &&
              third->metadata().sequence == 4 &&
              first->sampledHash() == 20 && third->sampledHash() == 40,
          "slow consumer did not receive the latest bounded frame set");
  require(third->release() == LeaseReleaseStatus::Released &&
              third->release() == LeaseReleaseStatus::AlreadyReleased,
          "double release was not safely rejected");
  first->release();
  second->release();
  require(capture.stop(100ms).ok, "released leases blocked stop");
}

void stopDuringStartIsBounded() {
  auto enumerator = std::make_unique<FakeEnumerator>();
  enumerator->candidates = {monitorCandidate()};
  SourceRegistry registry(std::move(enumerator));
  const auto source = registry.enumerate().sources.at(0);
  auto backend = std::make_unique<BlockingStartBackend>();
  auto* blocking = backend.get();
  MonitorCapture capture(registry, source.id, std::move(backend));

  CaptureStartResult start_result;
  std::thread starter([&] { start_result = capture.start(); });
  blocking->waitUntilEntered();
  const auto stop_result = capture.stop(100ms);
  starter.join();

  require(stop_result.ok && !start_result.ok && start_result.failure &&
              start_result.failure->code == "start_cancelled" &&
              capture.state() == CaptureState::Stopped,
          "stop during start did not cancel the session deterministically");
}

void stopWaitsForRegistryResolutionBeforeReturning() {
  auto enumerator = std::make_unique<BlockingTargetEnumerator>();
  auto* blocking = enumerator.get();
  blocking->result_status = ResolveStatus::Removed;
  SourceRegistry registry(std::move(enumerator));
  const auto source = registry.enumerate().sources.at(0);
  auto backend = std::make_unique<FakeBackend>();
  auto* fake = backend.get();
  MonitorCapture capture(registry, source.id, std::move(backend));

  CaptureStartResult start_result;
  std::thread starter([&] { start_result = capture.start(); });
  blocking->waitUntilEntered();

  std::promise<CaptureStopResult> stopped_promise;
  auto stopped_future = stopped_promise.get_future();
  std::thread stopper(
      [&] { stopped_promise.set_value(capture.stop(1s)); });
  const bool returned_before_start =
      stopped_future.wait_for(20ms) == std::future_status::ready;
  blocking->release();
  starter.join();
  stopper.join();
  const auto stop_result = stopped_future.get();

  require(!returned_before_start && stop_result.ok && !start_result.ok &&
              start_result.failure &&
              start_result.failure->code == "start_cancelled" &&
              capture.state() == CaptureState::Stopped && fake->starts == 0,
          "stop returned while start still used capture-owned state");
}

void terminalDuringBackendStartRollsBackBackend() {
  auto enumerator = std::make_unique<FakeEnumerator>();
  enumerator->candidates = {monitorCandidate()};
  SourceRegistry registry(std::move(enumerator));
  const auto source = registry.enumerate().sources.at(0);
  auto backend = std::make_unique<FakeBackend>();
  auto* fake = backend.get();
  fake->terminal_during_start = true;
  MonitorCapture capture(registry, source.id, std::move(backend));

  const auto started = capture.start();
  require(!started.ok && started.failure &&
              started.failure->code == "source_removed" && fake->stops == 1,
          "terminal callback during backend start did not roll back backend");
}

void frameLeaseCanOutliveCaptureOwnerSafely() {
  auto enumerator = std::make_unique<FakeEnumerator>();
  enumerator->candidates = {monitorCandidate()};
  SourceRegistry registry(std::move(enumerator));
  const auto source = registry.enumerate().sources.at(0);
  std::optional<FrameLease> lease;
  {
    auto backend = std::make_unique<FakeBackend>();
    auto* fake = backend.get();
    MonitorCapture capture(registry, source.id, std::move(backend));
    require(capture.start().ok, "outliving-lease capture did not start");
    fake->emit(10, 77);
    lease = capture.waitForFrame(0ms);
    require(lease.has_value(), "outliving frame lease was absent");
  }
  require(lease && lease->sampledHash() == 77 &&
              lease->release() == LeaseReleaseStatus::Released,
          "capture destruction invalidated an outstanding frame lease");
}

void backendStopCannotExceedTheCallerDeadline() {
  auto enumerator = std::make_unique<FakeEnumerator>();
  enumerator->candidates = {monitorCandidate()};
  SourceRegistry registry(std::move(enumerator));
  const auto source = registry.enumerate().sources.at(0);
  MonitorCapture capture(registry, source.id,
                         std::make_unique<DeadlineStopBackend>());
  require(capture.start().ok, "deadline backend did not start");
  const auto began = std::chrono::steady_clock::now();
  const auto stopped = capture.stop(20ms);
  const auto elapsed = std::chrono::steady_clock::now() - began;
  const auto repeated = capture.stop(20ms);
  require(!stopped.ok && stopped.failure &&
              stopped.failure->code == "wgc_callback_deadline_exceeded" &&
              !repeated.ok && repeated.failure &&
              repeated.failure->code == "wgc_callback_deadline_exceeded" &&
              elapsed < 200ms,
          "backend stop ignored the caller's absolute deadline");
}

void lateFramesAndOutstandingLeasesAreBounded() {
  auto enumerator = std::make_unique<FakeEnumerator>();
  enumerator->candidates = {monitorCandidate()};
  SourceRegistry registry(std::move(enumerator));
  const auto source = registry.enumerate().sources.at(0);
  auto backend = std::make_unique<FakeBackend>();
  auto* fake = backend.get();
  MonitorCapture capture(registry, source.id, std::move(backend));
  require(capture.start().ok, "capture did not start");
  fake->emit(10, 10);
  auto lease = capture.waitForFrame(0ms);
  require(lease.has_value(), "capture did not return a frame lease");

  const auto timed_out = capture.stop(0ms);
  require(!timed_out.ok && timed_out.failure &&
              timed_out.failure->code == "frame_lease_deadline_exceeded",
          "outstanding lease did not produce a typed stop failure");
  fake->emit(20, 20);
  require(capture.stats().received_frames == 1 &&
              !capture.waitForFrame(0ms).has_value(),
          "late backend frame escaped a stopped session");
  require(lease->release() == LeaseReleaseStatus::Released &&
              capture.stop(100ms).ok,
          "late lease release did not unblock repeated stop");
}

void captureOwnsFiftyCleanSessions() {
  auto enumerator = std::make_unique<FakeEnumerator>();
  enumerator->candidates = {monitorCandidate()};
  SourceRegistry registry(std::move(enumerator));
  const auto source = registry.enumerate().sources.at(0);
  for (int cycle = 0; cycle < 50; ++cycle) {
    auto backend = std::make_unique<FakeBackend>();
    auto* fake = backend.get();
    MonitorCapture capture(registry, source.id, std::move(backend));
    require(capture.start().ok, "repeat capture did not start");
    fake->emit(cycle + 1, static_cast<std::uint64_t>(cycle + 1));
    auto lease = capture.waitForFrame(0ms);
    require(lease && lease->sampledHash() ==
                         static_cast<std::uint64_t>(cycle + 1),
            "repeat capture returned the wrong resource");
    lease->release();
    require(capture.stop(100ms).ok && fake->starts == 1 && fake->stops == 1,
            "repeat capture did not own exactly one backend lifetime");
  }
}

void stopContractsCoverStaticTerminalAndLateRelease() {
  auto enumerator = std::make_unique<FakeEnumerator>();
  enumerator->candidates = {monitorCandidate()};
  SourceRegistry registry(std::move(enumerator));
  const auto source = registry.enumerate().sources.at(0);

  {
    auto backend = std::make_unique<FakeBackend>();
    auto* fake = backend.get();
    MonitorCapture capture(registry, source.id, std::move(backend));
    require(capture.start().ok && !capture.waitForFrame(1ms),
            "static interval was treated as a capture failure");
    require(capture.stop(100ms).ok && capture.stop(100ms).ok &&
                fake->starts == 1 && fake->stops == 1,
            "double stop restarted or stopped the backend twice");
  }

  {
    auto backend = std::make_unique<FakeBackend>();
    auto* fake = backend.get();
    MonitorCapture capture(registry, source.id, std::move(backend));
    require(capture.start().ok, "late-release capture did not start");
    fake->emit(10, 10);
    auto lease = capture.waitForFrame(0ms);
    require(lease.has_value(), "late-release frame was absent");
    std::thread releaser([&] {
      std::this_thread::sleep_for(10ms);
      lease->release();
    });
    const auto stopped = capture.stop(1s);
    releaser.join();
    require(stopped.ok, "lease released before deadline did not unblock stop");
  }

  {
    auto backend = std::make_unique<FakeBackend>();
    auto* fake = backend.get();
    MonitorCapture capture(registry, source.id, std::move(backend));
    require(capture.start().ok, "terminal capture did not start");
    fake->fail("source_removed");
    const auto failure = capture.terminalFailure();
    require(capture.state() == CaptureState::Failed && failure &&
                failure->code == "source_removed" && capture.stop(100ms).ok &&
                fake->stops == 1,
            "source removal did not produce terminal teardown");
  }
}

}  // namespace

int main() try {
  syrnike::windows_media::capture::tests::
      processDeviceIsSharedAndVideoCapable();
  sourceMustResolveAsAvailableMonitor();
  latestWinsQueueAndLeaseAreBounded();
  stopDuringStartIsBounded();
  stopWaitsForRegistryResolutionBeforeReturning();
  terminalDuringBackendStartRollsBackBackend();
  frameLeaseCanOutliveCaptureOwnerSafely();
  backendStopCannotExceedTheCallerDeadline();
  lateFramesAndOutstandingLeasesAreBounded();
  captureOwnsFiftyCleanSessions();
  stopContractsCoverStaticTerminalAndLateRelease();
  std::cout << "monitor-capture:ok\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
