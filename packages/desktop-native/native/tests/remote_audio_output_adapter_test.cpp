#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <cstdint>
#include <functional>
#include <iostream>
#include <malloc.h>
#include <memory>
#include <mutex>
#include <new>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <livekit/audio_source.h>
#include <livekit/livekit.h>
#include <livekit/local_audio_track.h>

#include "common/cleanup_supervisor.hpp"
#include "media/audio_devices.hpp"
#include "media/realtime_snapshot.hpp"
#include "media/remote_audio_ingress.hpp"
#include "media/remote_audio_output.hpp"

namespace realtime_allocation_probe {

std::atomic_size_t allocations{0};
std::atomic_size_t deallocations{0};

void reset() noexcept {
  allocations.store(0, std::memory_order_relaxed);
  deallocations.store(0, std::memory_order_relaxed);
}

void noteAllocation() noexcept {
  if (syrnike::desktop_native::media::detail::
        remoteAudioRealtimeFillActive()) {
    allocations.fetch_add(1, std::memory_order_relaxed);
  }
}

void noteDeallocation() noexcept {
  if (syrnike::desktop_native::media::detail::
        remoteAudioRealtimeFillActive()) {
    deallocations.fetch_add(1, std::memory_order_relaxed);
  }
}

}  // namespace realtime_allocation_probe

void* operator new(std::size_t size) {
  realtime_allocation_probe::noteAllocation();
  if (auto* allocation = std::malloc(size)) return allocation;
  throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
  return ::operator new(size);
}

void* operator new(std::size_t size, std::align_val_t alignment) {
  realtime_allocation_probe::noteAllocation();
  if (auto* allocation = _aligned_malloc(
        size,
        static_cast<std::size_t>(alignment)
      )) {
    return allocation;
  }
  throw std::bad_alloc();
}

void* operator new[](std::size_t size, std::align_val_t alignment) {
  return ::operator new(size, alignment);
}

void operator delete(void* allocation) noexcept {
  if (!allocation) return;
  realtime_allocation_probe::noteDeallocation();
  std::free(allocation);
}

void operator delete[](void* allocation) noexcept {
  ::operator delete(allocation);
}

void operator delete(void* allocation, std::align_val_t) noexcept {
  if (!allocation) return;
  realtime_allocation_probe::noteDeallocation();
  _aligned_free(allocation);
}

void operator delete[](void* allocation, std::align_val_t alignment) noexcept {
  ::operator delete(allocation, alignment);
}

void operator delete(void* allocation, std::size_t) noexcept {
  ::operator delete(allocation);
}

void operator delete[](void* allocation, std::size_t) noexcept {
  ::operator delete[](allocation);
}

void operator delete(
  void* allocation,
  std::size_t,
  std::align_val_t alignment
) noexcept {
  ::operator delete(allocation, alignment);
}

void operator delete[](
  void* allocation,
  std::size_t,
  std::align_val_t alignment
) noexcept {
  ::operator delete[](allocation, alignment);
}

namespace {

using namespace std::chrono_literals;
using syrnike::desktop_native::CleanupSupervisor;
using syrnike::desktop_native::media::AudioEndpointChange;
using syrnike::desktop_native::media::AudioEndpointChangeKind;
using syrnike::desktop_native::media::AudioFailure;
using syrnike::desktop_native::media::AudioFailureInfo;
using syrnike::desktop_native::media::AudioFailureKind;
using syrnike::desktop_native::media::RemoteAudioAttemptDomain;
using syrnike::desktop_native::media::RemoteAudioEndpointSubscription;
using syrnike::desktop_native::media::RemoteAudioExternalStage;
using syrnike::desktop_native::media::RemoteAudioIngress;
using syrnike::desktop_native::media::RemoteAudioIngressFrame;
using syrnike::desktop_native::media::RemoteAudioOperationDeadlines;
using syrnike::desktop_native::media::RemoteAudioOperationAttempt;
using syrnike::desktop_native::media::RemoteAudioOutput;
using syrnike::desktop_native::media::RemoteAudioOutputPhase;
using syrnike::desktop_native::media::RemoteAudioOutputState;
using syrnike::desktop_native::media::RemoteAudioRenderBuffer;
using syrnike::desktop_native::media::RemoteAudioRenderProgress;
using syrnike::desktop_native::media::RemoteAudioRendererPlatformAdapter;
using syrnike::desktop_native::media::RemoteAudioRendererRequest;
using syrnike::desktop_native::media::RealtimeSnapshotDomain;
using syrnike::desktop_native::media::WindowsAudioAttemptPhase;
using syrnike::desktop_native::media::WindowsAudioAttemptStep;
using syrnike::desktop_native::media::WindowsAudioPolicyStatus;
using syrnike::desktop_native::media::WindowsAudioSessionAttemptOperations;
using syrnike::desktop_native::media::WindowsAudioSessionAttemptPolicy;
using syrnike::desktop_native::media::WindowsAudioSessionUse;
using syrnike::desktop_native::media::applyWindowsAudioCategoryPolicy;
using syrnike::desktop_native::media::applyWindowsAudioDuckingPolicy;
using syrnike::desktop_native::media::detail::RemoteAudioAttemptMixGate;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

struct AdapterScript {
  std::optional<RemoteAudioExternalStage> hung_stage;
  std::string resolved_endpoint_id = "endpoint-current";
  bool emit_late_callbacks = false;
  bool exercise_audio_policy = false;
  bool continuous_fills = false;
  std::atomic_bool release{false};
  std::atomic_size_t fills{0};
  std::atomic<RemoteAudioExternalStage> entered{
    RemoteAudioExternalStage::EndpointProbe
  };
};

struct EndpointMonitorState {
  std::mutex mutex;
  std::function<void(const AudioEndpointChange&)> handler;
  std::size_t subscriptions = 0;
};

class TestEndpointSubscription final : public RemoteAudioEndpointSubscription {
 public:
  explicit TestEndpointSubscription(
    std::shared_ptr<EndpointMonitorState> state
  ) : state_(std::move(state)) {}

