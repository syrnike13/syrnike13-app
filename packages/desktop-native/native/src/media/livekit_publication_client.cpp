#include "livekit_publication_client.hpp"

#include <livekit/local_track_publication.h>
#include <livekit/remote_track_publication.h>
#include <livekit/room_delegate.h>

#include <atomic>
#include <cstdlib>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <unordered_map>

#include "../common/diagnostic_log.hpp"
#include "livekit_disconnect_reason.hpp"
#include "remote_audio_output.hpp"
#include "remote_video_bridge.hpp"

namespace syrnike::desktop_native::media {
namespace {

using diagnostics::DiagnosticField;

std::uint32_t electronMainPid() {
  char* value = nullptr;
  std::size_t length = 0;
  if (_dupenv_s(&value, &length, "SYRNIKE_ELECTRON_MAIN_PID") != 0 || !value) return 0;
  try {
    const auto parsed = std::stoul(value);
    std::free(value);
    return parsed <= UINT32_MAX ? static_cast<std::uint32_t>(parsed) : 0;
  } catch (...) {
    std::free(value);
    return 0;
  }
}

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
      post_(std::move(post)),
      audio_output_([this](std::string message, std::string device_id) {
        postOutputFailure(std::move(message), std::move(device_id));
      }),
      remote_video_(electronMainPid(), post_) {
    remote_video_.updateIdentity(session_id_, generation_);
  }

