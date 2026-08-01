#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>

#include <livekit/d3d11_h264_video_source.h>

#include "common/event_sink.hpp"
#include "common/sequenced_emitter.hpp"
#include "media/livekit_publication_client.hpp"
#include "media/media_runtime.hpp"
#include "media/screen_actor.hpp"
#include "media/screen_publication_controller.hpp"

namespace {

using namespace std::chrono_literals;

// Event predicates decide success; this deadline only terminates a stalled test.
constexpr auto kTestWatchdog = 15s;

class CollectingSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent event) override {
    {
      std::lock_guard lock(mutex_);
      events_.push_back(std::move(event));
    }
    changed_.notify_all();
    return true;
  }

  void close() override {}

  syrnike::desktop_native::RuntimeEvent waitReply(
    const std::string& request_id,
    std::chrono::milliseconds timeout = kTestWatchdog
  ) {
    std::unique_lock lock(mutex_);
    const bool found = changed_.wait_for(lock, timeout, [&] {
      for (const auto& event : events_) {
        if (event.type == "reply" && event.request_id == request_id) return true;
      }
      return false;
    });
    if (!found) throw std::runtime_error("timed out waiting for runtime reply: " + request_id);
    for (const auto& event : events_) {
      if (event.type == "reply" && event.request_id == request_id) return event;
    }
    throw std::runtime_error("runtime reply disappeared");
  }

  syrnike::desktop_native::RuntimeEvent waitEvent(
    const std::string& type,
    const std::string& session_id,
    std::uint64_t generation,
    std::chrono::milliseconds timeout = kTestWatchdog
  ) {
    std::unique_lock lock(mutex_);
    const bool found = changed_.wait_for(lock, timeout, [&] {
      for (const auto& event : events_) {
        if (event.type == type && event.session_id == session_id &&
            event.generation == generation) {
          return true;
        }
      }
      return false;
    });
    if (!found) throw std::runtime_error("timed out waiting for runtime event: " + type);
    for (const auto& event : events_) {
      if (event.type == type && event.session_id == session_id &&
          event.generation == generation) {
        return event;
      }
    }
    throw std::runtime_error("runtime event disappeared");
  }

  std::size_t countSessionStarted(
    const std::string& session_id,
    std::uint64_t generation
  ) const {
    std::lock_guard lock(mutex_);
    std::size_t count = 0;
    for (const auto& event : events_) {
      if (event.type == "sessionStarted" && event.session_id == session_id &&
          event.generation == generation) {
        ++count;
      }
    }
    return count;
  }

  std::size_t countRepliesWithEmptyRequestId() const {
    std::lock_guard lock(mutex_);
    std::size_t count = 0;
    for (const auto& event : events_) {
      if (event.type == "reply" && event.request_id.empty()) ++count;
    }
    return count;
  }

 private:
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::vector<syrnike::desktop_native::RuntimeEvent> events_;
};

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

template <typename Verify>
void verifyPhase(const char* name, Verify verify) {
  try {
    verify();
  } catch (const std::exception& error) {
    throw std::runtime_error(std::string(name) + ": " + error.what());
  }
}

syrnike::desktop_native::MediaCommand screenCommand(
  std::string type,
  std::string request_id,
  std::string session_id,
  std::uint64_t generation
) {
  syrnike::desktop_native::MediaCommand command;
  command.type = std::move(type);
  command.request_id = std::move(request_id);
  command.session_id = std::move(session_id);
  command.generation = generation;
  command.participant_identity = "user:desktop-native:screen";
  command.source_id = "screen:1";
  command.width = 1280;
  command.height = 720;
  command.fps = 30;
  command.bitrate = 2'500'000;
  command.audio_bitrate = 128'000;
  command.audio_requested = false;
  return command;
}

void requireProbe(
  syrnike::desktop_native::media::MediaRuntime& runtime,
  const std::shared_ptr<CollectingSink>& sink,
  const std::string& request_id
) {
  syrnike::desktop_native::MediaCommand probe;
  probe.type = "probeScreenActor";
  probe.request_id = request_id;
  require(runtime.dispatch(probe), "runtime rejected screen actor probe");
  require(
    sink->waitReply(request_id).ok,
    "screen actor probe did not reply while LiveKit was blocked"
  );
}

class FakeD3D11H264VideoSource final : public livekit::D3D11H264VideoSource {
 public:
  FakeD3D11H264VideoSource(int width, int height)
      : D3D11H264VideoSource(width, height) {}

  bool capture(
    std::unique_ptr<livekit::D3D11TextureLease> lease,
    std::int64_t
  ) override {
    if (lease) lease->release();
    return true;
  }
};

class FakeScreenGpuCapturer final
    : public syrnike::desktop_native::media::ScreenGpuCapturer {
 public:
  syrnike::desktop_native::media::ScreenGpuFrameResult capture(
      syrnike::desktop_native::media::ScreenGpuFrame&) override {
    return {};
  }
  void discard(
      const syrnike::desktop_native::media::ScreenGpuFrame&) noexcept override {}
  void pollRetirement() noexcept override {}
  void setPreviewDemand(
      syrnike::desktop_native::media::ScreenPreviewDemand) override {}
  bool takePreviewFrame(
      syrnike::desktop_native::media::ScreenPreviewFrame&) override {
    return false;
  }
  bool takePreviewFailure(
      syrnike::desktop_native::media::ScreenPreviewFailure&) override {
    return false;
  }
  void releasePreviewFrame(std::uint64_t) noexcept override {}
  std::size_t previewFramesInFlight() const noexcept override { return 0; }
  const char* method() const noexcept override { return "fake_gpu"; }
  LUID adapterLuid() const noexcept override { return {}; }
  std::size_t frameSlotsAvailable() const noexcept override { return 1; }
  std::size_t frameSlotsTotal() const noexcept override { return 1; }
  syrnike::desktop_native::media::ScreenFrameFlowStats frameFlowStats()
      const noexcept override {
    return {};
  }
};

class ScreenControllerHarness final {
 public:
  using Controller = syrnike::desktop_native::media::ScreenPublicationController;
  using FakeLiveKit =
    syrnike::desktop_native::media::DeterministicFakeLiveKitPublicationClient;