  ~TestEndpointSubscription() override {
    std::lock_guard lock(state_->mutex);
    state_->handler = {};
    if (state_->subscriptions != 0) --state_->subscriptions;
  }

 private:
  std::shared_ptr<EndpointMonitorState> state_;
};

class ScriptedAdapter final : public RemoteAudioRendererPlatformAdapter {
 public:
  void push(std::shared_ptr<AdapterScript> script) {
    std::lock_guard lock(mutex_);
    scripts_.push_back(std::move(script));
  }

  void runRenderer(
    RemoteAudioOperationAttempt::Context& context,
    RemoteAudioRendererRequest request
  ) override {
    auto script = takeScript();
    const auto active = active_runs_.fetch_add(1) + 1;
    auto peak = peak_active_runs_.load();
    while (peak < active &&
           !peak_active_runs_.compare_exchange_weak(peak, active)) {}
    struct RunGuard final {
      std::atomic_size_t* active;
      ~RunGuard() { active->fetch_sub(1); }
    } guard{&active_runs_};

    if (!enterStage(context, request, script,
                    RemoteAudioExternalStage::EndpointProbe)) return;
    if (!enterStage(context, request, script,
                    RemoteAudioExternalStage::EndpointResolve)) return;
    if (request.endpoint_resolved) {
      request.endpoint_resolved(script->resolved_endpoint_id);
    }
    if (!enterStage(context, request, script,
                    RemoteAudioExternalStage::Activate)) return;
    if (!enterStage(context, request, script,
                    RemoteAudioExternalStage::Initialize)) return;
    if (script->exercise_audio_policy) {
      const auto attempt = request.audio_attempt_policy->run(
        nullptr,
        WindowsAudioSessionUse::RemotePlayback,
        AUDCLNT_STREAMOPTIONS_NONE,
        [] { return S_OK; }
      );
      if (
        attempt.initialize.status != WindowsAudioPolicyStatus::Applied ||
        !attempt.ducking ||
        attempt.ducking->status != WindowsAudioPolicyStatus::Applied
      ) {
        throw std::runtime_error("deterministic remote audio policy failed");
      }
    }
    if (!enterStage(context, request, script,
                    RemoteAudioExternalStage::Start)) return;

    context.setStage(RemoteAudioExternalStage::Render);
    script->entered.store(
      RemoteAudioExternalStage::Render,
      std::memory_order_release
    );
    std::array<float, 960> samples{};
    do {
      if (request.fill) {
        static_cast<void>(request.fill(RemoteAudioRenderBuffer{
          .interleaved_samples = samples.data(),
          .capacity_frames = 480,
          .padding_frames = 0,
          .writable_frames = 480,
          .wake_gap_ms = 0,
          .wake_time = std::chrono::steady_clock::now(),
        }));
        script->fills.fetch_add(1, std::memory_order_relaxed);
      }
      const auto accepted = !request.render_progress ||
        request.render_progress(RemoteAudioRenderProgress{
          .capacity_frames = 480,
          .padding_frames = 0,
          .writable_frames = 480,
          .wake_gap_ms = 0,
        });
      if (accepted) static_cast<void>(context.markReady());
      std::this_thread::yield();
    } while (script->continuous_fills && !context.stopRequested());
    while (!context.stopRequested()) std::this_thread::yield();

    context.setStage(RemoteAudioExternalStage::Stop);
    script->entered.store(
      RemoteAudioExternalStage::Stop,
      std::memory_order_release
    );
    if (script->hung_stage == RemoteAudioExternalStage::Stop) {
      while (!script->release.load(std::memory_order_acquire)) {
        std::this_thread::yield();
      }
    }
  }

  std::unique_ptr<RemoteAudioEndpointSubscription> monitorEndpoints(
    std::function<void(const AudioEndpointChange&)> handler
  ) override {
    std::lock_guard lock(monitor_state_->mutex);
    require(!monitor_state_->handler, "more than one endpoint callback escaped");
    monitor_state_->handler = std::move(handler);
    ++monitor_state_->subscriptions;
    return std::make_unique<TestEndpointSubscription>(monitor_state_);
  }