  void updateIdentity(std::string session_id, std::uint64_t generation) {
    std::lock_guard lock(mutex_);
    session_id_ = std::move(session_id);
    generation_ = generation;
    remote_video_.updateIdentity(session_id_, generation_);
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

  void onTrackSubscribed(livekit::Room&, const livekit::TrackSubscribedEvent& event) override {
    CallbackGuard callback(*this);
    if (!callback || !event.track) return;
    if (event.track->kind() == livekit::TrackKind::KIND_AUDIO) {
      audio_output_.addTrack(
        event.publication ? event.publication->sid() : event.track->sid(),
        event.participant ? event.participant->identity() : std::string{},
        event.publication
          ? event.publication->source() == livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO
          : event.track->source() == livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO,
        event.track
      );
    } else if (event.track->kind() == livekit::TrackKind::KIND_VIDEO) {
      if (event.publication) {
        std::lock_guard lock(video_publications_mutex_);
        video_publications_[event.track->sid()] = event.publication;
      }
      remote_video_.addTrack(
        event.track,
        event.participant ? event.participant->identity() : std::string{}
      );
    }
  }

  void onTrackUnsubscribed(livekit::Room&, const livekit::TrackUnsubscribedEvent& event) override {
    CallbackGuard callback(*this);
    if (!callback || !event.track) return;
    audio_output_.removeTrack(
      event.publication ? event.publication->sid() : event.track->sid()
    );
    remote_video_.removeTrack(event.track->sid());
    {
      std::lock_guard lock(video_publications_mutex_);
      video_publications_.erase(event.track->sid());
    }
  }

  void onActiveSpeakersChanged(
    livekit::Room&,
    const livekit::ActiveSpeakersChangedEvent& event
  ) override {
    CallbackGuard callback(*this);
    if (!callback || kind_ != "voice") return;
    MediaCommand command;
    command.type = "__voiceActiveSpeakers";
    {
      std::lock_guard lock(mutex_);
      command.session_id = session_id_;
      command.generation = generation_;
    }
    command.participant_identities.reserve(event.speakers.size());
    for (const auto* participant : event.speakers) {
      if (participant && !participant->identity().empty()) {
        command.participant_identities.push_back(participant->identity());
      }
    }
    post_(std::move(command));
  }

  void setDeafened(bool value) { audio_output_.setDeafened(value); }
  void setOutputDevice(std::string value) { audio_output_.setOutputDevice(std::move(value)); }
  void setOutputVolume(float value) { audio_output_.setVolume(value); }
  void configureRemoteAudio(RemoteAudioSettings settings) { audio_output_.configure(std::move(settings)); }
  void stopAudio() { audio_output_.stop(); }
  void releaseRemoteVideoFrame(std::string track_id, std::uint64_t sequence) {
    remote_video_.release(track_id, sequence);
  }
  void setRemoteVideoDemand(const std::string& track_id, bool demanded) {
    std::shared_ptr<livekit::RemoteTrackPublication> publication;
    {
      std::lock_guard lock(video_publications_mutex_);
      const auto found = video_publications_.find(track_id);
      if (found != video_publications_.end()) publication = found->second;
    }
    if (!demanded) remote_video_.removeTrack(track_id);
    if (publication) publication->setSubscribed(demanded);
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

  void postOutputFailure(std::string message, std::string device_id) {
    MediaCommand command;
    command.type = "__voiceOutputFailed";
    {
      std::lock_guard lock(mutex_);
      command.session_id = session_id_;
      command.generation = generation_;
    }
    command.internal_message = std::move(message);
    command.device_id = std::move(device_id);
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
  RemoteAudioOutput audio_output_;
  RemoteVideoBridge remote_video_;
  std::mutex video_publications_mutex_;
  std::unordered_map<std::string, std::shared_ptr<livekit::RemoteTrackPublication>> video_publications_;
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
    delegate_->stopAudio();
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

  void setDeafened(bool value) { delegate_->setDeafened(value); }
  void setOutputDevice(std::string value) { delegate_->setOutputDevice(std::move(value)); }
  void setOutputVolume(float value) { delegate_->setOutputVolume(value); }
  void configureRemoteAudio(RemoteAudioSettings settings) {
    delegate_->configureRemoteAudio(std::move(settings));
  }
  void stopAudio() { delegate_->stopAudio(); }
  void releaseRemoteVideoFrame(std::string track_id, std::uint64_t sequence) {
    delegate_->releaseRemoteVideoFrame(std::move(track_id), sequence);
  }
  void setRemoteVideoDemand(std::string track_id, bool demanded) {
    delegate_->setRemoteVideoDemand(track_id, demanded);
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

class RealLiveKitPublicationClient;

class RealSharedTrackSession final : public LiveKitRoomSession {
 public:
  RealSharedTrackSession(
    RealLiveKitPublicationClient& client,
    std::string session_id,
    std::uint64_t generation,
    LiveKitPublicationClient::InternalPost post
  );

  void updateIdentity(std::string session_id, std::uint64_t generation) override;
  bool connect(
    const std::string& livekit_url,
    const std::string& livekit_token,
    const livekit::RoomOptions& options
  ) override;
  bool isConnected() const override;
  bool waitConnected(std::chrono::milliseconds timeout) override;
  std::string publishAudioTrack(
    const std::shared_ptr<livekit::LocalAudioTrack>& track,
    const livekit::TrackPublishOptions& options
  ) override;
  std::string publishVideoTrack(
    const std::shared_ptr<livekit::LocalVideoTrack>& track,
    const livekit::TrackPublishOptions& options
  ) override;
  void unpublishTrack(const std::string& publication_sid) override;
  void markIntentionalDisconnect() override;
  void disconnect() override;

 private:
  RealLiveKitPublicationClient& client_;
  mutable std::mutex mutex_;
  std::string session_id_;
  std::uint64_t generation_ = 0;
  LiveKitPublicationClient::InternalPost post_;
};

class RealLiveKitPublicationClient final : public LiveKitPublicationClient {
 public:
  bool connectVoice(
    std::string session_id,
    std::uint64_t generation,
    const std::string& livekit_url,
    const std::string& livekit_token,
    InternalPost post
  ) override {
    std::shared_ptr<RealLiveKitRoomSession> room;
    {
      std::lock_guard lock(mutex_);
      if (voice_room_ && voice_room_->isConnected()) {
        if (livekit_url != livekit_url_ || livekit_token != livekit_token_) {
          throw std::runtime_error(
            "LiveKit voice Room is already connected with another credential lease"
          );
        }
        return true;
      }
      voice_room_.reset();
      room = std::make_shared<RealLiveKitRoomSession>(
        "voice",
        "__voiceTerminal",
        std::move(session_id),
        generation,
        std::move(post)
      );
      voice_room_ = room;
      livekit_url_ = livekit_url;
      livekit_token_ = livekit_token;
    }
    livekit::RoomOptions options;
    options.auto_subscribe = true;
    if (!room->connect(livekit_url, livekit_token, options)) return false;
    return room->waitConnected(std::chrono::seconds(20));
  }

  bool isVoiceConnected() const override {
    const auto room = roomSnapshot();
    return room && room->isConnected();
  }

  void setVoiceDeafened(bool value) override {
    const auto room = roomSnapshot();
    if (room) room->setDeafened(value);
  }

  void setVoiceOutputDevice(std::string value) override {
    const auto room = roomSnapshot();
    if (room) room->setOutputDevice(std::move(value));
  }
  void setVoiceOutputVolume(float value) override {
    const auto room = roomSnapshot();
    if (room) room->setOutputVolume(value);
  }
  void configureRemoteAudio(RemoteAudioSettings settings) override {
    const auto room = roomSnapshot();
    if (room) room->configureRemoteAudio(std::move(settings));
  }

  void releaseRemoteVideoFrame(std::string track_id, std::uint64_t sequence) override {
    const auto room = roomSnapshot();
    if (room) room->releaseRemoteVideoFrame(std::move(track_id), sequence);
  }
  void setRemoteVideoDemand(std::string track_id, bool demanded) override {
    const auto room = roomSnapshot();
    if (room) room->setRemoteVideoDemand(std::move(track_id), demanded);
  }

  void disconnectVoice() override {
    std::shared_ptr<RealLiveKitRoomSession> room;
    {
      std::lock_guard lock(mutex_);
      room = std::move(voice_room_);
      livekit_url_.clear();
      livekit_token_.clear();
    }
    if (!room) return;
    room->markIntentionalDisconnect();
    room->stopAudio();
    room->disconnect();
  }

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
    return std::make_unique<RealSharedTrackSession>(
      *this,
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
    return std::make_unique<RealSharedTrackSession>(
      *this,
      std::move(session_id),
      generation,
      std::move(post)
    );
  }

  std::unique_ptr<LiveKitRoomSession> createCameraSession(
    std::string session_id,
    std::uint64_t generation,
    InternalPost post
  ) override {
    return std::make_unique<RealSharedTrackSession>(
      *this, std::move(session_id), generation, std::move(post)
    );
  }

  std::shared_ptr<RealLiveKitRoomSession> roomSnapshot() const {
    std::lock_guard lock(mutex_);
    return voice_room_;
  }

 private:
  mutable std::mutex mutex_;
  std::shared_ptr<RealLiveKitRoomSession> voice_room_;
  std::string livekit_url_;
  std::string livekit_token_;
};

RealSharedTrackSession::RealSharedTrackSession(
  RealLiveKitPublicationClient& client,
  std::string session_id,
  std::uint64_t generation,
  LiveKitPublicationClient::InternalPost post
) : client_(client),
    session_id_(std::move(session_id)),
    generation_(generation),
    post_(std::move(post)) {}

void RealSharedTrackSession::updateIdentity(
  std::string session_id,
  std::uint64_t generation
) {
  std::lock_guard lock(mutex_);
  session_id_ = std::move(session_id);
  generation_ = generation;
}

bool RealSharedTrackSession::connect(
  const std::string& livekit_url,
  const std::string& livekit_token,
  const livekit::RoomOptions&
) {
  std::string session_id;
  std::uint64_t generation = 0;
  {
    std::lock_guard lock(mutex_);
    session_id = session_id_;
    generation = generation_;
  }
  return client_.connectVoice(
    std::move(session_id),
    generation,
    livekit_url,
    livekit_token,
    post_
  );
}

bool RealSharedTrackSession::isConnected() const {
  return client_.isVoiceConnected();
}

bool RealSharedTrackSession::waitConnected(std::chrono::milliseconds timeout) {
  const auto room = client_.roomSnapshot();
  return room && room->waitConnected(timeout);
}

std::string RealSharedTrackSession::publishAudioTrack(
  const std::shared_ptr<livekit::LocalAudioTrack>& track,
  const livekit::TrackPublishOptions& options
) {
  const auto room = client_.roomSnapshot();
  if (!room) throw std::runtime_error("LiveKit voice Room is not connected");
  return room->publishAudioTrack(track, options);
}

std::string RealSharedTrackSession::publishVideoTrack(
  const std::shared_ptr<livekit::LocalVideoTrack>& track,
  const livekit::TrackPublishOptions& options
) {
  const auto room = client_.roomSnapshot();
  if (!room) throw std::runtime_error("LiveKit voice Room is not connected");
  return room->publishVideoTrack(track, options);
}

void RealSharedTrackSession::unpublishTrack(const std::string& publication_sid) {
  const auto room = client_.roomSnapshot();
  if (!room) return;
  room->unpublishTrack(publication_sid);
}

void RealSharedTrackSession::markIntentionalDisconnect() {}

void RealSharedTrackSession::disconnect() {
  // Track actors own publications, never the shared voice Room.
}

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
    if (client_.isVoiceConnected()) {
      std::lock_guard lock(mutex_);
      connected_ = true;
      return true;
    }
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
    if (client_.isVoiceConnected()) {
      std::lock_guard lock(mutex_);
      connected_ = false;
      return;
    }
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

bool DeterministicFakeLiveKitPublicationClient::connectVoice(
  std::string,
  std::uint64_t,
  const std::string&,
  const std::string&,
  InternalPost
) {
  Release release;
  {
    std::unique_lock lock(mutex_);
    connect_.pending += 1;
    voice_connect_pending_ += 1;
    changed_.notify_all();
    changed_.wait(lock, [&] {
      return !connect_.blocked || !connect_.releases.empty();
    });
    if (!connect_.releases.empty()) {
      release = std::move(connect_.releases.front());
      connect_.releases.pop_front();
    }
    connect_.pending -= 1;
    voice_connect_pending_ -= 1;
    changed_.notify_all();
  }
  if (release.error_message) throw std::runtime_error(*release.error_message);
  {
    std::lock_guard lock(mutex_);
    voice_connected_ = release.bool_result;
  }
  return release.bool_result;
}

bool DeterministicFakeLiveKitPublicationClient::isVoiceConnected() const {
  std::lock_guard lock(mutex_);
  return voice_connected_;
}

void DeterministicFakeLiveKitPublicationClient::setVoiceDeafened(bool value) {
  std::lock_guard lock(mutex_);
  voice_deafened_ = value;
}

void DeterministicFakeLiveKitPublicationClient::setVoiceOutputDevice(std::string value) {
  std::lock_guard lock(mutex_);
  voice_output_device_id_ = std::move(value);
}

void DeterministicFakeLiveKitPublicationClient::setVoiceOutputVolume(float) {}
void DeterministicFakeLiveKitPublicationClient::configureRemoteAudio(RemoteAudioSettings) {}

void DeterministicFakeLiveKitPublicationClient::releaseRemoteVideoFrame(
  std::string,
  std::uint64_t
) {}

void DeterministicFakeLiveKitPublicationClient::setRemoteVideoDemand(std::string, bool) {}

void DeterministicFakeLiveKitPublicationClient::disconnectVoice() {
  {
    std::lock_guard lock(mutex_);
    if (voice_connect_pending_ > 0) {
      Release cancelled;
      cancelled.bool_result = false;
      connect_.releases.push_back(std::move(cancelled));
      changed_.notify_all();
      return;
    }
    if (!voice_connected_) return;
  }
  const auto release = enterGate(Operation::Disconnect);
  if (release.error_message) throw std::runtime_error(*release.error_message);
  std::lock_guard lock(mutex_);
  voice_connected_ = false;
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

std::unique_ptr<LiveKitRoomSession> DeterministicFakeLiveKitPublicationClient::createCameraSession(
  std::string session_id,
  std::uint64_t generation,
  InternalPost
) {
  return std::make_unique<DeterministicFakeLiveKitRoomSession>(
    *this, std::move(session_id), generation
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
