#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

#include <livekit/ffi_handle.h>
#include <livekit/track.h>

#include "common/event_sink.hpp"
#include "media/livekit_voice_session.hpp"
#include "media/media_runtime.hpp"
#include "media/media_runtime_support.hpp"
#include "media/remote_video_bridge.hpp"

namespace {

using syrnike::desktop_native::MediaCommand;
using syrnike::desktop_native::RuntimeEvent;
using syrnike::desktop_native::media::AudioOutputDeviceIntent;
using syrnike::desktop_native::media::LiveKitVoiceRoomOwner;
using syrnike::desktop_native::media::RemoteAudioSettings;
using syrnike::desktop_native::media::RemoteVideoBridge;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

class FakeVideoTrack final : public livekit::Track {
 public:
  explicit FakeVideoTrack(std::atomic_int& releases)
    : livekit::Track(
        livekit::FfiHandle{},
        "blocked-video",
        "blocked-video",
        livekit::TrackKind::KIND_VIDEO,
        livekit::StreamState::STATE_ACTIVE,
        false,
        true
      ),
      releases_(releases) {
    setPublicationFields(
      livekit::TrackSource::SOURCE_CAMERA,
      false,
      640,
      360,
      std::string("video/test")
    );
  }

  ~FakeVideoTrack() override {
    releases_.fetch_add(1);
  }

 private:
  std::atomic_int& releases_;
};

class BlockingStreamReader final : public RemoteVideoBridge::StreamReader {
 public:
  bool read(livekit::VideoFrameEvent&) override {
    {
      std::lock_guard lock(mutex_);
      read_entered_ = true;
    }
    changed_.notify_all();
    while (!release_read_.load()) std::this_thread::yield();
    read_exits_.fetch_add(1);
    return false;
  }

  void close() override {
    close_calls_.fetch_add(1);
  }

  bool waitUntilRead(std::chrono::milliseconds timeout) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] { return read_entered_; });
  }

  void releaseRead() {
    release_read_.store(true);
  }

  int closeCalls() const {
    return close_calls_.load();
  }

  int readExits() const {
    return read_exits_.load();
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  bool read_entered_ = false;
  std::atomic_bool release_read_{false};
  std::atomic_int close_calls_{0};
  std::atomic_int read_exits_{0};
};

class SingleFrameThenBlockReader final : public RemoteVideoBridge::StreamReader {
 public:
  bool read(livekit::VideoFrameEvent& event) override {
    std::unique_lock lock(mutex_);
    if (!frame_sent_) {
      frame_sent_ = true;
      lock.unlock();
      event.frame = livekit::VideoFrame::create(
        64,
        64,
        livekit::VideoBufferType::BGRA
      );
      std::fill(
        event.frame.data(),
        event.frame.data() + event.frame.dataSize(),
        std::uint8_t{0x5a}
      );
      event.timestamp_us = 42;
      event.rotation = livekit::VideoRotation::VIDEO_ROTATION_0;
      return true;
    }
    changed_.wait(lock, [&] { return closed_; });
    return false;
  }

  void close() override {
    {
      std::lock_guard lock(mutex_);
      closed_ = true;
    }
    changed_.notify_all();
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  bool frame_sent_ = false;
  bool closed_ = false;
};

class PostGate final {
 public:
  explicit PostGate(
    std::function<bool(MediaCommand)> downstream = {}
  ) : downstream_(std::move(downstream)) {}

  bool post(MediaCommand command) {
    std::lock_guard lock(mutex_);
    if (closed_) return false;
    deliveries_.fetch_add(1);
    return downstream_ ? downstream_(std::move(command)) : true;
  }

  void close() {
    std::lock_guard lock(mutex_);
    closed_ = true;
    downstream_ = {};
  }

  bool closed() {
    std::lock_guard lock(mutex_);
    return closed_;
  }

  int deliveries() const {
    return deliveries_.load();
  }

