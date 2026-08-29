#include <algorithm>
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
#include "media/livekit_voice_session.hpp"
#include "media/media_runtime.hpp"
#include "media/screen_actor.hpp"
#include "media/screen_publication_controller.hpp"
#include "media/video_resource_admission.hpp"
#include "media_contention_publication_teardown.hpp"

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
        if (event.type == syrnike::desktop_native::NativeEventType::Reply && event.request_id == request_id) return true;
      }
      return false;
    });
    if (!found) throw std::runtime_error("timed out waiting for runtime reply: " + request_id);
    for (const auto& event : events_) {
      if (event.type == syrnike::desktop_native::NativeEventType::Reply && event.request_id == request_id) return event;
    }
    throw std::runtime_error("runtime reply disappeared");
  }

  [[nodiscard]] bool hasReply(const std::string& request_id) const {
    std::lock_guard lock(mutex_);
    return std::any_of(events_.begin(), events_.end(), [&](const auto& event) {
      return event.type == syrnike::desktop_native::NativeEventType::Reply &&
        event.request_id == request_id;
    });
  }

  syrnike::desktop_native::RuntimeEvent waitEvent(
    syrnike::desktop_native::NativeEventType type,
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
    if (!found) {
      throw std::runtime_error(
        "timed out waiting for runtime event: " +
        std::string(syrnike::desktop_native::nativeEventName(type))
      );
    }
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
      if (event.type == syrnike::desktop_native::NativeEventType::SessionStarted && event.session_id == session_id &&
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
      if (event.type == syrnike::desktop_native::NativeEventType::Reply && event.request_id.empty()) ++count;
    }
    return count;
  }

  syrnike::desktop_native::RuntimeEvent waitLifecycleCount(
    const std::string& session_id,
    std::uint64_t generation,
    const std::string& kind,
    const std::string& status,
    std::size_t minimum_count,
    std::chrono::milliseconds timeout = kTestWatchdog
  ) {
    const auto matches = [&](const auto& event) {
      return event.type == syrnike::desktop_native::NativeEventType::SessionLifecycle &&
        event.session_id == session_id && event.generation == generation &&
        event.kind == kind && event.status == status;
    };
    std::unique_lock lock(mutex_);
    const bool found = changed_.wait_for(lock, timeout, [&] {
      return static_cast<std::size_t>(std::count_if(
        events_.begin(), events_.end(), matches)) >= minimum_count;
    });
    if (!found) {
      throw std::runtime_error(
        "timed out waiting for session lifecycle: " + kind + "/" + status);
    }
    for (auto iterator = events_.rbegin(); iterator != events_.rend(); ++iterator) {
      if (matches(*iterator)) return *iterator;
    }
    throw std::runtime_error("session lifecycle event disappeared");
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
  syrnike::desktop_native::NativeCommandType type,
  std::string request_id,
  std::string session_id,
  std::uint64_t generation
) {
  syrnike::desktop_native::MediaCommand command;
  command.type = type;
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
  probe.type = syrnike::desktop_native::NativeCommandType::ProbeScreenActor;
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
  std::unique_ptr<
    syrnike::desktop_native::media::VideoResourceAdmissionBudget>
      owned_resource_budget_;

 public:
  using Controller = syrnike::desktop_native::media::ScreenPublicationController;
  using FakeLiveKit =
    syrnike::desktop_native::media::DeterministicFakeLiveKitVoiceSession;
  using PublicationPhase =
    syrnike::desktop_native::media::ScreenVideoPublicationPhase;

  ScreenControllerHarness(
    Controller::QueryEncoderCapability query_encoder_capability,
    Controller::CreateVideoSource create_video_source,
    syrnike::desktop_native::CleanupStartProbe cleanup_start_probe = {},
    syrnike::desktop_native::CleanupEnqueueProbe cleanup_enqueue_probe = {},
    Controller::BeforeResourceCleanup before_resource_cleanup = {},
    Controller::PrepareCapture prepare_capture = {},
    syrnike::desktop_native::media::VideoResourceAdmissionBudget*
      resource_budget = nullptr
  ) : sink(std::make_shared<CollectingSink>()),
      emitter(sink),
      livekit(std::make_shared<FakeLiveKit>()) {
    if (!resource_budget) {
      owned_resource_budget_ = std::make_unique<
        syrnike::desktop_native::media::VideoResourceAdmissionBudget>(
          syrnike::desktop_native::media::productionVideoResourceLimits());
      resource_budget = owned_resource_budget_.get();
    }
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
        if (command.type == syrnike::desktop_native::NativeCommandType::ScreenRetireDone) {
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
        description.publish_audio = command.audio_requested;
        description.audio_mode = command.audio_requested ? "system" : "none";
        return description;
      },
      std::move(prepare_capture),
      [this](
        const syrnike::desktop_native::MediaCommand&,
        const syrnike::desktop_native::media::ScreenPublicationDescription&,
        const std::shared_ptr<livekit::D3D11H264VideoSource>& source,
        const std::shared_ptr<livekit::LocalVideoTrack>&,
        const std::shared_ptr<syrnike::desktop_native::media::ScreenGpuCapturer>& capturer,
        const std::shared_ptr<std::atomic_bool>& running,
        const std::function<bool()>&,
        std::thread& worker
      ) {
        video_worker_starts.fetch_add(1, std::memory_order_relaxed);
        last_video_source = source;
        last_video_capturer = capturer;
        if (block_video_worker_.exchange(false, std::memory_order_acq_rel)) {
          worker = std::thread([this, running] {
            while (running->load(std::memory_order_acquire)) {
              std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            video_worker_exits.fetch_add(1, std::memory_order_release);
          });
        }
      },
      [this](
        const syrnike::desktop_native::MediaCommand& command,
        const syrnike::desktop_native::media::ScreenPublicationDescription&,
        const std::shared_ptr<livekit::AudioSource>&,
        const std::shared_ptr<std::atomic_bool>& running,
        const std::shared_ptr<syrnike::voice::ScreenAudioStopSignal>& stop,
        std::thread& worker
      ) {
        audio_worker_starts.fetch_add(1, std::memory_order_relaxed);
        previous_audio_epoch.store(
          current_audio_epoch.exchange(
            command.internal_epoch,
            std::memory_order_acq_rel),
          std::memory_order_release
        );
        auto failures = audio_worker_failures_.load(std::memory_order_acquire);
        while (failures > 0) {
          if (audio_worker_failures_.compare_exchange_weak(
                failures,
                failures - 1,
                std::memory_order_acq_rel)) {
            throw std::runtime_error("audio_device_lost");
          }
        }
        if (block_audio_worker_.exchange(false, std::memory_order_acq_rel)) {
          worker = std::thread([running, stop] {
            WaitForSingleObject(stop->handle(), INFINITE);
            running->store(false, std::memory_order_release);
          });
        }
      },
      [](const std::string&, std::uint64_t) {},
      std::move(query_encoder_capability),
      std::move(create_video_source),
      std::move(cleanup_start_probe),
      std::move(cleanup_enqueue_probe),
      std::move(before_resource_cleanup),
      resource_budget,
      [this](const syrnike::desktop_native::MediaCommand&, const std::string&) {
        after_video_published.fetch_add(1, std::memory_order_release);
      },
      [this](
          const syrnike::desktop_native::MediaCommand&,
          PublicationPhase phase) {
        if (phase == PublicationPhase::Started) {
          publication_gate.beginPublication();
          publication_starts.fetch_add(1, std::memory_order_release);
          return;
        }
        publication_gate.finishPublication();
        if (phase == PublicationPhase::Published) {
          publication_acks.fetch_add(1, std::memory_order_release);
        } else {
          publication_failures.fetch_add(1, std::memory_order_release);
        }
      }
    );
  }

  ~ScreenControllerHarness() {
    livekit->setBlocked(FakeLiveKit::Operation::Publish, false);
    livekit->setBlocked(FakeLiveKit::Operation::Unpublish, false);
    if (controller) {
      controller->shutdown();
      controller.reset();
    }
  }

  void setCurrent(std::uint64_t generation) { generation_.store(generation); }
  void rejectNextRetireCompletion() {
    reject_retire_completions_.fetch_add(1, std::memory_order_release);
  }
  void failNextAudioWorkerStart() {
    audio_worker_failures_.fetch_add(1, std::memory_order_release);
  }
  void blockNextAudioWorkerUntilStop() {
    block_audio_worker_.store(true, std::memory_order_release);
  }
  void blockNextVideoWorkerUntilStop() {
    block_video_worker_.store(true, std::memory_order_release);
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
  std::atomic_uint32_t video_worker_starts{0};
  std::atomic_uint32_t video_worker_exits{0};
  std::atomic_uint32_t after_video_published{0};
  syrnike::desktop_native::tests::ContentionPublicationTeardownGate
      publication_gate;
  std::atomic_uint32_t publication_starts{0};
  std::atomic_uint32_t publication_acks{0};
  std::atomic_uint32_t publication_failures{0};
  std::weak_ptr<livekit::D3D11H264VideoSource> last_video_source;
  std::weak_ptr<syrnike::desktop_native::media::ScreenGpuCapturer>
      last_video_capturer;
  std::atomic_uint32_t audio_worker_starts{0};
  std::atomic<std::uint64_t> previous_audio_epoch{0};
  std::atomic<std::uint64_t> current_audio_epoch{0};

 private:
  const std::string session_id_ = "screen-di";
  std::atomic<std::uint64_t> generation_{1};
  std::atomic_uint32_t reject_retire_completions_{0};
  std::atomic_uint32_t audio_worker_failures_{0};
  std::atomic_bool block_audio_worker_{false};
  std::atomic_bool block_video_worker_{false};
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

  const auto start = screenCommand(syrnike::desktop_native::NativeCommandType::StartScreenCapture, "di-unavailable", "screen-di", 1);
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
  namespace media = syrnike::desktop_native::media;
  auto limits = media::productionVideoResourceLimits();
  limits.maximum_hardware_encoder_sessions = 1;
  media::VideoResourceAdmissionBudget budget(limits);
  std::atomic_int source_calls{0};
  std::atomic_int preflight_calls{0};
  ScreenControllerHarness harness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [&](int width, int height) {
      source_calls.fetch_add(1);
      return std::make_shared<FakeD3D11H264VideoSource>(width, height);
    },
    syrnike::desktop_native::CleanupStartProbe{},
    syrnike::desktop_native::CleanupEnqueueProbe{},
    ScreenControllerHarness::Controller::BeforeResourceCleanup{},
    [&](const syrnike::desktop_native::MediaCommand&,
        const syrnike::desktop_native::media::ScreenPublicationDescription&)
        -> std::shared_ptr<syrnike::desktop_native::media::ScreenGpuCapturer> {
      preflight_calls.fetch_add(1);
      throw std::runtime_error(
        "gpu_capture_unavailable: gpu_access_lost: injected preflight failure");
    },
    &budget
  );
  harness.livekit->setBlocked(
    ScreenControllerHarness::FakeLiveKit::Operation::Publish, true);

  harness.controller->startCapture(screenCommand(
      syrnike::desktop_native::NativeCommandType::StartScreenCapture, "preflight-failure", "screen-di", 1));
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
  require(
    budget.snapshot().current.hardware_encoder_sessions == 0,
    "capture preflight failure did not return encoder capacity exactly once");
}

