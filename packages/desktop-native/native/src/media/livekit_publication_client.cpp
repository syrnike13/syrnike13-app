#include "livekit_publication_client.hpp"

#include <livekit/local_track_publication.h>
#include <livekit/room_delegate.h>

#include <atomic>
#include <stdexcept>
#include <string_view>
#include <utility>

#include "../common/diagnostic_log.hpp"
#include "livekit_disconnect_reason.hpp"

namespace syrnike::desktop_native::media {
namespace {

using diagnostics::DiagnosticField;

void logDelegate(
  std::string_view kind,
  std::string_view event,
  std::initializer_list<DiagnosticField> fields = {}
) {
  auto& logger = diagnostics::DiagnosticLog::instance();
  if (!logger.enabled()) return;
  logger.write(std::string(kind) + "_delegate_" + std::string(event), fields);
}

class PostedRoomDelegate final : public livekit::RoomDelegate {
 public:
  class CallbackGuard {
   public:
    explicit CallbackGuard(PostedRoomDelegate& owner)
      : owner_(&owner), active_(owner.beginCallback()) {}
    ~CallbackGuard() {
      if (active_) owner_->endCallback();
    }
    explicit operator bool() const { return active_; }

   private:
    PostedRoomDelegate* owner_;
    bool active_;
  };

  PostedRoomDelegate(
    std::string kind,
    std::string terminal_type,
    std::string session_id,
    std::uint64_t generation,
    LiveKitPublicationClient::InternalPost post
  ) : kind_(std::move(kind)),
      terminal_type_(std::move(terminal_type)),
      session_id_(std::move(session_id)),
      generation_(generation),
      post_(std::move(post)) {}

  void updateIdentity(std::string session_id, std::uint64_t generation) {
    std::lock_guard lock(mutex_);
    session_id_ = std::move(session_id);
    generation_ = generation;
  }

  void onConnectionStateChanged(
    livekit::Room&,
    const livekit::ConnectionStateChangedEvent& event
  ) override {
    CallbackGuard callback(*this);
    if (!callback) return;
    std::string session_id;
    std::uint64_t generation = 0;
    {
      std::lock_guard lock(mutex_);
      state_ = event.state;
      if (state_ == livekit::ConnectionState::Disconnected) disconnected_ = true;
      session_id = session_id_;
      generation = generation_;
    }
    changed_.notify_all();
    logDelegate(
      kind_,
      "connection_state_changed",
      {
        {"sessionId", session_id},
        {"generation", generation},
        {"state", static_cast<std::uint64_t>(event.state)}
      }
    );
  }

  void onDisconnected(livekit::Room&, const livekit::DisconnectedEvent& event) override {
    CallbackGuard callback(*this);
    if (!callback) return;
    const auto reason = describeLiveKitDisconnectReason(event.reason);
    const auto terminal_message = formatLiveKitDisconnectTerminalMessage(event.reason);
    std::string session_id;
    std::uint64_t generation = 0;
    bool notify_terminal = false;
    {
      std::lock_guard lock(mutex_);
      state_ = livekit::ConnectionState::Disconnected;
      disconnected_ = true;
      notify_terminal = !intentional_;
      session_id = session_id_;
      generation = generation_;
    }
    changed_.notify_all();
    logDelegate(
      kind_,
      "disconnected",
      {
        {"sessionId", session_id},
        {"generation", generation},
        {"disconnectReason", std::string(reason.code)},
        {"disconnectReasonCode", reason.numeric_code},
        {"notifyTerminal", notify_terminal}
      }
    );
    if (!notify_terminal) return;
    postTerminal(std::move(session_id), generation, std::move(terminal_message));
  }

  bool isConnected() const {
    std::lock_guard lock(mutex_);
    return state_ == livekit::ConnectionState::Connected;
  }

