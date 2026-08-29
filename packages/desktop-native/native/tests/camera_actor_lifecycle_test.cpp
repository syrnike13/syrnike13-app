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
#include "media/video_resource_admission.hpp"

namespace {
using namespace std::chrono_literals;
using namespace syrnike::desktop_native;
using namespace syrnike::desktop_native::media;

// wait_until bounds the wait itself, but a loaded Windows runner can resume
// the calling thread after the deadline. Keep deadline assertions distinct
// from the production budget while still catching composed or unbounded waits.
constexpr auto kDeadlineAssertionBudget = kNativeShutdownBudget + 500ms;
// Keep prompt-path assertions below the production shutdown deadline, but
// leave enough headroom for ASan and a loaded Windows scheduler to resume the
// test thread. A composed wait still takes at least kNativeShutdownBudget.
constexpr auto kPromptLaneAssertionBudget = 1s;

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
        if (event.type == syrnike::desktop_native::NativeEventType::Reply && event.request_id == request_id) return event;
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
        if (event.type == syrnike::desktop_native::NativeEventType::CameraTerminal &&
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
    const std::shared_ptr<DeterministicFakeLiveKitVoiceSession>& client,
    DeterministicFakeLiveKitVoiceSession::Operation operation) {
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
      std::shared_ptr<std::atomic_uint64_t> stop_calls,
      std::shared_ptr<std::atomic_uint64_t> read_calls)
      : fail_(fail), block_(block), slow_stop_(slow_stop), gpu_(gpu),
        stop_calls_(std::move(stop_calls)),
        read_calls_(std::move(read_calls)) {}
  bool read(CameraFrame& frame, const std::atomic_bool& running) override {
    read_calls_->fetch_add(1, std::memory_order_acq_rel);
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
  std::shared_ptr<std::atomic_uint64_t> read_calls_;
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
        fail.load(), block.load(), slow_stop.load(), gpu, stop_calls,
        read_calls);
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
  std::shared_ptr<std::atomic_uint64_t> read_calls =
      std::make_shared<std::atomic_uint64_t>(0);
  std::mutex mutex;
  std::weak_ptr<CameraCapture> first_gpu_capture;
};

MediaCommand command(std::uint64_t generation, std::string request_id = "request") {
  MediaCommand result;
  result.type = syrnike::desktop_native::NativeCommandType::ConnectCamera; result.request_id = std::move(request_id);
  result.session_id = "voice"; result.generation = generation;
  result.participant_identity = "user:native-camera";
  result.width = 16; result.height = 16; result.fps = 30;
  return result;
}

void verifyCameraEncoderSaturationFallsBackToCpu(
    const std::shared_ptr<LiveKitRuntimeLifetime>& runtime_lifetime) {
  auto limits = productionVideoResourceLimits();
  limits.maximum_hardware_encoder_sessions = 1;
  VideoResourceAdmissionBudget budget(limits);
  auto screen_encoder = requireVideoResourceAdmission(
      budget,
      VideoResourceRequest{
          .owner = VideoResourceOwner::ScreenEncoder,
          .owner_id = "screen:test-held",
          .hardware_encoder_sessions = 1,
      });
  auto sink = std::make_shared<Sink>();
  SequencedEmitter emitter(sink);
  auto client = std::make_shared<DeterministicFakeLiveKitVoiceSession>();
  client->retainRuntimeLifetime(runtime_lifetime);
  client->setVoiceSessionForTest("voice");
  auto factory = std::make_shared<Factory>();
  factory->gpu_first.store(true);
  std::atomic_uint64_t source_calls{0};
  auto actor = std::make_unique<CameraActor>(
      emitter,
      [](MediaCommand) { return true; },
      [](const std::string&, std::uint64_t generation) {
        return generation == 1;
      },
      client,
      factory,
      [&](int, int) {
        source_calls.fetch_add(1, std::memory_order_acq_rel);
        return std::shared_ptr<livekit::D3D11H264VideoSource>{};
      },
      CleanupStartProbe{},
      CameraActor::BeforeTerminalPost{},
      CleanupEnqueueProbe{},
      &budget);

  actor->connect(command(1, "encoder-budget-fallback"));
  const auto reply = waitReply(sink, "encoder-budget-fallback");
  if (!reply.ok || source_calls.load(std::memory_order_acquire) != 0 ||
      factory->force_cpu_calls.load(std::memory_order_acquire) != 1 ||
      !factory->gpu_destroyed_before_cpu.load(std::memory_order_acquire)) {
    throw std::runtime_error(
        "camera encoder saturation did not use the typed CPU reopen path");
  }
  auto disconnect = command(1, "encoder-budget-disconnect");
  disconnect.type = syrnike::desktop_native::NativeCommandType::DisconnectCamera;
  actor->disconnect(disconnect);
  actor->shutdown();
  actor.reset();
  if (budget.snapshot().current.hardware_encoder_sessions != 1) {
    throw std::runtime_error(
        "camera fallback changed the held screen encoder reservation");
  }
  screen_encoder.reset();
  if (budget.snapshot().current.hardware_encoder_sessions != 0) {
    throw std::runtime_error(
        "camera fallback test did not return encoder capacity exactly once");
  }
}
}