void verifyEncoderAdmissionFailsBeforeSourceConstruction() {
  namespace media = syrnike::desktop_native::media;
  auto limits = media::productionVideoResourceLimits();
  limits.maximum_hardware_encoder_sessions = 1;
  media::VideoResourceAdmissionBudget budget(limits);
  auto camera_encoder = media::requireVideoResourceAdmission(
      budget,
      media::VideoResourceRequest{
          .owner = media::VideoResourceOwner::CameraEncoder,
          .owner_id = "camera:test-held",
          .hardware_encoder_sessions = 1,
      });
  std::atomic_int source_calls{0};
  std::atomic_int preflight_calls{0};
  ScreenControllerHarness harness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [&](int width, int height) {
      source_calls.fetch_add(1);
      return std::make_shared<FakeD3D11H264VideoSource>(width, height);
    },
    syrnike::desktop_native::CleanupStartProbe{},
    syrnike::desktop_native::CleanupEnqueueProbe{},
    ScreenControllerHarness::Controller::BeforeResourceCleanup{},
    [&](const syrnike::desktop_native::MediaCommand&,
        const media::ScreenPublicationDescription&) {
      preflight_calls.fetch_add(1);
      return std::make_shared<FakeScreenGpuCapturer>();
    },
    &budget
  );
  harness.livekit->setBlocked(
    ScreenControllerHarness::FakeLiveKit::Operation::Publish, true);

  harness.controller->startCapture(screenCommand(
      syrnike::desktop_native::NativeCommandType::StartScreenCapture, "encoder-saturated", "screen-di", 1));
  harness.handleNextWorkerCommand();
  const auto reply = harness.sink->waitReply("encoder-saturated");
  require(
    !reply.ok && reply.error &&
      reply.error->code == "gpu_encoder_session_saturated",
    "screen encoder saturation lost its typed fail-closed error"
  );
  require(
    preflight_calls.load() == 0 && source_calls.load() == 0 &&
      harness.livekit->pending(
        ScreenControllerHarness::FakeLiveKit::Operation::Publish) == 0,
    "screen encoder saturation constructed a capture backend, source, or publication"
  );
  require(
    budget.snapshot().current.hardware_encoder_sessions == 1,
    "rejected screen attempt changed the held encoder reservation"
  );
  camera_encoder.reset();
  require(
    budget.snapshot().current.hardware_encoder_sessions == 0,
    "held encoder capacity did not return exactly once"
  );
}