  ScreenControllerHarness(
    Controller::QueryEncoderCapability query_encoder_capability,
    Controller::CreateVideoSource create_video_source,
    Controller::LaunchRetireWorker launch_retire_worker = {},
    Controller::BeforeRetireEnqueue before_retire_enqueue = {},
    Controller::BeforeResourceCleanup before_resource_cleanup = {},
    Controller::PrepareCapture prepare_capture = {}
  ) : sink(std::make_shared<CollectingSink>()),
      emitter(sink),
      livekit(std::make_shared<FakeLiveKit>()) {
    if (!prepare_capture) {
      prepare_capture = [](
          const syrnike::desktop_native::MediaCommand&,
          const syrnike::desktop_native::media::ScreenPublicationDescription&) {
        return std::make_shared<FakeScreenGpuCapturer>();
      };
    }
    livekit->setVoiceSessionForTest("screen-di");
    controller = std::make_unique<Controller>(
      emitter,
      [this](syrnike::desktop_native::MediaCommand command) {
        if (command.type == "__screenRetireDone") {
          auto remaining =
            reject_retire_completions_.load(std::memory_order_acquire);
          while (remaining > 0) {
            if (reject_retire_completions_.compare_exchange_weak(
                  remaining,
                  remaining - 1,
                  std::memory_order_acq_rel)) {
              return false;
            }
          }
        }
        {
          std::lock_guard lock(commands_mutex_);
          commands_.push_back(std::move(command));
        }
        commands_changed_.notify_all();
        return true;
      },
      [this](const std::string& session_id, std::uint64_t generation) {
        return session_id == session_id_ && generation == generation_.load();
      },
      livekit,
      Controller::CommitIfCurrent{},
      Controller::Now{},
      [](const syrnike::desktop_native::MediaCommand& command) {
        syrnike::desktop_native::media::ScreenPublicationDescription description;
        description.width = static_cast<std::uint32_t>(command.width);
        description.height = static_cast<std::uint32_t>(command.height);
        return description;
      },
      std::move(prepare_capture),
      [](
        const syrnike::desktop_native::MediaCommand&,
        const syrnike::desktop_native::media::ScreenPublicationDescription&,
        const std::shared_ptr<livekit::D3D11H264VideoSource>&,
        const std::shared_ptr<livekit::LocalVideoTrack>&,
        const std::shared_ptr<livekit::AudioSource>&,
        const std::shared_ptr<syrnike::desktop_native::media::ScreenGpuCapturer>&,
        const std::shared_ptr<std::atomic_bool>&,
        const std::shared_ptr<syrnike::voice::ScreenAudioStopSignal>&,
        const std::function<bool()>&,
        std::thread&,
        std::thread&
      ) {},
      [](const std::string&, std::uint64_t) {},
      std::move(query_encoder_capability),
      std::move(create_video_source),
      std::move(launch_retire_worker),
      std::move(before_retire_enqueue),
      std::move(before_resource_cleanup)
    );
  }

  ~ScreenControllerHarness() {
    livekit->setBlocked(FakeLiveKit::Operation::Publish, false);
    livekit->setBlocked(FakeLiveKit::Operation::Unpublish, false);
    if (controller) controller->shutdown();
  }

  void setCurrent(std::uint64_t generation) { generation_.store(generation); }
  void rejectNextRetireCompletion() {
    reject_retire_completions_.fetch_add(1, std::memory_order_release);
  }

  void handleNextWorkerCommand(std::chrono::milliseconds timeout = kTestWatchdog) {
    controller->handleWorkerCommand(takeNextWorkerCommand(timeout));
  }

  syrnike::desktop_native::MediaCommand takeNextWorkerCommand(
    std::chrono::milliseconds timeout = kTestWatchdog
  ) {
    syrnike::desktop_native::MediaCommand command;
    {
      std::unique_lock lock(commands_mutex_);
      if (!commands_changed_.wait_for(lock, timeout, [this] { return !commands_.empty(); })) {
        throw std::runtime_error("timed out waiting for screen controller worker command");
      }
      command = std::move(commands_.front());
      commands_.pop_front();
    }
    return command;
  }

  std::shared_ptr<CollectingSink> sink;
  syrnike::desktop_native::SequencedEmitter emitter;
  std::shared_ptr<FakeLiveKit> livekit;
  std::unique_ptr<Controller> controller;

 private:
  const std::string session_id_ = "screen-di";
  std::atomic<std::uint64_t> generation_{1};
  std::atomic_uint32_t reject_retire_completions_{0};
  std::mutex commands_mutex_;
  std::condition_variable commands_changed_;
  std::deque<syrnike::desktop_native::MediaCommand> commands_;
};

void verifyUnavailableEncoderFailsClosed() {
  std::atomic_int query_calls{0};
  std::atomic_int factory_calls{0};
  ScreenControllerHarness harness(
    [&] {
      query_calls.fetch_add(1);
      return livekit::D3D11H264Capability{false, "test capability unavailable"};
    },
    [&](int, int) -> std::shared_ptr<livekit::D3D11H264VideoSource> {
      factory_calls.fetch_add(1);
      return {};
    }
  );
  harness.livekit->setBlocked(ScreenControllerHarness::FakeLiveKit::Operation::Publish, true);

  const auto start = screenCommand("startScreenCapture", "di-unavailable", "screen-di", 1);
  harness.controller->startCapture(start);
  harness.handleNextWorkerCommand();
  const auto reply = harness.sink->waitReply("di-unavailable");
  require(!reply.ok, "unavailable encoder capability resolved as success");
  require(
    reply.error && reply.error->code == "gpu_encoder_unavailable",
    "unavailable encoder capability did not return gpu_encoder_unavailable"
  );
  require(query_calls.load() == 1, "encoder capability callback was not called exactly once");
  require(factory_calls.load() == 0, "video source factory ran after unavailable capability");
  require(
    harness.livekit->pending(ScreenControllerHarness::FakeLiveKit::Operation::Publish) == 0,
    "unavailable encoder capability reached LiveKit publication"
  );
  require(
    harness.sink->countSessionStarted("screen-di", 1) == 0,
    "unavailable encoder capability emitted sessionStarted"
  );
}

void verifyCapturePreflightFailsBeforePublication() {
  std::atomic_int source_calls{0};
  std::atomic_int preflight_calls{0};
  ScreenControllerHarness harness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [&](int width, int height) {
      source_calls.fetch_add(1);
      return std::make_shared<FakeD3D11H264VideoSource>(width, height);
    },
    ScreenControllerHarness::Controller::LaunchRetireWorker{},
    ScreenControllerHarness::Controller::BeforeRetireEnqueue{},
    ScreenControllerHarness::Controller::BeforeResourceCleanup{},
    [&](const syrnike::desktop_native::MediaCommand&,
        const syrnike::desktop_native::media::ScreenPublicationDescription&)
        -> std::shared_ptr<syrnike::desktop_native::media::ScreenGpuCapturer> {
      preflight_calls.fetch_add(1);
      throw std::runtime_error(
        "gpu_capture_unavailable: gpu_access_lost: injected preflight failure");
    }
  );
  harness.livekit->setBlocked(
    ScreenControllerHarness::FakeLiveKit::Operation::Publish, true);

  harness.controller->startCapture(screenCommand(
    "startScreenCapture", "preflight-failure", "screen-di", 1));
  harness.handleNextWorkerCommand();
  const auto reply = harness.sink->waitReply("preflight-failure");
  require(
    !reply.ok && reply.error &&
      reply.error->code == "gpu_capture_unavailable",
    "capture preflight failure lost its typed error");
  require(
    preflight_calls.load() == 1 && source_calls.load() == 0,
    "capture preflight did not run before encoder source construction");
  require(
    harness.livekit->pending(
      ScreenControllerHarness::FakeLiveKit::Operation::Publish) == 0,
    "failed capture preflight created a ghost LiveKit publication");
}

