#include <atomic>
#include <chrono>
#include <condition_variable>
#include <future>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

#include <livekit/livekit.h>

#include "common/cleanup_supervisor.hpp"
#include "common/event_sink.hpp"
#include "media/livekit_voice_session.hpp"
#include "media/media_runtime.hpp"
#include "media/media_runtime_support.hpp"

namespace {

using namespace std::chrono_literals;
using syrnike::desktop_native::media::LiveKitVoiceSession;
using syrnike::desktop_native::media::SessionPortCall;
using syrnike::desktop_native::media::SessionPortErrorCode;
using syrnike::desktop_native::media::SessionPortStage;
using syrnike::desktop_native::media::sessionPortStageName;
using syrnike::desktop_native::media::SessionEpoch;
using syrnike::desktop_native::media::requireSessionPortSuccess;
using syrnike::desktop_native::media::requireSessionPortValue;

std::atomic_uint64_t next_voice_owner_token{1};

std::uint64_t nextVoiceOwnerToken() {
  return next_voice_owner_token.fetch_add(1, std::memory_order_relaxed);
}

bool connectVoice(
  const std::shared_ptr<LiveKitVoiceSession>& session,
  std::string session_id,
  std::uint64_t generation,
  const std::string& url,
  const std::string& token,
  LiveKitVoiceSession::InternalPost post
) {
  return requireSessionPortValue(session->lifecycle().connect(
    SessionPortCall::forOwner(
      std::move(session_id), generation, nextVoiceOwnerToken()
    ),
    url,
    token,
    std::move(post)
  ));
}

bool connectVoiceAllowCancellation(
  const std::shared_ptr<LiveKitVoiceSession>& session,
  std::string session_id,
  std::uint64_t generation,
  const std::string& url,
  const std::string& token,
  LiveKitVoiceSession::InternalPost post,
  std::uint64_t owner_token = 0
) {
  if (owner_token == 0) owner_token = nextVoiceOwnerToken();
  const auto result = session->lifecycle().connect(
    SessionPortCall::forOwner(
      std::move(session_id), generation, owner_token
    ),
    url,
    token,
    std::move(post)
  );
  if (!result.hasError()) return result.value().value;
  if (result.error().code ==
        syrnike::desktop_native::media::SessionPortErrorCode::Cancelled ||
      result.error().code ==
        syrnike::desktop_native::media::SessionPortErrorCode::StaleOwner) {
    return false;
  }
  throw std::runtime_error(
    syrnike::desktop_native::media::describeSessionPortError(result.error())
  );
}

bool voiceConnected(const std::shared_ptr<LiveKitVoiceSession>& session) {
  return requireSessionPortValue(
    session->lifecycle().status(SessionPortCall::current())
  );
}

SessionPortCall bindOwnerCall(
  const std::shared_ptr<LiveKitVoiceSession>& session,
  std::string session_id,
  std::uint64_t generation,
  std::chrono::milliseconds budget = std::chrono::seconds(10)
) {
  return requireSessionPortValue(
    session->bindCurrentOwner(std::move(session_id), generation, budget)
  );
}

void disconnectVoice(
  const std::shared_ptr<LiveKitVoiceSession>& session,
  SessionEpoch owner
) {
  requireSessionPortSuccess(
    session->lifecycle().disconnect(SessionPortCall::forOwner(std::move(owner)))
  );
}

void disconnectVoice(const std::shared_ptr<LiveKitVoiceSession>& session) {
  const auto status = session->lifecycle().status(SessionPortCall::current());
  if (status.hasError()) {
    throw std::runtime_error(
      syrnike::desktop_native::media::describeSessionPortError(status.error())
    );
  }
  if (!status.value().value) return;
  disconnectVoice(session, status.value().epoch);
}

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
  bool ignore_connect_cancellation = false;
  bool connect_cancellation_seen = false;
  bool connect_result = true;
  bool connect_active = false;
  std::atomic_bool force_disconnected{false};
  std::atomic_bool block_next_connected_probe{false};
  bool connected_probe_entered = false;
  bool release_connected_probe = false;
  bool disconnect_entered = false;
  std::size_t disconnect_count = 0;
  std::size_t owner_destroyed_count = 0;
  bool lifecycle_overlap = false;
  bool block_publish = false;
  bool publish_entered = false;
  bool release_publish = false;
  bool publish_active = false;
  bool block_unpublish = false;
  bool unpublish_entered = false;
  bool release_unpublish = false;
  bool unpublish_active = false;
  bool block_output = false;
  bool output_entered = false;
  bool release_output = false;
  bool block_demand = false;
  bool demand_entered = false;
  bool release_demand = false;
  bool block_preview = false;
  bool preview_entered = false;
  bool release_preview = false;
  bool connect_auto_subscribe = true;
  std::size_t remote_reconcile_all_count = 0;
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
    if (state_->block_next_retire.exchange(false)) {
      std::unique_lock lock(state_->mutex);
      state_->retire_entered = true;
      state_->changed.notify_all();
      state_->changed.wait(lock, [&] { return state_->release_retire; });
    }
    {
      std::lock_guard lock(state_->mutex);
      ++state_->owner_destroyed_count;
    }
    state_->changed.notify_all();
  }

  bool connect(
    const std::string&,
    const std::string&,
    const livekit::RoomOptions& options
  ) override {
    return connectCancellable({}, {}, options, {});
  }

  bool connectCancellable(
    const std::string&,
    const std::string&,
    const livekit::RoomOptions& options,
    const livekit::OperationCancellation& cancellation
  ) override {
    [[maybe_unused]] const auto cancellation_subscription =
      cancellation.subscribe([state = state_] {
        {
          std::lock_guard lock(state->mutex);
          state->connect_cancellation_seen = true;
        }
        state->changed.notify_all();
      });
    bool cancelled = false;
    bool result = false;
    {
      std::unique_lock lock(state_->mutex);
      state_->connect_entered = true;
      state_->connect_active = true;
      state_->connect_auto_subscribe = options.auto_subscribe;
      state_->changed.notify_all();
      if (state_->block_connect) {
        state_->changed.wait(lock, [&] {
          return state_->release_connect ||
            (!state_->ignore_connect_cancellation &&
             cancellation.isCancellationRequested());
        });
      }
      cancelled = cancellation.isCancellationRequested() &&
        !state_->ignore_connect_cancellation;
      result = state_->connect_result;
      state_->connect_active = false;
    }
    state_->changed.notify_all();
    connected_.store(!cancelled && result);
    return !cancelled && result;
  }
  bool isConnected() const override {
    if (state_->block_next_connected_probe.exchange(false)) {
      std::unique_lock lock(state_->mutex);
      state_->connected_probe_entered = true;
      state_->changed.notify_all();
      state_->changed.wait(lock, [&] {
        return state_->release_connected_probe;
      });
    }
    return connected_.load() && !state_->force_disconnected.load();
  }
  bool waitConnected(std::chrono::milliseconds) override {
    return isConnected();
  }
  void markIntentionalDisconnect() override {}
  void stopAudio() override {}
  void disconnect() override {
    std::lock_guard lock(state_->mutex);
    state_->disconnect_entered = true;
    ++state_->disconnect_count;
    state_->lifecycle_overlap =
      state_->lifecycle_overlap || state_->connect_active ||
      state_->publish_active || state_->unpublish_active;
    connected_.store(false);
    state_->changed.notify_all();
  }
  void setDeafened(bool) override {}
  std::uint64_t setOutputDevice(std::string) override {
    std::unique_lock lock(state_->mutex);
    state_->output_entered = true;
    state_->changed.notify_all();
    if (state_->block_output) {
      state_->changed.wait(lock, [&] { return state_->release_output; });
    }
    return 1;
  }
  std::string outputDeviceId() const override { return "default"; }
  void setOutputVolume(float) override {}
  void configureRemoteAudio(
    syrnike::desktop_native::media::RemoteAudioSettings
  ) override {}
  void releaseRemoteVideoFrame(std::string, std::uint64_t) override {}
  void reconcileRemotePublication(std::string, std::uint64_t) override {
    blockDemand();
  }
  void reconcileRegisteredRemotePublications() override {
    std::lock_guard lock(state_->mutex);
    ++state_->remote_reconcile_all_count;
  }
  void setRemoteVideoDemand(std::string, bool) override { blockDemand(); }
  void retryRemoteVideo(
    std::string,
    std::string
  ) override { blockDemand(); }
  void startLocalCameraPreview(
    std::string,
    std::uint64_t,
    std::string,
    std::string,
    const std::shared_ptr<livekit::LocalVideoTrack>&
  ) override {
    std::unique_lock lock(state_->mutex);
    state_->preview_entered = true;
    state_->changed.notify_all();
    if (state_->block_preview) {
      state_->changed.wait(lock, [&] { return state_->release_preview; });
    }
  }
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
  syrnike::desktop_native::media::LiveKitVoiceRoomOperationResult<std::string>
  publishAudioTrackUntil(
    const std::shared_ptr<livekit::LocalAudioTrack>&,
    const livekit::TrackPublishOptions&,
    std::chrono::steady_clock::time_point deadline,
    const livekit::OperationCancellation& cancellation
  ) override {
    return publishUntil("fake-audio", deadline, cancellation);
  }
  syrnike::desktop_native::media::LiveKitVoiceRoomOperationResult<std::string>
  publishVideoTrackUntil(
    const std::shared_ptr<livekit::LocalVideoTrack>&,
    const livekit::TrackPublishOptions&,
    std::chrono::steady_clock::time_point deadline,
    const livekit::OperationCancellation& cancellation
  ) override {
    return publishUntil("fake-video", deadline, cancellation);
  }
  syrnike::desktop_native::media::LiveKitVoiceRoomOperationResult<void>
  unpublishTrackUntil(
    const std::string&,
    std::chrono::steady_clock::time_point deadline,
    const livekit::OperationCancellation& cancellation
  ) override {
    [[maybe_unused]] const auto cancellation_subscription =
      cancellation.subscribe([state = state_] { state->changed.notify_all(); });
    std::unique_lock lock(state_->mutex);
    state_->unpublish_entered = true;
    state_->unpublish_active = true;
    state_->changed.notify_all();
    if (state_->block_unpublish) {
      state_->changed.wait_until(lock, deadline, [&] {
        return state_->release_unpublish ||
          cancellation.isCancellationRequested();
      });
    }
    state_->unpublish_active = false;
    state_->changed.notify_all();
    if (cancellation.isCancellationRequested()) {
      return syrnike::desktop_native::media::LiveKitVoiceRoomOperationResult<
        void
      >::failure({
        syrnike::desktop_native::media::LiveKitVoiceRoomOperationErrorCode::Cancelled,
        "fake unpublication cancelled"
      });
    }
    if (std::chrono::steady_clock::now() >= deadline) {
      return syrnike::desktop_native::media::LiveKitVoiceRoomOperationResult<
        void
      >::failure({
        syrnike::desktop_native::media::LiveKitVoiceRoomOperationErrorCode::Timeout,
        "fake unpublication timed out"
      });
    }
    return syrnike::desktop_native::media::LiveKitVoiceRoomOperationResult<
      void
    >::success();
  }

 private:
  std::shared_ptr<BlockingRetireState> state_;
  void blockDemand() {
    std::unique_lock lock(state_->mutex);
    state_->demand_entered = true;
    state_->changed.notify_all();
    if (state_->block_demand) {
      state_->changed.wait(lock, [&] { return state_->release_demand; });
    }
  }

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

  syrnike::desktop_native::media::LiveKitVoiceRoomOperationResult<std::string>
  publishUntil(
    std::string result,
    std::chrono::steady_clock::time_point deadline,
    const livekit::OperationCancellation& cancellation
  ) {
    [[maybe_unused]] const auto cancellation_subscription =
      cancellation.subscribe([state = state_] { state->changed.notify_all(); });
    std::unique_lock lock(state_->mutex);
    state_->publish_entered = true;
    state_->publish_active = true;
    state_->changed.notify_all();
    if (state_->block_publish) {
      state_->changed.wait_until(lock, deadline, [&] {
        return state_->release_publish || cancellation.isCancellationRequested();
      });
    }
    state_->publish_active = false;
    state_->changed.notify_all();
    if (cancellation.isCancellationRequested()) {
      return syrnike::desktop_native::media::LiveKitVoiceRoomOperationResult<
        std::string
      >::failure({
        syrnike::desktop_native::media::LiveKitVoiceRoomOperationErrorCode::Cancelled,
        "fake publication cancelled"
      });
    }
    if (std::chrono::steady_clock::now() >= deadline) {
      return syrnike::desktop_native::media::LiveKitVoiceRoomOperationResult<
        std::string
      >::failure({
        syrnike::desktop_native::media::LiveKitVoiceRoomOperationErrorCode::Timeout,
        "fake publication timed out"
      });
    }
    return syrnike::desktop_native::media::LiveKitVoiceRoomOperationResult<
      std::string
    >::success(std::move(result));
  }

  std::atomic_bool connected_{false};
};

}  // namespace