void verifyCapturePermissionFailureStopsAutomaticRetry() {
  ScreenControllerHarness harness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [](int width, int height) {
      return std::make_shared<FakeD3D11H264VideoSource>(width, height);
    },
    syrnike::desktop_native::CleanupStartProbe{},
    syrnike::desktop_native::CleanupEnqueueProbe{},
    ScreenControllerHarness::Controller::BeforeResourceCleanup{},
    [](const syrnike::desktop_native::MediaCommand&,
       const syrnike::desktop_native::media::ScreenPublicationDescription&)
        -> std::shared_ptr<syrnike::desktop_native::media::ScreenGpuCapturer> {
      throw std::runtime_error(
        "gpu_permission_denied: DXGI and WGC initialization failed");
    }
  );

  harness.controller->startCapture(screenCommand(
      syrnike::desktop_native::NativeCommandType::StartScreenCapture, "permission-failure", "screen-di", 1));
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

  const auto start = screenCommand(syrnike::desktop_native::NativeCommandType::StartScreenCapture, "di-null-source", "screen-di", 1);
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

void verifyCaptureStartsOnlyAfterPublishAck() {
  ScreenControllerHarness harness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [](int width, int height) {
      return std::make_shared<FakeD3D11H264VideoSource>(width, height);
    }
  );
  using Operation = ScreenControllerHarness::FakeLiveKit::Operation;
  harness.livekit->setBlocked(Operation::Publish, true);

  const auto start = screenCommand(
      syrnike::desktop_native::NativeCommandType::StartScreenCapture,
      "capture-before-publish-ack", "screen-di", 1);
  harness.controller->startCapture(start);
  harness.livekit->waitUntilPending(Operation::Publish, 1, kTestWatchdog);
  require(
    harness.publication_starts.load(std::memory_order_acquire) == 1 &&
      harness.publication_acks.load(std::memory_order_acquire) == 0 &&
      harness.publication_gate.pending(true) == 1,
    "held LiveKit publish was absent from the teardown gate"
  );
  require(
    harness.video_worker_starts.load(std::memory_order_acquire) == 0,
    "D3D11 capture started before LiveKit installed the sender transformer"
  );
  require(
    harness.after_video_published.load(std::memory_order_acquire) == 0 &&
      !harness.sink->hasReply("capture-before-publish-ack") &&
      harness.sink->countSessionStarted("screen-di", 1) == 0,
    "screen capture committed or ran its post-publish callback before ACK"
  );

  ScreenControllerHarness::FakeLiveKit::Release published;
  published.publication_sid = "screen-video-ack";
  harness.livekit->releaseNext(Operation::Publish, std::move(published));
  harness.handleNextWorkerCommand();
  require(
    harness.sink->waitReply("capture-before-publish-ack").ok &&
      harness.video_worker_starts.load(std::memory_order_acquire) == 1 &&
      harness.after_video_published.load(std::memory_order_acquire) == 1 &&
      harness.publication_acks.load(std::memory_order_acquire) == 1 &&
      harness.publication_gate.readyToShutdown(true) &&
      harness.sink->countSessionStarted("screen-di", 1) == 1,
    "screen capture did not commit exactly once after publication ACK"
  );
}