int main() try {
  auto main_lifetime = std::make_shared<LiveKitRuntimeLifetime>();
  main_lifetime->initialize();
  verifyCameraEncoderSaturationFallsBackToCpu(main_lifetime);
  auto sink = std::make_shared<Sink>();
  SequencedEmitter emitter(sink);
  auto client = std::make_shared<DeterministicFakeLiveKitVoiceSession>();
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
  probe.type = syrnike::desktop_native::NativeCommandType::ProbeCameraActor;
  probe.request_id = "probe-available";
  if (actor->probe(probe).state != "available") {
    throw std::runtime_error("idle camera actor did not report available capacity");
  }

  // A publication blocked in the worker must not occupy the camera command lane.
  // Disconnect settles the original request immediately; a newer generation can
  // start before the stale SDK call returns.
  client->setBlocked(DeterministicFakeLiveKitVoiceSession::Operation::Publish, true);
  actor->connect(command(2, "blocked"));
  client->waitUntilPending(DeterministicFakeLiveKitVoiceSession::Operation::Publish, 1);
  probe.request_id = "probe-busy";
  if (actor->probe(probe).state != "busy") {
    throw std::runtime_error("pending camera publication did not report busy capacity");
  }
  current.store(3);
  auto cancel = command(2, "cancel"); cancel.type = syrnike::desktop_native::NativeCommandType::DisconnectCamera;
  const auto started = std::chrono::steady_clock::now();
  actor->disconnect(cancel);
  if (std::chrono::steady_clock::now() - started >
      kPromptLaneAssertionBudget) {
    throw std::runtime_error("disconnect blocked behind camera publication");
  }
  const auto blocked_reply = waitReply(sink, "blocked");
  if (blocked_reply.ok || !blocked_reply.error ||
      blocked_reply.error->code != "stale_generation") {
    throw std::runtime_error("cancelled camera connect did not receive typed reply");
  }
  client->releaseNext(DeterministicFakeLiveKitVoiceSession::Operation::Publish,
    {.publication_sid = {}});
  for (int i = 0; i < 200 &&
      client->pending(DeterministicFakeLiveKitVoiceSession::Operation::Publish) != 0; ++i) {
    std::this_thread::sleep_for(5ms);
  }
  client->setBlocked(DeterministicFakeLiveKitVoiceSession::Operation::Publish, false);
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
  auto preview_off = command(4, "preview-off");
  preview_off.type =
      syrnike::desktop_native::NativeCommandType::SetLocalCameraPreviewDemand;
  preview_off.demanded = false;
  actor->setPreviewDemand(preview_off);
  actor->setPreviewDemand(preview_off);
  if (client->localCameraPreviewStopCount() != 2) {
    throw std::runtime_error(
        "duplicate camera preview demand stopped the listener twice");
  }
  auto preview_retry = command(4, "preview-retry");
  preview_retry.type =
      syrnike::desktop_native::NativeCommandType::RetryLocalCameraPreview;
  preview_retry.internal_message = "renderer_presentation_stall";
  actor->retryPreview(preview_retry);
  if (client->localCameraPreviewStartCount() != 2 ||
      client->localCameraPreviewStopCount() != 2) {
    throw std::runtime_error(
        "camera preview retry bypassed a removed demand");
  }
  auto preview_on = preview_off;
  preview_on.request_id = "preview-on";
  preview_on.demanded = true;
  actor->setPreviewDemand(preview_on);
  actor->setPreviewDemand(preview_on);
  if (client->localCameraPreviewStartCount() != 3) {
    throw std::runtime_error(
        "camera preview demand did not restart exactly once");
  }
  actor->retryPreview(preview_retry);
  if (client->localCameraPreviewStartCount() != 4 ||
      client->localCameraPreviewStopCount() != 3) {
    throw std::runtime_error(
        "camera preview retry did not perform one bounded restart");
  }
  auto stale_preview_off = preview_off;
  stale_preview_off.generation = 3;
  bool stale_preview_rejected = false;
  try {
    actor->setPreviewDemand(stale_preview_off);
  } catch (const std::exception&) {
    stale_preview_rejected = true;
  }
  if (!stale_preview_rejected ||
      client->localCameraPreviewStartCount() != 4 ||
      client->localCameraPreviewStopCount() != 3) {
    throw std::runtime_error(
        "stale camera preview demand mutated the current generation");
  }
  auto read_stall = command(4);
  read_stall.type = syrnike::desktop_native::NativeCommandType::CameraTerminal;
  read_stall.internal_message = "camera_capture_timeout";
  actor->handleTerminal(read_stall);
  const auto read_stall_event = waitCameraTerminal(sink, "voice", 4);
  if (!read_stall_event.error ||
      read_stall_event.error->code != "camera_read_stall") {
    throw std::runtime_error(
        "camera async read timeout lost its typed terminal code");
  }
  auto disconnect = command(4, "disconnect-preview");
  disconnect.type = syrnike::desktop_native::NativeCommandType::DisconnectCamera;
  actor->disconnect(disconnect);
  if (client->localCameraPreviewStopCount() != 4) {
    throw std::runtime_error("camera disconnect did not stop its local preview");
  }

  // Cleanup failures are secondary: a stale attempt still settles with its
  // original typed result even when the SDK throws while unpublishing it.
  client->setBlocked(DeterministicFakeLiveKitVoiceSession::Operation::Publish, true);
  client->setBlocked(DeterministicFakeLiveKitVoiceSession::Operation::Unpublish, true);
  current.store(5);
  actor->connect(command(5, "cleanup-throws"));
  client->waitUntilPending(DeterministicFakeLiveKitVoiceSession::Operation::Publish, 1);
  current.store(6);
  client->releaseNext(DeterministicFakeLiveKitVoiceSession::Operation::Publish,
    {.publication_sid = "cleanup-publication"});
  client->waitUntilPending(DeterministicFakeLiveKitVoiceSession::Operation::Unpublish, 1);
  client->releaseNext(DeterministicFakeLiveKitVoiceSession::Operation::Unpublish,
    {.error_message = "injected unpublish cleanup failure"});
  const auto cleanup_reply = waitReply(sink, "cleanup-throws");
  if (cleanup_reply.ok || !cleanup_reply.error ||
      cleanup_reply.error->code != "stale_generation") {
    throw std::runtime_error("camera cleanup exception suppressed the original failure");
  }
  client->setBlocked(DeterministicFakeLiveKitVoiceSession::Operation::Publish, false);
  client->setBlocked(DeterministicFakeLiveKitVoiceSession::Operation::Unpublish, false);

  // A capture reader that never produces a sample must be interruptible by
  // CameraCapture::stop; disconnect cannot wait for an unbounded ReadSample.
  factory->block.store(true);
  current.store(7);
  const auto reads_before_block = factory->read_calls->load(
      std::memory_order_acquire);
  actor->connect(command(7, "blocked-capture"));
  if (!waitReply(sink, "blocked-capture").ok) {
    throw std::runtime_error("blocked capture did not finish publication");
  }
  for (int i = 0;
       i < 1000 && factory->read_calls->load(std::memory_order_acquire) ==
           reads_before_block;
       ++i) {
    std::this_thread::sleep_for(5ms);
  }
  if (factory->read_calls->load(std::memory_order_acquire) ==
      reads_before_block) {
    throw std::runtime_error("blocked capture did not enter its reader");
  }
  auto stop_blocked = command(7, "stop-blocked-capture");
  stop_blocked.type = syrnike::desktop_native::NativeCommandType::DisconnectCamera;
  const auto stops_before_block = factory->stop_calls->load(
      std::memory_order_acquire);
  const auto stop_started = std::chrono::steady_clock::now();
  actor->disconnect(stop_blocked);
  if (std::chrono::steady_clock::now() - stop_started >
      kPromptLaneAssertionBudget) {
    throw std::runtime_error("camera disconnect waited for a blocked reader");
  }
  if (factory->stop_calls->load(std::memory_order_acquire) !=
      stops_before_block + 1) {
    throw std::runtime_error(
        "camera disconnect did not stop the blocked capture exactly once");
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
  stop_slow.type = syrnike::desktop_native::NativeCommandType::DisconnectCamera;
  const auto slow_stop_started = std::chrono::steady_clock::now();
  actor->disconnect(stop_slow);
  if (std::chrono::steady_clock::now() - slow_stop_started >
      kDeadlineAssertionBudget) {
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
  stop_cpu_fallback.type = syrnike::desktop_native::NativeCommandType::DisconnectCamera;
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
  // publish while supervised retirement still owns the old resources.
  current.store(11);
  actor->connect(command(11, "active-unpublish"));
  if (!waitReply(sink, "active-unpublish").ok) {
    throw std::runtime_error("active unpublish scenario did not start");
  }
  client->setBlocked(
      DeterministicFakeLiveKitVoiceSession::Operation::Unpublish, true);
  auto stop_active_unpublish = command(11, "stop-active-unpublish");
  stop_active_unpublish.type = syrnike::desktop_native::NativeCommandType::DisconnectCamera;
  const auto active_unpublish_started = std::chrono::steady_clock::now();
  actor->disconnect(stop_active_unpublish);
  if (std::chrono::steady_clock::now() - active_unpublish_started >
      kDeadlineAssertionBudget) {
    throw std::runtime_error("active camera unpublish exceeded retire deadline");
  }
  client->waitUntilPending(
      DeterministicFakeLiveKitVoiceSession::Operation::Unpublish, 1);
  current.store(12);
  actor->connect(command(12, "after-active-unpublish"));
  if (!waitReply(sink, "after-active-unpublish").ok) {
    throw std::runtime_error(
        "supervised active unpublish did not release next-start capacity");
  }
  client->releaseNext(
      DeterministicFakeLiveKitVoiceSession::Operation::Unpublish);
  client->setBlocked(
      DeterministicFakeLiveKitVoiceSession::Operation::Unpublish, false);
  auto stop_after_active_unpublish =
      command(12, "stop-after-active-unpublish");
  stop_after_active_unpublish.type = syrnike::desktop_native::NativeCommandType::DisconnectCamera;
  actor->disconnect(stop_after_active_unpublish);

  // Retirement launch failures retain the shared task. The management worker
  // retries without another camera command and executes cleanup exactly once.
  auto retry_client =
      std::make_shared<DeterministicFakeLiveKitVoiceSession>();
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
      [&] {
        if (retire_launches.fetch_add(1) == 0) {
          throw std::runtime_error("injected retirement launch failure");
        }
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
  retry_disconnect.type = syrnike::desktop_native::NativeCommandType::DisconnectCamera;
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
      DeterministicFakeLiveKitVoiceSession::Operation::Publish, true);
  current.store(13);
  actor->connect(command(13, "shutdown-blocked-publication"));
  client->waitUntilPending(
      DeterministicFakeLiveKitVoiceSession::Operation::Publish, 1);
  const auto shutdown_started = std::chrono::steady_clock::now();
  actor->shutdown();
  if (std::chrono::steady_clock::now() - shutdown_started >
      kDeadlineAssertionBudget) {
    throw std::runtime_error(
        "camera shutdown exceeded its blocked-publication deadline");
  }
  client->releaseNext(
      DeterministicFakeLiveKitVoiceSession::Operation::Publish,
      {.publication_sid = {}});
  for (int i = 0; i < 500 &&
      client->pending(
          DeterministicFakeLiveKitVoiceSession::Operation::Publish) != 0;
      ++i) {
    std::this_thread::sleep_for(5ms);
  }
  actor.reset();

  auto shutdown_client =
      std::make_shared<DeterministicFakeLiveKitVoiceSession>();
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
      DeterministicFakeLiveKitVoiceSession::Operation::Unpublish, true);
  shutdown_client->setBlocked(
      DeterministicFakeLiveKitVoiceSession::Operation::Publish, true);
  shutdown_current.store(2);
  shutdown_actor->connect(command(2, "stale-shutdown-publication"));
  shutdown_client->waitUntilPending(
      DeterministicFakeLiveKitVoiceSession::Operation::Unpublish, 1);
  shutdown_client->waitUntilPending(
      DeterministicFakeLiveKitVoiceSession::Operation::Publish, 1);
  const auto active_shutdown_started = std::chrono::steady_clock::now();
  shutdown_actor->shutdown();
  if (std::chrono::steady_clock::now() - active_shutdown_started >
      kDeadlineAssertionBudget) {
    throw std::runtime_error(
        "camera shutdown composed active unpublish and stale publish deadlines");
  }
  shutdown_actor.reset();
  shutdown_client->releaseNext(
      DeterministicFakeLiveKitVoiceSession::Operation::Publish,
      {.publication_sid = {}});
  shutdown_client->releaseNext(
      DeterministicFakeLiveKitVoiceSession::Operation::Unpublish);

  // The terminal-post gate closes the check/call race: shutdown waits for a
  // callback that has entered the gate, then clears the borrowed function.
  auto gate_sink = std::make_shared<Sink>();
  SequencedEmitter gate_emitter(gate_sink);
  auto gate_client =
      std::make_shared<DeterministicFakeLiveKitVoiceSession>();
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
      syrnike::desktop_native::CleanupStartProbe{},
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

  // A blocked SDK attempt may finish after both actor and emitter teardown.
  // CleanupSupervisor must own its joinable handle while cancellation
  // checkpoints avoid borrowed runtime callbacks.
  auto late_client =
      std::make_shared<DeterministicFakeLiveKitVoiceSession>();
  late_client->retainRuntimeLifetime(main_lifetime);
  late_client->setVoiceSessionForTest("voice");
  late_client->setBlocked(
      DeterministicFakeLiveKitVoiceSession::Operation::Publish, true);
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
        DeterministicFakeLiveKitVoiceSession::Operation::Publish, 1);
    const auto late_cleanup_before = CleanupSupervisor::instance().snapshot();
    const auto destructor_started = std::chrono::steady_clock::now();
    late_actor.reset();
    if (std::chrono::steady_clock::now() - destructor_started >
        kDeadlineAssertionBudget) {
      throw std::runtime_error(
          "camera destructor exceeded blocked-attempt deadline");
    }
    const auto late_cleanup_after = CleanupSupervisor::instance().snapshot();
    if (late_cleanup_after.accepted_jobs <
            late_cleanup_before.accepted_jobs + 1 ||
        late_cleanup_after.owned_jobs == 0 ||
        late_cleanup_after.worker_threads > late_cleanup_after.worker_limit ||
        late_cleanup_after.worker_handles > late_cleanup_after.worker_limit) {
      throw std::runtime_error(
          "blocked camera attempt escaped cleanup-supervisor ownership");
    }
    callbacks_alive->store(false);
  }
  late_client->releaseNext(
      DeterministicFakeLiveKitVoiceSession::Operation::Publish,
      {.publication_sid = {}});
  for (int i = 0; i < 500 &&
      late_client->pending(
          DeterministicFakeLiveKitVoiceSession::Operation::Publish) != 0;
      ++i) {
    std::this_thread::sleep_for(5ms);
  }
  if (late_callback_violations->load() != 0) {
    throw std::runtime_error(
        "late camera attempt called runtime callbacks after teardown");
  }

  waitNoPending(
      client, DeterministicFakeLiveKitVoiceSession::Operation::Publish);
  waitNoPending(
      client, DeterministicFakeLiveKitVoiceSession::Operation::Unpublish);
  waitNoPending(
      shutdown_client,
      DeterministicFakeLiveKitVoiceSession::Operation::Publish);
  waitNoPending(
      shutdown_client,
      DeterministicFakeLiveKitVoiceSession::Operation::Unpublish);
  waitNoPending(
      late_client,
      DeterministicFakeLiveKitVoiceSession::Operation::Publish);
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

  auto supervised_lifetime = std::make_shared<LiveKitRuntimeLifetime>();
  supervised_lifetime->initialize();
  auto supervised_client =
      std::make_shared<DeterministicFakeLiveKitVoiceSession>();
  supervised_client->retainRuntimeLifetime(supervised_lifetime);
  supervised_client->setVoiceSessionForTest("voice");
  auto supervised_factory = std::make_shared<Factory>();
  supervised_factory->block.store(true);
  supervised_factory->slow_stop.store(true);
  auto supervised_sink = std::make_shared<Sink>();
  SequencedEmitter supervised_emitter(supervised_sink);
  auto supervised_actor = std::make_unique<CameraActor>(
      supervised_emitter,
      [](MediaCommand) { return true; },
      [](const std::string&, std::uint64_t generation) {
        return generation == 1;
      },
      supervised_client,
      supervised_factory);
  supervised_actor->connect(command(1, "supervised-capture-lifetime"));
  if (!waitReply(supervised_sink, "supervised-capture-lifetime").ok) {
    throw std::runtime_error("supervised capture lifetime scenario did not start");
  }
  for (int i = 0; i < 1000 && supervised_factory->read_calls->load() == 0;
       ++i) {
    std::this_thread::sleep_for(5ms);
  }
  if (supervised_factory->read_calls->load() == 0) {
    throw std::runtime_error(
        "supervised capture lifetime scenario did not enter the capture worker");
  }
  std::weak_ptr<LiveKitVoiceSession> supervised_client_weak =
      supervised_client;
  const auto capture_cleanup_before = CleanupSupervisor::instance().snapshot();
  supervised_actor->shutdown();
  const auto capture_cleanup_after = CleanupSupervisor::instance().snapshot();
  if (capture_cleanup_after.accepted_jobs <
          capture_cleanup_before.accepted_jobs + 3 ||
      capture_cleanup_after.owned_jobs < 2 ||
      capture_cleanup_after.peak_owned_jobs >
          capture_cleanup_after.admission_capacity ||
      capture_cleanup_after.worker_threads >
          capture_cleanup_after.worker_limit ||
      capture_cleanup_after.worker_handles >
          capture_cleanup_after.worker_limit) {
    throw std::runtime_error(
        "blocked camera capture escaped bounded cleanup ownership");
  }
  supervised_actor.reset();
  supervised_client.reset();
  supervised_lifetime.reset();
  for (int i = 0; i < 200 && !supervised_client_weak.expired(); ++i) {
    std::this_thread::sleep_for(5ms);
  }
  if (!supervised_client_weak.expired()) {
    throw std::runtime_error(
        "supervised capture worker retained the camera actor LiveKit client");
  }
  if (LiveKitLease::activeCount() != 1) {
    throw std::runtime_error(
        "supervised capture worker released LiveKit before its sources");
  }
  for (int i = 0; i < 1000 && LiveKitLease::active(); ++i) {
    std::this_thread::sleep_for(5ms);
  }
  if (LiveKitLease::active()) {
    throw std::runtime_error(
        "supervised capture worker did not release LiveKit lifetime");
  }
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