 private:
  std::mutex mutex_;
  bool closed_ = false;
  std::function<bool(MediaCommand)> downstream_;
  std::atomic_int deliveries_{0};
};

struct ReleaseToken {
  explicit ReleaseToken(std::atomic_int& releases) : releases_(releases) {}
  ~ReleaseToken() {
    releases_.fetch_add(1);
  }
  std::atomic_int& releases_;
};

class BlockingBridgeOwner final
  : public std::enable_shared_from_this<BlockingBridgeOwner> {
 public:
  BlockingBridgeOwner(
    std::shared_ptr<BlockingStreamReader> reader,
    std::shared_ptr<PostGate> post_gate,
    std::atomic_int& token_releases,
    syrnike::desktop_native::AsyncCleanupLauncher cleanup_launcher
  ) : token_(std::make_shared<ReleaseToken>(token_releases)),
      post_gate_(std::move(post_gate)),
      bridge_(
        0,
        [gate = post_gate_](MediaCommand command) {
          return gate->post(std::move(command));
        },
        {},
        {},
        {},
        [reader = std::move(reader)](const std::shared_ptr<livekit::Track>&) {
          return reader;
        },
        std::move(cleanup_launcher)
      ) {}

  void add(const std::shared_ptr<livekit::Track>& track) {
    bridge_.addTrack(
      track,
      "participant",
      livekit::TrackSource::SOURCE_CAMERA
    );
  }

  void beginShutdown() {
    post_gate_->close();
    bridge_.stop(shared_from_this());
  }

 private:
  std::shared_ptr<ReleaseToken> token_;
  std::shared_ptr<PostGate> post_gate_;
  RemoteVideoBridge bridge_;
};

class CollectingSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(RuntimeEvent event) override {
    std::lock_guard lock(mutex_);
    if (closed_) emissions_after_close_ += 1;
    events_.push_back(std::move(event));
    changed_.notify_all();
    return true;
  }

  void close() override {
    std::lock_guard lock(mutex_);
    closed_ = true;
  }

  bool waitReply(const std::string& request_id, std::chrono::milliseconds timeout) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] {
      for (const auto& event : events_) {
        if (event.type == "reply" && event.request_id == request_id && event.ok) {
          return true;
        }
      }
      return false;
    });
  }

  std::size_t replyCount(const std::string& request_id) {
    std::lock_guard lock(mutex_);
    std::size_t count = 0;
    for (const auto& event : events_) {
      if (event.type == "reply" && event.request_id == request_id) count += 1;
    }
    return count;
  }

  std::size_t emissionsAfterClose() {
    std::lock_guard lock(mutex_);
    return emissions_after_close_;
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  std::vector<RuntimeEvent> events_;
  bool closed_ = false;
  std::size_t emissions_after_close_ = 0;
};

struct RuntimeRoomState {
  std::shared_ptr<BlockingStreamReader> reader;
  std::shared_ptr<PostGate> post_gate;
  std::weak_ptr<LiveKitVoiceRoomOwner> owner;
  std::atomic_int owner_releases{0};
  std::atomic_int track_releases{0};
};