void verifyPublicationFailureClosesLifecycle() {
  ScreenControllerHarness harness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [](int width, int height) {
      return std::make_shared<FakeD3D11H264VideoSource>(width, height);
    }
  );
  using Operation = ScreenControllerHarness::FakeLiveKit::Operation;
  harness.livekit->setBlocked(Operation::Publish, true);
  harness.controller->startCapture(screenCommand(
      syrnike::desktop_native::NativeCommandType::StartScreenCapture,
      "publish-failure-lifecycle", "screen-di", 1));
  harness.livekit->waitUntilPending(Operation::Publish, 1, kTestWatchdog);
  require(
      harness.publication_gate.pending(true) == 1,
      "failed publish was not owned while in flight");
  harness.livekit->releaseNext(Operation::Publish, {.publication_sid = {}});
  harness.handleNextWorkerCommand();
  const auto reply = harness.sink->waitReply("publish-failure-lifecycle");
  require(
      !reply.ok &&
        harness.publication_failures.load(std::memory_order_acquire) == 1 &&
        harness.publication_gate.readyToShutdown(true),
      "failed publish did not close its exact lifecycle counter");
}

void verifyCancelledPublishRollsBackExactSid() {
  ScreenControllerHarness harness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [](int width, int height) {
      return std::make_shared<FakeD3D11H264VideoSource>(width, height);
    }
  );
  harness.livekit->setBlocked(ScreenControllerHarness::FakeLiveKit::Operation::Publish, true);
  const auto start = screenCommand(syrnike::desktop_native::NativeCommandType::StartScreenCapture, "di-stale", "screen-di", 1);
  harness.controller->startCapture(start);
  harness.livekit->waitUntilPending(
    ScreenControllerHarness::FakeLiveKit::Operation::Publish,
    1,
    kTestWatchdog
  );
  require(
    harness.video_worker_starts.load(std::memory_order_acquire) == 0,
    "cancelled publish started D3D11 capture before publication ACK"
  );

  harness.setCurrent(2);
  const auto cancel = screenCommand(syrnike::desktop_native::NativeCommandType::DisconnectScreen, "di-cancel", "screen-di", 2);
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
  require(
    harness.video_worker_starts.load(std::memory_order_acquire) == 0 &&
      harness.video_worker_exits.load(std::memory_order_acquire) == 0 &&
      harness.last_video_source.expired() &&
      harness.last_video_capturer.expired(),
    "cancelled screen publish leaked preflight resources or started capture"
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
  const auto start = screenCommand(syrnike::desktop_native::NativeCommandType::StartScreenCapture, request_id, "screen-di", 1);
  harness.controller->startCapture(start);
  const auto deadline = std::chrono::steady_clock::now() + kTestWatchdog;
  while (!harness.sink->hasReply(request_id)) {
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) {
      throw std::runtime_error(
        "timed out draining screen controller worker commands");
    }
    harness.handleNextWorkerCommand(
      std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now));
  }
  const auto reply = harness.sink->waitReply(request_id);
  require(reply.ok, "screen harness capture did not start");
}