void runLiveKitVoiceSessionTests() {
  using syrnike::desktop_native::media::DeterministicFakeLiveKitVoiceSession;
  using syrnike::desktop_native::media::LiveKitVoiceSession;

  {
    std::vector<syrnike::desktop_native::MediaCommand> terminals;
    syrnike::desktop_native::media::VoiceTerminalPostGate precommit_terminal(
      syrnike::desktop_native::NativeCommandType::VoiceTerminal,
      "voice-precommit", 17,
      [&](syrnike::desktop_native::MediaCommand command) {
        terminals.push_back(std::move(command));
        return true;
      }
    );
    // Models onDisconnected firing after waitConnected but before the actor's
    // commitConnectAttempt owner swap.
    precommit_terminal.post("disconnected before owner commit");
    if (!terminals.empty()) {
      throw std::runtime_error("voice terminal escaped before owner commit");
    }
    precommit_terminal.publish();
    precommit_terminal.post("duplicate disconnect callback");
    if (terminals.size() != 1 ||
        terminals.front().session_id != "voice-precommit" ||
        terminals.front().generation != 17) {
      throw std::runtime_error(
        "voice terminal was not released exactly once after owner commit"
      );
    }

    syrnike::desktop_native::media::VoiceTerminalPostGate cancelled_terminal(
      syrnike::desktop_native::NativeCommandType::VoiceTerminal,
      "voice-cancelled", 18,
      [&](syrnike::desktop_native::MediaCommand command) {
        terminals.push_back(std::move(command));
        return true;
      }
    );
    cancelled_terminal.post("cancelled candidate disconnected");
    cancelled_terminal.cancel();
    cancelled_terminal.publish();
    if (terminals.size() != 1) {
      throw std::runtime_error(
        "cancelled voice candidate released its buffered terminal"
      );
    }
  }

  {
    livekit::OperationCancellation cancellation;
    std::atomic_size_t expired_callbacks{0};
    for (std::size_t iteration = 0; iteration < 10000; ++iteration) {
      [[maybe_unused]] auto expired =
        cancellation.subscribe([&expired_callbacks] { ++expired_callbacks; });
    }
    std::atomic_size_t active_callbacks{0};
    [[maybe_unused]] auto active =
      cancellation.subscribe([&active_callbacks] { ++active_callbacks; });
    if (!cancellation.requestCancel() ||
        cancellation.requestCancel() ||
        expired_callbacks.load() != 0 || active_callbacks.load() != 1) {
      throw std::runtime_error(
        "operation cancellation retained an expired callback or fired twice"
      );
    }
  }

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
    static_cast<void>(connectVoice(real_path_client,
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
  if (!connectVoice(real_path_client,
        "real-path",
        1,
        "wss://example.invalid",
        "token-a",
        noop_post
      )) {
    throw std::runtime_error("real client seam did not establish its first owner");
  }
  {
    std::lock_guard lock(retire_state->mutex);
    if (retire_state->connect_auto_subscribe) {
      throw std::runtime_error(
        "real voice session overrode the explicit-subscription connect policy"
      );
    }
    if (retire_state->remote_reconcile_all_count != 1) {
      throw std::runtime_error(
        "connected voice owner did not replay its initial remote publications"
      );
    }
  }
  const auto real_path_owner = bindOwnerCall(real_path_client, "real-path", 1);
  auto replacing_owner = std::async(std::launch::async, [&] {
    return connectVoice(real_path_client,
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
  static_cast<void>(voiceConnected(real_path_client));
  const auto stale_release =
    real_path_client->remoteFrameRelease().releaseRemoteFrame(
      real_path_owner, "track", 1
  );
  if (!stale_release.hasError() ||
      stale_release.error().code != SessionPortErrorCode::StaleOwner) {
    throw std::runtime_error("retired Room owner accepted a late frame release");
  }
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
    if (!connectVoice(real_path_client,
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
  disconnectVoice(real_path_client);
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
  const auto serialized_owner_token = nextVoiceOwnerToken();
  auto serialized_connect = std::async(std::launch::async, [&] {
    return connectVoiceAllowCancellation(serialized_client,
      "serialized", 1, "wss://example.invalid", "token", noop_post,
      serialized_owner_token);
  });
  {
    std::unique_lock lock(serialized_state->mutex);
    if (!serialized_state->changed.wait_for(
          lock, 1s, [&] { return serialized_state->connect_entered; })) {
      throw std::runtime_error("serialized connect did not enter owner");
    }
  }
  auto serialized_disconnect = std::async(std::launch::async, [&] {
    disconnectVoice(
      serialized_client, SessionEpoch{"serialized", 1, serialized_owner_token}
    );
    return true;
  });
  if (serialized_disconnect.wait_for(250ms) != std::future_status::ready) {
    {
      std::lock_guard lock(serialized_state->mutex);
      serialized_state->release_connect = true;
    }
    serialized_state->changed.notify_all();
    serialized_connect.wait();
    serialized_disconnect.wait();
    serialized_runtime.requestShutdown();
    serialized_runtime.shutdownAndWait();
    throw std::runtime_error(
      "disconnect was not executable while Room::connect was pending"
    );
  }
  requireReady(
    serialized_connect,
    "disconnect did not cancel the pending Room::connect"
  );
  const auto serialized_connect_result = serialized_connect.get();
  const auto serialized_disconnect_result = serialized_disconnect.get();
  if (serialized_connect_result || !serialized_disconnect_result) {
    throw std::runtime_error("cancelled voice connection returned success");
  }
  {
    std::lock_guard lock(serialized_state->mutex);
    if (!serialized_state->connect_cancellation_seen ||
        serialized_state->disconnect_count != 1 ||
        serialized_state->owner_destroyed_count != 1) {
      throw std::runtime_error(
        "cancelled candidate owner was not reclaimed exactly once");
    }
  }
  for (int repeated_cancel = 0; repeated_cancel < 8; ++repeated_cancel) {
    disconnectVoice(serialized_client);
  }
  {
    std::lock_guard lock(serialized_state->mutex);
    if (serialized_state->disconnect_count != 1) {
      throw std::runtime_error("repeated disconnect retired a candidate twice");
    }
  }

  const auto verify_supersession = [&](bool late_connect_result) {
    auto lifetime =
      std::make_shared<syrnike::desktop_native::media::LiveKitRuntimeLifetime>();
    auto first_state = std::make_shared<BlockingRetireState>();
    first_state->block_next_retire.store(false);
    first_state->block_connect = true;
    first_state->ignore_connect_cancellation = true;
    first_state->connect_result = late_connect_result;
    auto second_state = std::make_shared<BlockingRetireState>();
    second_state->block_next_retire.store(false);
    std::atomic_size_t owner_sequence{0};
    auto supersession_client =
      syrnike::desktop_native::media::createRealLiveKitVoiceSession(
        lifetime,
        [&, first_state, second_state](auto, auto, auto, auto, auto) {
          const auto sequence = owner_sequence.fetch_add(1);
          if (sequence == 0) {
            return std::make_shared<FakeVoiceRoomOwner>(first_state);
          }
          if (sequence == 1) {
            return std::make_shared<FakeVoiceRoomOwner>(second_state);
          }
          throw std::runtime_error("supersession created an unexpected owner");
        }
      );
    syrnike::desktop_native::media::MediaRuntime supersession_runtime(
      std::make_shared<NoopSink>(),
      supersession_client,
      {},
      {},
      {},
      lifetime
    );
    supersession_runtime.waitUntilReady();

    auto first_connect = std::async(std::launch::async, [&] {
      return connectVoiceAllowCancellation(supersession_client,
        "superseded", 1, "wss://example.invalid", "token-a", noop_post);
    });
    {
      std::unique_lock lock(first_state->mutex);
      if (!first_state->changed.wait_for(
            lock, 1s, [&] { return first_state->connect_entered; })) {
        throw std::runtime_error("connect A did not enter its candidate owner");
      }
    }
    auto second_connect = std::async(std::launch::async, [&] {
      return connectVoice(supersession_client,
        "superseded", 2, "wss://example.invalid", "token-b", noop_post);
    });
    requireReady(second_connect, "connect B waited behind superseded connect A");
    if (!second_connect.get()) {
      throw std::runtime_error("connect B failed while superseding connect A");
    }
    requireNotReady(
      first_connect,
      "non-cooperative connect A completed before its late callback"
    );

    const auto control_started = std::chrono::steady_clock::now();
    if (requireSessionPortValue(supersession_client->output().setDevice(
          bindOwnerCall(supersession_client, "superseded", 2), "default")) != 1 ||
        std::chrono::steady_clock::now() - control_started >= 50ms) {
      throw std::runtime_error(
        "pending connect A blocked unrelated committed-Room media control"
      );
    }
    {
      std::lock_guard lock(first_state->mutex);
      if (!first_state->connect_cancellation_seen) {
        throw std::runtime_error("connect B did not cancel connect A");
      }
      first_state->release_connect = true;
    }
    first_state->changed.notify_all();
    requireReady(first_connect, "late connect A did not finish after release");
    if (first_connect.get()) {
      throw std::runtime_error("late connect A crossed the generation commit seam");
    }
    if (!voiceConnected(supersession_client)) {
      throw std::runtime_error("late connect A displaced committed connect B");
    }
    {
      std::lock_guard first_lock(first_state->mutex);
      std::lock_guard second_lock(second_state->mutex);
      if (first_state->disconnect_count != 1 ||
          first_state->owner_destroyed_count != 1 ||
          first_state->remote_reconcile_all_count != 0 ||
          second_state->disconnect_count != 0 ||
          second_state->remote_reconcile_all_count != 1) {
        throw std::runtime_error(
          "late candidate or committed owner crossed its exact cleanup boundary"
        );
      }
    }

    disconnectVoice(supersession_client);
    for (int repeated_cancel = 0; repeated_cancel < 4; ++repeated_cancel) {
      disconnectVoice(supersession_client);
    }
    {
      std::lock_guard lock(second_state->mutex);
      if (second_state->disconnect_count != 1 ||
          second_state->owner_destroyed_count != 1) {
        throw std::runtime_error("connect B owner was not retired exactly once");
      }
    }
    supersession_runtime.requestShutdown();
    supersession_runtime.shutdownAndWait();
  };
  verify_supersession(true);
  verify_supersession(false);

  {
    auto lifetime =
      std::make_shared<syrnike::desktop_native::media::LiveKitRuntimeLifetime>();
    auto owner_a_state = std::make_shared<BlockingRetireState>();
    owner_a_state->block_next_retire.store(false);
    auto owner_b_state = std::make_shared<BlockingRetireState>();
    owner_b_state->block_next_retire.store(false);
    std::atomic_size_t owner_sequence{0};
    auto session = syrnike::desktop_native::media::createRealLiveKitVoiceSession(
      lifetime,
      [&, owner_a_state, owner_b_state](auto, auto, auto, auto, auto) {
        return std::make_shared<FakeVoiceRoomOwner>(
          owner_sequence.fetch_add(1) == 0 ? owner_a_state : owner_b_state
        );
      }
    );
    syrnike::desktop_native::media::MediaRuntime runtime(
      std::make_shared<NoopSink>(), session, {}, {}, {}, lifetime
    );
    runtime.waitUntilReady();

    const SessionEpoch owner_a{"same-session", 1, 0xA1};
    const SessionEpoch owner_b{"same-session", 2, 0xA2};
    const auto connected_a = session->lifecycle().connect(
      SessionPortCall::forOwner(owner_a),
      "wss://example.invalid",
      "token-a",
      noop_post
    );
    if (connected_a.hasError() || !connected_a.value().value ||
        connected_a.value().epoch.owner_token != owner_a.owner_token) {
      throw std::runtime_error("Room owner A did not retain its exact token");
    }
    const auto connected_b = session->lifecycle().connect(
      SessionPortCall::forOwner(owner_b),
      "wss://example.invalid",
      "token-b",
      noop_post
    );
    if (connected_b.hasError() || !connected_b.value().value ||
        connected_b.value().epoch.owner_token != owner_b.owner_token) {
      throw std::runtime_error("Room owner B did not replace owner A exactly");
    }
    const SessionEpoch owner_b_transfer{"same-session", 2, 0xA3};
    const auto transferred_b = session->lifecycle().connect(
      SessionPortCall::forOwner(owner_b_transfer),
      "wss://example.invalid",
      "token-b",
      noop_post
    );
    if (transferred_b.hasError() || !transferred_b.value().value ||
        transferred_b.value().epoch.owner_token !=
          owner_b_transfer.owner_token || owner_sequence.load() != 2) {
      throw std::runtime_error(
        "same-generation reconnect did not transfer the exact Room owner"
      );
    }

    const auto stale_disconnect = session->lifecycle().disconnect(
      SessionPortCall::forOwner(owner_a)
    );
    if (!stale_disconnect.hasError() ||
        stale_disconnect.error().code !=
          syrnike::desktop_native::media::SessionPortErrorCode::StaleOwner) {
      throw std::runtime_error(
        "stale same-session disconnect did not hit the exact owner fence"
      );
    }
    const auto current = session->lifecycle().status(SessionPortCall::current());
    if (current.hasError() || !current.value().value ||
        current.value().epoch.owner_token != owner_b_transfer.owner_token) {
      throw std::runtime_error(
        "stale owner A disconnect cleared replacement Room owner B"
      );
    }
    const auto superseded_b_disconnect = session->lifecycle().disconnect(
      SessionPortCall::forOwner(owner_b)
    );
    if (!superseded_b_disconnect.hasError() ||
        superseded_b_disconnect.error().code !=
          syrnike::desktop_native::media::SessionPortErrorCode::StaleOwner) {
      throw std::runtime_error(
        "transferred Room accepted its superseded same-generation owner"
      );
    }
    requireSessionPortSuccess(
      session->lifecycle().disconnect(
        SessionPortCall::forOwner(owner_b_transfer)
      )
    );
    {
      std::lock_guard owner_a_lock(owner_a_state->mutex);
      std::lock_guard owner_b_lock(owner_b_state->mutex);
      if (owner_a_state->disconnect_count != 1 ||
          owner_a_state->owner_destroyed_count != 1 ||
          owner_b_state->disconnect_count != 1 ||
          owner_b_state->owner_destroyed_count != 1) {
        throw std::runtime_error(
          "same-session replacement did not clean both Room owners exactly once"
        );
      }
    }
    runtime.requestShutdown();
    runtime.shutdownAndWait();
  }

  {
    auto lifetime =
      std::make_shared<syrnike::desktop_native::media::LiveKitRuntimeLifetime>();
    auto state = std::make_shared<BlockingRetireState>();
    state->block_next_retire.store(false);
    auto session = syrnike::desktop_native::media::createRealLiveKitVoiceSession(
      lifetime,
      [state](auto, auto, auto, auto, auto) {
        return std::make_shared<FakeVoiceRoomOwner>(state);
      }
    );
    syrnike::desktop_native::media::MediaRuntime runtime(
      std::make_shared<NoopSink>(), session, {}, {}, {}, lifetime
    );
    runtime.waitUntilReady();

    auto connected = session->lifecycle().connect(
      SessionPortCall::forOwner(SessionEpoch{"owner-operation-gate", 1, 0xE1}),
      "wss://example.invalid", "token", noop_post
    );
    if (connected.hasError() || !connected.value().value) {
      throw std::runtime_error("owner-operation gate fixture did not connect");
    }
    auto current_owner = connected.value().epoch;
    std::uint64_t next_owner_token = 0xE2;

    const auto verify_transfer_waits_for_operation = [&]<typename Configure,
        typename Entered, typename ReleaseOperation, typename Operation>(
        Configure configure,
        Entered entered,
        ReleaseOperation release_operation,
        Operation operation,
        SessionPortStage stage) {
      configure();
      const auto old_owner = current_owner;
      auto operation_future = std::async(std::launch::async, [&] {
        return operation(SessionPortCall::forOwner(old_owner));
      });
      {
        std::unique_lock lock(state->mutex);
        if (!state->changed.wait_for(lock, 1s, entered)) {
          throw std::runtime_error(
            std::string(sessionPortStageName(stage)) +
            " did not enter its deterministic owner-operation barrier"
          );
        }
      }
      const SessionEpoch replacement{
        old_owner.session_id, old_owner.generation, next_owner_token++
      };
      auto transfer_future = std::async(std::launch::async, [&] {
        return session->lifecycle().connect(
          SessionPortCall::forOwner(replacement),
          "wss://example.invalid", "token", noop_post
        );
      });
      if (transfer_future.wait_for(25ms) != std::future_status::timeout) {
        throw std::runtime_error(
          std::string(sessionPortStageName(stage)) +
          " allowed ownership transfer through an in-flight old mutation"
        );
      }
      release_operation();
      const auto completed = operation_future.get();
      if (completed.hasError()) {
        throw std::runtime_error(
          std::string(sessionPortStageName(stage)) +
          " did not drain before ownership transfer"
        );
      }
      const auto transferred = transfer_future.get();
      if (transferred.hasError() || !transferred.value().value ||
          transferred.value().epoch.owner_token != replacement.owner_token ||
          transferred.value().epoch.room_instance_token !=
            old_owner.room_instance_token) {
        throw std::runtime_error(
          std::string(sessionPortStageName(stage)) +
          " transfer lost the physical Room cleanup capability"
        );
      }
      current_owner = transferred.value().epoch;
      const auto stale = operation(SessionPortCall::forOwner(old_owner));
      if (!stale.hasError() ||
          stale.error().code != SessionPortErrorCode::StaleOwner) {
        throw std::runtime_error(
          std::string(sessionPortStageName(stage)) +
          " accepted an old mutation after ownership transfer"
        );
      }
    };

    verify_transfer_waits_for_operation(
      [&] {
        std::lock_guard lock(state->mutex);
        state->block_output = true;
        state->output_entered = false;
        state->release_output = false;
      },
      [&] { return state->output_entered; },
      [&] {
        std::lock_guard lock(state->mutex);
        state->release_output = true;
        state->block_output = false;
        state->changed.notify_all();
      },
      [&](SessionPortCall call) {
        return session->output().setDevice(std::move(call), "default");
      },
      SessionPortStage::OutputDevice
    );
    verify_transfer_waits_for_operation(
      [&] {
        std::lock_guard lock(state->mutex);
        state->block_demand = true;
        state->demand_entered = false;
        state->release_demand = false;
      },
      [&] { return state->demand_entered; },
      [&] {
        std::lock_guard lock(state->mutex);
        state->release_demand = true;
        state->block_demand = false;
        state->changed.notify_all();
      },
      [&](SessionPortCall call) {
        return session->remoteDemand().set(std::move(call), "remote", true);
      },
      SessionPortStage::DemandSet
    );
    verify_transfer_waits_for_operation(
      [&] {
        std::lock_guard lock(state->mutex);
        state->block_preview = true;
        state->preview_entered = false;
        state->release_preview = false;
      },
      [&] { return state->preview_entered; },
      [&] {
        std::lock_guard lock(state->mutex);
        state->release_preview = true;
        state->block_preview = false;
        state->changed.notify_all();
      },
      [&](SessionPortCall call) {
        return session->cameraPreview().start(
          std::move(call), "camera", "participant", {}
        );
      },
      SessionPortStage::CameraPreviewStart
    );
    verify_transfer_waits_for_operation(
      [&] {
        std::lock_guard lock(state->mutex);
        state->block_publish = true;
        state->publish_entered = false;
        state->release_publish = false;
      },
      [&] { return state->publish_entered; },
      [&] {
        std::lock_guard lock(state->mutex);
        state->release_publish = true;
        state->block_publish = false;
        state->changed.notify_all();
      },
      [&](SessionPortCall call) {
        return session->publication().publishAudioTrack(
          std::move(call), {}, livekit::TrackPublishOptions{}
        );
      },
      SessionPortStage::PublicationPublishAudio
    );

    requireSessionPortSuccess(session->lifecycle().disconnect(
      SessionPortCall::forOwner(current_owner)
    ));
    runtime.requestShutdown();
    runtime.shutdownAndWait();
  }

  {
    auto lifetime =
      std::make_shared<syrnike::desktop_native::media::LiveKitRuntimeLifetime>();
    auto state = std::make_shared<BlockingRetireState>();
    state->block_next_retire.store(false);
    auto session = syrnike::desktop_native::media::createRealLiveKitVoiceSession(
      lifetime,
      [state](auto, auto, auto, auto, auto) {
        return std::make_shared<FakeVoiceRoomOwner>(state);
      }
    );
    syrnike::desktop_native::media::MediaRuntime runtime(
      std::make_shared<NoopSink>(), session, {}, {}, {}, lifetime
    );
    runtime.waitUntilReady();

    const SessionEpoch old_owner{"same-session-ports", 1, 0xD1};
    const SessionEpoch replacement_owner{"same-session-ports", 1, 0xD2};
    const auto old_connection = session->lifecycle().connect(
      SessionPortCall::forOwner(old_owner),
      "wss://example.invalid", "token", noop_post
    );
    if (old_connection.hasError() || !old_connection.value().value) {
      throw std::runtime_error("old same-session port owner did not connect");
    }
    const auto retained_cleanup_epoch = old_connection.value().epoch;
    const auto replacement_connection = session->lifecycle().connect(
      SessionPortCall::forOwner(replacement_owner),
      "wss://example.invalid", "token", noop_post
    );
    if (replacement_connection.hasError() ||
        !replacement_connection.value().value) {
      throw std::runtime_error("same-session port owners did not connect");
    }
    const auto current_owner = replacement_connection.value().epoch;
    if (retained_cleanup_epoch.room_instance_token == 0 ||
        retained_cleanup_epoch.room_instance_token !=
          current_owner.room_instance_token ||
        retained_cleanup_epoch.owner_token == current_owner.owner_token) {
      throw std::runtime_error(
        "same-Room ownership transfer changed its cleanup capability"
      );
    }

    const auto stale_call = SessionPortCall::forOwner(retained_cleanup_epoch);
    const auto fresh_call = SessionPortCall::forOwner(SessionEpoch{
      current_owner.session_id,
      99,
      current_owner.owner_token,
      current_owner.room_instance_token,
    });
    const auto require_owner_fence = [](
        const auto& stale,
        const auto& fresh,
        SessionPortStage stage) {
      if (!stale.hasError() ||
          stale.error().code != SessionPortErrorCode::StaleOwner ||
          stale.error().stage != stage) {
        throw std::runtime_error(
          std::string(sessionPortStageName(stage)) +
          " accepted a stale same-session Room owner"
        );
      }
      if (fresh.hasError() || fresh.value().epoch.owner_token == 0xD1 ||
          fresh.value().epoch.owner_token != 0xD2) {
        throw std::runtime_error(
          std::string(sessionPortStageName(stage)) +
          " rejected the freshly rebound Room owner"
        );
      }
    };

    require_owner_fence(
      session->lifecycle().status(stale_call),
      session->lifecycle().status(fresh_call),
      SessionPortStage::LifecycleStatus
    );
    require_owner_fence(
      session->lifecycle().require(stale_call),
      session->lifecycle().require(fresh_call),
      SessionPortStage::LifecycleStatus
    );
    require_owner_fence(
      session->publication().publishAudioTrack(
        stale_call, {}, livekit::TrackPublishOptions{}
      ),
      session->publication().publishAudioTrack(
        fresh_call, {}, livekit::TrackPublishOptions{}
      ),
      SessionPortStage::PublicationPublishAudio
    );
    require_owner_fence(
      session->publication().publishVideoTrack(
        stale_call, {}, livekit::TrackPublishOptions{}
      ),
      session->publication().publishVideoTrack(
        fresh_call, {}, livekit::TrackPublishOptions{}
      ),
      SessionPortStage::PublicationPublishVideo
    );
    requireSessionPortSuccess(
      session->publication().unpublishTrack(stale_call, "old-publication")
    );
    requireSessionPortSuccess(
      session->publication().unpublishTrack(fresh_call, "publication")
    );
    require_owner_fence(
      session->output().setDeafened(stale_call, true),
      session->output().setDeafened(fresh_call, true),
      SessionPortStage::OutputDeafen
    );
    require_owner_fence(
      session->output().setDevice(stale_call, "default"),
      session->output().setDevice(fresh_call, "default"),
      SessionPortStage::OutputDevice
    );
    require_owner_fence(
      session->output().deviceId(stale_call),
      session->output().deviceId(fresh_call),
      SessionPortStage::OutputDeviceQuery
    );
    require_owner_fence(
      session->output().setVolume(stale_call, 0.5f),
      session->output().setVolume(fresh_call, 0.5f),
      SessionPortStage::OutputVolume
    );
    require_owner_fence(
      session->output().configureRemoteAudio(stale_call, {}),
      session->output().configureRemoteAudio(fresh_call, {}),
      SessionPortStage::OutputConfigureRemoteAudio
    );
    requireSessionPortSuccess(
      session->remoteFrameRelease().releaseRemoteFrame(
        stale_call, "old-remote", 1
      )
    );
    requireSessionPortSuccess(
      session->remoteFrameRelease().releaseRemoteFrame(
        fresh_call, "remote", 1
      )
    );
    require_owner_fence(
      session->cameraPreview().start(stale_call, "camera", "participant", {}),
      session->cameraPreview().start(fresh_call, "camera", "participant", {}),
      SessionPortStage::CameraPreviewStart
    );
    requireSessionPortSuccess(
      session->cameraPreview().stop(stale_call, "old-camera")
    );
    requireSessionPortSuccess(
      session->cameraPreview().stop(fresh_call, "camera")
    );
    requireSessionPortSuccess(
      session->cameraPreview().releasePreviewFrame(
        stale_call, "old-camera", 1
      )
    );
    requireSessionPortSuccess(
      session->cameraPreview().releasePreviewFrame(fresh_call, "camera", 1)
    );
    require_owner_fence(
      session->remoteDemand().set(stale_call, "remote", true),
      session->remoteDemand().set(fresh_call, "remote", true),
      SessionPortStage::DemandSet
    );
    require_owner_fence(
      session->remoteDemand().reconcile(stale_call, "remote", 1),
      session->remoteDemand().reconcile(fresh_call, "remote", 1),
      SessionPortStage::DemandReconcile
    );
    require_owner_fence(
      session->remoteDemand().retry(stale_call, "remote", "test"),
      session->remoteDemand().retry(fresh_call, "remote", "test"),
      SessionPortStage::DemandRetry
    );
    const auto liveness = session->lifecycle().status(SessionPortCall::current());
    if (liveness.hasError() || !liveness.value().value ||
        liveness.value().epoch.owner_token != replacement_owner.owner_token) {
      throw std::runtime_error("owner-independent liveness probe was fenced");
    }
    requireSessionPortSuccess(session->lifecycle().disconnect(
      SessionPortCall::forOwner(current_owner)
    ));
    runtime.requestShutdown();
    runtime.shutdownAndWait();
  }

  {
    auto lifetime =
      std::make_shared<syrnike::desktop_native::media::LiveKitRuntimeLifetime>();
    auto owner_state = std::make_shared<BlockingRetireState>();
    owner_state->block_next_retire.store(false);
    std::atomic_size_t owner_sequence{0};
    auto session = syrnike::desktop_native::media::createRealLiveKitVoiceSession(
      lifetime,
      [&, owner_state](auto, auto, auto, auto, auto) {
        ++owner_sequence;
        return std::make_shared<FakeVoiceRoomOwner>(owner_state);
      }
    );
    syrnike::desktop_native::media::MediaRuntime runtime(
      std::make_shared<NoopSink>(), session, {}, {}, {}, lifetime
    );
    runtime.waitUntilReady();

    const SessionEpoch owner_a{"transfer-cancel", 1, 0xD1};
    const SessionEpoch owner_b{"transfer-cancel", 1, 0xD2};
    const SessionEpoch owner_c{"transfer-cancel", 1, 0xD3};
    if (!requireSessionPortValue(session->lifecycle().connect(
          SessionPortCall::forOwner(owner_a),
          "wss://example.invalid", "token", noop_post))) {
      throw std::runtime_error("transfer-cancel owner A did not connect");
    }
    livekit::OperationCancellation cancel_owner_b;
    auto owner_b_call = SessionPortCall::forOwner(owner_b);
    owner_b_call.cancellation = cancel_owner_b;
    owner_state->block_next_connected_probe.store(true);
    auto connect_b = std::async(std::launch::async, [&, owner_b_call]() mutable {
      return session->lifecycle().connect(
        std::move(owner_b_call),
        "wss://example.invalid", "token", noop_post
      );
    });
    {
      std::unique_lock lock(owner_state->mutex);
      if (!owner_state->changed.wait_for(
            lock, 1s, [&] { return owner_state->connected_probe_entered; })) {
        throw std::runtime_error(
          "cancelled owner B did not enter the reusable Room probe"
        );
      }
    }
    cancel_owner_b.requestCancel();
    const auto connected_c = session->lifecycle().connect(
      SessionPortCall::forOwner(owner_c),
      "wss://example.invalid", "token", noop_post
    );
    if (connected_c.hasError() || !connected_c.value().value ||
        connected_c.value().epoch.owner_token != owner_c.owner_token) {
      throw std::runtime_error(
        "replacement owner C did not transfer the connected Room"
      );
    }
    {
      std::lock_guard lock(owner_state->mutex);
      owner_state->release_connected_probe = true;
    }
    owner_state->changed.notify_all();
    requireReady(connect_b, "cancelled owner B did not leave its Room probe");
    const auto cancelled_b = connect_b.get();
    if (!cancelled_b.hasError() ||
        cancelled_b.error().code !=
          syrnike::desktop_native::media::SessionPortErrorCode::Cancelled) {
      throw std::runtime_error(
        "cancelled owner B stole the same-generation Room from owner C"
      );
    }
    const auto stale_b_cleanup = session->lifecycle().disconnect(
      SessionPortCall::forOwner(owner_b)
    );
    if (!stale_b_cleanup.hasError() ||
        stale_b_cleanup.error().code !=
          syrnike::desktop_native::media::SessionPortErrorCode::StaleOwner) {
      throw std::runtime_error(
        "cancelled owner B cleanup retired replacement owner C"
      );
    }
    const auto current = session->lifecycle().status(SessionPortCall::current());
    if (current.hasError() || !current.value().value ||
        current.value().epoch.owner_token != owner_c.owner_token ||
        owner_sequence.load() != 1) {
      throw std::runtime_error(
        "replacement owner C did not remain current after cancelled B cleanup"
      );
    }
    requireSessionPortSuccess(session->lifecycle().disconnect(
      SessionPortCall::forOwner(owner_c)
    ));
    {
      std::lock_guard lock(owner_state->mutex);
      if (owner_state->disconnect_count != 1 ||
          owner_state->owner_destroyed_count != 1) {
        throw std::runtime_error(
          "transfer-cancel Room owner was not cleaned exactly once"
        );
      }
    }
    runtime.requestShutdown();
    runtime.shutdownAndWait();
  }

  {
    auto lifetime =
      std::make_shared<syrnike::desktop_native::media::LiveKitRuntimeLifetime>();
    auto disconnected_state = std::make_shared<BlockingRetireState>();
    disconnected_state->block_next_retire.store(false);
    auto replacement_state = std::make_shared<BlockingRetireState>();
    replacement_state->block_next_retire.store(false);
    std::atomic_size_t owner_sequence{0};
    auto session = syrnike::desktop_native::media::createRealLiveKitVoiceSession(
      lifetime,
      [&, disconnected_state, replacement_state](auto, auto, auto, auto, auto) {
        return std::make_shared<FakeVoiceRoomOwner>(
          owner_sequence.fetch_add(1) == 0
            ? disconnected_state
            : replacement_state
        );
      }
    );
    syrnike::desktop_native::media::MediaRuntime runtime(
      std::make_shared<NoopSink>(), session, {}, {}, {}, lifetime
    );
    runtime.waitUntilReady();

    const SessionEpoch disconnected_owner{"terminal-retry", 1, 0xC1};
    const SessionEpoch replacement_owner{"terminal-retry", 1, 0xC2};
    if (!requireSessionPortValue(session->lifecycle().connect(
          SessionPortCall::forOwner(disconnected_owner),
          "wss://example.invalid", "token", noop_post))) {
      throw std::runtime_error("terminal-retry owner did not connect");
    }
    disconnected_state->force_disconnected.store(true);
    const auto replacement = session->lifecycle().connect(
      SessionPortCall::forOwner(replacement_owner),
      "wss://example.invalid", "token", noop_post
    );
    if (replacement.hasError() || !replacement.value().value ||
        replacement.value().epoch.owner_token !=
          replacement_owner.owner_token ||
        owner_sequence.load() != 2) {
      throw std::runtime_error(
        "same-generation retry transferred ownership to a disconnected Room"
      );
    }
    const auto current = session->lifecycle().status(SessionPortCall::current());
    if (current.hasError() || !current.value().value ||
        current.value().epoch.owner_token != replacement_owner.owner_token) {
      throw std::runtime_error(
        "same-generation retry did not commit its connected replacement Room"
      );
    }
    requireSessionPortSuccess(session->lifecycle().disconnect(
      SessionPortCall::forOwner(replacement_owner)
    ));
    {
      std::lock_guard disconnected_lock(disconnected_state->mutex);
      std::lock_guard replacement_lock(replacement_state->mutex);
      if (disconnected_state->disconnect_count != 1 ||
          disconnected_state->owner_destroyed_count != 1 ||
          replacement_state->disconnect_count != 1 ||
          replacement_state->owner_destroyed_count != 1) {
        throw std::runtime_error(
          "terminal retry did not clean both Room owners exactly once"
        );
      }
    }
    runtime.requestShutdown();
    runtime.shutdownAndWait();
  }

  {
    auto lifetime =
      std::make_shared<syrnike::desktop_native::media::LiveKitRuntimeLifetime>();
    auto owner_a_state = std::make_shared<BlockingRetireState>();
    owner_a_state->block_next_retire.store(false);
    auto owner_b_state = std::make_shared<BlockingRetireState>();
    owner_b_state->block_next_retire.store(false);
    std::atomic_size_t owner_sequence{0};
    std::mutex factory_mutex;
    std::condition_variable factory_changed;
    bool owner_b_factory_entered = false;
    bool release_owner_b_factory = false;
    auto session = syrnike::desktop_native::media::createRealLiveKitVoiceSession(
      lifetime,
      [&, owner_a_state, owner_b_state](auto, auto, auto, auto, auto) {
        const auto sequence = owner_sequence.fetch_add(1);
        if (sequence == 1) {
          std::unique_lock lock(factory_mutex);
          owner_b_factory_entered = true;
          factory_changed.notify_all();
          factory_changed.wait(lock, [&] { return release_owner_b_factory; });
        }
        return std::make_shared<FakeVoiceRoomOwner>(
          sequence == 0 ? owner_a_state : owner_b_state
        );
      }
    );
    syrnike::desktop_native::media::MediaRuntime runtime(
      std::make_shared<NoopSink>(), session, {}, {}, {}, lifetime
    );
    runtime.waitUntilReady();

    const SessionEpoch owner_a{"factory-window", 1, 0xB1};
    const SessionEpoch owner_b{"factory-window", 2, 0xB2};
    if (!requireSessionPortValue(session->lifecycle().connect(
          SessionPortCall::forOwner(owner_a),
          "wss://example.invalid", "token-a", noop_post))) {
      throw std::runtime_error("factory-window owner A did not connect");
    }
    auto connect_b = std::async(std::launch::async, [&] {
      return session->lifecycle().connect(
        SessionPortCall::forOwner(owner_b),
        "wss://example.invalid", "token-b", noop_post
      );
    });
    {
      std::unique_lock lock(factory_mutex);
      if (!factory_changed.wait_for(
            lock, 1s, [&] { return owner_b_factory_entered; })) {
        throw std::runtime_error(
          "replacement owner B did not enter its Room factory window"
        );
      }
    }
    requireSessionPortSuccess(session->lifecycle().disconnect(
      SessionPortCall::forOwner(owner_a)
    ));
    {
      std::lock_guard lock(factory_mutex);
      release_owner_b_factory = true;
    }
    factory_changed.notify_all();
    requireReady(
      connect_b,
      "replacement owner B did not finish after its factory was released"
    );
    const auto connected_b = connect_b.get();
    if (connected_b.hasError() || !connected_b.value().value ||
        connected_b.value().epoch.owner_token != owner_b.owner_token) {
      throw std::runtime_error(
        "exact cleanup of owner A superseded replacement B in its factory window"
      );
    }
    const auto current = session->lifecycle().status(SessionPortCall::current());
    if (current.hasError() || !current.value().value ||
        current.value().epoch.owner_token != owner_b.owner_token) {
      throw std::runtime_error(
        "replacement B did not own the Room after exact cleanup of A"
      );
    }
    requireSessionPortSuccess(session->lifecycle().disconnect(
      SessionPortCall::forOwner(owner_b)
    ));
    {
      std::lock_guard owner_a_lock(owner_a_state->mutex);
      std::lock_guard owner_b_lock(owner_b_state->mutex);
      if (owner_a_state->disconnect_count != 1 ||
          owner_a_state->owner_destroyed_count != 1 ||
          owner_b_state->disconnect_count != 1 ||
          owner_b_state->owner_destroyed_count != 1) {
        throw std::runtime_error(
          "factory-window replacement did not clean both owners exactly once"
        );
      }
    }
    runtime.requestShutdown();
    runtime.shutdownAndWait();
  }

  {
    auto shutdown_lifetime =
      std::make_shared<syrnike::desktop_native::media::LiveKitRuntimeLifetime>();
    auto shutdown_state = std::make_shared<BlockingRetireState>();
    shutdown_state->block_next_retire.store(false);
    shutdown_state->block_connect = true;
    auto shutdown_client =
      syrnike::desktop_native::media::createRealLiveKitVoiceSession(
        shutdown_lifetime,
        [shutdown_state](auto, auto, auto, auto, auto) {
          return std::make_shared<FakeVoiceRoomOwner>(shutdown_state);
        }
      );
    auto shutdown_runtime =
      std::make_unique<syrnike::desktop_native::media::MediaRuntime>(
        std::make_shared<NoopSink>(),
        shutdown_client,
        syrnike::desktop_native::media::MediaRuntime::SteadyNow{},
        syrnike::desktop_native::media::MediaRuntime::BeforeMicrophoneOperation{},
        syrnike::desktop_native::media::MediaRuntime::BeforeVoiceShutdown{},
        shutdown_lifetime
      );
    shutdown_runtime->waitUntilReady();
    syrnike::desktop_native::MediaCommand shutdown_connect;
    shutdown_connect.type = syrnike::desktop_native::NativeCommandType::ConnectVoice;
    shutdown_connect.request_id = "utility-shutdown-connect";
    shutdown_connect.session_id = "utility-shutdown";
    shutdown_connect.generation = 1;
    shutdown_connect.livekit_url = "wss://example.invalid";
    shutdown_connect.livekit_token = "token";
    if (!shutdown_runtime->dispatch(std::move(shutdown_connect))) {
      throw std::runtime_error("utility runtime rejected pending voice connect");
    }
    {
      std::unique_lock lock(shutdown_state->mutex);
      if (!shutdown_state->changed.wait_for(
            lock, 1s, [&] { return shutdown_state->connect_entered; })) {
        throw std::runtime_error("utility voice connect did not enter owner");
      }
    }
    const auto shutdown_started = std::chrono::steady_clock::now();
    shutdown_runtime->requestShutdown();
    shutdown_runtime->shutdownAndWait();
    if (std::chrono::steady_clock::now() - shutdown_started >=
        syrnike::desktop_native::media::kNativeShutdownBudget) {
      throw std::runtime_error(
        "utility shutdown exceeded the native deadline during voice connect"
      );
    }
    {
      std::unique_lock lock(shutdown_state->mutex);
      if (!shutdown_state->changed.wait_for(lock, 1s, [&] {
            return shutdown_state->owner_destroyed_count == 1;
          })) {
        throw std::runtime_error(
          "utility shutdown did not reclaim its cancelled candidate owner"
        );
      }
      if (!shutdown_state->connect_cancellation_seen ||
          shutdown_state->disconnect_count != 1 ||
          shutdown_state->connect_active) {
        throw std::runtime_error(
          "utility shutdown crossed the candidate cleanup boundary"
        );
      }
    }
    shutdown_runtime.reset();
  }

  serialized_state->block_connect = false;
  serialized_state->disconnect_entered = false;
  if (!connectVoice(serialized_client,
        "serialized-publish", 2, "wss://example.invalid", "token-2",
        noop_post)) {
    throw std::runtime_error("publication lifecycle Room did not connect");
  }
  const auto serialized_owner =
    bindOwnerCall(serialized_client, "serialized-publish", 2);
  serialized_state->block_output = true;
  auto serialized_output = std::async(std::launch::async, [&] {
    return requireSessionPortValue(serialized_client->output().setDevice(
      serialized_owner, "default"
    ));
  });
  {
    std::unique_lock lock(serialized_state->mutex);
    if (!serialized_state->changed.wait_for(
          lock, 1s, [&] { return serialized_state->output_entered; })) {
      throw std::runtime_error("serialized output change did not enter owner");
    }
  }
  auto publish_during_output = std::async(std::launch::async, [&] {
    return requireSessionPortValue(
      serialized_client->publication().publishAudioTrack(
        serialized_owner,
        {},
        livekit::TrackPublishOptions{}
      )
    );
  });
  requireReady(
    publish_during_output,
    "output configuration delayed the independent publication port"
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
    return serialized_client->publication().publishAudioTrack(
      serialized_owner,
      {},
      livekit::TrackPublishOptions{}
    );
  });
  {
    std::unique_lock lock(serialized_state->mutex);
    if (!serialized_state->changed.wait_for(
          lock, 1s, [&] { return serialized_state->publish_entered; })) {
      throw std::runtime_error("serialized publication did not enter owner");
    }
  }
  auto output_during_publish = std::async(std::launch::async, [&] {
    return requireSessionPortValue(serialized_client->output().setDevice(
      serialized_owner, "default"
    ));
  });
  auto remote_release_during_publish = std::async(std::launch::async, [&] {
    requireSessionPortSuccess(
      serialized_client->remoteFrameRelease().releaseRemoteFrame(
        serialized_owner, "remote-video", 41
      )
    );
    return true;
  });
  auto demand_during_publish = std::async(std::launch::async, [&] {
    requireSessionPortSuccess(serialized_client->remoteDemand().set(
      serialized_owner, "remote-video", true
    ));
    return true;
  });
  auto preview_release_during_publish = std::async(std::launch::async, [&] {
    requireSessionPortSuccess(
      serialized_client->cameraPreview().releasePreviewFrame(
        serialized_owner, "camera-preview", 73
      )
    );
    return true;
  });
  auto status_during_publish = std::async(std::launch::async, [&] {
    return voiceConnected(serialized_client);
  });
  const bool independent_ports_ready =
    output_during_publish.wait_for(250ms) == std::future_status::ready &&
    remote_release_during_publish.wait_for(250ms) == std::future_status::ready &&
    demand_during_publish.wait_for(250ms) == std::future_status::ready &&
    preview_release_during_publish.wait_for(250ms) == std::future_status::ready &&
    status_during_publish.wait_for(250ms) == std::future_status::ready;
  auto publish_disconnect = std::async(std::launch::async, [&] {
    disconnectVoice(serialized_client);
    return true;
  });
  requireReady(
    publish_disconnect,
    "disconnect did not cancel and drain the blocked publication"
  );
  {
    std::lock_guard lock(serialized_state->mutex);
    serialized_state->release_publish = true;
  }
  serialized_state->changed.notify_all();
  requireReady(serialized_publish, "serialized publication did not finish");
  requireReady(publish_disconnect, "post-publication disconnect did not finish");
  requireReady(output_during_publish, "output port remained blocked after publication");
  requireReady(remote_release_during_publish, "remote release port remained blocked after publication");
  requireReady(demand_during_publish, "demand port remained blocked after publication");
  requireReady(preview_release_during_publish, "preview release port remained blocked after publication");
  requireReady(status_during_publish, "lifecycle status port remained blocked after publication");
  if (!independent_ports_ready) {
    throw std::runtime_error(
      "blocked publication delayed an independent Native Media Session port"
    );
  }
  const auto cancelled_publication = serialized_publish.get();
  if (!cancelled_publication.hasError() || !publish_disconnect.get() ||
      !status_during_publish.get()) {
    throw std::runtime_error("disconnect did not fence the cancelled publication");
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

  enum class BlockedPublicationKind { Video, Unpublish };
  const auto verify_independent_ports = [&](BlockedPublicationKind kind) {
    auto lifetime =
      std::make_shared<syrnike::desktop_native::media::LiveKitRuntimeLifetime>();
    auto state = std::make_shared<BlockingRetireState>();
    state->block_next_retire.store(false);
    auto session = syrnike::desktop_native::media::createRealLiveKitVoiceSession(
      lifetime,
      [state](auto, auto, auto, auto, auto) {
        return std::make_shared<FakeVoiceRoomOwner>(state);
      }
    );
    syrnike::desktop_native::media::MediaRuntime runtime(
      std::make_shared<NoopSink>(), session, {}, {}, {}, lifetime
    );
    runtime.waitUntilReady();
    if (!connectVoice(
          session, "port-matrix", 1, "wss://example.invalid", "token",
          noop_post)) {
      throw std::runtime_error("port matrix failed to connect its Room owner");
    }
    const auto owner_call = bindOwnerCall(session, "port-matrix", 1);
    {
      std::lock_guard lock(state->mutex);
      if (kind == BlockedPublicationKind::Video) {
        state->block_publish = true;
        state->publish_entered = false;
        state->release_publish = false;
      } else {
        state->block_unpublish = true;
        state->unpublish_entered = false;
        state->release_unpublish = false;
      }
    }
    auto blocked = std::async(std::launch::async, [&] {
      if (kind == BlockedPublicationKind::Video) {
        return session->publication().publishVideoTrack(
          owner_call,
          {},
          livekit::TrackPublishOptions{}
        ).ok();
      }
      return session->publication().unpublishTrack(
        owner_call, "publication"
      ).ok();
    });
    {
      std::unique_lock lock(state->mutex);
      if (!state->changed.wait_for(lock, 1s, [&] {
            return kind == BlockedPublicationKind::Video
              ? state->publish_entered
              : state->unpublish_entered;
          })) {
        throw std::runtime_error("blocked publication did not enter fake owner");
      }
    }

    auto unrelated = std::async(std::launch::async, [&] {
      const auto output = session->output().setDevice(owner_call, "default");
      const auto remote = session->remoteFrameRelease().releaseRemoteFrame(
        owner_call, "remote-video", 1
      );
      const auto preview = session->cameraPreview().releasePreviewFrame(
        owner_call, "camera-preview", 1
      );
      const auto demand = session->remoteDemand().set(
        owner_call, "remote-video", true
      );
      const auto status = session->lifecycle().status(SessionPortCall::current());
      return output.ok() && remote.ok() && preview.ok() && demand.ok() &&
        status.ok() && status.value().value;
    });

    std::future<syrnike::desktop_native::media::SessionPortResult<std::string>>
      gate_waiter;
    if (kind == BlockedPublicationKind::Video) {
      gate_waiter = std::async(std::launch::async, [&] {
        auto deadline_call = owner_call;
        deadline_call.deadline = SessionPortCall::Clock::now() + 50ms;
        return session->publication().publishAudioTrack(
          deadline_call,
          {},
          livekit::TrackPublishOptions{}
        );
      });
    }
    const bool unrelated_ready =
      unrelated.wait_for(250ms) == std::future_status::ready;
    const bool gate_deadline_ready =
      kind != BlockedPublicationKind::Video ||
      gate_waiter.wait_for(250ms) == std::future_status::ready;
    {
      std::lock_guard lock(state->mutex);
      if (kind == BlockedPublicationKind::Video) {
        state->release_publish = true;
      } else {
        state->release_unpublish = true;
      }
    }
    state->changed.notify_all();
    requireReady(blocked, "blocked publication did not resume after release");
    requireReady(unrelated, "independent port did not settle after release");
    if (!unrelated_ready || !unrelated.get() || !blocked.get()) {
      throw std::runtime_error(
        "blocked publication delayed or failed an independent session port"
      );
    }
    if (kind == BlockedPublicationKind::Video) {
      requireReady(gate_waiter, "publication gate waiter did not meet its deadline");
      const auto gate_result = gate_waiter.get();
      if (!gate_deadline_ready || !gate_result.hasError() ||
          gate_result.error().code !=
            syrnike::desktop_native::media::SessionPortErrorCode::Timeout ||
          gate_result.error().stage !=
            syrnike::desktop_native::media::SessionPortStage::PublicationAcquire) {
        throw std::runtime_error(
          "publication ordering gate did not return its typed acquisition timeout"
        );
      }
    }
    disconnectVoice(session);
    {
      std::lock_guard lock(state->mutex);
      if (state->disconnect_count != 1 ||
          state->owner_destroyed_count != 1 || state->lifecycle_overlap) {
        throw std::runtime_error(
          "publication port owner was not reclaimed exactly once"
        );
      }
    }
    runtime.requestShutdown();
    runtime.shutdownAndWait();
  };
  verify_independent_ports(BlockedPublicationKind::Video);
  verify_independent_ports(BlockedPublicationKind::Unpublish);

  // Room connect/disconnect gates belong only to the voice owner. Publishing
  // a track must never enter either gate.
  client->setBlocked(DeterministicFakeLiveKitVoiceSession::Operation::Connect, true);
  auto connect_future = std::async(std::launch::async, [&] {
    return connectVoice(client,
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
  const auto client_owner = bindOwnerCall(client, "voice", 1);

  if (client->pending(DeterministicFakeLiveKitVoiceSession::Operation::Connect) != 0) {
    throw std::runtime_error("track publication attempted to connect its own Room");
  }
  auto publish_future = std::async(std::launch::async, [&] {
    return requireSessionPortValue(client->publication().publishAudioTrack(
      client_owner,
      {},
      livekit::TrackPublishOptions{}
    ));
  });
  client->waitUntilPending(DeterministicFakeLiveKitVoiceSession::Operation::Publish, 1);
  requireNotReady(publish_future, "blocked publish completed before release");

  auto unpublish_future = std::async(std::launch::async, [&] {
    requireSessionPortSuccess(client->publication().unpublishTrack(
      client_owner, "publication-1"
    ));
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
    const auto result = failing_client->lifecycle().connect(
      SessionPortCall::forOwner("failing", 1, nextVoiceOwnerToken()),
      "wss://example.invalid",
      "token",
      noop_post
    );
    return result.ok() && result.value().value;
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
  if (!connectVoice(shared_client,
        "voice-op",
        1,
        "wss://example.invalid",
        "shared-token",
        noop_post
      )) {
    throw std::runtime_error("shared voice Room did not connect");
  }
  const auto shared_owner = bindOwnerCall(shared_client, "voice-op", 1);
  bool conflicting_duplicate_rejected = false;
  try {
    connectVoice(shared_client,
      "voice-op", 1, "wss://example.invalid", "other-token", noop_post);
  } catch (const std::exception&) {
    conflicting_duplicate_rejected = true;
  }
  if (!conflicting_duplicate_rejected) {
    throw std::runtime_error("duplicate voice epoch accepted another credential lease");
  }
  requireSessionPortSuccess(shared_client->publication().unpublishTrack(
    SessionPortCall::forOwner(SessionEpoch{
      shared_owner.expected_epoch.session_id,
      41,
      shared_owner.expected_epoch.owner_token,
    }),
    "already-retired"
  ));
  if (!voiceConnected(shared_client)) {
    throw std::runtime_error("track retirement disconnected shared voice Room");
  }
  // Receive-side controls are properties of the existing Room lease. They
  // must not reconnect or retire the participant.
  requireSessionPortSuccess(shared_client->output().setDeafened(
    shared_owner, true
  ));
  const auto output_epoch_a =
    requireSessionPortValue(shared_client->output().setDevice(
      shared_owner, "communications-output"
    ));
  const auto output_epoch_b =
    requireSessionPortValue(shared_client->output().setDevice(
      shared_owner, "default"
    ));
  if (output_epoch_a == 0 || output_epoch_b <= output_epoch_a) {
    throw std::runtime_error("output renderer generation did not advance");
  }
  requireSessionPortSuccess(shared_client->output().setDeafened(
    shared_owner, false
  ));
  if (!voiceConnected(shared_client)) {
    throw std::runtime_error("output/deafen update disconnected shared voice Room");
  }
  disconnectVoice(shared_client);
  if (!connectVoice(shared_client,
        "voice-recovered", 2, "wss://example.invalid", "replacement-token", noop_post)) {
    throw std::runtime_error("replacement voice Room did not connect");
  }
  bool stale_publish_rejected = false;
  try {
    requireSessionPortValue(shared_client->publication().publishVideoTrack(
      SessionPortCall::forOwner(SessionEpoch{
        shared_owner.expected_epoch.session_id,
        7,
        shared_owner.expected_epoch.owner_token,
      }),
      {},
      livekit::TrackPublishOptions{}
    ));
  } catch (const std::exception&) {
    stale_publish_rejected = true;
  }
  if (!stale_publish_rejected) {
    throw std::runtime_error("old track publication published into a replacement voice Room");
  }
  disconnectVoice(shared_client);
  for (int attempt = 0; attempt < 32; ++attempt) disconnectVoice(shared_client);
  if (voiceConnected(shared_client)) {
    throw std::runtime_error("explicit voice disconnect left shared Room connected");
  }
}

int main() try {
  auto& cleanup_supervisor =
    syrnike::desktop_native::CleanupSupervisor::instance();
  const auto cleanup_before = cleanup_supervisor.snapshot();
  if (syrnike::desktop_native::media::LiveKitLease::activeCount() != 0) {
    throw std::runtime_error(
      "livekit voice-session test inherited an active SDK lifetime"
    );
  }

  runLiveKitVoiceSessionTests();
  auto cleanup_after = cleanup_supervisor.snapshot();
  const auto cleanup_deadline = std::chrono::steady_clock::now() + 2s;
  while ((cleanup_after.owned_jobs != cleanup_before.owned_jobs ||
          syrnike::desktop_native::media::LiveKitLease::activeCount() != 0) &&
         std::chrono::steady_clock::now() < cleanup_deadline) {
    std::this_thread::sleep_for(1ms);
    cleanup_after = cleanup_supervisor.snapshot();
  }
  if (cleanup_after.owned_jobs != cleanup_before.owned_jobs) {
    throw std::runtime_error(
      "livekit voice-session test did not return cleanup ownership to baseline"
    );
  }
  const auto retained_livekit_leases =
    syrnike::desktop_native::media::LiveKitLease::activeCount();
  if (retained_livekit_leases != 0) {
    throw std::runtime_error(
      "livekit voice-session test retained " +
      std::to_string(retained_livekit_leases) +
      " SDK lifetime(s) after owner teardown"
    );
  }

  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