  bool waitConnected(std::chrono::milliseconds timeout) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] {
      return state_ == livekit::ConnectionState::Connected || disconnected_;
    }) && state_ == livekit::ConnectionState::Connected;
  }

  bool waitDisconnected(std::chrono::milliseconds timeout) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] { return disconnected_; });
  }

  void markIntentionalDisconnect() {
    std::lock_guard lock(mutex_);
    intentional_ = true;
  }

  void beginShutdown() {
    std::lock_guard lock(callback_mutex_);
    shutting_down_ = true;
  }

  void waitForCallbacks() {
    std::unique_lock lock(callback_mutex_);
    callbacks_changed_.wait(lock, [&] {
      return active_callbacks_ == 0;
    });
  }

 private:
  bool beginCallback() {
    std::lock_guard lock(callback_mutex_);
    if (shutting_down_) return false;
    ++active_callbacks_;
    return true;
  }

  void endCallback() {
    std::lock_guard lock(callback_mutex_);
    --active_callbacks_;
    if (active_callbacks_ == 0) callbacks_changed_.notify_all();
  }

  void postTerminal(
    std::string session_id,
    std::uint64_t generation,
    std::string message
  ) {
    if (terminal_posted_.exchange(true)) return;
    logDelegate(
      kind_,
      "post_terminal",
      {
        {"sessionId", session_id},
        {"generation", generation},
        {"message", message}
      }
    );
    MediaCommand command;
    command.type = terminal_type_;
    command.session_id = std::move(session_id);
    command.generation = generation;
    command.internal_message = std::move(message);
    post_(std::move(command));
  }

  std::string kind_;
  std::string terminal_type_;
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::string session_id_;
  std::uint64_t generation_ = 0;
  livekit::ConnectionState state_ = livekit::ConnectionState::Disconnected;
  bool disconnected_ = false;
  bool intentional_ = false;
  std::mutex callback_mutex_;
  std::condition_variable callbacks_changed_;
  std::size_t active_callbacks_ = 0;
  bool shutting_down_ = false;
  std::atomic_bool terminal_posted_{false};
  LiveKitPublicationClient::InternalPost post_;
};

class RealLiveKitRoomSession final : public LiveKitRoomSession {
 public:
  RealLiveKitRoomSession(
    std::string kind,
    std::string terminal_type,
    std::string session_id,
    std::uint64_t generation,
    LiveKitPublicationClient::InternalPost post
  ) : delegate_(std::make_unique<PostedRoomDelegate>(
        std::move(kind),
        std::move(terminal_type),
        std::move(session_id),
        generation,
        std::move(post)
      )) {
    room_.setDelegate(delegate_.get());
  }

  ~RealLiveKitRoomSession() override {
    // LiveKit disconnect is asynchronous. Destroying Room immediately after
    // requesting it races its signalling/subscription callbacks during rapid
    // make-before-break moves. Keep the delegate alive until the terminal
    // callback is observed, then detach it before Room teardown.
    delegate_->markIntentionalDisconnect();
    try {
      close();
    } catch (...) {
    }
    delegate_->beginShutdown();
    room_.setDelegate(nullptr);
    delegate_->waitForCallbacks();
  }

  void updateIdentity(std::string session_id, std::uint64_t generation) override {
    delegate_->updateIdentity(std::move(session_id), generation);
  }

  bool connect(
    const std::string& livekit_url,
    const std::string& livekit_token,
    const livekit::RoomOptions& options
  ) override {
    return room_.connect(livekit_url, livekit_token, options);
  }

  bool isConnected() const override {
    return delegate_->isConnected();
  }

  bool waitConnected(std::chrono::milliseconds timeout) override {
    return delegate_->waitConnected(timeout);
  }

  std::string publishAudioTrack(
    const std::shared_ptr<livekit::LocalAudioTrack>& track,
    const livekit::TrackPublishOptions& options
  ) override {
    auto participant = room_.localParticipant().lock();
    if (!participant) throw std::runtime_error("LiveKit local participant is unavailable");
    participant->publishTrack(track, options);
    const auto publication = track ? track->publication() : nullptr;
    return publication ? publication->sid() : std::string{};
  }

  std::string publishVideoTrack(
    const std::shared_ptr<livekit::LocalVideoTrack>& track,
    const livekit::TrackPublishOptions& options
  ) override {
    auto participant = room_.localParticipant().lock();
    if (!participant) throw std::runtime_error("LiveKit local participant is unavailable");
    participant->publishTrack(track, options);
    const auto publication = track ? track->publication() : nullptr;
    return publication ? publication->sid() : std::string{};
  }

