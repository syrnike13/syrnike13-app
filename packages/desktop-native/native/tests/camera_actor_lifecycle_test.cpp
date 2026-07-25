#include <livekit/livekit.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

#include "common/event_sink.hpp"
#include "media/camera_actor.hpp"
#include "media/media_runtime_support.hpp"

namespace {
using namespace std::chrono_literals;
using namespace syrnike::desktop_native;
using namespace syrnike::desktop_native::media;

class Sink final : public EventSink {
 public:
  bool emit(RuntimeEvent event) override { std::lock_guard lock(mutex); events.push_back(std::move(event)); return true; }
  void close() override {}
  std::mutex mutex;
  std::vector<RuntimeEvent> events;
};

RuntimeEvent waitReply(const std::shared_ptr<Sink>& sink, const std::string& request_id) {
  for (int i = 0; i < 1000; ++i) {
    {
      std::lock_guard lock(sink->mutex);
      for (const auto& event : sink->events) {
        if (event.type == "reply" && event.request_id == request_id) return event;
      }
    }
    std::this_thread::sleep_for(5ms);
  }
  throw std::runtime_error("timed out waiting for camera reply");
}

RuntimeEvent waitCameraTerminal(
    const std::shared_ptr<Sink>& sink,
    const std::string& session_id,
    std::uint64_t generation) {
  for (int i = 0; i < 1000; ++i) {
    {
      std::lock_guard lock(sink->mutex);
      for (const auto& event : sink->events) {
        if (event.type == "cameraTerminal" &&
            event.session_id == session_id &&
            event.generation == generation) {
          return event;
        }
      }
    }
    std::this_thread::sleep_for(5ms);
  }
  throw std::runtime_error("timed out waiting for camera terminal event");
}

void waitNoPending(
    const std::shared_ptr<DeterministicFakeLiveKitPublicationClient>& client,
    DeterministicFakeLiveKitPublicationClient::Operation operation) {
  for (int i = 0; i < 1000 && client->pending(operation) != 0; ++i) {
    std::this_thread::sleep_for(5ms);
  }
  if (client->pending(operation) != 0) {
    throw std::runtime_error("timed out draining fake LiveKit operation");
  }
}

class Capture final : public CameraCapture {
 public:
  Capture(
      bool fail,
      bool block,
      bool slow_stop,
      bool gpu,
      std::shared_ptr<std::atomic_uint64_t> stop_calls)
      : fail_(fail), block_(block), slow_stop_(slow_stop), gpu_(gpu),
        stop_calls_(std::move(stop_calls)) {}
  bool read(CameraFrame& frame, const std::atomic_bool& running) override {
    if (fail_) throw std::runtime_error("fake camera failure");
    if (block_) {
      std::unique_lock lock(mutex_);
      stopped_.wait(lock, [&] { return stopped_value_; });
      return false;
    }
    std::this_thread::sleep_for(2ms);
    if (!running.load()) return false;
    frame.width = 16; frame.height = 16; frame.bgra.assign(16 * 16 * 4, 0);
    return true;
  }
  void stop() noexcept override {
    stop_calls_->fetch_add(1, std::memory_order_acq_rel);
    if (slow_stop_) std::this_thread::sleep_for(4s);
    std::lock_guard lock(mutex_);
    stopped_value_ = true;
    stopped_.notify_all();
  }
  CameraCaptureInfo info() const override {
    return {CameraFormat{16, 16, 30, 1}, gpu_};
  }
 private:
  bool fail_;
  bool block_;
  bool slow_stop_;
  bool gpu_;
  std::shared_ptr<std::atomic_uint64_t> stop_calls_;
  std::mutex mutex_;
  std::condition_variable stopped_;
  bool stopped_value_ = false;
};

class Factory final : public CameraCaptureFactory {
 public:
  std::shared_ptr<CameraCapture> create(const std::string&, std::uint32_t,
      std::uint32_t, int, bool force_cpu) override {
    if (force_cpu) {
      ++force_cpu_calls;
      std::lock_guard lock(mutex);
      gpu_destroyed_before_cpu.store(first_gpu_capture.expired());
      if (!first_gpu_capture.expired()) {
        throw std::runtime_error(
            "forced CPU reopen retained the previous GPU capture");
      }
    }
    const bool gpu = !force_cpu && gpu_first.exchange(false);
    auto capture = std::make_shared<Capture>(
        fail.load(), block.load(), slow_stop.load(), gpu, stop_calls);
    if (gpu) {
      std::lock_guard lock(mutex);
      first_gpu_capture = capture;
    }
    return capture;
  }
  std::atomic_bool fail{false};
  std::atomic_bool block{false};
  std::atomic_bool slow_stop{false};
  std::atomic_bool gpu_first{false};
  std::atomic_uint64_t force_cpu_calls{0};
  std::atomic_bool gpu_destroyed_before_cpu{false};
  std::shared_ptr<std::atomic_uint64_t> stop_calls =
      std::make_shared<std::atomic_uint64_t>(0);
  std::mutex mutex;
  std::weak_ptr<CameraCapture> first_gpu_capture;
};

MediaCommand command(std::uint64_t generation, std::string request_id = "request") {
  MediaCommand result;
  result.type = "connectCamera"; result.request_id = std::move(request_id);
  result.session_id = "voice"; result.generation = generation;
  result.participant_identity = "user:native-camera";
  result.width = 16; result.height = 16; result.fps = 30;
  return result;
}
}

