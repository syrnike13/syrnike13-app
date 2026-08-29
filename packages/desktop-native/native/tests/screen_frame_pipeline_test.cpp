#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

#include "common/cleanup_supervisor.hpp"
#include "media/screen_frame_pipeline.hpp"
#include "media/screen_gpu_retirement.hpp"

namespace {

class FakeRetirementCapturer
    : public syrnike::desktop_native::media::ScreenGpuCapturer {
 public:
  void holdPendingPreview() noexcept {
    pending_preview_.store(true, std::memory_order_release);
  }

  void holdDeliveredPreview() noexcept {
    delivered_preview_.store(true, std::memory_order_release);
  }

  void holdEncoderFrame() noexcept {
    encoder_frame_.store(true, std::memory_order_release);
  }

  void blockRetirementPoll() noexcept {
    std::lock_guard lock(poll_mutex_);
    block_poll_ = true;
  }

  bool waitForRetirementPoll(std::chrono::milliseconds timeout) {
    std::unique_lock lock(poll_mutex_);
    return poll_changed_.wait_for(
        lock, timeout, [&] { return poll_started_; });
  }

  void releaseRetirementPoll() noexcept {
    {
      std::lock_guard lock(poll_mutex_);
      block_poll_ = false;
    }
    poll_changed_.notify_all();
  }

  [[nodiscard]] bool demanded() const noexcept {
    return demanded_.load(std::memory_order_acquire);
  }

  [[nodiscard]] bool pendingPreview() const noexcept {
    return pending_preview_.load(std::memory_order_acquire);
  }

  [[nodiscard]] std::uint64_t discardCount() const noexcept {
    return discard_count_.load(std::memory_order_acquire);
  }

  syrnike::desktop_native::media::ScreenGpuFrameResult capture(
      syrnike::desktop_native::media::ScreenGpuFrame&) override {
    return {};
  }

  void discard(
      const syrnike::desktop_native::media::ScreenGpuFrame&) noexcept override {
    encoder_frame_.store(false, std::memory_order_release);
    discard_count_.fetch_add(1, std::memory_order_relaxed);
  }

  void setPreviewDemand(
      syrnike::desktop_native::media::ScreenPreviewDemand demand) override {
    demanded_.store(demand.demanded, std::memory_order_release);
    if (!demand.demanded) {
      // Pending/ready work was never handed to Electron and has no renderer
      // fence, so detaching demand must return it immediately. A delivered
      // frame remains held until releasePreviewFrame acknowledges its fence.
      pending_preview_.store(false, std::memory_order_release);
    }
  }

  bool takePreviewFrame(
      syrnike::desktop_native::media::ScreenPreviewFrame&) override {
    return false;
  }

  bool takePreviewFailure(
      syrnike::desktop_native::media::ScreenPreviewFailure&) override {
    return false;
  }

  void releasePreviewFrame(std::uint64_t) noexcept override {
    delivered_preview_.store(false, std::memory_order_release);
    preview_release_count_.fetch_add(1, std::memory_order_relaxed);
  }

  [[nodiscard]] std::uint64_t previewReleaseCount() const noexcept {
    return preview_release_count_.load(std::memory_order_acquire);
  }

  [[nodiscard]] std::size_t previewFramesInFlight() const noexcept override {
    return pending_preview_.load(std::memory_order_acquire) ||
            delivered_preview_.load(std::memory_order_acquire)
        ? 1
        : 0;
  }

  [[nodiscard]] const char* method() const noexcept override {
    return "fake_retirement";
  }

  [[nodiscard]] LUID adapterLuid() const noexcept override { return {}; }

  [[nodiscard]] std::size_t frameSlotsAvailable() const noexcept override {
    return encoder_frame_.load(std::memory_order_acquire) ? 0 : 1;
  }

  [[nodiscard]] std::size_t frameSlotsTotal() const noexcept override {
    return 1;
  }

  void pollRetirement() noexcept override {
    std::unique_lock lock(poll_mutex_);
    poll_started_ = true;
    poll_changed_.notify_all();
    poll_changed_.wait(lock, [&] { return !block_poll_; });
  }

  [[nodiscard]] syrnike::desktop_native::media::ScreenFrameFlowStats
  frameFlowStats() const noexcept override {
    syrnike::desktop_native::media::ScreenFrameFlowStats stats;
    stats.gpu_submissions = 1;
    return stats;
  }

 private:
  std::atomic_bool demanded_{true};
  std::atomic_bool pending_preview_{false};
  std::atomic_bool delivered_preview_{false};
  std::atomic_bool encoder_frame_{false};
  std::atomic<std::uint64_t> discard_count_{0};
  std::atomic<std::uint64_t> preview_release_count_{0};
  std::mutex poll_mutex_;
  std::condition_variable poll_changed_;
  bool block_poll_ = false;
  bool poll_started_ = false;
};

struct CapturerDestructionGate {
  std::mutex mutex;
  std::condition_variable changed;
  std::atomic<std::uint64_t> preview_releases{0};
  bool entered = false;
  bool release = false;
  std::thread::id thread;
};

class BlockingDestructionCapturer final : public FakeRetirementCapturer {
 public:
  explicit BlockingDestructionCapturer(
      std::shared_ptr<CapturerDestructionGate> gate)
      : gate_(std::move(gate)) {}