void releaseRetirement(ScreenControllerHarness& harness) {
  using Operation = ScreenControllerHarness::FakeLiveKit::Operation;
  harness.livekit->waitUntilPending(Operation::Unpublish, 1, kTestWatchdog);
  harness.livekit->releaseNext(Operation::Unpublish);
  harness.handleNextWorkerCommand();
}

void verifyRejectedRetireCompletionRetriesInternally() {
  using Operation = ScreenControllerHarness::FakeLiveKit::Operation;
  auto harness = makeWorkingHarness();
  startHarnessCapture(harness, "di-retire-retry-start");
  harness.livekit->setBlocked(Operation::Unpublish, true);
  harness.rejectNextRetireCompletion();

  const auto stop =
    screenCommand(syrnike::desktop_native::NativeCommandType::StopScreenCapture, "di-retire-retry-stop", "screen-di", 1);
  harness.controller->stopCapture(stop);
  harness.livekit->waitUntilPending(Operation::Unpublish, 1, kTestWatchdog);
  harness.livekit->releaseNext(Operation::Unpublish);

  const auto completion = harness.takeNextWorkerCommand();
  require(
    completion.type == syrnike::desktop_native::NativeCommandType::ScreenRetireDone,
    "rejected retirement completion was not retried internally"
  );
  harness.controller->handleWorkerCommand(completion);
  const auto probe = harness.controller->probe(
    screenCommand(syrnike::desktop_native::NativeCommandType::ProbeScreenActor, {}, "screen-di", 1)
  );
  require(
    probe.state == "available",
    "retried retirement completion did not release controller capacity"
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
    probe.type = syrnike::desktop_native::NativeCommandType::ProbeScreenActor;
    probe.request_id = request_id;
    require(runtime.dispatch(probe), "runtime rejected availability probe");
    const auto reply = sink->waitReply(request_id);
    if (reply.ok && reply.state == "available") return;
    std::this_thread::sleep_for(1ms);
  }
  throw std::runtime_error("screen actor did not become available");
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
      syrnike::desktop_native::NativeCommandType::StartScreenCapture, "shutdown-budget-candidate", "screen-di", 2));
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
    [&] {
      if (launches.fetch_add(1, std::memory_order_acq_rel) < 2) {
        throw std::system_error(
          std::make_error_code(std::errc::resource_unavailable_try_again)
        );
      }
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
      syrnike::desktop_native::NativeCommandType::StopScreenCapture, "retire-launch-failure-stop", "screen-di", 1);
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
    [&] {
      const auto launch = launches.fetch_add(1, std::memory_order_acq_rel);
      if (launch < 2) {
        throw std::system_error(
          std::make_error_code(std::errc::resource_unavailable_try_again)
        );
      }
    },
    syrnike::desktop_native::CleanupEnqueueProbe{},
    [&] { cleanup_entered.store(true, std::memory_order_release); }
  );
  startHarnessCapture(harness, "retire-launch-blocked");
  harness.livekit->setBlocked(Operation::Unpublish, true);

  const auto stop_started = std::chrono::steady_clock::now();
  harness.controller->stopCapture(
    screenCommand(
      syrnike::desktop_native::NativeCommandType::StopScreenCapture,
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
    syrnike::desktop_native::CleanupStartProbe{},
    syrnike::desktop_native::CleanupEnqueueProbe{},
    [&] {
      cleanup_faults.fetch_add(1, std::memory_order_acq_rel);
      throw std::bad_alloc();
    }
  );
  startHarnessCapture(harness, "cleanup-fault-regular");
  harness.controller->stopCapture(
    screenCommand(
      syrnike::desktop_native::NativeCommandType::StopScreenCapture,
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
      syrnike::desktop_native::NativeCommandType::StartScreenCapture,
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

  std::function<void()> guarded_stats_work;
  worker = syrnike::desktop_native::media::launchOptionalScreenStatsWorker(
    [&](std::function<void()> work) -> std::thread {
      guarded_stats_work = std::move(work);
      return {};
    },
    [] { throw std::bad_alloc(); }
  );
  require(
    !worker.joinable() && static_cast<bool>(guarded_stats_work),
    "optional stats worker did not expose its guarded task to the launcher"
  );
  bool stats_failure_escaped = false;
  try {
    guarded_stats_work();
  } catch (...) {
    stats_failure_escaped = true;
  }
  require(
    !stats_failure_escaped,
    "optional stats work failure escaped and could terminate screen capture"
  );
}

void verifyShutdownCancelsInFlightUnpublish() {
  using Operation = ScreenControllerHarness::FakeLiveKit::Operation;
  auto harness = makeWorkingHarness();
  startHarnessCapture(harness, "shutdown-cancel-active-unpublish");
  harness.livekit->setBlocked(Operation::Unpublish, true);
  harness.livekit->setCancellationAware(Operation::Unpublish, true);
  harness.controller->stopCapture(
    screenCommand(
      syrnike::desktop_native::NativeCommandType::StopScreenCapture,
      "shutdown-cancel-stop",
      "screen-di",
      1),
    false
  );
  harness.livekit->waitUntilPending(Operation::Unpublish, 1, kTestWatchdog);

  const auto started = std::chrono::steady_clock::now();
  harness.controller->shutdown(started + std::chrono::milliseconds(1750));
  require(
    std::chrono::steady_clock::now() - started <
        std::chrono::milliseconds(500),
    "screen shutdown left an in-flight unpublish on its ordinary deadline"
  );
  require(
    harness.livekit->pending(Operation::Unpublish) == 0,
    "screen shutdown did not cancel its in-flight unpublish"
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

void verifyCaptureWorkerRetainsOwnerUntilJoin() {
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
  owner.reset();
  require(
    !destroyed.load(std::memory_order_acquire),
    "capture worker released its actor owner while still running"
  );
  {
    std::lock_guard lock(mutex);
    release = true;
  }
  changed.notify_all();
  worker.join();
  require(
    destroyed.load(std::memory_order_acquire),
    "joined capture worker did not release its actor owner after exit"
  );
}

void verifyAudioFailureRetryAndRetirementAreIndependentFromVideo() {
  using Operation = ScreenControllerHarness::FakeLiveKit::Operation;
  using Release = ScreenControllerHarness::FakeLiveKit::Release;
  ScreenControllerHarness harness(
    [] { return livekit::D3D11H264Capability{true, {}}; },
    [](int width, int height) {
      return std::make_shared<FakeD3D11H264VideoSource>(width, height);
    }
  );
  harness.livekit->releaseNext(Operation::Publish, Release{.publication_sid = "video-1"});
  harness.livekit->releaseNext(Operation::Publish, Release{.publication_sid = "audio-failed"});
  harness.failNextAudioWorkerStart();

  auto start = screenCommand(syrnike::desktop_native::NativeCommandType::StartScreenCapture, "screen-start", "screen-di", 1);
  start.audio_requested = true;
  harness.controller->startCapture(start);
  harness.handleNextWorkerCommand();
  require(harness.sink->waitReply("screen-start").ok, "healthy screen video failed to start");
  harness.handleNextWorkerCommand();
  const auto first_failure = harness.sink->waitLifecycleCount(
    "screen-di", 1, "screen_audio", "error", 1);
  require(
    first_failure.error && first_failure.error->code == "audio_device_lost",
    "screen audio failure lost its typed audio-only error"
  );
  require(
    harness.video_worker_starts.load() == 1 &&
      harness.audio_worker_starts.load() == 1,
    "screen audio failure restarted or skipped the healthy video lane"
  );

  for (int attempt = 0; attempt < 1000; ++attempt) {
    const auto unpublished = harness.livekit->unpublishedPublicationSids();
    if (std::find(unpublished.begin(), unpublished.end(), "audio-failed") != unpublished.end()) {
      break;
    }
    std::this_thread::sleep_for(1ms);
  }
  const auto after_failure = harness.livekit->unpublishedPublicationSids();
  require(
    std::find(after_failure.begin(), after_failure.end(), "audio-failed") !=
      after_failure.end() &&
      std::find(after_failure.begin(), after_failure.end(), "video-1") ==
        after_failure.end(),
    "audio-only failure retired the wrong publication"
  );

  harness.livekit->releaseNext(Operation::Publish, Release{.publication_sid = "audio-retry"});
  auto retry = start;
  retry.request_id = "audio-retry";
  harness.controller->startCapture(retry);
  require(harness.sink->waitReply("audio-retry").ok, "audio-only retry rejected healthy video");
  harness.handleNextWorkerCommand();
  harness.sink->waitLifecycleCount("screen-di", 1, "screen_audio", "running", 1);
  require(
    harness.video_worker_starts.load() == 1 &&
      harness.audio_worker_starts.load() == 2,
    "audio-only retry republished the healthy video lane"
  );

  syrnike::desktop_native::MediaCommand terminal;
  terminal.type = syrnike::desktop_native::NativeCommandType::ScreenAudioTerminal;
  terminal.session_id = "screen-di";
  terminal.generation = 1;
  terminal.internal_epoch = harness.current_audio_epoch.load();
  terminal.internal_message = "audio_device_lost";
  harness.controller->handleWorkerCommand(terminal);
  harness.sink->waitLifecycleCount("screen-di", 1, "screen_audio", "error", 2);

  harness.livekit->releaseNext(
    Operation::Publish, Release{.publication_sid = "audio-reconnect"});
  harness.blockNextAudioWorkerUntilStop();
  auto reconnect = start;
  reconnect.request_id = "audio-reconnect";
  harness.controller->startCapture(reconnect);
  require(
    harness.sink->waitReply("audio-reconnect").ok,
    "screen audio reconnect rejected the current screen session"
  );
  harness.handleNextWorkerCommand();
  harness.sink->waitLifecycleCount("screen-di", 1, "screen_audio", "running", 2);
  require(
    harness.video_worker_starts.load() == 1 &&
      harness.audio_worker_starts.load() == 3,
    "screen audio reconnect recreated healthy video"
  );

  auto late_terminal = terminal;
  late_terminal.internal_epoch = harness.previous_audio_epoch.load();
  late_terminal.internal_message = "late_old_audio_device_lost";
  harness.controller->handleWorkerCommand(late_terminal);
  std::this_thread::sleep_for(10ms);
  const auto before_stop = harness.livekit->unpublishedPublicationSids();
  require(
    std::find(before_stop.begin(), before_stop.end(), "audio-reconnect") ==
      before_stop.end(),
    "a late old audio terminal retired the reconnected audio lane"
  );

  const auto stopped_at = std::chrono::steady_clock::now();
  auto stop = screenCommand(syrnike::desktop_native::NativeCommandType::StopScreenCapture, "screen-stop", "screen-di", 1);
  harness.controller->stopCapture(stop);
  harness.controller->shutdown(stopped_at + 2s);
  require(
    std::chrono::steady_clock::now() - stopped_at < 2s,
    "screen audio shutdown exceeded its two-second cleanup budget"
  );
  const auto unpublished = harness.livekit->unpublishedPublicationSids();
  for (const auto* sid : {"video-1", "audio-failed", "audio-retry", "audio-reconnect"}) {
    require(
      std::count(unpublished.begin(), unpublished.end(), sid) == 1,
      "screen publication was not released exactly once"
    );
  }
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
        ScreenOutputStall::None,
      "a static published track was misclassified as an output failure"
    );
    require(
      detector.observe(started + 30s, false, 6, 6, 6, 5s) ==
        ScreenOutputStall::None,
      "inactive output retained a stale watchdog"
    );
    detector.reset();
    require(
      detector.observe(started + 31s, true, 0, 0, 0, 5s) ==
          ScreenOutputStall::None &&
        detector.observe(started + 37s, true, 0, 0, 0, 5s) ==
          ScreenOutputStall::Encoder,
      "a published screen source without its first handoff was treated as static"
    );
  }

  using syrnike::desktop_native::media::DeterministicFakeLiveKitVoiceSession;
  using syrnike::desktop_native::media::MediaRuntime;


  auto sink = std::make_shared<CollectingSink>();
  auto livekit = std::make_shared<DeterministicFakeLiveKitVoiceSession>();
  const auto clock_origin = std::chrono::steady_clock::now();
  std::atomic<std::int64_t> clock_offset_ms{0};
  MediaRuntime runtime(sink, livekit, [&] {
    return clock_origin + std::chrono::milliseconds(clock_offset_ms.load());
  });
  runtime.waitUntilReady();

  verifyPhase("unavailable encoder", verifyUnavailableEncoderFailsClosed);
  verifyPhase(
    "process encoder admission",
    verifyEncoderAdmissionFailsBeforeSourceConstruction);
  verifyPhase(
    "capture preflight before publication",
    verifyCapturePreflightFailsBeforePublication);
  verifyPhase(
    "capture permission denial",
    verifyCapturePermissionFailureStopsAutomaticRetry);
  verifyPhase("null encoder source", verifyNullEncoderSourceFailsClosed);
  verifyPhase(
    "capture after publish ACK",
    verifyCaptureStartsOnlyAfterPublishAck);
  verifyPhase(
    "publication failure lifecycle",
    verifyPublicationFailureClosesLifecycle);
  verifyPhase("cancelled publish rollback", verifyCancelledPublishRollsBackExactSid);
  verifyPhase(
    "retire completion retry",
    verifyRejectedRetireCompletionRetriesInternally
  );
  verifyPhase(
    "combined screen shutdown deadline",
    verifyCombinedShutdownUsesOneDeadline
  );
  verifyPhase(
    "screen shutdown cancels in-flight unpublish",
    verifyShutdownCancelsInFlightUnpublish
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
    "optional stats launcher failure",
    verifyStatsLauncherFailureIsOptional
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
    "capture worker ownership until join",
    verifyCaptureWorkerRetainsOwnerUntilJoin
  );
  verifyPhase(
    "independent screen audio lane",
    verifyAudioFailureRetryAndRetirementAreIndependentFromVideo
  );

  livekit->setBlocked(DeterministicFakeLiveKitVoiceSession::Operation::Publish, false);
  livekit->setVoiceSessionForTest("screen-c");
  const auto prepare_c = screenCommand(syrnike::desktop_native::NativeCommandType::ConnectScreen, "prepare-c", "screen-c", 7);
  require(runtime.dispatch(prepare_c), "runtime rejected terminal-semantics prepare");
  require(sink->waitReply("prepare-c").ok, "terminal-semantics prepare failed");

  syrnike::desktop_native::MediaCommand terminal;
  terminal.type = syrnike::desktop_native::NativeCommandType::ScreenTerminal;
  terminal.session_id = "screen-c";
  terminal.generation = 7;
  terminal.internal_message = "livekit_disconnected:network";
  terminal.terminal_producer =
    syrnike::desktop_native::NativeTerminalProducer::ScreenCapture;
  terminal.terminal_incarnation =
    syrnike::desktop_native::nextTerminalIncarnation();
  require(
    syrnike::desktop_native::terminalIncarnationFence().registerCurrent(
      terminal.terminal_producer, terminal.terminal_incarnation),
    "terminal-semantics fixture failed to register its screen incarnation"
  );
  require(runtime.dispatch(terminal), "runtime rejected screen terminal event");
  const auto ended = sink->waitEvent(syrnike::desktop_native::NativeEventType::ScreenCaptureEnded, "screen-c", 7);
  require(ended.reason == "runtime_error", "terminal disconnect lost screen ended semantics");
  require(
    ended.detail == "livekit_disconnected:network",
    "terminal disconnect lost its typed detail"
  );
  const auto stopped = sink->waitEvent(syrnike::desktop_native::NativeEventType::SessionStopped, "screen-c", 7);
  require(
    stopped.reason == "livekit_disconnected:network",
    "terminal disconnect lost sessionStopped semantics"
  );
  requireProbe(runtime, sink, "probe-terminal-retire");


  waitForAvailable(runtime, sink, "recovery-available");
  livekit->setVoiceSessionForTest("screen-recovery-next");
  const auto next_recovery_retry = screenCommand(
      syrnike::desktop_native::NativeCommandType::ConnectScreen,
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