  void emit(AudioEndpointChange change) {
    std::function<void(const AudioEndpointChange&)> handler;
    {
      std::lock_guard lock(monitor_state_->mutex);
      handler = monitor_state_->handler;
    }
    require(static_cast<bool>(handler), "endpoint callback was not installed");
    handler(change);
  }

  [[nodiscard]] std::size_t peakActiveRuns() const noexcept {
    return peak_active_runs_.load(std::memory_order_acquire);
  }

  [[nodiscard]] std::size_t subscriptions() const noexcept {
    std::lock_guard lock(monitor_state_->mutex);
    return monitor_state_->subscriptions;
  }

 private:
  std::shared_ptr<AdapterScript> takeScript() {
    std::lock_guard lock(mutex_);
    if (scripts_.empty()) {
      throw std::runtime_error("remote audio adapter script queue is empty");
    }
    auto script = std::move(scripts_.front());
    scripts_.erase(scripts_.begin());
    return script;
  }

  static bool enterStage(
    RemoteAudioOperationAttempt::Context& context,
    RemoteAudioRendererRequest& request,
    const std::shared_ptr<AdapterScript>& script,
    RemoteAudioExternalStage stage
  ) {
    context.setStage(stage);
    script->entered.store(stage, std::memory_order_release);
    if (script->hung_stage != stage) return !context.stopRequested();
    while (!script->release.load(std::memory_order_acquire)) {
      std::this_thread::yield();
    }
    if (script->emit_late_callbacks) {
      if (request.endpoint_resolved) {
        request.endpoint_resolved(script->resolved_endpoint_id);
      }
      const auto accepted = request.render_progress &&
        request.render_progress(RemoteAudioRenderProgress{});
      if (accepted) static_cast<void>(context.markReady());
    }
    return !context.stopRequested();
  }

  mutable std::mutex mutex_;
  std::vector<std::shared_ptr<AdapterScript>> scripts_;
  std::shared_ptr<EndpointMonitorState> monitor_state_ =
    std::make_shared<EndpointMonitorState>();
  std::atomic_size_t active_runs_{0};
  std::atomic_size_t peak_active_runs_{0};
};

class StateLog final {
 public:
  void push(RemoteAudioOutputState state) {
    {
      std::lock_guard lock(mutex_);
      states_.push_back(std::move(state));
    }
    changed_.notify_all();
  }

  [[nodiscard]] RemoteAudioOutputState last() const {
    std::lock_guard lock(mutex_);
    require(!states_.empty(), "remote audio output published no state");
    return states_.back();
  }

  bool waitFor(
    const std::function<bool(const RemoteAudioOutputState&)>& predicate,
    std::chrono::milliseconds timeout = 2s
  ) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] {
      return !states_.empty() && predicate(states_.back());
    });
  }

 private:
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::vector<RemoteAudioOutputState> states_;
};

std::unique_ptr<RemoteAudioOutput> makeOutput(
  const std::shared_ptr<ScriptedAdapter>& adapter,
  const std::shared_ptr<RemoteAudioAttemptDomain>& domain,
  StateLog& states,
  std::shared_ptr<WindowsAudioSessionAttemptPolicy> audio_attempt_policy = {},
  RemoteAudioOutput::TrackFailureHandler on_track_failure = {}
) {
  return std::make_unique<RemoteAudioOutput>(
    [&states](RemoteAudioOutputState state) {
      states.push(std::move(state));
    },
    std::move(on_track_failure),
    RemoteAudioOutput::SpeakingActivityHandler{},
    syrnike::desktop_native::CleanupStartProbe{},
    adapter,
    RemoteAudioOperationDeadlines{
      .startup = 20ms,
      .retirement = 20ms,
    },
    domain,
    std::move(audio_attempt_policy)
  );
}

void waitForBaseline(const std::shared_ptr<RemoteAudioAttemptDomain>& domain) {
  const auto deadline = std::chrono::steady_clock::now() + 2s;
  while (std::chrono::steady_clock::now() < deadline) {
    const auto snapshot = domain->snapshot();
    if (snapshot.active_attempts == 0 &&
        snapshot.quarantined_attempts == 0) return;
    std::this_thread::yield();
  }
  throw std::runtime_error("remote audio attempts did not return to baseline");
}