  void unpublishTrack(const std::string& publication_sid) override {
    auto participant = room_.localParticipant().lock();
    if (!participant) throw std::runtime_error("LiveKit local participant is unavailable");
    participant->unpublishTrack(publication_sid);
  }

  void markIntentionalDisconnect() override {
    delegate_->markIntentionalDisconnect();
  }

  void disconnect() override {
    close();
  }

 private:
  void close() {
    if (!disconnect_requested_.exchange(true)) {
      room_.disconnect();
    }
    delegate_->waitDisconnected(std::chrono::seconds(2));
  }

  std::unique_ptr<PostedRoomDelegate> delegate_;
  livekit::Room room_;
  std::atomic_bool disconnect_requested_{false};
};

class RealLiveKitPublicationClient final : public LiveKitPublicationClient {
 public:
  std::shared_ptr<livekit::LocalAudioTrack> createMicrophoneTrack(
    const std::shared_ptr<livekit::AudioSource>& source
  ) override {
    return livekit::LocalAudioTrack::createLocalAudioTrack("microphone", source);
  }

  std::unique_ptr<LiveKitRoomSession> createMicrophoneSession(
    std::string session_id,
    std::uint64_t generation,
    InternalPost post
  ) override {
    return std::make_unique<RealLiveKitRoomSession>(
      "microphone",
      "__microphoneTerminal",
      std::move(session_id),
      generation,
      std::move(post)
    );
  }

  std::unique_ptr<LiveKitRoomSession> createScreenSession(
    std::string session_id,
    std::uint64_t generation,
    InternalPost post
  ) override {
    return std::make_unique<RealLiveKitRoomSession>(
      "screen",
      "__screenTerminal",
      std::move(session_id),
      generation,
      std::move(post)
    );
  }
};

class DeterministicFakeLiveKitRoomSession final : public LiveKitRoomSession {
 public:
  DeterministicFakeLiveKitRoomSession(
    DeterministicFakeLiveKitPublicationClient& client,
    std::string session_id,
    std::uint64_t generation
  ) : client_(client), session_id_(std::move(session_id)), generation_(generation) {}

  void updateIdentity(std::string session_id, std::uint64_t generation) override {
    std::lock_guard lock(mutex_);
    session_id_ = std::move(session_id);
    generation_ = generation;
  }

  bool connect(const std::string&, const std::string&, const livekit::RoomOptions&) override {
    const auto release = client_.enterGate(
      DeterministicFakeLiveKitPublicationClient::Operation::Connect
    );
    if (release.error_message) throw std::runtime_error(*release.error_message);
    {
      std::lock_guard lock(mutex_);
      connected_ = release.bool_result;
    }
    return release.bool_result;
  }

  bool isConnected() const override {
    std::lock_guard lock(mutex_);
    return connected_;
  }

  bool waitConnected(std::chrono::milliseconds) override {
    return isConnected();
  }

  std::string publishAudioTrack(
    const std::shared_ptr<livekit::LocalAudioTrack>&,
    const livekit::TrackPublishOptions&
  ) override {
    return publish();
  }

  std::string publishVideoTrack(
    const std::shared_ptr<livekit::LocalVideoTrack>&,
    const livekit::TrackPublishOptions&
  ) override {
    return publish();
  }

  void unpublishTrack(const std::string& publication_sid) override {
    const auto release = client_.enterGate(
      DeterministicFakeLiveKitPublicationClient::Operation::Unpublish
    );
    if (release.error_message) throw std::runtime_error(*release.error_message);
    client_.recordUnpublishedPublicationSid(publication_sid);
  }

  void markIntentionalDisconnect() override {}

  void disconnect() override {
    const auto release = client_.enterGate(
      DeterministicFakeLiveKitPublicationClient::Operation::Disconnect
    );
    if (release.error_message) throw std::runtime_error(*release.error_message);
    std::lock_guard lock(mutex_);
    connected_ = false;
  }

 private:
  std::string publish() {
    const auto release = client_.enterGate(
      DeterministicFakeLiveKitPublicationClient::Operation::Publish
    );
    if (release.error_message) throw std::runtime_error(*release.error_message);
    return release.publication_sid;
  }