  ~BlockingDestructionCapturer() override {
    std::unique_lock lock(gate_->mutex);
    gate_->entered = true;
    gate_->thread = std::this_thread::get_id();
    gate_->changed.notify_all();
    static_cast<void>(gate_->changed.wait_for(
        lock, std::chrono::seconds(2), [&] { return gate_->release; }));
  }

  void releasePreviewFrame(std::uint64_t sequence) noexcept override {
    FakeRetirementCapturer::releasePreviewFrame(sequence);
    gate_->preview_releases.fetch_add(1, std::memory_order_release);
  }

 private:
  std::shared_ptr<CapturerDestructionGate> gate_;
};

void verifyFinalPreviewReleaseHandsDestructionToCleanupSupervisor() {
  using namespace std::chrono_literals;
  using syrnike::desktop_native::CleanupJob;
  using syrnike::desktop_native::CleanupSupervisor;
  using syrnike::desktop_native::CleanupSupervisorConfig;
  using syrnike::desktop_native::media::ScreenGpuCapturer;
  using syrnike::desktop_native::media::ScreenPreviewReleaseDetach;
  using syrnike::desktop_native::media::releaseScreenPreviewFrameWithRetirement;

  CleanupSupervisor supervisor(CleanupSupervisorConfig{
      .worker_limit = 1,
      .admission_capacity = 2,
  });
  auto gate = std::make_shared<CapturerDestructionGate>();
  auto concrete = std::make_shared<BlockingDestructionCapturer>(gate);
  concrete->holdDeliveredPreview();
  std::weak_ptr<ScreenGpuCapturer> weak = concrete;
  std::shared_ptr<ScreenGpuCapturer> registered = concrete;
  concrete.reset();

  std::shared_ptr<CleanupJob> cleanup;
  const auto caller = std::this_thread::get_id();
  const auto started = std::chrono::steady_clock::now();
  releaseScreenPreviewFrameWithRetirement(
      registered,
      41,
      [&](const std::shared_ptr<ScreenGpuCapturer>& expected) {
        ScreenPreviewReleaseDetach detached;
        if (registered == expected) {
          detached.capturer = std::move(registered);
        }
        return detached;
      },
      [&](std::shared_ptr<ScreenGpuCapturer> retired) {
        auto owner = std::make_shared<std::shared_ptr<ScreenGpuCapturer>>(
            std::move(retired));
        cleanup = std::make_shared<CleanupJob>();
        if (!cleanup->prepare(
                owner,
                reinterpret_cast<std::uintptr_t>(gate.get()),
                [](void* context) {
                  static_cast<std::shared_ptr<ScreenGpuCapturer>*>(context)
                      ->reset();
                })) {
          throw std::runtime_error("failed to prepare preview cleanup job");
        }
        supervisor.submitOrEscalate(cleanup, "screen_preview_release_test");
      });
  const auto elapsed = std::chrono::steady_clock::now() - started;

  {
    std::unique_lock lock(gate->mutex);
    if (!gate->changed.wait_for(lock, 1s, [&] { return gate->entered; })) {
      throw std::runtime_error(
          "final preview owner did not reach cleanup supervisor");
    }
    if (gate->thread == caller) {
      throw std::runtime_error(
          "final preview capturer destructor ran on the control caller");
    }
  }
  if (elapsed >= 100ms || registered || !cleanup ||
      gate->preview_releases.load(std::memory_order_acquire) != 1) {
    throw std::runtime_error(
        "final preview release blocked or lost its exact fence handoff");
  }
  {
    std::lock_guard lock(gate->mutex);
    gate->release = true;
  }
  gate->changed.notify_all();
  if (!cleanup->waitUntil(std::chrono::steady_clock::now() + 1s) ||
      !weak.expired()) {
    throw std::runtime_error(
        "preview cleanup did not release the final capturer owner");
  }
  const auto report = supervisor.shutdown(
      std::chrono::steady_clock::now() + 1s);
  if (!report.finished || report.unfinished_jobs != 0) {
    throw std::runtime_error("preview cleanup supervisor did not quiesce");
  }
}

void verifyRetiredPreviewDetachesPendingButPreservesDeliveredFence() {
  using syrnike::desktop_native::media::ScreenGpuCapturer;
  using syrnike::desktop_native::media::ScreenGpuRetirementLane;
  using syrnike::desktop_native::media::ScreenPreviewDemand;

  ScreenGpuRetirementLane retirement;
  auto pending = std::make_shared<FakeRetirementCapturer>();
  pending->holdPendingPreview();
  const std::vector<std::shared_ptr<ScreenGpuCapturer>> pending_backend{
      pending};
  if (!retirement.canRetire(pending_backend)) {
    throw std::runtime_error("pending preview unexpectedly exhausted retirement");
  }
  auto pending_plan = retirement.prepare(
      pending_backend, ScreenPreviewDemand{.demanded = true});
  if (!retirement.commit(pending_plan) || retirement.size() != 0 ||
      pending->demanded() || pending->pendingPreview()) {
    throw std::runtime_error(
        "pending-undelivered preview did not return to baseline on retire");
  }

  auto delivered = std::make_shared<FakeRetirementCapturer>();
  delivered->holdPendingPreview();
  delivered->holdDeliveredPreview();
  delivered->holdEncoderFrame();
  const std::vector<std::shared_ptr<ScreenGpuCapturer>> delivered_backend{
      delivered};
  auto delivered_plan = retirement.prepare(
      delivered_backend, ScreenPreviewDemand{.demanded = true});
  if (!retirement.commit(delivered_plan) || retirement.size() != 1 ||
      delivered->demanded() || delivered->pendingPreview()) {
    throw std::runtime_error(
        "retirement dropped demand without preserving delivered fence");
  }
  retirement.poll();
  if (retirement.size() != 1 || retirement.pollPending()) {
    throw std::runtime_error("retirement released a renderer-held generation");
  }
  delivered->releasePreviewFrame(1);
  if (!retirement.pollPending()) {
    throw std::runtime_error(
        "renderer fence release did not expose pending retirement work");
  }
  const auto released_snapshot = retirement.snapshot();
  for (std::size_t index = 0; index < released_snapshot.size; ++index) {
    released_snapshot.capturers[index]->discard(
        syrnike::desktop_native::media::ScreenGpuFrame{});
  }
  retirement.poll();
  if (retirement.size() != 0 ||
      retirement.completedStats().gpu_submissions != 2) {
    throw std::runtime_error(
        "exact renderer release did not return retired capacity once");
  }
}

void verifyBlockedRetiredPollDoesNotBlockEncoderReleaseRouting() {
  using namespace std::chrono_literals;
  using syrnike::desktop_native::media::ScreenGpuCapturer;
  using syrnike::desktop_native::media::ScreenGpuFrame;
  using syrnike::desktop_native::media::ScreenGpuRetirementLane;
  using syrnike::desktop_native::media::ScreenPreviewDemand;

  ScreenGpuRetirementLane retirement;
  auto backend = std::make_shared<FakeRetirementCapturer>();
  backend->holdEncoderFrame();
  backend->blockRetirementPoll();
  const std::vector<std::shared_ptr<ScreenGpuCapturer>> candidates{backend};
  auto plan = retirement.prepare(
      candidates, ScreenPreviewDemand{.demanded = true});
  if (!retirement.commit(plan) || retirement.size() != 1) {
    throw std::runtime_error("blocking backend was not retained for cleanup");
  }

  std::thread poller([&] { retirement.poll(); });
  if (!backend->waitForRetirementPoll(1s)) {
    backend->releaseRetirementPoll();
    poller.join();
    throw std::runtime_error("retired poll did not enter injected block");
  }
  const auto release_started = std::chrono::steady_clock::now();
  const auto snapshot = retirement.snapshot();
  for (std::size_t index = 0; index < snapshot.size; ++index) {
    snapshot.capturers[index]->discard(ScreenGpuFrame{});
  }
  const auto release_elapsed =
      std::chrono::steady_clock::now() - release_started;
  backend->releaseRetirementPoll();
  poller.join();
  if (release_elapsed >= 100ms || backend->discardCount() != 1 ||
      retirement.size() != 0) {
    throw std::runtime_error(
        "blocked retired preview poll delayed encoder release routing");
  }
}

}  // namespace