void testRendererGenerationMixAdmissionNeverBlocks() {
  RemoteAudioAttemptMixGate old_gate;
  RemoteAudioAttemptMixGate replacement_gate;
  std::mutex stalled_mutex;
  std::condition_variable stalled_changed;
  bool stalled_entered = false;
  bool release_stalled = false;
  std::exception_ptr stalled_failure;
  int old_state = 0;
  int replacement_state = 0;
  std::thread stalled_old_renderer([&] {
    try {
      auto stalled_old_mix = old_gate.tryAcquire();
      require(
        static_cast<bool>(stalled_old_mix),
        "current renderer could not acquire its mix lane"
      );
      old_state = 1;
      std::unique_lock lock(stalled_mutex);
      stalled_entered = true;
      stalled_changed.notify_all();
      stalled_changed.wait(lock, [&] { return release_stalled; });
      old_state = 2;
    } catch (...) {
      std::lock_guard lock(stalled_mutex);
      stalled_failure = std::current_exception();
      stalled_entered = true;
      stalled_changed.notify_all();
    }
  });
  {
    std::unique_lock lock(stalled_mutex);
    require(
      stalled_changed.wait_for(lock, 2s, [&] { return stalled_entered; }),
      "old renderer did not enter its deterministic blocked mix pass"
    );
  }
  if (stalled_failure) {
    stalled_old_renderer.join();
    std::rethrow_exception(stalled_failure);
  }

  const auto started = std::chrono::steady_clock::now();
  auto replacement_while_old_is_stalled = replacement_gate.tryAcquire();
  require(
    std::chrono::steady_clock::now() - started < 20ms,
    "replacement renderer blocked behind a quarantined mix pass"
  );
  require(
    static_cast<bool>(replacement_while_old_is_stalled),
    "replacement renderer shared the quarantined attempt's mix gate"
  );
  replacement_state = 1;
  require(
    !old_gate.tryAcquire(),
    "quarantined attempt admitted a concurrent pass into its own state"
  );
  require(
    old_state == 1 && replacement_state == 1,
    "attempt-local renderer state was coupled during replacement"
  );
  replacement_while_old_is_stalled = {};

  {
    std::lock_guard lock(stalled_mutex);
    release_stalled = true;
  }
  stalled_changed.notify_all();
  stalled_old_renderer.join();
  if (stalled_failure) std::rethrow_exception(stalled_failure);
  auto replacement_mix = replacement_gate.tryAcquire();
  require(
    static_cast<bool>(replacement_mix),
    "replacement renderer did not acquire the released mix lane"
  );
  replacement_state = 2;
  replacement_mix = {};
  require(
    old_state == 2 && replacement_state == 2,
    "attempt-local renderer state lost exact cleanup"
  );

  std::atomic_bool failed{false};
  for (std::uint64_t epoch = 3; epoch != 2'003; ++epoch) {
    RemoteAudioAttemptMixGate stale_gate;
    RemoteAudioAttemptMixGate current_gate;
    std::atomic_int stale_in_mix{0};
    std::atomic_int current_in_mix{0};
    std::thread stale([&] {
      if (auto lease = stale_gate.tryAcquire()) {
        if (stale_in_mix.fetch_add(1) != 0) failed.store(true);
        std::this_thread::yield();
        if (stale_in_mix.fetch_sub(1) != 1) failed.store(true);
      }
    });
    std::thread current([&] {
      if (auto lease = current_gate.tryAcquire()) {
        if (current_in_mix.fetch_add(1) != 0) failed.store(true);
        std::this_thread::yield();
        if (current_in_mix.fetch_sub(1) != 1) failed.store(true);
      }
    });
    stale.join();
    current.join();
  }
  require(!failed.load(), "renderer generation mix lane raced under stress");
}