  DeterministicFakeLiveKitPublicationClient& client_;
  mutable std::mutex mutex_;
  std::string session_id_;
  std::uint64_t generation_ = 0;
  bool connected_ = false;
};

}  // namespace

std::shared_ptr<LiveKitPublicationClient> createRealLiveKitPublicationClient() {
  return std::make_shared<RealLiveKitPublicationClient>();
}

std::shared_ptr<livekit::LocalAudioTrack>
DeterministicFakeLiveKitPublicationClient::createMicrophoneTrack(
  const std::shared_ptr<livekit::AudioSource>&
) {
  return {};
}

std::unique_ptr<LiveKitRoomSession> DeterministicFakeLiveKitPublicationClient::createMicrophoneSession(
  std::string session_id,
  std::uint64_t generation,
  InternalPost
) {
  return std::make_unique<DeterministicFakeLiveKitRoomSession>(
    *this,
    std::move(session_id),
    generation
  );
}

std::unique_ptr<LiveKitRoomSession> DeterministicFakeLiveKitPublicationClient::createScreenSession(
  std::string session_id,
  std::uint64_t generation,
  InternalPost
) {
  return std::make_unique<DeterministicFakeLiveKitRoomSession>(
    *this,
    std::move(session_id),
    generation
  );
}

void DeterministicFakeLiveKitPublicationClient::setBlocked(Operation operation, bool blocked) {
  {
    std::lock_guard lock(mutex_);
    gateState(operation).blocked = blocked;
  }
  changed_.notify_all();
}

void DeterministicFakeLiveKitPublicationClient::releaseNext(Operation operation, Release release) {
  {
    std::lock_guard lock(mutex_);
    gateState(operation).releases.push_back(std::move(release));
  }
  changed_.notify_all();
}

void DeterministicFakeLiveKitPublicationClient::waitUntilPending(
  Operation operation,
  std::size_t count,
  std::chrono::milliseconds timeout
) {
  std::unique_lock lock(mutex_);
  if (!changed_.wait_for(lock, timeout, [&] {
        return gateState(operation).pending >= count;
      })) {
    throw std::runtime_error("timed out waiting for fake LiveKit operation");
  }
}

std::size_t DeterministicFakeLiveKitPublicationClient::pending(Operation operation) const {
  std::lock_guard lock(mutex_);
  return gateState(operation).pending;
}

std::vector<std::string>
DeterministicFakeLiveKitPublicationClient::unpublishedPublicationSids() const {
  std::lock_guard lock(mutex_);
  return unpublished_publication_sids_;
}

void DeterministicFakeLiveKitPublicationClient::recordUnpublishedPublicationSid(
  std::string publication_sid
) {
  std::lock_guard lock(mutex_);
  unpublished_publication_sids_.push_back(std::move(publication_sid));
}

DeterministicFakeLiveKitPublicationClient::Release
DeterministicFakeLiveKitPublicationClient::enterGate(Operation operation) {
  std::unique_lock lock(mutex_);
  auto& gate = gateState(operation);
  gate.pending += 1;
  changed_.notify_all();
  changed_.wait(lock, [&] { return !gate.blocked || !gate.releases.empty(); });
  Release release;
  if (!gate.releases.empty()) {
    release = std::move(gate.releases.front());
    gate.releases.pop_front();
  }
  gate.pending -= 1;
  changed_.notify_all();
  return release;
}

DeterministicFakeLiveKitPublicationClient::GateState&
DeterministicFakeLiveKitPublicationClient::gateState(Operation operation) {
  switch (operation) {
    case Operation::Connect: return connect_;
    case Operation::Publish: return publish_;
    case Operation::Unpublish: return unpublish_;
    case Operation::Disconnect: return disconnect_;
  }
  throw std::logic_error("unknown LiveKit fake operation");
}

const DeterministicFakeLiveKitPublicationClient::GateState&
DeterministicFakeLiveKitPublicationClient::gateState(Operation operation) const {
  switch (operation) {
    case Operation::Connect: return connect_;
    case Operation::Publish: return publish_;
    case Operation::Unpublish: return unpublish_;
    case Operation::Disconnect: return disconnect_;
  }
  throw std::logic_error("unknown LiveKit fake operation");
}

}  // namespace syrnike::desktop_native::media