int main() try {
  using namespace std::chrono_literals;
  using syrnike::desktop_native::media::ScreenFrameCadence;
  using syrnike::desktop_native::media::ScreenFrameSubmitReason;
  using syrnike::desktop_native::media::ScreenLatencyWindow;
  using syrnike::desktop_native::media::ScreenPreviewWorkLane;
  using syrnike::desktop_native::media::ScreenPreviewWorkSignal;
  using syrnike::desktop_native::media::ScreenTelemetryCadence;

  const auto started = ScreenFrameCadence::TimePoint{10s};
  ScreenFrameCadence cadence(1s);
  if (cadence.decision(started) != ScreenFrameSubmitReason::None) {
    throw std::runtime_error("cadence submitted without captured state");
  }
  cadence.noteSourceUpdate();
  if (cadence.decision(started) != ScreenFrameSubmitReason::SourceUpdate) {
    throw std::runtime_error("new source state was not selected immediately");
  }
  cadence.noteSourceUpdate();
  if (cadence.coalescedSourceUpdates() != 1) {
    throw std::runtime_error("unsubmitted source state was not coalesced");
  }
  cadence.noteSubmitted(ScreenFrameSubmitReason::SourceUpdate, started);
  if (cadence.decision(started + 999ms) != ScreenFrameSubmitReason::None ||
      cadence.decision(started + 1s) != ScreenFrameSubmitReason::IdleRefresh) {
    throw std::runtime_error("static refresh cadence was not bounded");
  }
  cadence.noteSubmitted(ScreenFrameSubmitReason::IdleRefresh, started + 1s);
  if (cadence.submissions() != 2 || cadence.idleRefreshes() != 1) {
    throw std::runtime_error("cadence submission counters diverged");
  }
  cadence.reset();
  if (cadence.decision(started + 2s) != ScreenFrameSubmitReason::None ||
      cadence.sourceRevision() != 0 || cadence.submissions() != 0 ||
      cadence.idleRefreshes() != 0 ||
      cadence.coalescedSourceUpdates() != 0) {
    throw std::runtime_error("cadence reset retained a previous generation");
  }

  ScreenLatencyWindow<8> latency;
  for (const std::uint64_t sample : {8U, 1U, 4U, 2U, 16U}) {
    latency.record(sample);
  }
  const auto quantiles = latency.snapshot();
  if (quantiles.p50_us != 4 || quantiles.p95_us != 16 ||
      quantiles.max_us != 16) {
    throw std::runtime_error("latency quantiles were calculated incorrectly");
  }

  // The capture thread records samples while the one-second telemetry worker
  // sorts a snapshot. Both sides must remain independent and race-free.
  ScreenLatencyWindow<64> concurrent_latency;
  ScreenFrameCadence concurrent_cadence(1s);
  std::atomic_bool telemetry_writer_done{false};
  std::thread telemetry_writer([&] {
    for (std::uint64_t sample = 1; sample <= 50'000; ++sample) {
      concurrent_latency.record(sample);
      concurrent_cadence.noteSourceUpdate();
    }
    telemetry_writer_done.store(true, std::memory_order_release);
  });
  std::uint64_t telemetry_snapshots = 0;
  do {
    const auto snapshot = concurrent_latency.snapshot();
    if (snapshot.p50_us > snapshot.p95_us ||
        snapshot.p95_us > snapshot.max_us) {
      throw std::runtime_error("concurrent telemetry quantiles were incoherent");
    }
    static_cast<void>(concurrent_cadence.sourceRevision());
    ++telemetry_snapshots;
  } while (!telemetry_writer_done.load(std::memory_order_acquire));
  telemetry_writer.join();
  if (telemetry_snapshots == 0 || concurrent_latency.size() != 64 ||
      concurrent_cadence.sourceRevision() != 50'000) {
    throw std::runtime_error("telemetry snapshot lane lost capture samples");
  }

  ScreenTelemetryCadence telemetry(1s);
  if (!telemetry.shouldSample(started) ||
      telemetry.shouldSample(started + 999ms) ||
      !telemetry.shouldSample(started + 1s) ||
      !telemetry.shouldSample(started + 5s) ||
      telemetry.shouldSample(started + 5s + 999ms) ||
      !telemetry.shouldSample(started + 6s)) {
    throw std::runtime_error("screen telemetry cadence recomputed hot-path stats");
  }

  ScreenPreviewWorkLane preview_lane;
  preview_lane.setEnabled(true);
  for (std::uint64_t revision = 1; revision <= 500; ++revision) {
    if (!preview_lane.request(revision)) {
      throw std::runtime_error("enabled preview lane rejected bounded work");
    }
  }
  const auto latest_preview = preview_lane.takeLatest();
  const auto preview_snapshot = preview_lane.snapshot();
  if (!latest_preview || *latest_preview != 500 ||
      preview_snapshot.pending != 0 ||
      preview_snapshot.coalesced != 499 ||
      preview_snapshot.requested != 500) {
    throw std::runtime_error(
        "blocked preview work did not coalesce to the latest frame");
  }
  preview_lane.setEnabled(false);
  if (preview_lane.request(501) || preview_lane.takeLatest()) {
    throw std::runtime_error("disabled preview lane retained new work");
  }
  if (preview_lane.snapshot().disabled_drops != 1) {
    throw std::runtime_error("disabled preview drop was not diagnosed");
  }

  auto preview_signal = std::make_shared<ScreenPreviewWorkSignal>();
  ScreenPreviewWorkLane event_driven_preview(preview_signal);
  event_driven_preview.setEnabled(true);
  const auto idle_epoch = preview_signal->epoch();
  std::atomic_bool idle_worker_woke{false};
  std::thread idle_worker([&] {
    if (preview_signal->waitForChange(idle_epoch)) {
      idle_worker_woke.store(true, std::memory_order_release);
    }
  });
  std::this_thread::sleep_for(25ms);
  if (idle_worker_woke.load(std::memory_order_acquire)) {
    preview_signal->stop();
    idle_worker.join();
    throw std::runtime_error("idle preview worker woke without work");
  }
  if (!event_driven_preview.request(1)) {
    preview_signal->stop();
    idle_worker.join();
    throw std::runtime_error("event-driven preview rejected work");
  }
  idle_worker.join();
  if (!idle_worker_woke.load(std::memory_order_acquire)) {
    throw std::runtime_error("preview request did not wake the worker");
  }
  const auto pending_epoch = preview_signal->epoch();
  if (!event_driven_preview.request(2) ||
      preview_signal->epoch() != pending_epoch) {
    throw std::runtime_error("coalesced preview request caused a busy wake");
  }
  static_cast<void>(event_driven_preview.takeLatest());

  auto prequeued_signal = std::make_shared<ScreenPreviewWorkSignal>();
  ScreenPreviewWorkLane prequeued_preview(prequeued_signal);
  prequeued_preview.setEnabled(true);
  static_cast<void>(prequeued_preview.request(7));
  std::atomic_bool prequeued_woke{false};
  std::thread prequeued_worker([&] {
    if (prequeued_signal->waitForChange(0)) {
      prequeued_woke.store(true, std::memory_order_release);
    }
  });
  prequeued_worker.join();
  if (!prequeued_woke.load(std::memory_order_acquire) ||
      prequeued_preview.takeLatest() != std::optional<std::uint64_t>{7}) {
    throw std::runtime_error("prequeued preview notification was lost");
  }

  ScreenPreviewWorkLane blocked_preview_lane;
  blocked_preview_lane.setEnabled(true);
  static_cast<void>(blocked_preview_lane.request(1));
  std::mutex preview_gate_mutex;
  std::condition_variable preview_gate_changed;
  bool preview_worker_blocked = false;
  bool release_preview_worker = false;
  std::uint64_t resumed_revision = 0;
  std::thread preview_worker([&] {
    const auto first = blocked_preview_lane.takeLatest();
    if (!first || *first != 1) return;
    {
      std::lock_guard lock(preview_gate_mutex);
      preview_worker_blocked = true;
    }
    preview_gate_changed.notify_all();
    {
      std::unique_lock lock(preview_gate_mutex);
      preview_gate_changed.wait(lock, [&] { return release_preview_worker; });
    }
    if (const auto latest = blocked_preview_lane.takeLatest()) {
      resumed_revision = *latest;
    }
  });
  {
    std::unique_lock lock(preview_gate_mutex);
    if (!preview_gate_changed.wait_for(
            lock, 1s, [&] { return preview_worker_blocked; })) {
      throw std::runtime_error("preview worker did not enter injected delay");
    }
  }
  std::uint64_t encoder_submissions = 0;
  const auto sender_started = std::chrono::steady_clock::now();
  for (std::uint64_t revision = 2; revision <= 501; ++revision) {
    ++encoder_submissions;
    static_cast<void>(blocked_preview_lane.request(revision));
  }
  const auto sender_elapsed = std::chrono::steady_clock::now() - sender_started;
  std::this_thread::sleep_for(550ms);
  {
    std::lock_guard lock(preview_gate_mutex);
    release_preview_worker = true;
  }
  preview_gate_changed.notify_all();
  preview_worker.join();
  if (encoder_submissions != 500 || sender_elapsed >= 100ms ||
      resumed_revision != 501 ||
      blocked_preview_lane.snapshot().coalesced != 499) {
    throw std::runtime_error(
        "550ms preview delay blocked sender cadence or lost latest frame");
  }

  verifyRetiredPreviewDetachesPendingButPreservesDeliveredFence();
  verifyBlockedRetiredPollDoesNotBlockEncoderReleaseRouting();
  verifyFinalPreviewReleaseHandsDestructionToCleanupSupervisor();

  std::cout << "screen frame cadence and latency tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