void testIngressConsumerGenerationHandoff() {
  RemoteAudioIngress ingress;
  ingress.activate(1);
  std::atomic_bool stop_old{false};
  std::thread old_renderer([&] {
    RemoteAudioIngressFrame frame;
    while (!stop_old.load(std::memory_order_acquire)) {
      static_cast<void>(ingress.tryRead(frame, 1));
      static_cast<void>(ingress.enforceFreshness(1, 0, 0, 0, 1));
    }
  });

  RemoteAudioIngressFrame frame;
  for (std::uint64_t epoch = 2; epoch != 2'002; ++epoch) {
    ingress.activate(epoch);
    require(ingress.activeFor(epoch), "ingress lost the replacement epoch");
    static_cast<void>(ingress.tryRead(frame, epoch));
    static_cast<void>(ingress.enforceFreshness(epoch, 0, 0, 0, epoch));
  }
  stop_old.store(true, std::memory_order_release);
  old_renderer.join();
  ingress.suspend();
  require(!ingress.activeFor(2'001), "ingress retained a suspended renderer");
}

struct SnapshotReclaimStats {
  explicit SnapshotReclaimStats(std::thread::id control)
    : control_thread(control) {}
  const std::thread::id control_thread;
  std::atomic_size_t constructed{0};
  std::atomic_size_t destroyed{0};
  std::atomic_size_t realtime_destructions{0};
};

struct InstrumentedRenderSnapshot {
  InstrumentedRenderSnapshot(
    std::shared_ptr<SnapshotReclaimStats> observed,
    std::uint64_t value
  ) : stats(std::move(observed)), generation(value), allocation(64, value) {
    stats->constructed.fetch_add(1, std::memory_order_relaxed);
  }
  ~InstrumentedRenderSnapshot() {
    if (std::this_thread::get_id() != stats->control_thread) {
      stats->realtime_destructions.fetch_add(1, std::memory_order_relaxed);
    }
    stats->destroyed.fetch_add(1, std::memory_order_relaxed);
  }

  std::shared_ptr<SnapshotReclaimStats> stats;
  std::uint64_t generation = 0;
  // Exercises both allocation and deallocation ownership for the payload.
  std::vector<std::uint64_t> allocation;
};

void testRenderSnapshotReclamationStaysOffRealtimeReaders() {
  auto stats = std::make_shared<SnapshotReclaimStats>(
    std::this_thread::get_id()
  );
  {
    RealtimeSnapshotDomain<InstrumentedRenderSnapshot, 8> snapshots(
      std::make_unique<const InstrumentedRenderSnapshot>(stats, 0)
    );
    auto stalled_slot = snapshots.claimReader();
    auto current_slot = snapshots.claimReader();
    std::mutex stalled_mutex;
    std::condition_variable stalled_changed;
    bool stalled = false;
    bool release_stalled = false;
    std::atomic_bool old_reader_failed{false};
    std::thread old_renderer([&] {
      auto lease = snapshots.acquire(stalled_slot);
      if (lease.get().generation != 0) old_reader_failed.store(true);
      std::unique_lock lock(stalled_mutex);
      stalled = true;
      stalled_changed.notify_all();
      stalled_changed.wait(lock, [&] { return release_stalled; });
    });
    {
      std::unique_lock lock(stalled_mutex);
      require(
        stalled_changed.wait_for(lock, 2s, [&] { return stalled; }),
        "old renderer did not retain the deterministic snapshot"
      );
    }

    std::atomic_bool stop_current{false};
    std::atomic_bool reader_failed{false};
    std::thread current_renderer([&] {
      while (!stop_current.load(std::memory_order_acquire)) {
        auto lease = snapshots.acquire(current_slot);
        if (lease.get().allocation.size() != 64) reader_failed.store(true);
      }
    });
    for (std::uint64_t generation = 1; generation <= 2'000; ++generation) {
      snapshots.publish(
        std::make_unique<const InstrumentedRenderSnapshot>(
          stats,
          generation
        )
      );
    }
    stop_current.store(true, std::memory_order_release);
    current_renderer.join();
    require(!reader_failed.load(), "current renderer observed a freed snapshot");
    snapshots.reclaim();
    require(
      snapshots.retiredCount() == 1,
      "snapshot reclamation lost its exact stalled-reader bound"
    );
    require(
      stats->realtime_destructions.load() == 0,
      "render callback destroyed an immutable snapshot payload"
    );

    {
      std::lock_guard lock(stalled_mutex);
      release_stalled = true;
    }
    stalled_changed.notify_all();
    old_renderer.join();
    require(!old_reader_failed.load(), "old renderer lost its snapshot");
    snapshots.reclaim();
    require(
      snapshots.retiredCount() == 0,
      "control thread did not reclaim the released stalled snapshot"
    );
  }
  require(
    stats->destroyed.load() == stats->constructed.load() &&
      stats->realtime_destructions.load() == 0,
    "snapshot payload cleanup escaped the control thread"
  );
}

void testActualFillNeverReclaimsSnapshots(CleanupSupervisor& cleanup) {
  syrnike::desktop_native::media::detail::
    resetRemoteAudioRealtimeSnapshotDestructions();
  auto domain = std::make_shared<RemoteAudioAttemptDomain>(cleanup, 2);
  auto adapter = std::make_shared<ScriptedAdapter>();
  auto script = std::make_shared<AdapterScript>();
  script->continuous_fills = true;
  adapter->push(script);
  StateLog states;
  std::atomic_size_t track_failures{0};
  auto output = makeOutput(
    adapter,
    domain,
    states,
    {},
    [&](AudioFailureInfo, std::string, std::uint64_t) {
      track_failures.fetch_add(1, std::memory_order_relaxed);
    }
  );
  static_cast<void>(output->setOutputDevice("default"));

  auto source = std::make_shared<livekit::AudioSource>(48'000, 2);
  auto track = livekit::LocalAudioTrack::createLocalAudioTrack(
    "snapshot-churn",
    source
  );
  const auto fills_before = script->fills.load(std::memory_order_acquire);
  realtime_allocation_probe::reset();
  const auto wait_for_fill = [&](std::size_t previous, const char* message) {
    const auto deadline = std::chrono::steady_clock::now() + 2s;
    while (script->fills.load(std::memory_order_acquire) <= previous &&
           std::chrono::steady_clock::now() < deadline) {
      std::this_thread::yield();
    }
    require(script->fills.load() > previous, message);
  };
  for (std::size_t index = 0; index < 100; ++index) {
    const auto sid = "snapshot-track-" + std::to_string(index);
    auto previous_fill = script->fills.load(std::memory_order_acquire);
    output->addTrack(sid, "snapshot-user", false, track);
    wait_for_fill(previous_fill, "renderer did not observe an added track");
    previous_fill = script->fills.load(std::memory_order_acquire);
    output->removeTrack(sid);
    wait_for_fill(previous_fill, "renderer did not observe a removed track");
  }
  output->stop();
  waitForBaseline(domain);
  require(track_failures.load() == 0, "actual audio track churn failed");
  require(
    script->fills.load() >= fills_before + 200,
    "actual renderer fill callback did not overlap snapshot churn"
  );
  require(
    realtime_allocation_probe::allocations.load() == 0 &&
      realtime_allocation_probe::deallocations.load() == 0,
    "actual renderer fill callback allocated or freed track mixer state"
  );
  require(
    syrnike::desktop_native::media::detail::
      remoteAudioRealtimeSnapshotDestructions() == 0,
    "actual renderer fill callback reclaimed a snapshot graph"
  );
}

void testSyntheticLiveKitTrackReachesRendererFill(CleanupSupervisor& cleanup) {
  auto domain = std::make_shared<RemoteAudioAttemptDomain>(cleanup, 2);
  auto adapter = std::make_shared<ScriptedAdapter>();
  auto script = std::make_shared<AdapterScript>();
  script->continuous_fills = true;
  adapter->push(script);
  StateLog states;
  auto output = makeOutput(adapter, domain, states);
  static_cast<void>(output->setOutputDevice("default"));

  auto source = std::make_shared<livekit::AudioSource>(48'000, 2);
  auto track = livekit::LocalAudioTrack::createLocalAudioTrack(
    "contention-audio",
    source
  );
  output->addTrack("contention-audio", "contention-user", false, track);
  auto frame = livekit::AudioFrame::create(48'000, 2, 480);
  std::fill(frame.data().begin(), frame.data().end(), 1'024);
  for (std::size_t index = 0; index < 8; ++index) {
    source->captureFrame(frame);
  }

  const auto deadline = std::chrono::steady_clock::now() + 2s;
  std::optional<syrnike::desktop_native::media::RemoteAudioPlayoutSnapshot>
    snapshot;
  while (std::chrono::steady_clock::now() < deadline) {
    snapshot = output->playoutSnapshot("contention-audio");
    if (snapshot && snapshot->ingress_frames > 0 &&
        snapshot->renderer_fill_callbacks > 0 &&
        snapshot->rendered_track_frames > 0) {
      break;
    }
    std::this_thread::yield();
  }
  require(snapshot.has_value(), "tracked audio playout snapshot was absent");
  require(
    snapshot->track_id == "contention-audio" &&
      snapshot->ingress_frames > 0 &&
      snapshot->renderer_fill_callbacks > 0 &&
      snapshot->rendered_track_frames > 0,
    "synthetic LiveKit track did not reach the production renderer fill"
  );
  output->stop();
  waitForBaseline(domain);
}

void expectTimedOutStage(
  RemoteAudioOutput& output,
  StateLog& states,
  RemoteAudioExternalStage expected_stage,
  std::size_t expected_quarantined_attempts = 1
) {
  const auto started = std::chrono::steady_clock::now();
  bool typed_timeout = false;
  try {
    static_cast<void>(output.setOutputDevice("default"));
  } catch (const AudioFailure& failure) {
    typed_timeout = failure.kind() == AudioFailureKind::OperationTimedOut;
  }
  require(typed_timeout, "hung platform call lost its typed timeout");
  require(
    std::chrono::steady_clock::now() - started < 250ms,
    "hung platform call blocked the output control thread"
  );
  const auto state = states.last();
  require(
    state.external_stage == expected_stage,
    "hung platform call lost its exact diagnostic stage"
  );
  require(
    state.quarantined_attempts == expected_quarantined_attempts,
    "hung platform call was not reflected in diagnostics"
  );
  require(
    state.startup_deadline_ms == 20 && state.retirement_deadline_ms == 20,
    "timeout diagnostics lost the injected operation deadlines"
  );
  require(state.renderer_epoch != 0, "timeout diagnostics lost renderer epoch");
}

void testHungStartupStagesAndLateReturn(CleanupSupervisor& cleanup) {
  const std::array stages{
    RemoteAudioExternalStage::EndpointProbe,
    RemoteAudioExternalStage::EndpointResolve,
    RemoteAudioExternalStage::Activate,
    RemoteAudioExternalStage::Initialize,
    RemoteAudioExternalStage::Start,
  };
  for (const auto stage : stages) {
    auto domain = std::make_shared<RemoteAudioAttemptDomain>(cleanup, 2);
    auto adapter = std::make_shared<ScriptedAdapter>();
    StateLog states;
    auto output = makeOutput(adapter, domain, states);
    auto stalled = std::make_shared<AdapterScript>();
    stalled->hung_stage = stage;
    stalled->resolved_endpoint_id = "endpoint-stale";
    stalled->emit_late_callbacks = true;
    adapter->push(stalled);

    expectTimedOutStage(*output, states, stage);
    const auto timed_out_epoch = states.last().renderer_epoch;

    auto healthy = std::make_shared<AdapterScript>();
    healthy->resolved_endpoint_id = "endpoint-current";
    adapter->push(healthy);
    const auto healthy_epoch = output->setOutputDevice("default");
    require(
      healthy_epoch > timed_out_epoch,
      "healthy retry did not advance renderer generation"
    );
    stalled->release.store(true, std::memory_order_release);
    const auto stale_release_deadline =
      std::chrono::steady_clock::now() + 2s;
    while (domain->snapshot().quarantined_attempts != 0 &&
           std::chrono::steady_clock::now() < stale_release_deadline) {
      std::this_thread::yield();
    }
    require(
      output->outputDeviceId() == "endpoint-current",
      "late old endpoint callback mutated the healthy renderer generation"
    );
    output->stop();
    waitForBaseline(domain);
    require(adapter->subscriptions() == 0, "endpoint subscription leaked on stop");
  }
}

void testFailClosedQuarantineCap(CleanupSupervisor& cleanup) {
  auto domain = std::make_shared<RemoteAudioAttemptDomain>(cleanup, 2);
  auto adapter = std::make_shared<ScriptedAdapter>();
  StateLog states;
  auto output = makeOutput(adapter, domain, states);
  auto first = std::make_shared<AdapterScript>();
  first->hung_stage = RemoteAudioExternalStage::Activate;
  auto second = std::make_shared<AdapterScript>();
  second->hung_stage = RemoteAudioExternalStage::Initialize;
  adapter->push(first);
  expectTimedOutStage(
    *output,
    states,
    RemoteAudioExternalStage::Activate
  );
  adapter->push(second);
  expectTimedOutStage(
    *output,
    states,
    RemoteAudioExternalStage::Initialize,
    2
  );

  bool third_rejected = false;
  const auto started = std::chrono::steady_clock::now();
  try {
    static_cast<void>(output->setOutputDevice("default"));
  } catch (const AudioFailure& failure) {
    third_rejected = failure.kind() == AudioFailureKind::OperationTimedOut;
  }
  const auto saturated = domain->snapshot();
  require(third_rejected, "third renderer generation did not fail closed");
  require(
    std::chrono::steady_clock::now() - started < 100ms,
    "quarantine capacity rejection waited for an external deadline"
  );
  require(
    saturated.quarantined_attempts == 2 &&
      saturated.peak_owned_attempts <= 2 &&
      saturated.rejected_starts == 1,
    "renderer attempt ownership exceeded its fixed bound"
  );
  const auto diagnostic = states.last();
  require(
    diagnostic.quarantined_attempts == 2 &&
      diagnostic.rejected_attempts == 1,
    "fail-closed owner bounds were absent from diagnostics"
  );
  first->release.store(true, std::memory_order_release);
  second->release.store(true, std::memory_order_release);
  waitForBaseline(domain);
  output->stop();
}

void testConcurrentShutdownAndHungStop(CleanupSupervisor& cleanup) {
  auto domain = std::make_shared<RemoteAudioAttemptDomain>(cleanup, 2);
  auto adapter = std::make_shared<ScriptedAdapter>();
  StateLog states;
  auto output = makeOutput(adapter, domain, states);
  auto hung_stop = std::make_shared<AdapterScript>();
  hung_stop->hung_stage = RemoteAudioExternalStage::Stop;
  adapter->push(hung_stop);
  static_cast<void>(output->setOutputDevice("default"));

  const auto started = std::chrono::steady_clock::now();
  std::thread first([&] { output->stop(); });
  std::thread second([&] { output->stop(); });
  first.join();
  second.join();
  require(
    std::chrono::steady_clock::now() - started < 250ms,
    "concurrent shutdown joined a hung WASAPI stop"
  );
  const auto state = states.last();
  require(
    state.phase == RemoteAudioOutputPhase::Stopped &&
      state.external_stage == RemoteAudioExternalStage::Stop &&
      state.quarantined_attempts == 1,
    "hung stop lost its typed stopped-state diagnostics"
  );

  output.reset();
  require(
    domain->snapshot().quarantined_attempts == 1,
    "destroyed output released a still-running platform attempt"
  );
  hung_stop->release.store(true, std::memory_order_release);
  waitForBaseline(domain);
  require(adapter->subscriptions() == 0, "shutdown retained endpoint callback");
}

void testEndpointChangeRecoveryLoop(CleanupSupervisor& cleanup) {
  auto domain = std::make_shared<RemoteAudioAttemptDomain>(cleanup, 2);
  auto adapter = std::make_shared<ScriptedAdapter>();
  StateLog states;
  auto output = makeOutput(adapter, domain, states);
  auto initial = std::make_shared<AdapterScript>();
  initial->resolved_endpoint_id = "endpoint-0";
  adapter->push(initial);
  auto epoch = output->setOutputDevice("default");

  for (std::uint64_t index = 1; index <= 10; ++index) {
    auto replacement = std::make_shared<AdapterScript>();
    replacement->resolved_endpoint_id =
      "endpoint-" + std::to_string(index);
    adapter->push(replacement);
    adapter->emit(AudioEndpointChange{
      eRender,
      AudioEndpointChangeKind::DefaultChanged,
      replacement->resolved_endpoint_id,
      eConsole,
    });
    const auto previous_epoch = epoch;
    require(
      states.waitFor([previous_epoch](const RemoteAudioOutputState& state) {
        return state.phase == RemoteAudioOutputPhase::Running &&
          state.renderer_epoch > previous_epoch;
      }),
      "endpoint change did not recover the output-local renderer"
    );
    const auto recovered = states.last();
    epoch = recovered.renderer_epoch;
    require(
      recovered.quarantined_attempts == 0,
      "cooperative endpoint recovery accumulated renderer generations"
    );
  }
  require(
    adapter->peakActiveRuns() == 1,
    "endpoint recovery overlapped platform renderer generations"
  );
  output->stop();
  waitForBaseline(domain);
}

void testProductionPolicyReapplyAndMuteStability(CleanupSupervisor& cleanup) {
  std::mutex phase_mutex;
  std::vector<WindowsAudioAttemptPhase> phases;
  auto policy = std::make_shared<WindowsAudioSessionAttemptPolicy>(
    WindowsAudioSessionAttemptOperations{
      .category = [](IAudioClient*, WindowsAudioSessionUse use,
                     AUDCLNT_STREAMOPTIONS) {
        return applyWindowsAudioCategoryPolicy(
          use,
          [](AUDIO_STREAM_CATEGORY) { return S_OK; }
        );
      },
      .ducking = [](IAudioClient*, WindowsAudioSessionUse use) {
        return applyWindowsAudioDuckingPolicy(
          use,
          [](bool) { return S_OK; }
        );
      },
    },
    [&](const WindowsAudioAttemptStep& step) {
      std::lock_guard lock(phase_mutex);
      phases.push_back(step.phase);
    }
  );
  auto domain = std::make_shared<RemoteAudioAttemptDomain>(cleanup, 2);
  auto adapter = std::make_shared<ScriptedAdapter>();
  StateLog states;
  auto output = makeOutput(adapter, domain, states, policy);
  auto initial = std::make_shared<AdapterScript>();
  initial->exercise_audio_policy = true;
  adapter->push(initial);
  const auto initial_epoch = output->setOutputDevice("default");
  output->setDeafened(true);
  output->setDeafened(false);
  {
    std::lock_guard lock(phase_mutex);
    require(
      phases.size() == 3,
      "remote mute/unmute reapplied endpoint policy"
    );
  }

  auto replacement = std::make_shared<AdapterScript>();
  replacement->exercise_audio_policy = true;
  replacement->resolved_endpoint_id = "endpoint-policy-recreated";
  adapter->push(replacement);
  adapter->emit(AudioEndpointChange{
    eRender,
    AudioEndpointChangeKind::DefaultChanged,
    replacement->resolved_endpoint_id,
    eConsole,
  });
  require(
    states.waitFor([initial_epoch](const RemoteAudioOutputState& state) {
      return state.phase == RemoteAudioOutputPhase::Running &&
        state.renderer_epoch > initial_epoch;
    }),
    "remote policy endpoint recreation did not settle"
  );
  output->stop();
  waitForBaseline(domain);
  std::lock_guard lock(phase_mutex);
  require(
    phases == std::vector<WindowsAudioAttemptPhase>{
      WindowsAudioAttemptPhase::BeforeInitialize,
      WindowsAudioAttemptPhase::Initialize,
      WindowsAudioAttemptPhase::AfterInitialize,
      WindowsAudioAttemptPhase::BeforeInitialize,
      WindowsAudioAttemptPhase::Initialize,
      WindowsAudioAttemptPhase::AfterInitialize,
    },
    "RemoteAudioOutput did not reapply category/ducking in order per renderer epoch"
  );
}

}  // namespace

int main() try {
  require(
    livekit::initialize(livekit::LogLevel::Off),
    "LiveKit initialization failed"
  );
  CleanupSupervisor cleanup({.worker_limit = 2, .admission_capacity = 16});
  testRendererGenerationMixAdmissionNeverBlocks();
  testIngressConsumerGenerationHandoff();
  testRenderSnapshotReclamationStaysOffRealtimeReaders();
  testActualFillNeverReclaimsSnapshots(cleanup);
  testSyntheticLiveKitTrackReachesRendererFill(cleanup);
  testHungStartupStagesAndLateReturn(cleanup);
  testFailClosedQuarantineCap(cleanup);
  testConcurrentShutdownAndHungStop(cleanup);
  testEndpointChangeRecoveryLoop(cleanup);
  testProductionPolicyReapplyAndMuteStability(cleanup);
  const auto shutdown = cleanup.shutdown(std::chrono::steady_clock::now() + 2s);
  require(
    shutdown.finished && shutdown.detached_threads == 0,
    "remote audio adapter tests left detached cleanup"
  );
  livekit::shutdown();
  std::cout << "Remote audio output adapter tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