class BlockingVideoRoomOwner final
  : public LiveKitVoiceRoomOwner,
    public std::enable_shared_from_this<BlockingVideoRoomOwner> {
 public:
  BlockingVideoRoomOwner(
    std::shared_ptr<RuntimeRoomState> state,
    std::function<bool(MediaCommand)> post
  ) : state_(std::move(state)),
      post_gate_(std::make_shared<PostGate>(std::move(post))),
      track_(std::make_shared<FakeVideoTrack>(state_->track_releases)),
      bridge_(
        0,
        [gate = post_gate_](MediaCommand command) {
          return gate->post(std::move(command));
        },
        {},
        {},
        {},
        [reader = state_->reader](const std::shared_ptr<livekit::Track>&) {
          return reader;
        }
      ) {
    state_->post_gate = post_gate_;
  }

  ~BlockingVideoRoomOwner() override {
    state_->owner_releases.fetch_add(1);
  }

  bool connect(
    const std::string&,
    const std::string&,
    const livekit::RoomOptions&
  ) override {
    connected_.store(true);
    bridge_.addTrack(
      track_,
      "participant",
      livekit::TrackSource::SOURCE_CAMERA
    );
    return true;
  }

  bool isConnected() const override {
    return connected_.load();
  }

  bool waitConnected(std::chrono::milliseconds) override {
    return connected_.load();
  }

  void markIntentionalDisconnect() override {}
  void stopAudio() override {}

  void disconnect() override {
    if (disconnect_started_.exchange(true)) return;
    connected_.store(false);
    post_gate_->close();
    bridge_.stop(shared_from_this());
  }

  void setDeafened(bool) override {}
  std::uint64_t setOutputDevice(
    std::string,
    AudioOutputDeviceIntent
  ) override {
    return 1;
  }
  std::string outputDeviceId() const override { return "default"; }
  bool isOutputEpochCurrent(std::uint64_t) const override { return true; }
  void setOutputVolume(float) override {}
  void configureRemoteAudio(RemoteAudioSettings) override {}
  void releaseRemoteVideoFrame(std::string, std::uint64_t) override {}
  void setRemoteVideoDemand(std::string, bool) override {}
  void retryRemoteVideo(
    std::string,
    syrnike::desktop_native::media::RemoteVideoRecoveryMode,
    std::string
  ) override {}
  void startLocalCameraPreview(
    std::string,
    std::uint64_t,
    std::string,
    std::string,
    const std::shared_ptr<livekit::LocalVideoTrack>&
  ) override {}
  void stopLocalCameraPreview(const std::string&) override {}
  void releaseLocalCameraPreviewFrame(std::string, std::uint64_t) override {}
  std::string publishAudioTrack(
    const std::shared_ptr<livekit::LocalAudioTrack>&,
    const livekit::TrackPublishOptions&
  ) override {
    return "audio";
  }
  std::string publishVideoTrack(
    const std::shared_ptr<livekit::LocalVideoTrack>&,
    const livekit::TrackPublishOptions&
  ) override {
    return "video";
  }
  void unpublishTrack(const std::string&) override {}

 private:
  std::shared_ptr<RuntimeRoomState> state_;
  std::shared_ptr<PostGate> post_gate_;
  std::shared_ptr<livekit::Track> track_;
  RemoteVideoBridge bridge_;
  std::atomic_bool connected_{false};
  std::atomic_bool disconnect_started_{false};
};

template <typename Predicate>
bool waitUntil(Predicate predicate, std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (!predicate() && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return predicate();
}

}  // namespace