void verifyCapturePermissionFailureStopsAutomaticRetry() {
  ScreenControllerHarness harness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [](int width, int height) {
      return std::make_shared<FakeD3D11H264VideoSource>(width, height);
    },
    ScreenControllerHarness::Controller::LaunchRetireWorker{},
    ScreenControllerHarness::Controller::BeforeRetireEnqueue{},
    ScreenControllerHarness::Controller::BeforeResourceCleanup{},
    [](const syrnike::desktop_native::MediaCommand&,
       const syrnike::desktop_native::media::ScreenPublicationDescription&)
        -> std::shared_ptr<syrnike::desktop_native::media::ScreenGpuCapturer> {
      throw std::runtime_error(
        "gpu_permission_denied: DXGI and WGC initialization failed");
    }
  );

  harness.controller->startCapture(screenCommand(
    "startScreenCapture", "permission-failure", "screen-di", 1));
  harness.handleNextWorkerCommand();
  const auto reply = harness.sink->waitReply("permission-failure");
  require(
    !reply.ok && reply.error &&
      reply.error->code == "gpu_permission_denied" &&
      !reply.error->retryable,
    "capture permission denial remained retryable or lost its typed error"
  );
}

void verifyNullEncoderSourceFailsClosed() {
  std::atomic_int factory_calls{0};
  ScreenControllerHarness harness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [&](int, int) -> std::shared_ptr<livekit::D3D11H264VideoSource> {
      factory_calls.fetch_add(1);
      return {};
    }
  );
  harness.livekit->setBlocked(ScreenControllerHarness::FakeLiveKit::Operation::Publish, true);

  const auto start = screenCommand("startScreenCapture", "di-null-source", "screen-di", 1);
  harness.controller->startCapture(start);
  harness.handleNextWorkerCommand();
  const auto reply = harness.sink->waitReply("di-null-source");
  require(!reply.ok, "null encoder source resolved as success");
  require(
    reply.error && reply.error->code == "gpu_encoder_unavailable",
    "null encoder source did not return gpu_encoder_unavailable"
  );
  require(factory_calls.load() == 1, "video source factory was not called exactly once");
  require(
    harness.livekit->pending(ScreenControllerHarness::FakeLiveKit::Operation::Publish) == 0,
    "null encoder source reached LiveKit publication"
  );
  require(
    harness.sink->countSessionStarted("screen-di", 1) == 0,
    "null encoder source emitted sessionStarted"
  );
}

void verifyCancelledPublishRollsBackExactSid() {
  ScreenControllerHarness harness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [](int width, int height) {
      return std::make_shared<FakeD3D11H264VideoSource>(width, height);
    }
  );
  harness.livekit->setBlocked(ScreenControllerHarness::FakeLiveKit::Operation::Publish, true);

  const auto start = screenCommand("startScreenCapture", "di-stale", "screen-di", 1);
  harness.controller->startCapture(start);
  harness.livekit->waitUntilPending(
    ScreenControllerHarness::FakeLiveKit::Operation::Publish,
    1,
    kTestWatchdog
  );

  harness.setCurrent(2);
  const auto cancel = screenCommand("disconnectScreen", "di-cancel", "screen-di", 2);
  harness.controller->disconnect(cancel, false);

  harness.livekit->setBlocked(ScreenControllerHarness::FakeLiveKit::Operation::Unpublish, true);
  ScreenControllerHarness::FakeLiveKit::Release published;
  published.publication_sid = "screen-video-exact";
  harness.livekit->releaseNext(
    ScreenControllerHarness::FakeLiveKit::Operation::Publish,
    std::move(published)
  );
  harness.livekit->waitUntilPending(
    ScreenControllerHarness::FakeLiveKit::Operation::Unpublish,
    1,
    kTestWatchdog
  );
  harness.livekit->releaseNext(ScreenControllerHarness::FakeLiveKit::Operation::Unpublish);

  harness.handleNextWorkerCommand();
  const auto reply = harness.sink->waitReply("di-stale");
  require(!reply.ok, "cancelled screen publish resolved as success");
  require(
    reply.error && reply.error->code == "stale_generation",
    "cancelled screen publish did not return stale_generation"
  );
  require(
    harness.sink->countSessionStarted("screen-di", 1) == 0,
    "cancelled screen publish emitted an obsolete sessionStarted"
  );
  const auto unpublished_sids = harness.livekit->unpublishedPublicationSids();
  require(
    unpublished_sids.size() == 1 && unpublished_sids.front() == "screen-video-exact",
    "cancelled screen publish did not roll back the exact publication SID"
  );
}

ScreenControllerHarness makeWorkingHarness() {
  return ScreenControllerHarness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [](int width, int height) {
      return std::make_shared<FakeD3D11H264VideoSource>(width, height);
    }
  );
}

void startHarnessCapture(ScreenControllerHarness& harness, const std::string& request_id) {
  const auto start = screenCommand("startScreenCapture", request_id, "screen-di", 1);
  harness.controller->startCapture(start);
  harness.handleNextWorkerCommand();
  require(harness.sink->waitReply(request_id).ok, "screen harness capture did not start");
}

void releaseRetirement(ScreenControllerHarness& harness) {
  using Operation = ScreenControllerHarness::FakeLiveKit::Operation;
  harness.livekit->waitUntilPending(Operation::Unpublish, 1, kTestWatchdog);
  harness.livekit->releaseNext(Operation::Unpublish);
  harness.handleNextWorkerCommand();
}

void verifyRtpStallRestartsCapture() {
  using Operation = ScreenControllerHarness::FakeLiveKit::Operation;
  auto harness = makeWorkingHarness();
  startHarnessCapture(harness, "di-stall-start");
  require(
    harness.sink->countSessionStarted("screen-di", 1) == 1,
    "initial screen capture did not emit sessionStarted exactly once"
  );

  harness.livekit->setBlocked(Operation::Unpublish, true);
  harness.livekit->setBlocked(Operation::Publish, true);
  auto stalled = screenCommand(
    "__screenExecutePublicationRestart", {}, "screen-di", 1);
  harness.controller->executePublicationRestart(stalled);

  releaseRetirement(harness);
  harness.livekit->waitUntilPending(Operation::Publish, 1, kTestWatchdog);
  harness.livekit->releaseNext(Operation::Publish);
  harness.handleNextWorkerCommand();

  require(
    harness.sink->countSessionStarted("screen-di", 1) == 1,
    "internal RTP recovery emitted a duplicate sessionStarted event"
  );
  require(
    harness.sink->countRepliesWithEmptyRequestId() == 0,
    "RTP stall recovery emitted an invalid empty-request reply"
  );
}