int main() try {
  auto main_lifetime = std::make_shared<LiveKitRuntimeLifetime>();
  main_lifetime->initialize();
  auto sink = std::make_shared<Sink>();
  SequencedEmitter emitter(sink);
  auto client = std::make_shared<DeterministicFakeLiveKitPublicationClient>();
  client->retainRuntimeLifetime(main_lifetime);
  client->setVoiceSessionForTest("voice");
  auto factory = std::make_shared<Factory>();
  std::mutex posted_mutex;
  std::vector<MediaCommand> posted;
  std::atomic_uint64_t current{1};
  auto actor = std::make_unique<CameraActor>(emitter, [&](MediaCommand value) {
    std::lock_guard lock(posted_mutex); posted.push_back(std::move(value)); return true;
  }, [&](const std::string&, std::uint64_t generation) { return generation == current.load(); },
    client, factory,
    [](int, int) {
      return std::shared_ptr<livekit::D3D11H264VideoSource>{};
    });

  current.store(2);
  bool stale = false;
  try { actor->connect(command(1)); } catch (const std::exception&) { stale = true; }
  if (!stale) throw std::runtime_error("stale camera generation was accepted");

  MediaCommand probe;
  probe.type = "probeCameraActor";
  probe.request_id = "probe-available";
  if (actor->probe(probe).state != "available") {
    throw std::runtime_error("idle camera actor did not report available capacity");
  }

  // A publication blocked in the worker must not occupy the camera command lane.
  // Disconnect settles the original request immediately; a newer generation can
  // start before the stale SDK call returns.
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Publish, true);
  actor->connect(command(2, "blocked"));
  client->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Publish, 1);
  probe.request_id = "probe-busy";
  if (actor->probe(probe).state != "busy") {
    throw std::runtime_error("pending camera publication did not report busy capacity");
  }
  current.store(3);
  auto cancel = command(2, "cancel"); cancel.type = "disconnectCamera";
  const auto started = std::chrono::steady_clock::now();
  actor->disconnect(cancel);
  if (std::chrono::steady_clock::now() - started > 250ms) {
    throw std::runtime_error("disconnect blocked behind camera publication");
  }
  const auto blocked_reply = waitReply(sink, "blocked");
  if (blocked_reply.ok || !blocked_reply.error ||
      blocked_reply.error->code != "stale_generation") {
    throw std::runtime_error("cancelled camera connect did not receive typed reply");
  }
  client->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Publish,
    {.publication_sid = {}});
  for (int i = 0; i < 200 &&
      client->pending(DeterministicFakeLiveKitPublicationClient::Operation::Publish) != 0; ++i) {
    std::this_thread::sleep_for(5ms);
  }
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Publish, false);
  actor->connect(command(3, "replacement"));
  const auto replacement_reply = waitReply(sink, "replacement");
  if (!replacement_reply.ok) {
    throw std::runtime_error("replacement camera attempt was not launched and settled");
  }

  current.store(4);
  actor->connect(command(4, "preview"));
  const auto preview_reply = waitReply(sink, "preview");
  if (!preview_reply.ok || client->localCameraPreviewStartCount() != 2) {
    throw std::runtime_error("camera publication did not start its local preview");
  }
  auto read_stall = command(4);
  read_stall.type = "__cameraTerminal";
  read_stall.internal_message = "camera_capture_timeout";
  actor->handleTerminal(read_stall);
  const auto read_stall_event = waitCameraTerminal(sink, "voice", 4);
  if (!read_stall_event.error ||
      read_stall_event.error->code != "camera_read_stall") {
    throw std::runtime_error(
        "camera async read timeout lost its typed terminal code");
  }
  auto disconnect = command(4, "disconnect-preview");
  disconnect.type = "disconnectCamera";
  actor->disconnect(disconnect);
  if (client->localCameraPreviewStopCount() != 2) {
    throw std::runtime_error("camera disconnect did not stop its local preview");
  }

  // Cleanup failures are secondary: a stale attempt still settles with its
  // original typed result even when the SDK throws while unpublishing it.
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Publish, true);
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, true);
  current.store(5);
  actor->connect(command(5, "cleanup-throws"));
  client->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Publish, 1);
  current.store(6);
  client->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Publish,
    {.publication_sid = "cleanup-publication"});
  client->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, 1);
  client->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish,
    {.error_message = "injected unpublish cleanup failure"});
  const auto cleanup_reply = waitReply(sink, "cleanup-throws");
  if (cleanup_reply.ok || !cleanup_reply.error ||
      cleanup_reply.error->code != "stale_generation") {
    throw std::runtime_error("camera cleanup exception suppressed the original failure");
  }
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Publish, false);
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, false);

  // A capture reader that never produces a sample must be interruptible by
  // CameraCapture::stop; disconnect cannot wait for an unbounded ReadSample.
  factory->block.store(true);
  current.store(7);
  actor->connect(command(7, "blocked-capture"));
  if (!waitReply(sink, "blocked-capture").ok) {
    throw std::runtime_error("blocked capture did not finish publication");
  }
  auto stop_blocked = command(7, "stop-blocked-capture");
  stop_blocked.type = "disconnectCamera";
  const auto stop_started = std::chrono::steady_clock::now();
  actor->disconnect(stop_blocked);
  if (std::chrono::steady_clock::now() - stop_started > 250ms) {
    throw std::runtime_error("camera disconnect waited for a blocked reader");
  }

  // A broken driver can also hang its stop/flush path. The actor must bound
  // both CameraCapture::stop() and the capture thread rather than carrying the
  // driver hang into application shutdown.
  factory->slow_stop.store(true);
  current.store(8);
  actor->connect(command(8, "slow-stop-capture"));
  if (!waitReply(sink, "slow-stop-capture").ok) {
    throw std::runtime_error("slow-stop capture did not finish publication");
  }
  auto stop_slow = command(8, "stop-slow-capture");
  stop_slow.type = "disconnectCamera";
  const auto slow_stop_started = std::chrono::steady_clock::now();
  actor->disconnect(stop_slow);
  if (std::chrono::steady_clock::now() - slow_stop_started > 1800ms) {
    throw std::runtime_error("camera disconnect exceeded its stop deadline");
  }
  factory->block.store(false);
  factory->slow_stop.store(false);

  // MF can negotiate a GPU path before the LiveKit hardware source allocation
  // fails. Reopen the device with an explicit CPU policy instead of failing
  // the publication after successful camera negotiation.
  factory->gpu_first.store(true);
  current.store(9);
  actor->connect(command(9, "gpu-source-fallback"));
  if (!waitReply(sink, "gpu-source-fallback").ok ||
      factory->force_cpu_calls.load() != 1 ||
      !factory->gpu_destroyed_before_cpu.load()) {
    throw std::runtime_error(
        "null GPU encoder source did not reopen camera capture in CPU mode");
  }
  auto stop_cpu_fallback = command(9, "stop-gpu-source-fallback");
  stop_cpu_fallback.type = "disconnectCamera";
  actor->disconnect(stop_cpu_fallback);

  // CPU fallback must not reopen the same device while a broken GPU capture
  // is still stopping. The attempt settles with a typed timeout instead.
  factory->slow_stop.store(true);
  factory->gpu_first.store(true);
  current.store(10);
  actor->connect(command(10, "gpu-fallback-stop-timeout"));
  const auto fallback_timeout =
      waitReply(sink, "gpu-fallback-stop-timeout");
  if (fallback_timeout.ok || !fallback_timeout.error ||
      fallback_timeout.error->code != "camera_capture_stop_timeout" ||
      factory->force_cpu_calls.load() != 1) {
    throw std::runtime_error(
        "GPU fallback stop timeout reopened the camera or lost its typed error");
  }
  factory->slow_stop.store(false);

  // Active unpublish belongs to a bounded retire worker. A blocked SDK call
  // must release actor capacity at the deadline so the next generation can
  // publish while the detached retirement still owns the old resources.
  current.store(11);
  actor->connect(command(11, "active-unpublish"));
  if (!waitReply(sink, "active-unpublish").ok) {
    throw std::runtime_error("active unpublish scenario did not start");
  }
  client->setBlocked(
      DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, true);
  auto stop_active_unpublish = command(11, "stop-active-unpublish");
  stop_active_unpublish.type = "disconnectCamera";
  const auto active_unpublish_started = std::chrono::steady_clock::now();
  actor->disconnect(stop_active_unpublish);
  if (std::chrono::steady_clock::now() - active_unpublish_started > 1800ms) {
    throw std::runtime_error("active camera unpublish exceeded retire deadline");
  }
  client->waitUntilPending(
      DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, 1);
  current.store(12);
  actor->connect(command(12, "after-active-unpublish"));
  if (!waitReply(sink, "after-active-unpublish").ok) {
    throw std::runtime_error(
        "detached active unpublish did not release next-start capacity");
  }
  client->releaseNext(
      DeterministicFakeLiveKitPublicationClient::Operation::Unpublish);
  client->setBlocked(
      DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, false);
  auto stop_after_active_unpublish =
      command(12, "stop-after-active-unpublish");
  stop_after_active_unpublish.type = "disconnectCamera";
  actor->disconnect(stop_after_active_unpublish);

  // Retirement launch failures retain the shared task. The management worker
  // retries without another camera command and executes cleanup exactly once.
  auto retry_client =
      std::make_shared<DeterministicFakeLiveKitPublicationClient>();
  retry_client->retainRuntimeLifetime(main_lifetime);
  retry_client->setVoiceSessionForTest("voice");
  auto retry_factory = std::make_shared<Factory>();
  std::atomic_uint64_t retry_current{1};
  std::atomic_uint64_t retire_launches{0};
  std::atomic_uint64_t enqueue_failures{0};
  auto retry_actor = std::make_unique<CameraActor>(
      emitter,
      [](MediaCommand) { return true; },
      [&](const std::string&, std::uint64_t generation) {
        return generation == retry_current.load();
      },
      retry_client,
      retry_factory,
      CameraActor::CreateGpuVideoSource{},
      [&](std::function<void()> work) {
        if (retire_launches.fetch_add(1) == 0) {
          throw std::runtime_error("injected retirement launch failure");
        }
        return std::thread(std::move(work));
      },
      CameraActor::BeforeTerminalPost{},
      [&] {
        if (enqueue_failures.fetch_add(1, std::memory_order_acq_rel) == 0) {
          throw std::bad_alloc();
        }
      });
  retry_actor->connect(command(1, "retire-launch-retry"));
  if (!waitReply(sink, "retire-launch-retry").ok) {
    throw std::runtime_error("retire launch retry scenario did not start");
  }
  auto retry_disconnect = command(1, "retire-launch-retry-disconnect");
  retry_disconnect.type = "disconnectCamera";
  retry_actor->disconnect(retry_disconnect);
  if (retire_launches.load() < 2 ||
      enqueue_failures.load(std::memory_order_acquire) < 1 ||
      retry_factory->stop_calls->load(std::memory_order_acquire) != 1 ||
      retry_client->localCameraPreviewStopCount() != 1 ||
      retry_client->unpublishedPublicationSids().size() != 1) {
    throw std::runtime_error(
        "cleanup launcher failure lost or duplicated stop/retirement");
  }
  retry_actor->shutdown();
  retry_actor.reset();

  client->setBlocked(
      DeterministicFakeLiveKitPublicationClient::Operation::Publish, true);
  current.store(13);
  actor->connect(command(13, "shutdown-blocked-publication"));
  client->waitUntilPending(
      DeterministicFakeLiveKitPublicationClient::Operation::Publish, 1);
  const auto shutdown_started = std::chrono::steady_clock::now();
  actor->shutdown();
  if (std::chrono::steady_clock::now() - shutdown_started > 1800ms) {
    throw std::runtime_error(
        "camera shutdown exceeded its blocked-publication deadline");
  }
  client->releaseNext(
      DeterministicFakeLiveKitPublicationClient::Operation::Publish,
      {.publication_sid = {}});
  for (int i = 0; i < 500 &&
      client->pending(
          DeterministicFakeLiveKitPublicationClient::Operation::Publish) != 0;
      ++i) {
    std::this_thread::sleep_for(5ms);
  }
  actor.reset();

  auto shutdown_client =
      std::make_shared<DeterministicFakeLiveKitPublicationClient>();
  shutdown_client->retainRuntimeLifetime(main_lifetime);
  shutdown_client->setVoiceSessionForTest("voice");
  auto shutdown_factory = std::make_shared<Factory>();
  std::atomic_uint64_t shutdown_current{1};
  auto shutdown_actor = std::make_unique<CameraActor>(
      emitter,
      [](MediaCommand) { return true; },
      [&](const std::string&, std::uint64_t generation) {
        return generation == shutdown_current.load();
      },
      shutdown_client,
      shutdown_factory);
  shutdown_actor->connect(command(1, "active-shutdown-unpublish"));
  if (!waitReply(sink, "active-shutdown-unpublish").ok) {
    throw std::runtime_error("active shutdown-unpublish scenario did not start");
  }
  shutdown_client->setBlocked(
      DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, true);
  shutdown_client->setBlocked(
      DeterministicFakeLiveKitPublicationClient::Operation::Publish, true);
  shutdown_current.store(2);
  shutdown_actor->connect(command(2, "stale-shutdown-publication"));
  shutdown_client->waitUntilPending(
      DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, 1);
  shutdown_client->waitUntilPending(
      DeterministicFakeLiveKitPublicationClient::Operation::Publish, 1);
  const auto active_shutdown_started = std::chrono::steady_clock::now();
  shutdown_actor->shutdown();
  if (std::chrono::steady_clock::now() - active_shutdown_started > 1800ms) {
    throw std::runtime_error(
        "camera shutdown composed active unpublish and stale publish deadlines");
  }
  shutdown_actor.reset();
  shutdown_client->releaseNext(
      DeterministicFakeLiveKitPublicationClient::Operation::Publish,
      {.publication_sid = {}});
  shutdown_client->releaseNext(
      DeterministicFakeLiveKitPublicationClient::Operation::Unpublish);

  // The terminal-post gate closes the check/call race: shutdown waits for a
  // callback that has entered the gate, then clears the borrowed function.
  auto gate_sink = std::make_shared<Sink>();
  SequencedEmitter gate_emitter(gate_sink);
  auto gate_client =
      std::make_shared<DeterministicFakeLiveKitPublicationClient>();
  gate_client->retainRuntimeLifetime(main_lifetime);
  gate_client->setVoiceSessionForTest("voice");
  auto gate_factory = std::make_shared<Factory>();
  gate_factory->fail.store(true);
  std::mutex gate_mutex;
  std::condition_variable gate_changed;
  bool gate_entered = false;
  bool gate_release = false;
  std::atomic_bool gate_shutdown_finished{false};
  std::atomic_uint64_t terminal_posts{0};
  auto gate_actor = std::make_unique<CameraActor>(
      gate_emitter,
      [&](MediaCommand) {
        terminal_posts.fetch_add(1);
        return true;
      },
      [](const std::string&, std::uint64_t generation) {
        return generation == 1;
      },
      gate_client,
      gate_factory,
      CameraActor::CreateGpuVideoSource{},
      CameraActor::LaunchRetireWorker{},
      [&] {
        std::unique_lock lock(gate_mutex);
        gate_entered = true;
        gate_changed.notify_all();
        gate_changed.wait(lock, [&] { return gate_release; });
      });
  gate_actor->connect(command(1, "terminal-post-gate"));
  if (!waitReply(gate_sink, "terminal-post-gate").ok) {
    throw std::runtime_error("terminal post gate scenario did not start");
  }
  {
    std::unique_lock lock(gate_mutex);
    if (!gate_changed.wait_for(lock, 2s, [&] { return gate_entered; })) {
      throw std::runtime_error("capture failure did not enter terminal post gate");
    }
  }
  std::thread gate_shutdown([
      actor_to_destroy = std::move(gate_actor),
      &gate_shutdown_finished
    ]() mutable {
    actor_to_destroy.reset();
    gate_shutdown_finished.store(true);
  });
  std::this_thread::sleep_for(100ms);
  if (gate_shutdown_finished.load()) {
    throw std::runtime_error(
        "camera shutdown cleared an in-flight terminal callback");
  }
  {
    std::lock_guard lock(gate_mutex);
    gate_release = true;
  }
  gate_changed.notify_all();
  gate_shutdown.join();
  if (terminal_posts.load() != 1) {
    throw std::runtime_error("terminal post gate lost or duplicated callback");
  }

  // A detached SDK attempt may finish after both actor and emitter teardown.
  // Cancellation checkpoints must not touch borrowed runtime callbacks then.
  auto late_client =
      std::make_shared<DeterministicFakeLiveKitPublicationClient>();
  late_client->retainRuntimeLifetime(main_lifetime);
  late_client->setVoiceSessionForTest("voice");
  late_client->setBlocked(
      DeterministicFakeLiveKitPublicationClient::Operation::Publish, true);
  auto callbacks_alive = std::make_shared<std::atomic_bool>(true);
  auto late_callback_violations =
      std::make_shared<std::atomic_uint64_t>(0);
  {
    auto late_sink = std::make_shared<Sink>();
    SequencedEmitter late_emitter(late_sink);
    auto late_factory = std::make_shared<Factory>();
    auto late_actor = std::make_unique<CameraActor>(
        late_emitter,
        [callbacks_alive, late_callback_violations](MediaCommand) {
          if (!callbacks_alive->load()) {
            late_callback_violations->fetch_add(1);
          }
          return true;
        },
        [callbacks_alive, late_callback_violations](
            const std::string&, std::uint64_t generation) {
          if (!callbacks_alive->load()) {
            late_callback_violations->fetch_add(1);
          }
          return generation == 1;
        },
        late_client,
        late_factory);
    late_actor->connect(command(1, "late-sdk-release"));
    late_client->waitUntilPending(
        DeterministicFakeLiveKitPublicationClient::Operation::Publish, 1);
    const auto destructor_started = std::chrono::steady_clock::now();
    late_actor.reset();
    if (std::chrono::steady_clock::now() - destructor_started > 1800ms) {
      throw std::runtime_error(
          "camera destructor exceeded blocked-attempt deadline");
    }
    callbacks_alive->store(false);
  }
  late_client->releaseNext(
      DeterministicFakeLiveKitPublicationClient::Operation::Publish,
      {.publication_sid = {}});
  for (int i = 0; i < 500 &&
      late_client->pending(
          DeterministicFakeLiveKitPublicationClient::Operation::Publish) != 0;
      ++i) {
    std::this_thread::sleep_for(5ms);
  }
  if (late_callback_violations->load() != 0) {
    throw std::runtime_error(
        "detached camera attempt called runtime callbacks after teardown");
  }

  waitNoPending(
      client, DeterministicFakeLiveKitPublicationClient::Operation::Publish);
  waitNoPending(
      client, DeterministicFakeLiveKitPublicationClient::Operation::Unpublish);
  waitNoPending(
      shutdown_client,
      DeterministicFakeLiveKitPublicationClient::Operation::Publish);
  waitNoPending(
      shutdown_client,
      DeterministicFakeLiveKitPublicationClient::Operation::Unpublish);
  waitNoPending(
      late_client,
      DeterministicFakeLiveKitPublicationClient::Operation::Publish);
  client.reset();
  retry_client.reset();
  shutdown_client.reset();
  gate_client.reset();
  late_client.reset();
  main_lifetime.reset();
  for (int i = 0; i < 1000 && LiveKitLease::active(); ++i) {
    std::this_thread::sleep_for(5ms);
  }
  if (LiveKitLease::active()) {
    throw std::runtime_error(
        "camera lifecycle left SDK work alive before lifetime rollover");
  }

  auto detached_lifetime = std::make_shared<LiveKitRuntimeLifetime>();
  detached_lifetime->initialize();
  auto detached_client =
      std::make_shared<DeterministicFakeLiveKitPublicationClient>();
  detached_client->retainRuntimeLifetime(detached_lifetime);
  detached_client->setVoiceSessionForTest("voice");
  auto detached_factory = std::make_shared<Factory>();
  detached_factory->block.store(true);
  detached_factory->slow_stop.store(true);
  auto detached_sink = std::make_shared<Sink>();
  SequencedEmitter detached_emitter(detached_sink);
  auto detached_actor = std::make_unique<CameraActor>(
      detached_emitter,
      [](MediaCommand) { return true; },
      [](const std::string&, std::uint64_t generation) {
        return generation == 1;
      },
      detached_client,
      detached_factory);
  detached_actor->connect(command(1, "detached-capture-lifetime"));
  if (!waitReply(detached_sink, "detached-capture-lifetime").ok) {
    throw std::runtime_error("detached capture lifetime scenario did not start");
  }
  std::weak_ptr<LiveKitPublicationClient> detached_client_weak =
      detached_client;
  detached_actor->shutdown();
  detached_actor.reset();
  detached_client.reset();
  detached_lifetime.reset();
  for (int i = 0; i < 200 && !detached_client_weak.expired(); ++i) {
    std::this_thread::sleep_for(5ms);
  }
  if (!detached_client_weak.expired()) {
    throw std::runtime_error(
        "detached capture worker retained the camera actor LiveKit client");
  }
  if (LiveKitLease::activeCount() != 1) {
    throw std::runtime_error(
        "detached capture worker released LiveKit before its sources");
  }
  for (int i = 0; i < 1000 && LiveKitLease::active(); ++i) {
    std::this_thread::sleep_for(5ms);
  }
  if (LiveKitLease::active()) {
    throw std::runtime_error(
        "detached capture worker did not release LiveKit lifetime");
  }
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