int main() try {
#ifdef _WIN32
  // The GPU pump must publish a completed upload even though the decoder does
  // not deliver a second frame to wake the blocking read loop.
  {
    std::atomic_int static_track_releases{0};
    auto static_track = std::make_shared<FakeVideoTrack>(static_track_releases);
    auto static_reader = std::make_shared<SingleFrameThenBlockReader>();
    std::mutex frame_mutex;
    std::condition_variable frame_changed;
    bool frame_delivered = false;
    RemoteVideoBridge* bridge_pointer = nullptr;
    RemoteVideoBridge static_bridge(
      GetCurrentProcessId(),
      [&](MediaCommand command) {
        if (command.type != "__remoteVideoFrame") return true;
        bridge_pointer->release(command.track_id, command.frame_sequence);
        {
          std::lock_guard lock(frame_mutex);
          frame_delivered = command.timestamp_us == 42;
        }
        frame_changed.notify_all();
        return true;
      },
      {},
      {},
      {},
      [static_reader](const std::shared_ptr<livekit::Track>&) {
        return static_reader;
      }
    );
    bridge_pointer = &static_bridge;
    static_bridge.updateIdentity("static-frame", 1);
    static_bridge.addTrack(
      static_track,
      "participant",
      livekit::TrackSource::SOURCE_CAMERA,
      "static-frame-track"
    );
    {
      std::unique_lock lock(frame_mutex);
      require(
        frame_changed.wait_for(
          lock,
          std::chrono::seconds(2),
          [&] { return frame_delivered; }
        ),
        "remote video GPU pump did not publish a lone static frame"
      );
    }
    static_bridge.removeTrack("static-frame-track", false);
  }
#endif

  std::atomic_int token_releases{0};
  std::atomic_int track_releases{0};
  std::atomic_int bridge_cleanup_launches{0};
  auto reader = std::make_shared<BlockingStreamReader>();
  auto post_gate = std::make_shared<PostGate>();
  auto owner = std::make_shared<BlockingBridgeOwner>(
    reader,
    post_gate,
    token_releases,
    [&](syrnike::desktop_native::AsyncCleanupTask task) -> std::thread {
      if (bridge_cleanup_launches.fetch_add(1) == 0) {
        throw std::runtime_error(
          "injected remote video quarantine launch failure"
        );
      }
      return std::thread(std::move(task));
    }
  );
  auto track = std::make_shared<FakeVideoTrack>(track_releases);
  owner->add(track);
  require(
    reader->waitUntilRead(std::chrono::seconds(1)),
    "remote video reader did not enter its injected blocking read"
  );
  // The GPU pump wakes independently before a first decoded frame exists.
  // Keep the read blocked past its idle interval to prove that an absent lazy
  // uploader remains a valid no-work state instead of a null dereference.
  std::this_thread::sleep_for(std::chrono::milliseconds(100));

  const auto shutdown_started = std::chrono::steady_clock::now();
  owner->beginShutdown();
  require(
    std::chrono::steady_clock::now() - shutdown_started <
      std::chrono::milliseconds(100),
    "remote video blocked read delayed outer Room shutdown"
  );
  require(post_gate->closed(), "remote video callback gate remained open");

  std::weak_ptr<BlockingBridgeOwner> owner_lifetime = owner;
  owner.reset();
  track.reset();
  require(
    !owner_lifetime.expired() &&
      token_releases.load() == 0 &&
      track_releases.load() == 0,
    "remote video quarantine released its delegate, SDK token, or track early"
  );

  reader->releaseRead();
  require(
    waitUntil(
      [&] {
        return owner_lifetime.expired() &&
          token_releases.load() == 1 &&
          track_releases.load() == 1;
      },
      std::chrono::seconds(1)
    ),
    "remote video quarantine did not finish owner member destruction"
  );
  require(reader->readExits() == 1, "remote video reader did not exit exactly once");
  require(reader->closeCalls() == 1, "remote video stream did not close exactly once");
  require(track_releases.load() == 1, "remote video track did not release exactly once");
  require(token_releases.load() == 1, "remote video SDK token did not release exactly once");
  require(post_gate->deliveries() == 0, "late remote video work escaped the closed post gate");
  require(
    bridge_cleanup_launches.load() >= 2,
    "remote video quarantine did not retry its failed cleanup launch"
  );

  using syrnike::desktop_native::media::LiveKitLease;
  using syrnike::desktop_native::media::LiveKitRuntimeLifetime;
  using syrnike::desktop_native::media::MediaRuntime;
  const auto leases_before_runtime = LiveKitLease::activeCount();
  const auto initializes_before_runtime =
    LiveKitLease::initializeTransitionCount();
  const auto shutdowns_before_runtime =
    LiveKitLease::shutdownTransitionCount();
  auto runtime_state = std::make_shared<RuntimeRoomState>();
  runtime_state->reader = std::make_shared<BlockingStreamReader>();
  auto runtime_lifetime = std::make_shared<LiveKitRuntimeLifetime>();
  auto runtime_client =
    syrnike::desktop_native::media::createRealLiveKitVoiceSession(
      runtime_lifetime,
      [runtime_state](auto, auto, auto, auto, auto post) {
        auto owner = std::make_shared<BlockingVideoRoomOwner>(
          runtime_state,
          std::move(post)
        );
        runtime_state->owner = owner;
        return owner;
      }
    );
  auto runtime_sink = std::make_shared<CollectingSink>();
  std::mutex microphone_mutex;
  std::condition_variable microphone_changed;
  bool microphone_entered = false;
  bool release_microphone = false;
  bool microphone_exited = false;
  auto runtime = std::make_unique<MediaRuntime>(
    runtime_sink,
    runtime_client,
    MediaRuntime::SteadyNow{},
    [&](const MediaCommand&) {
      std::unique_lock lock(microphone_mutex);
      microphone_entered = true;
      microphone_changed.notify_all();
      microphone_changed.wait(lock, [&] { return release_microphone; });
      microphone_exited = true;
      microphone_changed.notify_all();
    },
    MediaRuntime::BeforeVoiceShutdown{},
    runtime_lifetime
  );
  runtime->waitUntilReady();

  MediaCommand connect;
  connect.type = "connectVoice";
  connect.request_id = "remote-video-connect";
  connect.session_id = "remote-video-room";
  connect.generation = 1;
  connect.livekit_url = "wss://example.invalid";
  connect.livekit_token = "token";
  require(runtime->dispatch(std::move(connect)), "runtime rejected video Room connect");
  require(
    runtime_sink->waitReply("remote-video-connect", std::chrono::seconds(1)),
    "video Room connect did not complete"
  );
  require(
    runtime_state->reader->waitUntilRead(std::chrono::seconds(1)),
    "runtime video Room did not enter its blocking read"
  );

  MediaCommand configure;
  configure.type = "configureMicrophone";
  configure.request_id = "remote-video-blocked-microphone";
  configure.session_id = "remote-video-microphone";
  configure.generation = 1;
  require(
    runtime->dispatch(std::move(configure)),
    "runtime rejected the second blocked subsystem"
  );
  {
    std::unique_lock lock(microphone_mutex);
    require(
      microphone_changed.wait_for(
        lock,
        std::chrono::seconds(1),
        [&] { return microphone_entered; }
      ),
      "runtime microphone operation did not enter its blocker"
    );
  }

  MediaCommand shutdown;
  shutdown.type = "shutdown";
  shutdown.request_id = "remote-video-runtime-shutdown";
  const auto runtime_shutdown_started = std::chrono::steady_clock::now();
  require(runtime->dispatch(std::move(shutdown)), "runtime rejected shutdown");
  runtime->shutdownAndWait();
  require(
    std::chrono::steady_clock::now() - runtime_shutdown_started <
      syrnike::desktop_native::media::kNativeShutdownBudget,
    "blocked video and microphone exceeded the shared native shutdown budget"
  );
  require(
    runtime_sink->replyCount("remote-video-runtime-shutdown") == 1,
    "blocked multi-subsystem shutdown did not emit exactly one reply"
  );
  require(
    waitUntil(
      [&] {
        return runtime_state->post_gate && runtime_state->post_gate->closed();
      },
      std::chrono::seconds(1)
    ),
    "Room callback gate did not close after outer runtime shutdown"
  );
  runtime.reset();
  require(
    !runtime_state->owner.expired() &&
      runtime_state->owner_releases.load() == 0 &&
      runtime_state->track_releases.load() == 0,
    "runtime quarantine released its Room, track, or SDK graph early"
  );
  {
    std::lock_guard lock(microphone_mutex);
    require(!microphone_exited, "second subsystem was not quarantined");
    release_microphone = true;
  }
  microphone_changed.notify_all();
  runtime_state->reader->releaseRead();
  require(
    waitUntil(
      [&] {
        std::lock_guard lock(microphone_mutex);
        return microphone_exited;
      },
      std::chrono::seconds(1)
    ),
    "quarantined microphone operation did not exit after release"
  );
  require(
    waitUntil(
      [&] {
        return runtime_state->owner.expired() &&
          runtime_state->owner_releases.load() == 1 &&
          runtime_state->track_releases.load() == 1;
      },
      std::chrono::seconds(1)
    ),
    "quarantined Room owner did not finish after the video read exited"
  );
  require(
    runtime_state->reader->readExits() == 1 &&
      runtime_state->reader->closeCalls() == 1 &&
      runtime_state->owner_releases.load() == 1 &&
      runtime_state->track_releases.load() == 1,
    "late video worker did not release Room, stream, and track exactly once"
  );
  runtime_client.reset();
  runtime_lifetime.reset();
  require(
    waitUntil(
      [&] { return LiveKitLease::activeCount() == leases_before_runtime; },
      std::chrono::seconds(2)
    ),
    "runtime video quarantine retained its LiveKit lease"
  );
  require(
    LiveKitLease::initializeTransitionCount() ==
        initializes_before_runtime + 1 &&
      LiveKitLease::shutdownTransitionCount() ==
        shutdowns_before_runtime + 1,
    "runtime video quarantine initialized or released LiveKit more than once"
  );
  require(
    runtime_sink->emissionsAfterClose() == 0 &&
      runtime_state->post_gate->deliveries() == 0,
    "late video work escaped the closed emitter or callback gate"
  );
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