void verifyManualStopCancelsPendingStallRestart() {
  using Operation = ScreenControllerHarness::FakeLiveKit::Operation;
  auto harness = makeWorkingHarness();
  startHarnessCapture(harness, "di-stop-start");

  harness.livekit->setBlocked(Operation::Unpublish, true);
  harness.livekit->setBlocked(Operation::Publish, true);
  auto stalled = screenCommand(
    "__screenExecutePublicationRestart", {}, "screen-di", 1);
  harness.controller->executePublicationRestart(stalled);
  harness.livekit->waitUntilPending(Operation::Unpublish, 1, kTestWatchdog);

  const auto stop = screenCommand("stopScreenCapture", "di-stop", "screen-di", 1);
  harness.controller->stopCapture(stop);
  releaseRetirement(harness);
  const auto probe = harness.controller->probe(
    screenCommand("probeScreenActor", {}, "screen-di", 1)
  );
  require(
    probe.state == "available" &&
      harness.livekit->pending(Operation::Publish) == 0,
    "manual stop launched the pending RTP stall restart"
  );
  require(
    harness.sink->countSessionStarted("screen-di", 1) == 1,
    "manual stop promoted an unexpected replacement screen capture"
  );
}

void verifyRejectedRetireCompletionRetriesInternally() {
  using Operation = ScreenControllerHarness::FakeLiveKit::Operation;
  auto harness = makeWorkingHarness();
  startHarnessCapture(harness, "di-retire-retry-start");
  harness.livekit->setBlocked(Operation::Unpublish, true);
  harness.rejectNextRetireCompletion();

  const auto stop =
    screenCommand("stopScreenCapture", "di-retire-retry-stop", "screen-di", 1);
  harness.controller->stopCapture(stop);
  harness.livekit->waitUntilPending(Operation::Unpublish, 1, kTestWatchdog);
  harness.livekit->releaseNext(Operation::Unpublish);

  const auto completion = harness.takeNextWorkerCommand();
  require(
    completion.type == "__screenRetireDone",
    "rejected retirement completion was not retried internally"
  );
  harness.controller->handleWorkerCommand(completion);
  const auto probe = harness.controller->probe(
    screenCommand("probeScreenActor", {}, "screen-di", 1)
  );
  require(
    probe.state == "available",
    "retried retirement completion did not release controller capacity"
  );
}

void verifyControllerOnlyExecutesRecoveryPolicy() {
  using Operation = ScreenControllerHarness::FakeLiveKit::Operation;
  auto harness = makeWorkingHarness();
  startHarnessCapture(harness, "di-budget-start");
  harness.livekit->setBlocked(Operation::Unpublish, true);
  harness.livekit->setBlocked(Operation::Publish, true);

  auto stalled = screenCommand(
    "__screenExecutePublicationRestart", {}, "screen-di", 1);
  stalled.internal_message = "encoder_output_stalled";
  for (int attempt = 0; attempt < 4; ++attempt) {
    stalled.revision = static_cast<std::uint64_t>(attempt + 1);
    harness.controller->executePublicationRestart(stalled);
    releaseRetirement(harness);
    harness.livekit->waitUntilPending(Operation::Publish, 1, kTestWatchdog);
    harness.livekit->releaseNext(Operation::Publish);
    harness.handleNextWorkerCommand();
  }
  require(
    harness.sink->countSessionStarted("screen-di", 1) == 1,
    "explicit recovery execution exposed internal restarts as new sessions"
  );
  require(
    harness.sink->countRepliesWithEmptyRequestId() == 0,
    "explicit recovery execution emitted an invalid empty-request reply"
  );
}

void waitForAvailable(
  syrnike::desktop_native::media::MediaRuntime& runtime,
  const std::shared_ptr<CollectingSink>& sink,
  const std::string& request_prefix
) {
  const auto deadline = std::chrono::steady_clock::now() + kTestWatchdog;
  for (std::size_t attempt = 0;
       std::chrono::steady_clock::now() < deadline;
       ++attempt) {
    const auto request_id = request_prefix + "-" + std::to_string(attempt);
    syrnike::desktop_native::MediaCommand probe;
    probe.type = "probeScreenActor";
    probe.request_id = request_id;
    require(runtime.dispatch(probe), "runtime rejected availability probe");
    const auto reply = sink->waitReply(request_id);
    if (reply.ok && reply.state == "available") return;
    std::this_thread::sleep_for(1ms);
  }
  throw std::runtime_error("screen actor did not become available");
}

void verifyInternalRecoveryFailureDoesNotReply() {
  using Operation = ScreenControllerHarness::FakeLiveKit::Operation;
  auto harness = makeWorkingHarness();
  startHarnessCapture(harness, "di-failure-start");
  harness.livekit->setBlocked(Operation::Unpublish, true);
  harness.livekit->setBlocked(Operation::Publish, true);

  auto stalled = screenCommand(
    "__screenExecutePublicationRestart", {}, "screen-di", 1);
  stalled.internal_message = "encoder_output_stalled";
  harness.controller->executePublicationRestart(stalled);
  releaseRetirement(harness);
  harness.livekit->waitUntilPending(Operation::Publish, 1, kTestWatchdog);
  harness.livekit->releaseNext(
    Operation::Publish,
    {.error_message = "gpu_encoder_unavailable"}
  );
  harness.handleNextWorkerCommand();
  const auto failure = harness.takeNextWorkerCommand();
  require(
    failure.type == "__screenRecoveryFailed" &&
      failure.session_id == "screen-di" &&
      failure.generation == 1 &&
      failure.internal_message == "gpu_encoder_unavailable",
    "internal recovery failure did not produce a typed media failure"
  );
  require(
    harness.sink->countRepliesWithEmptyRequestId() == 0,
    "internal recovery failure emitted a reply with an empty request id"
  );
}

