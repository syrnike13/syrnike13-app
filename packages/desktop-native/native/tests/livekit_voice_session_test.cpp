#include <atomic>
#include <chrono>
#include <condition_variable>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>

#include <livekit/livekit.h>

#include "common/event_sink.hpp"
#include "media/livekit_voice_session.hpp"
#include "media/media_runtime.hpp"
#include "media/media_runtime_support.hpp"

namespace {

using namespace std::chrono_literals;

template <typename Future>
void requireNotReady(Future& future, const char* message) {
  if (future.wait_for(0ms) != std::future_status::timeout) {
    throw std::runtime_error(message);
  }
}

template <typename Future>
void requireReady(Future& future, const char* message) {
  if (future.wait_for(1s) != std::future_status::ready) {
    throw std::runtime_error(message);
  }
}

struct BlockingRetireState {
  std::mutex mutex;
  std::condition_variable changed;
  bool retire_entered = false;
  bool release_retire = false;
  std::atomic_bool block_next_retire{true};
  bool block_connect = false;
  bool connect_entered = false;
  bool release_connect = false;
  bool connect_active = false;
  bool disconnect_entered = false;
  bool lifecycle_overlap = false;
  bool block_publish = false;
  bool publish_entered = false;
  bool release_publish = false;
  bool publish_active = false;
  bool block_output = false;
  bool output_entered = false;
  bool release_output = false;
};

class NoopSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent) override { return true; }
  void close() override {}
};

class FakeVoiceRoomOwner final
  : public syrnike::desktop_native::media::LiveKitVoiceRoomOwner {
 public:
  explicit FakeVoiceRoomOwner(std::shared_ptr<BlockingRetireState> state)
    : state_(std::move(state)) {}

  ~FakeVoiceRoomOwner() override {
    if (!state_->block_next_retire.exchange(false)) return;
    std::unique_lock lock(state_->mutex);
    state_->retire_entered = true;
    state_->changed.notify_all();
    state_->changed.wait(lock, [&] { return state_->release_retire; });
  }

  bool connect(
    const std::string&,
    const std::string&,
    const livekit::RoomOptions&
  ) override {
    {
      std::unique_lock lock(state_->mutex);
      state_->connect_entered = true;
      state_->connect_active = true;
      state_->changed.notify_all();
      if (state_->block_connect) {
        state_->changed.wait(lock, [&] { return state_->release_connect; });
      }
      state_->connect_active = false;
    }
    state_->changed.notify_all();
    connected_.store(true);
    return true;
  }
  bool isConnected() const override { return false; }
  bool waitConnected(std::chrono::milliseconds) override { return connected_.load(); }
  void markIntentionalDisconnect() override {}
  void stopAudio() override {}
  void disconnect() override {
    std::lock_guard lock(state_->mutex);
    state_->disconnect_entered = true;
    state_->lifecycle_overlap =
      state_->lifecycle_overlap || state_->connect_active ||
      state_->publish_active;
    connected_.store(false);
    state_->changed.notify_all();
  }
  void setDeafened(bool) override {}
  std::uint64_t setOutputDevice(
    std::string,
    syrnike::desktop_native::media::AudioOutputDeviceIntent
  ) override {
    std::unique_lock lock(state_->mutex);
    state_->output_entered = true;
    state_->changed.notify_all();
    if (state_->block_output) {
      state_->changed.wait(lock, [&] { return state_->release_output; });
    }
    return 1;
  }
  std::string outputDeviceId() const override { return "default"; }
  bool isOutputEpochCurrent(std::uint64_t) const override { return true; }
  void setOutputVolume(float) override {}
  void configureRemoteAudio(
    syrnike::desktop_native::media::RemoteAudioSettings
  ) override {}
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
  ) override { return publish("fake-audio"); }
  std::string publishVideoTrack(
    const std::shared_ptr<livekit::LocalVideoTrack>&,
    const livekit::TrackPublishOptions&
  ) override { return publish("fake-video"); }
  void unpublishTrack(const std::string&) override {}

 private:
  std::string publish(std::string result) {
    {
      std::unique_lock lock(state_->mutex);
      state_->publish_entered = true;
      state_->publish_active = true;
      state_->changed.notify_all();
      if (state_->block_publish) {
        state_->changed.wait(lock, [&] { return state_->release_publish; });
      }
      state_->publish_active = false;
    }
    state_->changed.notify_all();
    return result;
  }

  std::shared_ptr<BlockingRetireState> state_;
  std::atomic_bool connected_{false};
};

}  // namespace

int main() try {
  using syrnike::desktop_native::media::DeterministicFakeLiveKitVoiceSession;
  using syrnike::desktop_native::media::LiveKitVoiceSession;

  auto client = std::make_shared<DeterministicFakeLiveKitVoiceSession>();
  auto noop_post = LiveKitVoiceSession::InternalPost{[](syrnike::desktop_native::MediaCommand) {
    return true;
  }};

  bool rejected_missing_lifetime = false;
  try {
    static_cast<void>(
      syrnike::desktop_native::media::createRealLiveKitVoiceSession({})
    );
  } catch (const std::invalid_argument&) {
    rejected_missing_lifetime = true;
  }
  if (!rejected_missing_lifetime) {
    throw std::runtime_error("real client factory accepted a missing runtime lifetime");
  }

  auto real_path_lifetime =
    std::make_shared<syrnike::desktop_native::media::LiveKitRuntimeLifetime>();
  auto retire_state = std::make_shared<BlockingRetireState>();
  auto real_path_client =
    syrnike::desktop_native::media::createRealLiveKitVoiceSession(
      real_path_lifetime,
      [retire_state](auto, auto, auto, auto, auto) {
        return std::make_shared<FakeVoiceRoomOwner>(retire_state);
      }
    );
  bool rejected_uninitialized_lifetime = false;
  try {
    static_cast<void>(real_path_client->connectVoice(
      "uninitialized",
      0,
      "wss://example.invalid",
      "token",
      noop_post
    ));
  } catch (const std::logic_error&) {
    rejected_uninitialized_lifetime = true;
  }
  if (!rejected_uninitialized_lifetime) {
    throw std::runtime_error(
      "real client used SDK state before its runtime lifetime was initialized"
    );
  }
  syrnike::desktop_native::media::MediaRuntime real_path_runtime(
    std::make_shared<NoopSink>(),
    real_path_client,
    {},
    {},
    {},
    real_path_lifetime
  );
  real_path_runtime.waitUntilReady();
  if (!real_path_client->connectVoice(
        "real-path",
        1,
        "wss://example.invalid",
        "token-a",
        noop_post
      )) {
    throw std::runtime_error("real client seam did not establish its first owner");
  }
  auto replacing_owner = std::async(std::launch::async, [&] {
    return real_path_client->connectVoice(
      "real-path",
      2,
      "wss://example.invalid",
      "token-b",
      noop_post
    );
  });
  {
    std::unique_lock lock(retire_state->mutex);
    if (!retire_state->changed.wait_for(
          lock,
          1s,
          [&] { return retire_state->retire_entered; }
        )) {
      throw std::runtime_error("replacement did not enter old owner teardown");
    }
  }
  const auto snapshot_started = std::chrono::steady_clock::now();
  static_cast<void>(real_path_client->isVoiceConnected());
  real_path_client->releaseRemoteVideoFrame("track", 1);
  if (std::chrono::steady_clock::now() - snapshot_started >= 50ms) {
    throw std::runtime_error(
      "old Room teardown retained the real client mutex across JS-facing calls"
    );
  }
  requireNotReady(
    replacing_owner,
    "replacement connect completed before old owner teardown was released"
  );
  {
    std::lock_guard lock(retire_state->mutex);
    retire_state->release_retire = true;
  }
  retire_state->changed.notify_all();
  requireReady(replacing_owner, "replacement connect did not resume after teardown");
  if (!replacing_owner.get()) {
    throw std::runtime_error("replacement connect failed after teardown");
  }
  for (std::uint64_t generation = 3; generation < 53; ++generation) {
    const auto reconnect_started = std::chrono::steady_clock::now();
    if (!real_path_client->connectVoice(
          "real-path",
          generation,
          "wss://example.invalid",
          "token-" + std::to_string(generation),
          noop_post
        )) {
      throw std::runtime_error("real client reconnect seam failed");
    }
    if (std::chrono::steady_clock::now() - reconnect_started >= 50ms) {
      throw std::runtime_error("real client reconnect exceeded 50ms");
    }
  }
  real_path_client->disconnectVoice();
  real_path_runtime.requestShutdown();
  real_path_runtime.shutdownAndWait();

  auto serialized_lifetime =
    std::make_shared<syrnike::desktop_native::media::LiveKitRuntimeLifetime>();
  auto serialized_state = std::make_shared<BlockingRetireState>();
  serialized_state->block_next_retire.store(false);
  serialized_state->block_connect = true;
  auto serialized_client =
    syrnike::desktop_native::media::createRealLiveKitVoiceSession(
      serialized_lifetime,
      [serialized_state](auto, auto, auto, auto, auto) {
        return std::make_shared<FakeVoiceRoomOwner>(serialized_state);
      }
    );
  syrnike::desktop_native::media::MediaRuntime serialized_runtime(
    std::make_shared<NoopSink>(),
    serialized_client,
    {},
    {},
    {},
    serialized_lifetime
  );
  serialized_runtime.waitUntilReady();
  auto serialized_connect = std::async(std::launch::async, [&] {
    return serialized_client->connectVoice(
      "serialized", 1, "wss://example.invalid", "token", noop_post);
  });
  {
    std::unique_lock lock(serialized_state->mutex);
    if (!serialized_state->changed.wait_for(
          lock, 1s, [&] { return serialized_state->connect_entered; })) {
      throw std::runtime_error("serialized connect did not enter owner");
    }
  }
  auto serialized_disconnect = std::async(std::launch::async, [&] {
    serialized_client->disconnectVoice();
    return true;
  });
  requireNotReady(
    serialized_disconnect,
    "disconnect entered LiveKit while Room::connect was still active"
  );
  {
    std::lock_guard lock(serialized_state->mutex);
    serialized_state->release_connect = true;
  }
  serialized_state->changed.notify_all();
  requireReady(serialized_connect, "serialized connect did not finish");
  requireReady(serialized_disconnect, "serialized disconnect did not finish");
  if (!serialized_connect.get() || !serialized_disconnect.get()) {
    throw std::runtime_error("serialized voice lifecycle returned failure");
  }
  {
    std::lock_guard lock(serialized_state->mutex);
    if (!serialized_state->disconnect_entered ||
        serialized_state->lifecycle_overlap) {
      throw std::runtime_error(
        "LiveKit connect/disconnect lifecycle was not serialized");
    }
  }

  serialized_state->block_connect = false;
  serialized_state->disconnect_entered = false;
  if (!serialized_client->connectVoice(
        "serialized-publish", 2, "wss://example.invalid", "token-2",
        noop_post)) {
    throw std::runtime_error("publication lifecycle Room did not connect");
  }
  serialized_state->block_output = true;
  auto serialized_output = std::async(std::launch::async, [&] {
    return serialized_client->setVoiceOutputDevice(
      "default",
      syrnike::desktop_native::media::AudioOutputDeviceIntent::UserConfiguration
    );
  });
  {
    std::unique_lock lock(serialized_state->mutex);
    if (!serialized_state->changed.wait_for(
          lock, 1s, [&] { return serialized_state->output_entered; })) {
      throw std::runtime_error("serialized output change did not enter owner");
    }
  }
  auto publish_during_output = std::async(std::launch::async, [&] {
    return serialized_client->publishAudioTrack(
      "serialized-publish", 2, {}, livekit::TrackPublishOptions{});
  });
  requireNotReady(
    publish_during_output,
    "publication reported a result while output configuration owned the Room"
  );
  {
    std::lock_guard lock(serialized_state->mutex);
    serialized_state->release_output = true;
  }
  serialized_state->changed.notify_all();
  requireReady(serialized_output, "serialized output change did not finish");
  requireReady(
    publish_during_output,
    "publication did not resume after output configuration"
  );
  if (serialized_output.get() != 1 ||
      publish_during_output.get() != "fake-audio") {
    throw std::runtime_error(
      "output contention was misreported as a disconnected voice Room");
  }
  {
    std::lock_guard lock(serialized_state->mutex);
    serialized_state->block_publish = true;
    serialized_state->publish_entered = false;
    serialized_state->release_publish = false;
  }

  auto serialized_publish = std::async(std::launch::async, [&] {
    return serialized_client->publishAudioTrack(
      "serialized-publish", 2, {}, livekit::TrackPublishOptions{});
  });
  {
    std::unique_lock lock(serialized_state->mutex);
    if (!serialized_state->changed.wait_for(
          lock, 1s, [&] { return serialized_state->publish_entered; })) {
      throw std::runtime_error("serialized publication did not enter owner");
    }
  }
  auto publish_disconnect = std::async(std::launch::async, [&] {
    serialized_client->disconnectVoice();
    return true;
  });
  requireNotReady(
    publish_disconnect,
    "disconnect entered LiveKit while track publication was active"
  );
  {
    std::lock_guard lock(serialized_state->mutex);
    serialized_state->release_publish = true;
  }
  serialized_state->changed.notify_all();
  requireReady(serialized_publish, "serialized publication did not finish");
  requireReady(publish_disconnect, "post-publication disconnect did not finish");
  if (serialized_publish.get() != "fake-audio" ||
      !publish_disconnect.get()) {
    throw std::runtime_error("serialized publication lifecycle returned failure");
  }
  {
    std::lock_guard lock(serialized_state->mutex);
    if (serialized_state->lifecycle_overlap) {
      throw std::runtime_error(
        "LiveKit publication/disconnect lifecycle was not serialized");
    }
  }
  serialized_runtime.requestShutdown();
  serialized_runtime.shutdownAndWait();

  // Room connect/disconnect gates belong only to the voice owner. Publishing
  // a track must never enter either gate.
  client->setBlocked(DeterministicFakeLiveKitVoiceSession::Operation::Connect, true);
  auto connect_future = std::async(std::launch::async, [&] {
    return client->connectVoice(
      "voice", 1, "wss://example.invalid", "token", noop_post);
  });
  client->waitUntilPending(DeterministicFakeLiveKitVoiceSession::Operation::Connect, 1);
  requireNotReady(connect_future, "blocked connect completed before release");
  client->releaseNext(DeterministicFakeLiveKitVoiceSession::Operation::Connect);
  requireReady(connect_future, "released connect did not finish");
  if (!connect_future.get()) {
    throw std::runtime_error("released connect returned false");
  }

  client->setBlocked(DeterministicFakeLiveKitVoiceSession::Operation::Publish, true);
  client->setBlocked(DeterministicFakeLiveKitVoiceSession::Operation::Unpublish, true);

  if (client->pending(DeterministicFakeLiveKitVoiceSession::Operation::Connect) != 0) {
    throw std::runtime_error("track publication attempted to connect its own Room");
  }
  auto publish_future = std::async(std::launch::async, [&] {
    return client->publishAudioTrack(
      "voice", 1, {}, livekit::TrackPublishOptions{});
  });
  client->waitUntilPending(DeterministicFakeLiveKitVoiceSession::Operation::Publish, 1);
  requireNotReady(publish_future, "blocked publish completed before release");

  auto unpublish_future = std::async(std::launch::async, [&] {
    client->unpublishTrack("voice", 1, "publication-1");
    return true;
  });
  client->waitUntilPending(DeterministicFakeLiveKitVoiceSession::Operation::Unpublish, 1);
  requireNotReady(unpublish_future, "blocked unpublish completed before release");

  client->releaseNext(DeterministicFakeLiveKitVoiceSession::Operation::Unpublish);
  requireReady(unpublish_future, "released unpublish did not finish");
  if (!unpublish_future.get()) {
    throw std::runtime_error("released unpublish returned false");
  }
  requireNotReady(publish_future, "unpublish release also unblocked publish");

  DeterministicFakeLiveKitVoiceSession::Release publish_release;
  publish_release.bool_result = true;
  publish_release.publication_sid = "published-audio";
  client->releaseNext(
    DeterministicFakeLiveKitVoiceSession::Operation::Publish,
    std::move(publish_release)
  );
  requireReady(publish_future, "released publish did not finish");
  if (publish_future.get() != "published-audio") {
    throw std::runtime_error("publish release lost its deterministic publication SID");
  }

  auto failing_client = std::make_shared<DeterministicFakeLiveKitVoiceSession>();
  failing_client->setBlocked(DeterministicFakeLiveKitVoiceSession::Operation::Connect, true);
  auto failing_future = std::async(std::launch::async, [&] {
    return failing_client->connectVoice(
      "failing", 1, "wss://example.invalid", "token", noop_post);
  });
  failing_client->waitUntilPending(DeterministicFakeLiveKitVoiceSession::Operation::Connect, 1);
  DeterministicFakeLiveKitVoiceSession::Release failed_connect_release;
  failed_connect_release.bool_result = false;
  failing_client->releaseNext(
    DeterministicFakeLiveKitVoiceSession::Operation::Connect,
    std::move(failed_connect_release)
  );
  requireReady(failing_future, "released failing connect did not finish");
  if (failing_future.get()) {
    throw std::runtime_error("connect failure release returned true");
  }

  // The target runtime owns one voice Room. Track operations reuse it and may
  // retire independently without disconnecting the shared participant.
  auto shared_client = std::make_shared<DeterministicFakeLiveKitVoiceSession>();
  if (!shared_client->connectVoice(
        "voice-op",
        1,
        "wss://example.invalid",
        "shared-token",
        noop_post
      )) {
    throw std::runtime_error("shared voice Room did not connect");
  }
  bool conflicting_duplicate_rejected = false;
  try {
    shared_client->connectVoice(
      "voice-op", 1, "wss://example.invalid", "other-token", noop_post);
  } catch (const std::exception&) {
    conflicting_duplicate_rejected = true;
  }
  if (!conflicting_duplicate_rejected) {
    throw std::runtime_error("duplicate voice epoch accepted another credential lease");
  }
  shared_client->unpublishTrack("voice-op", 41, "already-retired");
  if (!shared_client->isVoiceConnected()) {
    throw std::runtime_error("track retirement disconnected shared voice Room");
  }
  // Receive-side controls are properties of the existing Room lease. They
  // must not reconnect or retire the participant.
  shared_client->setVoiceDeafened(true);
  const auto output_epoch_a =
    shared_client->setVoiceOutputDevice(
      "communications-output",
      syrnike::desktop_native::media::AudioOutputDeviceIntent::UserConfiguration
    );
  if (!shared_client->isVoiceOutputEpochCurrent(output_epoch_a)) {
    throw std::runtime_error("committed output renderer epoch was not current");
  }
  const auto output_epoch_b = shared_client->setVoiceOutputDevice(
    "default",
    syrnike::desktop_native::media::AudioOutputDeviceIntent::UserConfiguration
  );
  if (shared_client->isVoiceOutputEpochCurrent(output_epoch_a) ||
      !shared_client->isVoiceOutputEpochCurrent(output_epoch_b)) {
    throw std::runtime_error("replaced output renderer epoch accepted a stale failure");
  }
  shared_client->setVoiceDeafened(false);
  if (!shared_client->isVoiceConnected()) {
    throw std::runtime_error("output/deafen update disconnected shared voice Room");
  }
  shared_client->disconnectVoice();
  if (!shared_client->connectVoice(
        "voice-recovered", 2, "wss://example.invalid", "replacement-token", noop_post)) {
    throw std::runtime_error("replacement voice Room did not connect");
  }
  bool stale_publish_rejected = false;
  try {
    shared_client->publishVideoTrack(
      "voice-op", 7, {}, livekit::TrackPublishOptions{});
  } catch (const std::exception&) {
    stale_publish_rejected = true;
  }
  if (!stale_publish_rejected) {
    throw std::runtime_error("old track publication published into a replacement voice Room");
  }
  shared_client->disconnectVoice();
  for (int attempt = 0; attempt < 32; ++attempt) shared_client->disconnectVoice();
  if (shared_client->isVoiceConnected()) {
    throw std::runtime_error("explicit voice disconnect left shared Room connected");
  }

  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