void verifyCombinedShutdownUsesOneDeadline() {
  using Operation = ScreenControllerHarness::FakeLiveKit::Operation;
  auto harness = makeWorkingHarness();
  startHarnessCapture(harness, "shutdown-budget-active");
  harness.livekit->setBlocked(Operation::Unpublish, true);
  harness.livekit->setBlocked(Operation::Publish, true);
  harness.setCurrent(2);
  harness.controller->startCapture(
      screenCommand(
          "startScreenCapture", "shutdown-budget-candidate", "screen-di", 2));
  harness.livekit->waitUntilPending(Operation::Unpublish, 1, kTestWatchdog);
  harness.livekit->waitUntilPending(Operation::Publish, 1, kTestWatchdog);

  const auto started = std::chrono::steady_clock::now();
  harness.controller->shutdown(started + std::chrono::milliseconds(1750));
  require(
      std::chrono::steady_clock::now() - started <
          std::chrono::milliseconds(1800),
      "screen shutdown composed blocked publish and unpublish deadlines"
  );
  harness.controller.reset();

  harness.livekit->releaseNext(
      Operation::Publish, {.publication_sid = {}});
  harness.livekit->releaseNext(Operation::Unpublish);
  for (int attempt = 0; attempt < 1000 &&
       (harness.livekit->pending(Operation::Publish) != 0 ||
        harness.livekit->pending(Operation::Unpublish) != 0);
       ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  require(
      harness.livekit->pending(Operation::Publish) == 0 &&
          harness.livekit->pending(Operation::Unpublish) == 0,
      "late screen shutdown cleanup did not finish safely"
  );
}

void verifyRetireLauncherFailureRetriesWithoutNextOperation() {
  std::atomic_uint64_t launches{0};
  std::atomic_uint64_t enqueue_failures{0};
  std::atomic_uint64_t cleanup_faults{0};
  ScreenControllerHarness harness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [](int width, int height) {
      return std::make_shared<FakeD3D11H264VideoSource>(width, height);
    },
    [&](std::function<void()> work) {
      if (launches.fetch_add(1, std::memory_order_acq_rel) < 2) {
        throw std::system_error(
          std::make_error_code(std::errc::resource_unavailable_try_again)
        );
      }
      return std::thread(std::move(work));
    },
    [&] {
      if (enqueue_failures.fetch_add(1, std::memory_order_acq_rel) == 0) {
        throw std::bad_alloc();
      }
    },
    [&] {
      cleanup_faults.fetch_add(1, std::memory_order_acq_rel);
      throw std::bad_alloc();
    }
  );
  startHarnessCapture(harness, "retire-launch-failure");

  const auto stop = screenCommand(
    "stopScreenCapture", "retire-launch-failure-stop", "screen-di", 1);
  harness.controller->stopCapture(stop, false);
  harness.controller->shutdown(
    std::chrono::steady_clock::now() + std::chrono::milliseconds(1750)
  );
  harness.controller.reset();

  for (int attempt = 0; attempt < 1000 &&
       harness.livekit->unpublishedPublicationSids().size() != 1;
       ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  const auto unpublished = harness.livekit->unpublishedPublicationSids();
  require(
    launches.load(std::memory_order_acquire) >= 3,
    "retained screen retirement did not retry launcher failure"
  );
  require(
    enqueue_failures.load(std::memory_order_acquire) >= 1 &&
    cleanup_faults.load(std::memory_order_acquire) >= 1 &&
    unpublished.size() == 1,
    "retained screen retirement did not clean the publication exactly once"
  );
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  require(
    harness.livekit->unpublishedPublicationSids().size() == 1,
    "retained screen retirement duplicated cleanup"
  );
}

void verifyRetireLauncherFailureDoesNotRunBlockedCleanupInline() {
  using Operation = ScreenControllerHarness::FakeLiveKit::Operation;
  std::atomic_uint64_t launches{0};
  std::atomic_bool cleanup_entered{false};
  ScreenControllerHarness harness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [](int width, int height) {
      return std::make_shared<FakeD3D11H264VideoSource>(width, height);
    },
    [&](std::function<void()> work) {
      const auto launch = launches.fetch_add(1, std::memory_order_acq_rel);
      if (launch == 0) {
        throw std::system_error(
          std::make_error_code(std::errc::resource_unavailable_try_again)
        );
      }
      if (launch == 1) {
        std::thread(std::move(work)).detach();
        for (int attempt = 0; attempt < 1000 &&
             !cleanup_entered.load(std::memory_order_acquire);
             ++attempt) {
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        throw std::system_error(
          std::make_error_code(std::errc::resource_unavailable_try_again)
        );
      }
      return std::thread(std::move(work));
    },
    ScreenControllerHarness::Controller::BeforeRetireEnqueue{},
    [&] { cleanup_entered.store(true, std::memory_order_release); }
  );
  startHarnessCapture(harness, "retire-launch-blocked");
  harness.livekit->setBlocked(Operation::Unpublish, true);

  const auto stop_started = std::chrono::steady_clock::now();
  harness.controller->stopCapture(
    screenCommand(
      "stopScreenCapture",
      "retire-launch-blocked-stop",
      "screen-di",
      1),
    false
  );
  require(
    std::chrono::steady_clock::now() - stop_started <
      std::chrono::milliseconds(100),
    "retire launcher failure ran blocked SDK cleanup inline"
  );

  const auto shutdown_started = std::chrono::steady_clock::now();
  harness.controller->shutdown(
    shutdown_started + std::chrono::milliseconds(150)
  );
  require(
    std::chrono::steady_clock::now() - shutdown_started <
      std::chrono::milliseconds(250),
    "retained blocked screen cleanup exceeded the shared shutdown deadline"
  );
  harness.controller.reset();
  harness.livekit->waitUntilPending(Operation::Unpublish, 1, kTestWatchdog);
  harness.livekit->releaseNext(Operation::Unpublish);

  for (int attempt = 0; attempt < 1000 &&
       harness.livekit->unpublishedPublicationSids().size() != 1;
       ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  require(
    launches.load(std::memory_order_acquire) >= 3 &&
      harness.livekit->unpublishedPublicationSids().size() == 1,
    "retained screen cleanup did not retry and unpublish exactly once"
  );
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  require(
    harness.livekit->unpublishedPublicationSids().size() == 1,
    "retained blocked screen cleanup duplicated unpublish after release"
  );
}

void verifyRegularRetireFinalizesAfterCleanupFault() {
  std::atomic_uint64_t cleanup_faults{0};
  ScreenControllerHarness harness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [](int width, int height) {
      return std::make_shared<FakeD3D11H264VideoSource>(width, height);
    },
    ScreenControllerHarness::Controller::LaunchRetireWorker{},
    ScreenControllerHarness::Controller::BeforeRetireEnqueue{},
    [&] {
      cleanup_faults.fetch_add(1, std::memory_order_acq_rel);
      throw std::bad_alloc();
    }
  );
  startHarnessCapture(harness, "cleanup-fault-regular");
  harness.controller->stopCapture(
    screenCommand(
      "stopScreenCapture",
      "cleanup-fault-regular-stop",
      "screen-di",
      1),
    false
  );
  harness.handleNextWorkerCommand();
  require(
    cleanup_faults.load(std::memory_order_acquire) == 1 &&
      harness.livekit->unpublishedPublicationSids().size() == 1,
    "regular retirement cleanup fault lost finalization or duplicated unpublish"
  );
  harness.controller->startCapture(
    screenCommand(
      "startScreenCapture",
      "cleanup-fault-capacity",
      "screen-di",
      1)
  );
  harness.handleNextWorkerCommand();
  require(
    harness.sink->waitReply("cleanup-fault-capacity").ok,
    "regular cleanup fault did not release screen capacity"
  );
}

void verifyCapturerRetireLauncherFailureRetries() {
  using Dispatcher =
    syrnike::desktop_native::media::ScreenCapturerRetireDispatcher;
  std::atomic_uint64_t launches{0};
  std::atomic_uint64_t destroyed{0};
  Dispatcher dispatcher([&](std::function<void()> work) {
    if (launches.fetch_add(1, std::memory_order_acq_rel) == 0) {
      throw std::system_error(
        std::make_error_code(std::errc::resource_unavailable_try_again)
      );
    }
    return std::thread(std::move(work));
  });
  std::vector<std::shared_ptr<
      syrnike::desktop_native::media::ScreenGpuCapturer>> capturers;
  capturers.emplace_back(
    reinterpret_cast<syrnike::desktop_native::media::ScreenGpuCapturer*>(
      static_cast<std::uintptr_t>(1)),
    [&](syrnike::desktop_native::media::ScreenGpuCapturer*) {
      destroyed.fetch_add(1, std::memory_order_acq_rel);
    }
  );
  bool launch_failed = false;
  try {
    auto worker =
      syrnike::desktop_native::media::launchScreenCaptureWorker(
        [](std::function<void()>) -> std::thread {
          throw std::system_error(
            std::make_error_code(std::errc::resource_unavailable_try_again)
          );
        },
        {},
        [] {},
        [&] { dispatcher.submit(std::move(capturers)); }
      );
    if (worker.joinable()) worker.join();
  } catch (const std::system_error&) {
    launch_failed = true;
  }
  dispatcher.close(
    std::chrono::steady_clock::now() + std::chrono::milliseconds(1750)
  );
  for (int attempt = 0; attempt < 1000 &&
       destroyed.load(std::memory_order_acquire) != 1;
       ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  require(
    launch_failed &&
      launches.load(std::memory_order_acquire) >= 2 &&
      destroyed.load(std::memory_order_acquire) == 1,
    "capturer retirement was lost after launcher failure"
  );
}

void verifyStatsLauncherFailureIsOptional() {
  std::atomic_uint64_t stats_runs{0};
  std::atomic_uint64_t capture_iterations{0};
  auto worker =
    syrnike::desktop_native::media::launchOptionalScreenStatsWorker(
      [](std::function<void()>) -> std::thread {
        throw std::system_error(
          std::make_error_code(std::errc::resource_unavailable_try_again)
        );
      },
      [&] { stats_runs.fetch_add(1, std::memory_order_acq_rel); }
    );
  capture_iterations.fetch_add(1, std::memory_order_acq_rel);
  require(
    !worker.joinable() &&
      stats_runs.load(std::memory_order_acquire) == 0 &&
      capture_iterations.load(std::memory_order_acquire) == 1,
    "optional stats launcher failure interrupted screen capture work"
  );
}

void verifyCapturerShutdownSlotSurvivesRuntimeSaturation() {
  using Capturer = syrnike::desktop_native::media::ScreenGpuCapturer;
  using Dispatcher =
    syrnike::desktop_native::media::ScreenCapturerRetireDispatcher;
  std::atomic_bool allow_launch{false};
  std::atomic_uint64_t destroyed{0};
  Dispatcher dispatcher([&](std::function<void()> work) {
    if (!allow_launch.load(std::memory_order_acquire)) {
      throw std::system_error(
        std::make_error_code(std::errc::resource_unavailable_try_again)
      );
    }
    return std::thread(std::move(work));
  });
  auto fake = [&](std::uintptr_t identity) {
    return std::shared_ptr<Capturer>(
      reinterpret_cast<Capturer*>(identity),
      [&](Capturer*) { destroyed.fetch_add(1, std::memory_order_acq_rel); }
    );
  };
  for (std::uintptr_t identity = 1; identity <= 8; ++identity) {
    dispatcher.submit(fake(identity));
  }
  std::vector<std::shared_ptr<Capturer>> shutdown_capturers;
  shutdown_capturers.push_back(fake(9));
  dispatcher.submitShutdown(std::move(shutdown_capturers));
  allow_launch.store(true, std::memory_order_release);
  dispatcher.close(
    std::chrono::steady_clock::now() + std::chrono::milliseconds(1750)
  );
  for (int attempt = 0; attempt < 1000 &&
       destroyed.load(std::memory_order_acquire) != 9;
       ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  require(
    destroyed.load(std::memory_order_acquire) == 9,
    "dedicated shutdown capturer slot lost saturated retirement ownership"
  );
}

void verifyCaptureRollbackFaultPreservesLaunchFailure() {
  bool preserved_launch_error = false;
  try {
    auto worker =
      syrnike::desktop_native::media::launchScreenCaptureWorker(
        [](std::function<void()>) -> std::thread {
          throw std::system_error(
            std::make_error_code(std::errc::resource_unavailable_try_again)
          );
        },
        {},
        [] {},
        [] { throw std::bad_alloc(); }
      );
    if (worker.joinable()) worker.join();
  } catch (const std::system_error&) {
    preserved_launch_error = true;
  }
  require(
    preserved_launch_error,
    "rollback allocation fault replaced the capture launcher failure"
  );
}

void verifyCapturePackagingFailureRollsBack() {
  bool launch_attempted = false;
  bool rollback_attempted = false;
  bool preserved_packaging_error = false;
  try {
    auto worker =
      syrnike::desktop_native::media::launchScreenCaptureWorker(
        [&](std::function<void()>) -> std::thread {
          launch_attempted = true;
          return {};
        },
        std::make_shared<int>(1),
        [] {},
        [&] {
          rollback_attempted = true;
          throw std::runtime_error("rollback failed");
        },
        +[](
          std::shared_ptr<void>,
          std::function<void()>
        ) -> std::function<void()> {
          throw std::bad_alloc();
        }
      );
    if (worker.joinable()) worker.join();
  } catch (const std::bad_alloc&) {
    preserved_packaging_error = true;
  }
  require(
    rollback_attempted && !launch_attempted && preserved_packaging_error,
    "capture work packaging failure bypassed rollback or lost its error"
  );
}

void verifyDetachedCaptureWorkerRetainsOwner() {
  struct LifetimeProbe {
    explicit LifetimeProbe(std::atomic_bool& destroyed)
        : destroyed(destroyed) {}
    ~LifetimeProbe() {
      destroyed.store(true, std::memory_order_release);
    }
    std::atomic_bool& destroyed;
  };

  std::atomic_bool destroyed{false};
  std::mutex mutex;
  std::condition_variable changed;
  bool entered = false;
  bool release = false;
  auto owner = std::make_shared<LifetimeProbe>(destroyed);
  auto worker = syrnike::desktop_native::media::launchScreenCaptureWorker(
      {},
      owner,
      [&] {
        std::unique_lock lock(mutex);
        entered = true;
        changed.notify_all();
        changed.wait(lock, [&] { return release; });
      },
      [] {});
  {
    std::unique_lock lock(mutex);
    require(
      changed.wait_for(lock, kTestWatchdog, [&] { return entered; }),
      "capture worker did not start"
    );
  }
  worker.detach();
  owner.reset();
  require(
    !destroyed.load(std::memory_order_acquire),
    "detached capture worker released its actor owner while still running"
  );
  {
    std::lock_guard lock(mutex);
    release = true;
  }
  changed.notify_all();
  for (int attempt = 0; attempt < 1000 &&
       !destroyed.load(std::memory_order_acquire);
       ++attempt) {
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  require(
    destroyed.load(std::memory_order_acquire),
    "detached capture worker did not release its actor owner after exit"
  );
}

}  // namespace

int main() try {
  {
    using syrnike::desktop_native::media::ScreenGpuCaptureError;
    using syrnike::desktop_native::media::ScreenGpuCaptureErrorCode;
    const ScreenGpuCaptureError dxgi(
      ScreenGpuCaptureErrorCode::InteropUnavailable,
      "DXGI interop is unavailable",
      static_cast<long>(E_NOINTERFACE)
    );
    const ScreenGpuCaptureError wgc(
      ScreenGpuCaptureErrorCode::PermissionDenied,
      "WGC CreateForMonitor was denied",
      static_cast<long>(E_ACCESSDENIED)
    );
    const auto combined =
      syrnike::desktop_native::media::combineInitialMonitorCaptureFailures(
        dxgi, wgc);
    require(
      combined.code() == ScreenGpuCaptureErrorCode::PermissionDenied &&
        combined.hresult() == static_cast<long>(E_ACCESSDENIED) &&
        combined.backendFailures().size() == 2 &&
        combined.backendFailures()[0].hresult == dxgi.hresult() &&
        combined.backendFailures()[1].hresult == wgc.hresult(),
      "DXGI/WGC initialization failure did not preserve both backend causes"
    );
    const ScreenGpuCaptureError transient_dxgi(
      ScreenGpuCaptureErrorCode::CaptureUnavailable,
      "DXGI output duplication is temporarily unavailable",
      static_cast<long>(DXGI_ERROR_NOT_CURRENTLY_AVAILABLE)
    );
    const auto retryable =
      syrnike::desktop_native::media::combineInitialMonitorCaptureFailures(
        transient_dxgi, wgc);
    require(
      retryable.code() == ScreenGpuCaptureErrorCode::CaptureUnavailable &&
        retryable.hresult() == transient_dxgi.hresult(),
      "WGC permission denial masked a retryable DXGI initialization failure"
    );
    const ScreenGpuCaptureError secure_desktop_dxgi(
      ScreenGpuCaptureErrorCode::PermissionDenied,
      "DXGI cannot access the secure desktop",
      static_cast<long>(E_ACCESSDENIED)
    );
    const auto secure_desktop_retryable =
      syrnike::desktop_native::media::combineInitialMonitorCaptureFailures(
        secure_desktop_dxgi, wgc);
    require(
      secure_desktop_retryable.code() ==
          ScreenGpuCaptureErrorCode::CaptureUnavailable &&
        secure_desktop_retryable.hresult() == secure_desktop_dxgi.hresult(),
      "WGC denial made a temporary DXGI secure-desktop denial terminal"
    );
    const ScreenGpuCaptureError mode_change_dxgi(
      ScreenGpuCaptureErrorCode::FormatUnsupported,
      "DXGI does not support the current display mode",
      static_cast<long>(DXGI_ERROR_UNSUPPORTED)
    );
    const auto mode_change_retryable =
      syrnike::desktop_native::media::combineInitialMonitorCaptureFailures(
        mode_change_dxgi, wgc);
    require(
      mode_change_retryable.code() ==
          ScreenGpuCaptureErrorCode::FormatUnsupported &&
        mode_change_retryable.hresult() == mode_change_dxgi.hresult(),
      "WGC denial made a temporary DXGI display-mode failure terminal"
    );
  }
  {
    using syrnike::desktop_native::media::EncoderBackpressureStallDetector;
    EncoderBackpressureStallDetector detector;
    const auto started = std::chrono::steady_clock::now();
    require(
      !detector.observe(started, 2s),
      "encoder backpressure detector fired on the first observation"
    );
    // NoFrame is deliberately not progress: an alternating
    // Backpressure/NoFrame capture must still trip the stall detector.
    require(
      detector.observe(started + 2s, 2s),
      "idle capture observations masked continuous encoder backpressure"
    );
    detector.noteProgress();
    require(
      !detector.observe(started + 3s, 2s),
      "encoder progress did not reset the backpressure detector"
    );
  }
  {
    using syrnike::desktop_native::media::ScreenOutputStall;
    using syrnike::desktop_native::media::ScreenOutputStallDetector;
    ScreenOutputStallDetector detector;
    const auto started = std::chrono::steady_clock::now();
    require(
      detector.observe(started, false, 0, 0, 0, 5s) ==
        ScreenOutputStall::None,
      "inactive screen output started a stall watchdog"
    );
    require(
      detector.observe(started + 1s, true, 1, 0, 0, 5s) ==
        ScreenOutputStall::None,
      "first active zero-frame output sample fired immediately"
    );
    require(
      detector.observe(started + 7s, true, 2, 0, 0, 5s) ==
        ScreenOutputStall::Encoder,
      "growing ingress with no encoded frame was not classified as encoder stall"
    );
    detector.reset();
    require(
      detector.observe(started + 8s, true, 1, 0, 0, 5s) ==
        ScreenOutputStall::None &&
      detector.observe(started + 14s, true, 1, 0, 0, 5s) ==
        ScreenOutputStall::Encoder,
      "a static first frame masked an encoder that never produced output"
    );
    detector.reset();
    require(
      detector.observe(started + 15s, true, 3, 1, 0, 5s) ==
        ScreenOutputStall::None &&
      detector.observe(started + 21s, true, 3, 1, 0, 5s) ==
        ScreenOutputStall::Transport,
      "encoded output with no sent frame was not classified as transport stall"
    );
    detector.reset();
    require(
      detector.observe(started + 22s, true, 5, 5, 5, 5s) ==
        ScreenOutputStall::None &&
      detector.observe(started + 23s, true, 6, 6, 6, 5s) ==
        ScreenOutputStall::None,
      "idle refresh progress was treated as failed output"
    );
    require(
      detector.observe(started + 29s, true, 6, 6, 6, 5s) ==
        ScreenOutputStall::Capture,
      "a published track with no idle refresh was not classified as capture stall"
    );
    require(
      detector.observe(started + 30s, false, 6, 6, 6, 5s) ==
        ScreenOutputStall::None,
      "inactive output retained a stale watchdog"
    );
  }

  using syrnike::desktop_native::media::DeterministicFakeLiveKitPublicationClient;
  using syrnike::desktop_native::media::MediaRuntime;

  auto sink = std::make_shared<CollectingSink>();
  auto livekit = std::make_shared<DeterministicFakeLiveKitPublicationClient>();
  const auto clock_origin = std::chrono::steady_clock::now();
  std::atomic<std::int64_t> clock_offset_ms{0};
  MediaRuntime runtime(sink, livekit, [&] {
    return clock_origin + std::chrono::milliseconds(clock_offset_ms.load());
  });
  runtime.waitUntilReady();

  verifyPhase("unavailable encoder", verifyUnavailableEncoderFailsClosed);
  verifyPhase(
    "capture preflight before publication",
    verifyCapturePreflightFailsBeforePublication);
  verifyPhase(
    "capture permission denial",
    verifyCapturePermissionFailureStopsAutomaticRetry);
  verifyPhase("null encoder source", verifyNullEncoderSourceFailsClosed);
  verifyPhase("cancelled publish rollback", verifyCancelledPublishRollsBackExactSid);
  verifyPhase("RTP stall restart", verifyRtpStallRestartsCapture);
  verifyPhase(
    "retire completion retry",
    verifyRejectedRetireCompletionRetriesInternally
  );
  verifyPhase("manual stop cancels restart", verifyManualStopCancelsPendingStallRestart);
  verifyPhase(
    "policy-free publication restart execution",
    verifyControllerOnlyExecutesRecoveryPolicy);
  verifyPhase(
    "internal stall recovery failure",
    verifyInternalRecoveryFailureDoesNotReply
  );
  verifyPhase(
    "combined screen shutdown deadline",
    verifyCombinedShutdownUsesOneDeadline
  );
  verifyPhase(
    "retire launcher failure retry",
    verifyRetireLauncherFailureRetriesWithoutNextOperation
  );
  verifyPhase(
    "retire launcher failure blocked cleanup",
    verifyRetireLauncherFailureDoesNotRunBlockedCleanupInline
  );
  verifyPhase(
    "regular retire cleanup fault",
    verifyRegularRetireFinalizesAfterCleanupFault
  );
  verifyPhase(
    "capturer retire launcher failure retry",
    verifyCapturerRetireLauncherFailureRetries
  );
  verifyPhase(
    "optional stats launcher failure",
    verifyStatsLauncherFailureIsOptional
  );
  verifyPhase(
    "capturer shutdown saturation",
    verifyCapturerShutdownSlotSurvivesRuntimeSaturation
  );
  verifyPhase(
    "capture rollback fault",
    verifyCaptureRollbackFaultPreservesLaunchFailure
  );
  verifyPhase(
    "capture packaging failure rollback",
    verifyCapturePackagingFailureRollsBack
  );
  verifyPhase(
    "detached capture worker ownership",
    verifyDetachedCaptureWorkerRetainsOwner
  );

  livekit->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Publish, false);
  livekit->setVoiceSessionForTest("screen-c");
  const auto prepare_c = screenCommand("connectScreen", "prepare-c", "screen-c", 7);
  require(runtime.dispatch(prepare_c), "runtime rejected terminal-semantics prepare");
  require(sink->waitReply("prepare-c").ok, "terminal-semantics prepare failed");

  syrnike::desktop_native::MediaCommand terminal;
  terminal.type = "__screenTerminal";
  terminal.session_id = "screen-c";
  terminal.generation = 7;
  terminal.internal_message = "livekit_disconnected:network";
  require(runtime.dispatch(terminal), "runtime rejected screen terminal event");
  const auto ended = sink->waitEvent("screenCaptureEnded", "screen-c", 7);
  require(ended.reason == "runtime_error", "terminal disconnect lost screen ended semantics");
  require(
    ended.detail == "livekit_disconnected:network",
    "terminal disconnect lost its typed detail"
  );
  const auto stopped = sink->waitEvent("sessionStopped", "screen-c", 7);
  require(
    stopped.reason == "livekit_disconnected:network",
    "terminal disconnect lost sessionStopped semantics"
  );
  requireProbe(runtime, sink, "probe-terminal-retire");

  livekit->setVoiceSessionForTest("screen-recovery");
  const auto prepare_recovery = screenCommand(
    "connectScreen", "prepare-recovery", "screen-recovery", 8);
  require(
    runtime.dispatch(prepare_recovery),
    "runtime rejected recovery-failure prepare");
  require(
    sink->waitReply("prepare-recovery").ok,
    "recovery-failure prepare failed");
  syrnike::desktop_native::MediaCommand recovery_failed;
  recovery_failed.type = "__screenRecoveryFailed";
  recovery_failed.session_id = "screen-recovery";
  recovery_failed.generation = 8;
  recovery_failed.internal_message = "rtp_stall_recovery_exhausted";
  require(
    runtime.dispatch(recovery_failed),
    "runtime rejected internal screen recovery failure");
  const auto recovery_ended =
    sink->waitEvent("screenCaptureEnded", "screen-recovery", 8);
  require(
    recovery_ended.reason == "rtp_stall_recovery_exhausted",
    "screen recovery circuit reason was rewritten");
  const auto stale_recovery_retry = screenCommand(
    "connectScreen",
    "recovery-stale",
    "screen-recovery",
    8);
  require(
    runtime.dispatch(stale_recovery_retry),
    "runtime rejected dispatch of a fenced recovery retry");
  const auto stale_recovery_reply = sink->waitReply("recovery-stale");
  require(
    stale_recovery_reply.error &&
      stale_recovery_reply.error->code == "stale_generation",
    "same-generation retry escaped the recovery terminal fence");

  waitForAvailable(runtime, sink, "recovery-available");
  livekit->setVoiceSessionForTest("screen-recovery-next");
  const auto next_recovery_retry = screenCommand(
    "connectScreen",
    "recovery-next",
    "screen-recovery-next",
    9);
  require(
    runtime.dispatch(next_recovery_retry),
    "runtime rejected a newer generation after recovery failure");
  const auto next_recovery_reply = sink->waitReply("recovery-next");
  require(
    next_recovery_reply.ok,
    "recovery terminal fence did not accept a newer generation");

  runtime.requestShutdown();
  runtime.shutdownAndWait();
  runtime.shutdownAndWait();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
