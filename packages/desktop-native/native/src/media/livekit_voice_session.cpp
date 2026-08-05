#include "livekit_voice_session.hpp"

#include <livekit/local_track_publication.h>
#include <livekit/remote_track_publication.h>
#include <livekit/room_delegate.h>

#include <atomic>
#include <cstdlib>
#include <optional>
#include <stdexcept>
#include <string_view>
#include <utility>

#include "../common/diagnostic_log.hpp"
#include "livekit_disconnect_reason.hpp"
#include "livekit_connect_policy.hpp"
#include "media_runtime_support.hpp"
#include "remote_audio_output.hpp"
#include "remote_publication_reconciler.hpp"
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

std::string_view outputPhaseName(RemoteAudioOutputPhase phase) {
  switch (phase) {
    case RemoteAudioOutputPhase::Stopped: return "stopped";
    case RemoteAudioOutputPhase::Starting: return "starting";
    case RemoteAudioOutputPhase::Running: return "running";
    case RemoteAudioOutputPhase::Recovering: return "recovering";
    case RemoteAudioOutputPhase::Failed: return "failed";
  }
  return "failed";
}

class PostedCommandGate final {
 public:
  explicit PostedCommandGate(LiveKitVoiceSession::InternalPost post)
    : post_(std::move(post)) {}

  bool post(MediaCommand command) {
    std::lock_guard lock(mutex_);
    return post_ ? post_(std::move(command)) : false;
  }

  void close() {
    std::lock_guard lock(mutex_);
    post_ = {};
  }

 private:
  std::mutex mutex_;
  LiveKitVoiceSession::InternalPost post_;
};

class PostedRoomDelegate final
  : public livekit::RoomDelegate,
    public std::enable_shared_from_this<PostedRoomDelegate> {
 public:
  class CallbackGuard {
   public:
    explicit CallbackGuard(PostedRoomDelegate& owner)
      : owner_(owner.shared_from_this()), active_(owner.beginCallback()) {
      if (!active_) owner_.reset();
    }
    ~CallbackGuard() {
      if (active_) owner_->endCallback();
    }
    explicit operator bool() const { return active_; }

   private:
    std::shared_ptr<PostedRoomDelegate> owner_;
    bool active_;
  };

  PostedRoomDelegate(
    std::string kind,
    std::string terminal_type,
    std::string session_id,
    std::uint64_t generation,
    LiveKitVoiceSession::InternalPost post
  ) : kind_(std::move(kind)),
      terminal_type_(std::move(terminal_type)),
      session_id_(std::move(session_id)),
      generation_(generation),
      post_gate_(std::make_shared<PostedCommandGate>(std::move(post))),
      post_([gate = post_gate_](MediaCommand command) {
        return gate->post(std::move(command));
      }),
      audio_output_([this](RemoteAudioOutputState state) {
        postOutputState(std::move(state));
      }, [this](
        AudioFailureInfo failure,
        std::string track_id,
        std::uint64_t renderer_epoch
      ) {
        postOutputTrackFailure(
          std::move(failure),
          std::move(track_id),
          renderer_epoch
        );
      }, [this](std::vector<std::string> identities) {
        postSpeakingActivity(std::move(identities));
      }),
      remote_video_(electronMainPid(), post_, [this](
        const std::string& track_id,
        const std::shared_ptr<livekit::Track>& track,
        const std::string& message
      ) {
        handleRemoteVideoEnded(track_id, track, message);
      }, {}),
      local_camera_preview_(
        electronMainPid(),
        post_,
        {},
        {},
        VideoBridgeEventTypes{
          "__localCameraPreviewFrame",
          "__localCameraPreviewTrackRemoved",
          "__localCameraPreviewFailed",
          "Local camera preview"
        }
      ) {
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
    if (event.state == livekit::ConnectionState::Connected) {
      requestAllRemotePublicationReconcile();
    }
    if (event.state == livekit::ConnectionState::Disconnected) {
      clearRemotePublications();
    }
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
    clearRemotePublications();
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

  void onTrackPublished(livekit::Room&, const livekit::TrackPublishedEvent& event) override {
    CallbackGuard callback(*this);
    if (!callback || !event.publication) return;
    registerRemotePublication(
      event.publication,
      event.participant ? event.participant->identity() : std::string{}
    );
  }

  void onParticipantConnected(
    livekit::Room&,
    const livekit::ParticipantConnectedEvent& event
  ) override {
    CallbackGuard callback(*this);
    if (!callback || !event.participant) return;
    for (const auto& [_, publication] : event.participant->trackPublications()) {
      registerRemotePublication(publication, event.participant->identity());
    }
  }

  void registerInitialRemotePublications(livekit::Room& room) {
    CallbackGuard callback(*this);
    if (!callback) return;
    for (const auto& weak_participant : room.remoteParticipants()) {
      const auto participant = weak_participant.lock();
      if (!participant) continue;
      for (const auto& [_, publication] : participant->trackPublications()) {
        registerRemotePublication(publication, participant->identity());
      }
    }
  }

  void onTrackUnpublished(livekit::Room&, const livekit::TrackUnpublishedEvent& event) override {
    CallbackGuard callback(*this);
    if (!callback || !event.publication) return;
    const auto publication_id = event.publication->sid();
    const auto removed = remote_publications_.removePublication(
      publication_id,
      event.publication
    );
    audio_output_.removeTrack(publication_id);
    if (removed && removed->is_video) {
      remote_video_.removeTrack(publication_id);
      postRemoteVideoPublication("__remoteVideoPublicationUnavailable", publication_id,
                                 removed->participant_identity, removed->source);
      if (removed->source == livekit::TrackSource::SOURCE_SCREENSHARE) {
        for (const auto& dependent_id :
             remote_publications_.syncScreenAudioDemand(
               removed->participant_identity
             )) {
          requestRemotePublicationReconcile(dependent_id);
        }
      }
    }
  }

  void onParticipantDisconnected(
    livekit::Room&,
    const livekit::ParticipantDisconnectedEvent& event
  ) override {
    CallbackGuard callback(*this);
    if (!callback || !event.participant) return;
    removeRemotePublicationsForParticipant(event.participant->identity());
  }

  void onTrackSubscribed(livekit::Room&, const livekit::TrackSubscribedEvent& event) override {
    CallbackGuard callback(*this);
    if (!callback || !event.track) return;
    const auto publication_id = event.publication
      ? event.publication->sid()
      : event.track->sid();
    if (event.publication &&
        !remote_publications_.matches(publication_id, event.publication)) {
      registerRemotePublication(
        event.publication,
        event.participant ? event.participant->identity() : std::string{}
      );
    }
    const auto subscribed = remote_publications_.onTrackSubscribed(
      publication_id,
      event.publication,
      event.track
    );
    if (!subscribed.matched) return;
    if (!subscribed.demanded) {
      requestRemotePublicationReconcile(publication_id);
      return;
    }
    if (!subscribed.is_video) {
      audio_output_.addTrack(
        publication_id,
        event.participant ? event.participant->identity() : std::string{},
        event.publication
          ? event.publication->source() == livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO
          : event.track->source() == livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO,
        event.track
      );
    } else if (!subscribed.duplicate) {
      remote_video_.addTrack(
        event.track,
        event.participant ? event.participant->identity() : std::string{},
        event.publication
          ? std::optional{event.publication->source()}
          : std::nullopt,
        publication_id
      );
      if (!remote_publications_.isCurrentDemandedTrack(
            publication_id,
            event.track
          )) {
        remote_video_.removeTrackIfCurrent(publication_id, event.track, false);
      }
    }
  }

  void onTrackUnsubscribed(livekit::Room&, const livekit::TrackUnsubscribedEvent& event) override {
    CallbackGuard callback(*this);
    if (!callback || (!event.track && !event.publication)) return;
    const auto publication_id = event.publication
      ? event.publication->sid()
      : event.track->sid();
    const auto unsubscribed = remote_publications_.onTrackUnsubscribed(
      publication_id,
      event.publication,
      event.track
    );
    if (!unsubscribed.matched) return;
    if (!unsubscribed.is_video) {
      audio_output_.removeTrack(publication_id);
      if (unsubscribed.resubscribe) {
        requestRemotePublicationReconcile(publication_id);
      }
      return;
    }
    // LiveKit can deliver an old unsubscribe after a replacement subscribe
    // for the same publication SID. Only the event for the current track may
    // retire its decoder. A matching in-flight unsubscribe still completes the
    // phase transition even when no SDK track was ever attached.
    if (unsubscribed.current) {
      remote_video_.removeTrackIfCurrent(publication_id, event.track);
    }
    if (unsubscribed.resubscribe) {
      requestRemotePublicationReconcile(publication_id);
    }
  }

  void onTrackSubscriptionFailed(
    livekit::Room&,
    const livekit::TrackSubscriptionFailedEvent& event
  ) override {
    CallbackGuard callback(*this);
    if (!callback) return;
    postRemoteVideoSubscriptionFailure(
      event.track_sid,
      "subscription_failed",
      event.error
    );
  }

  void postSpeakingActivity(std::vector<std::string> identities) {
    // RemoteAudioOutput is stopped and its workers are joined before the
    // delegate enters shutdown, so this callback cannot outlive the delegate.
    // Do not acquire callback_mutex_ here: audio callbacks can be emitted
    // reentrantly from onTrackSubscribed/onTrackUnsubscribed, which already
    // hold CallbackGuard.
    if (kind_ != "voice") return;
    MediaCommand command;
    command.type = "__voiceActiveSpeakers";
    {
      std::lock_guard lock(mutex_);
      command.session_id = session_id_;
      command.generation = generation_;
    }
    command.participant_identities = std::move(identities);
    post_(std::move(command));
  }

  void setDeafened(bool value) { audio_output_.setDeafened(value); }
  std::uint64_t setOutputDevice(std::string value) {
    return audio_output_.setOutputDevice(std::move(value));
  }
  std::string outputDeviceId() const {
    return audio_output_.outputDeviceId();
  }
  void setOutputVolume(float value) { audio_output_.setVolume(value); }
  void configureRemoteAudio(RemoteAudioSettings settings) { audio_output_.configure(std::move(settings)); }
  void retainSdkRuntimeLifetime(
    std::shared_ptr<LiveKitRuntimeLifetime> lifetime
  ) {
    sdk_runtime_lifetime_ = std::move(lifetime);
  }
  void stopAudio() { audio_output_.stop(shared_from_this()); }
  void releaseRemoteVideoFrame(std::string track_id, std::uint64_t sequence) {
    remote_video_.release(track_id, sequence);
  }
  void startLocalCameraPreview(
    std::string session_id,
    std::uint64_t generation,
    std::string track_id,
    std::string participant_identity,
    const std::shared_ptr<livekit::LocalVideoTrack>& track
  ) {
    local_camera_preview_.updateIdentity(std::move(session_id), generation);
    local_camera_preview_.addTrack(
      track,
      std::move(participant_identity),
      livekit::TrackSource::SOURCE_CAMERA,
      std::move(track_id)
    );
  }
  void stopLocalCameraPreview(const std::string& track_id) {
    local_camera_preview_.removeTrack(track_id);
  }
  void stopVideoBridges() {
    auto owner = shared_from_this();
    remote_video_.stop(owner);
    local_camera_preview_.stop(std::move(owner));
  }
  void releaseLocalCameraPreviewFrame(
    std::string track_id,
    std::uint64_t sequence
  ) {
    local_camera_preview_.release(track_id, sequence);
  }
  void setRemoteVideoDemand(const std::string& track_id, bool demanded) {
    const auto publication =
      remote_publications_.setVideoDemand(track_id, demanded);
    if (!publication) return;
    if (!demanded) remote_video_.removeTrack(track_id);
    reconcileRemotePublication(track_id);
    if (publication->source == livekit::TrackSource::SOURCE_SCREENSHARE) {
      for (const auto& dependent_id :
           remote_publications_.syncScreenAudioDemand(
             publication->participant_identity
           )) {
        reconcileRemotePublication(dependent_id);
      }
    }
    // Re-announce before the asynchronous subscription can produce frames so
    // the renderer can lift its unsubscribe tombstone without losing inventory.
    if (demanded) {
      postRemoteVideoPublication("__remoteVideoPublicationAvailable", track_id,
                                 publication->participant_identity,
                                 publication->source);
    }
  }

  void reconcileRemotePublication(const std::string& track_id) {
    const auto plan = remote_publications_.planReconcile(track_id);
    if (plan.command == RemotePublicationReconcileCommand::Deferred) {
      logDelegate(
        kind_,
        "remote_publication_reconcile_deferred",
        {
          {"publicationId", track_id},
          {"demanded", plan.demanded}
        }
      );
      return;
    }
    if (plan.command == RemotePublicationReconcileCommand::None) return;
    try {
      plan.publication->setSubscribed(
        plan.command == RemotePublicationReconcileCommand::Subscribe
      );
    } catch (...) {
      remote_publications_.markReconcileFailed(plan);
      throw;
    }
    if (!remote_publications_.isReconcileCurrent(plan)) return;
    logDelegate(
      kind_,
      "remote_publication_reconciled",
      {
        {"publicationId", track_id},
        {"demanded", plan.demanded}
      }
    );
  }

  void retryRemoteVideo(
    const std::string& track_id,
    const std::string& reason
  ) {
    CallbackGuard callback(*this);
    if (!callback) return;
    const auto plan = remote_publications_.planVideoRecovery(track_id);
    const auto& publication = plan.publication;
    if (plan.action == RemotePublicationRecoveryAction::RestartLocalBridge) {
      remote_video_.addTrack(
        publication.current_track,
        publication.participant_identity,
        publication.source,
        track_id
      );
      if (!remote_publications_.isCurrentDemandedTrack(
            track_id,
            publication.current_track
          )) {
        remote_video_.removeTrackIfCurrent(
          track_id,
          publication.current_track,
          false
        );
        return;
      }
      logDelegate(
        kind_,
        "remote_video_bridge_restarted",
        {
          {"publicationId", track_id},
          {"participantIdentity", publication.participant_identity},
          {"reason", reason}
        }
      );
      return;
    }
    if (plan.action == RemotePublicationRecoveryAction::RequestUnsubscribe) {
      try {
        publication.publication->setSubscribed(false);
      } catch (...) {
        remote_publications_.markRecoveryFailed(plan);
        throw;
      }
      remote_video_.removeTrack(track_id, false);
      logDelegate(
        kind_,
        "remote_video_unsubscribe_requested",
        {
          {"publicationId", track_id},
          {"participantIdentity", publication.participant_identity},
          {"reason", reason}
        }
      );
      return;
    }
    if (plan.action != RemotePublicationRecoveryAction::Reconcile) return;
    remote_video_.removeTrack(track_id, false);
    reconcileRemotePublication(track_id);
    logDelegate(
      kind_,
      "remote_video_subscription_retried",
      {
        {"publicationId", track_id},
        {"participantIdentity", publication.participant_identity},
        {"reason", reason}
      }
    );
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
    {
      std::lock_guard lock(callback_mutex_);
      shutting_down_ = true;
    }
    // A callback that exceeds the teardown deadline may retain the delegate,
    // but it must not retain or invoke MediaRuntime's queue closures after the
    // runtime has begun member destruction.
    post_gate_->close();
  }

  bool waitForCallbacks(std::chrono::milliseconds timeout) {
    std::unique_lock lock(callback_mutex_);
    return callbacks_changed_.wait_for(
      lock,
      timeout,
      [&] { return active_callbacks_ == 0; }
    );
  }

 private:
  void postRemoteVideoSubscriptionFailure(
    const std::string& publication_id,
    std::string_view reason,
    const std::string& error
  ) {
    const auto publication = remote_publications_.markSubscriptionFailed(
      publication_id,
      reason == "subscription_failed"
    );
    if (!publication) return;
    const auto video_source =
      publication->source == livekit::TrackSource::SOURCE_SCREENSHARE
        ? "screen"
        : "camera";
    logDelegate(
      kind_,
      "remote_publication_subscription_failed",
      {
        {"publicationId", publication_id},
        {"participantIdentity", publication->participant_identity},
        {"reason", std::string(reason)},
        {"error", error}
      }
    );
    if (!publication->is_video) return;
    MediaCommand failed;
    failed.type = "__remoteVideoFailed";
    failed.track_id = publication_id;
    failed.participant_identity = publication->participant_identity;
    failed.video_source = video_source;
    failed.recovery_mode = "subscription";
    failed.internal_message = error.empty()
      ? std::string("Remote video subscription failed")
      : error;
    {
      std::lock_guard lock(mutex_);
      failed.session_id = session_id_;
      failed.generation = generation_;
    }
    post_(std::move(failed));
  }

  void handleRemoteVideoEnded(
    const std::string& publication_id,
    const std::shared_ptr<livekit::Track>& track,
    const std::string&
  ) {
    CallbackGuard callback(*this);
    if (!callback) return;
    if (!remote_publications_.isCurrentDemandedTrack(publication_id, track)) return;
    // The local reader ending does not detach the SDK RemoteTrack. Keep it as
    // the source for a bridge-only retry; unsubscribe/unpublish callbacks own
    // the current_track transition.
  }

  void registerRemotePublication(
    const std::shared_ptr<livekit::RemoteTrackPublication>& publication,
    const std::string& participant_identity
  ) {
    if (!publication) return;
    const auto publication_id = publication->sid();
    const auto registered = remote_publications_.registerPublication(
      publication,
      participant_identity
    );
    if (!registered) return;
    requestRemotePublicationReconcile(publication_id);
    if (registered->is_video) {
      postRemoteVideoPublication("__remoteVideoPublicationAvailable", publication_id,
                                 registered->participant_identity,
                                 registered->source);
    }
  }

  void requestRemotePublicationReconcile(const std::string& publication_id) {
    MediaCommand command;
    command.type = "__reconcileRemotePublication";
    command.track_id = publication_id;
    {
      std::lock_guard lock(mutex_);
      command.session_id = session_id_;
      command.generation = generation_;
    }
    post_(std::move(command));
  }

  void requestAllRemotePublicationReconcile() {
    for (const auto& publication_id : remote_publications_.publicationIds()) {
      requestRemotePublicationReconcile(publication_id);
    }
  }

  void postRemoteVideoPublication(
    std::string type,
    std::string publication_id,
    std::string participant_identity,
    livekit::TrackSource source
  ) {
    MediaCommand command;
    command.type = std::move(type);
    command.track_id = std::move(publication_id);
    command.participant_identity = std::move(participant_identity);
    command.video_source = source == livekit::TrackSource::SOURCE_SCREENSHARE
      ? "screen"
      : "camera";
    {
      std::lock_guard lock(mutex_);
      command.session_id = session_id_;
      command.generation = generation_;
    }
    post_(std::move(command));
  }

  void removeRemotePublicationsForParticipant(const std::string& participant_identity) {
    for (const auto& removed :
         remote_publications_.removeParticipant(participant_identity)) {
      const auto publication_id = removed.publication
        ? removed.publication->sid()
        : std::string{};
      if (publication_id.empty()) continue;
      if (!removed.is_video) {
        audio_output_.removeTrack(publication_id);
        continue;
      }
      remote_video_.removeTrack(publication_id);
      postRemoteVideoPublication(
        "__remoteVideoPublicationUnavailable",
        publication_id,
        removed.participant_identity,
        removed.source
      );
    }
  }

  void clearRemotePublications() {
    for (const auto& removed : remote_publications_.clear()) {
      const auto publication_id = removed.publication
        ? removed.publication->sid()
        : std::string{};
      if (publication_id.empty()) continue;
      if (!removed.is_video) {
        audio_output_.removeTrack(publication_id);
        continue;
      }
      remote_video_.removeTrack(publication_id);
      postRemoteVideoPublication(
        "__remoteVideoPublicationUnavailable",
        publication_id,
        removed.participant_identity,
        removed.source
      );
    }
  }

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

  void postOutputState(RemoteAudioOutputState state) {
    MediaCommand command;
    command.type = "__voiceOutputStateChanged";
    {
      std::lock_guard lock(mutex_);
      command.session_id = session_id_;
      command.generation = generation_;
    }
    command.status = std::string(outputPhaseName(state.phase));
    command.device_id = std::move(state.active_device_id);
    command.source_id = std::move(state.resolved_endpoint_id);
    command.recovery_mode = state.using_fallback ? "fallback" : "selected";
    command.internal_message = std::move(state.detail);
    command.internal_epoch = state.renderer_epoch;
    if (state.failure) {
      command.video_source = std::move(state.failure->code);
      if (command.internal_message.empty()) {
        command.internal_message = std::move(state.failure->message);
      }
      command.diagnostic_hresult =
        static_cast<std::int64_t>(state.failure->hresult);
      command.diagnostic_retryable = state.failure->retryable;
    }
    post_(std::move(command));
  }

  void postOutputTrackFailure(
    AudioFailureInfo failure,
    std::string track_id,
    std::uint64_t renderer_epoch
  ) {
    MediaCommand command;
    command.type = "__voiceRemoteAudioTrackFailed";
    {
      std::lock_guard lock(mutex_);
      command.session_id = session_id_;
      command.generation = generation_;
    }
    command.internal_message = std::move(failure.message);
    command.video_source = std::move(failure.code);
    command.diagnostic_hresult = static_cast<std::int64_t>(failure.hresult);
    command.diagnostic_retryable = failure.retryable;
    command.track_id = std::move(track_id);
    command.internal_epoch = renderer_epoch;
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
  std::shared_ptr<PostedCommandGate> post_gate_;
  LiveKitVoiceSession::InternalPost post_;
  std::shared_ptr<LiveKitRuntimeLifetime> sdk_runtime_lifetime_;
  RemoteAudioOutput audio_output_;
  RemoteVideoBridge remote_video_;
  RemoteVideoBridge local_camera_preview_;
  RemotePublicationReconciler remote_publications_;
};

class RealLiveKitRoomOwner final : public LiveKitVoiceRoomOwner {
 public:
  RealLiveKitRoomOwner(
    std::string kind,
    std::string terminal_type,
    std::string session_id,
    std::uint64_t generation,
    LiveKitVoiceSession::InternalPost post
  ) : delegate_(std::make_shared<PostedRoomDelegate>(
        std::move(kind),
        std::move(terminal_type),
        std::move(session_id),
        generation,
        std::move(post)
      )) {
    room_.setDelegate(delegate_.get());
  }

  ~RealLiveKitRoomOwner() override {
    // LiveKit disconnect is asynchronous. Destroying Room immediately after
    // requesting it races its signalling/subscription callbacks during rapid
    // make-before-break moves. Keep the delegate alive until the terminal
    // callback is observed, then detach it before Room teardown.
    delegate_->markIntentionalDisconnect();
    delegate_->retainSdkRuntimeLifetime(runtimeLifetimeToken());
    delegate_->beginShutdown();
    delegate_->stopAudio();
    delegate_->stopVideoBridges();
    const auto deadline =
      std::chrono::steady_clock::now() + kNativeShutdownBudget;
    try {
      closeUntil(deadline);
    } catch (...) {
    }
    room_.setDelegate(nullptr);
    const auto now = std::chrono::steady_clock::now();
    const auto callback_budget = now < deadline
      ? std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now)
      : std::chrono::milliseconds::zero();
    if (!delegate_->waitForCallbacks(callback_budget)) {
      logDelegate(
        "voice",
        "callback_shutdown_timeout",
        {{"deadlineMs", static_cast<std::uint64_t>(
          kNativeShutdownBudget.count()
        )}}
      );
    }
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
    const bool connected = delegate_->waitConnected(timeout);
    if (connected) delegate_->registerInitialRemotePublications(room_);
    return connected;
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

  void setDeafened(bool value) override { delegate_->setDeafened(value); }
  std::uint64_t setOutputDevice(std::string value) override {
    return delegate_->setOutputDevice(std::move(value));
  }
  std::string outputDeviceId() const override {
    return delegate_->outputDeviceId();
  }
  void setOutputVolume(float value) override { delegate_->setOutputVolume(value); }
  void configureRemoteAudio(RemoteAudioSettings settings) override {
    delegate_->configureRemoteAudio(std::move(settings));
  }
  void stopAudio() override { delegate_->stopAudio(); }
  void releaseRemoteVideoFrame(std::string track_id, std::uint64_t sequence) override {
    delegate_->releaseRemoteVideoFrame(std::move(track_id), sequence);
  }
  void startLocalCameraPreview(
    std::string session_id,
    std::uint64_t generation,
    std::string track_id,
    std::string participant_identity,
    const std::shared_ptr<livekit::LocalVideoTrack>& track
  ) override {
    delegate_->startLocalCameraPreview(
      std::move(session_id),
      generation,
      std::move(track_id),
      std::move(participant_identity),
      track
    );
  }
  void stopLocalCameraPreview(const std::string& track_id) override {
    delegate_->stopLocalCameraPreview(track_id);
  }
  void releaseLocalCameraPreviewFrame(
    std::string track_id,
    std::uint64_t sequence
  ) override {
    delegate_->releaseLocalCameraPreviewFrame(std::move(track_id), sequence);
  }
  void setRemoteVideoDemand(std::string track_id, bool demanded) override {
    delegate_->setRemoteVideoDemand(track_id, demanded);
  }
  void reconcileRemotePublication(std::string track_id) override {
    delegate_->reconcileRemotePublication(track_id);
  }
  void retryRemoteVideo(
    std::string track_id,
    std::string reason
  ) override {
    delegate_->retryRemoteVideo(track_id, reason);
  }

  void disconnect() override {
    close();
  }

 private:
  void close() {
    closeUntil(
      std::chrono::steady_clock::now() + std::chrono::seconds(2)
    );
  }

  void closeUntil(std::chrono::steady_clock::time_point deadline) {
    if (!disconnect_requested_.exchange(true)) {
      room_.disconnect();
    }
    const auto now = std::chrono::steady_clock::now();
    delegate_->waitDisconnected(
      now < deadline
        ? std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now)
        : std::chrono::milliseconds::zero()
    );
  }

  std::shared_ptr<PostedRoomDelegate> delegate_;
  livekit::Room room_;
  std::atomic_bool disconnect_requested_{false};
};

class RealLiveKitVoiceSession final : public LiveKitVoiceSession {
 public:
  explicit RealLiveKitVoiceSession(
    LiveKitVoiceRoomOwnerFactory voice_room_factory
  ) : voice_room_factory_(std::move(voice_room_factory)) {
    if (!voice_room_factory_) {
      voice_room_factory_ = [](auto kind, auto terminal_type, auto session_id,
                               auto generation, auto post) {
        return std::make_shared<RealLiveKitRoomOwner>(
          std::move(kind), std::move(terminal_type), std::move(session_id),
          generation, std::move(post)
        );
      };
    }
  }

  bool connectVoice(
    std::string session_id,
    std::uint64_t generation,
    const std::string& livekit_url,
    const std::string& livekit_token,
    InternalPost post
  ) override {
    requireRuntimeReady();
    std::unique_lock lifecycle_lock(voice_lifecycle_mutex_);
    std::shared_ptr<LiveKitVoiceRoomOwner> room;
    std::shared_ptr<LiveKitVoiceRoomOwner> retired_room;
    {
      std::unique_lock operation_lock(voice_operation_mutex_);
      std::lock_guard lock(mutex_);
      if (voice_room_ && voice_room_->isConnected()) {
        if (session_id != voice_session_id_ || generation != voice_generation_ ||
            livekit_url != livekit_url_ || livekit_token != livekit_token_) {
          throw std::runtime_error(
            "voice_connection_conflict: LiveKit voice Room already owns another epoch or credential lease"
          );
        }
        return true;
      }
      retired_room = std::move(voice_room_);
      voice_session_id_.clear();
      voice_generation_ = 0;
      livekit_url_.clear();
      livekit_token_.clear();
    }
    // Room teardown waits for signalling and delegate callbacks. Never run it
    // while mutex_ is held because JS-facing snapshots also take that lock.
    retired_room.reset();
    room = voice_room_factory_(
      "voice",
      "__voiceTerminal",
      session_id,
      generation,
      std::move(post)
    );
    room->retainRuntimeLifetime(runtimeLifetimeToken());
    const auto started_at = LiveKitConnectPolicy::Clock::now();
    auto options = LiveKitConnectPolicy::roomOptions(
      LiveKitConnectPolicy::remainingConnectTimeout(started_at, started_at)
    );
    const bool connected =
      room->connect(livekit_url, livekit_token, options) &&
      room->waitConnected(LiveKitConnectPolicy::remainingPostConnectWait(
        started_at, LiveKitConnectPolicy::Clock::now()
      ));
    if (!connected) {
      room->markIntentionalDisconnect();
      room->stopAudio();
      room->disconnect();
      return false;
    }
    // Publish the owner only after its SDK connection has committed. Track
    // actors can never acquire a half-connected Room, and disconnectVoice()
    // cannot race Room::connect()/waitConnected() because both operations own
    // voice_lifecycle_mutex_.
    {
      std::unique_lock operation_lock(voice_operation_mutex_);
      std::lock_guard lock(mutex_);
      voice_room_ = room;
      voice_session_id_ = session_id;
      voice_generation_ = generation;
      livekit_url_ = livekit_url;
      livekit_token_ = livekit_token;
    }
    return true;
  }

  void requireVoiceSession(const std::string& session_id) const override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot(session_id, 0);
    if (!room || !room->isConnected()) {
      throw std::runtime_error("LiveKit voice Room is not connected");
    }
  }

  bool isVoiceConnected() const override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot();
    return room && room->isConnected();
  }

  void setVoiceDeafened(bool value) override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot();
    if (room) room->setDeafened(value);
  }

  std::uint64_t setVoiceOutputDevice(std::string value) override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot();
    return room ? room->setOutputDevice(std::move(value)) : 0;
  }
  std::string voiceOutputDeviceId() const override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot();
    return room ? room->outputDeviceId() : std::string{"default"};
  }
  void setVoiceOutputVolume(float value) override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot();
    if (room) room->setOutputVolume(value);
  }
  void configureRemoteAudio(RemoteAudioSettings settings) override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot();
    if (room) room->configureRemoteAudio(std::move(settings));
  }

  void releaseRemoteVideoFrame(std::string track_id, std::uint64_t sequence) override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot();
    if (room) room->releaseRemoteVideoFrame(std::move(track_id), sequence);
  }
  void setRemoteVideoDemand(std::string track_id, bool demanded) override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot();
    if (room) room->setRemoteVideoDemand(std::move(track_id), demanded);
  }
  void reconcileRemotePublication(std::string track_id) override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot();
    if (room) room->reconcileRemotePublication(std::move(track_id));
  }
  void retryRemoteVideo(
    std::string track_id,
    std::string reason
  ) override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot();
    if (room) {
      room->retryRemoteVideo(
        std::move(track_id),
        std::move(reason)
      );
    }
  }

  void startLocalCameraPreview(
    std::string session_id,
    std::uint64_t generation,
    std::string track_id,
    std::string participant_identity,
    std::shared_ptr<livekit::LocalVideoTrack> track
  ) override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot(session_id, generation);
    if (!room) throw std::runtime_error("stale LiveKit voice connection epoch");
    room->startLocalCameraPreview(
      std::move(session_id),
      generation,
      std::move(track_id),
      std::move(participant_identity),
      track
    );
  }

  void stopLocalCameraPreview(std::string track_id) override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot();
    if (room) room->stopLocalCameraPreview(track_id);
  }

  void releaseLocalCameraPreviewFrame(
    std::string track_id,
    std::uint64_t sequence
  ) override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot();
    if (room) room->releaseLocalCameraPreviewFrame(std::move(track_id), sequence);
  }

  void disconnectVoice() override {
    requireRuntimeReady();
    std::unique_lock lifecycle_lock(voice_lifecycle_mutex_);
    std::shared_ptr<LiveKitVoiceRoomOwner> room;
    {
      std::unique_lock operation_lock(voice_operation_mutex_);
      std::lock_guard lock(mutex_);
      room = std::move(voice_room_);
      voice_session_id_.clear();
      voice_generation_ = 0;
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
    requireRuntimeReady();
    return livekit::LocalAudioTrack::createLocalAudioTrack("microphone", source);
  }

  std::string publishAudioTrack(
    const std::string& session_id,
    std::uint64_t generation,
    const std::shared_ptr<livekit::LocalAudioTrack>& track,
    const livekit::TrackPublishOptions& options
  ) override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot(session_id, generation);
    if (!room) throw std::runtime_error("stale LiveKit voice connection epoch");
    return room->publishAudioTrack(track, options);
  }

  std::string publishVideoTrack(
    const std::string& session_id,
    std::uint64_t generation,
    const std::shared_ptr<livekit::LocalVideoTrack>& track,
    const livekit::TrackPublishOptions& options
  ) override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot(session_id, generation);
    if (!room) throw std::runtime_error("stale LiveKit voice connection epoch");
    return room->publishVideoTrack(track, options);
  }

  void unpublishTrack(
    const std::string& session_id,
    std::uint64_t generation,
    const std::string& publication_sid
  ) override {
    std::unique_lock operation_lock(voice_operation_mutex_);
    const auto room = roomSnapshot(session_id, generation);
    if (room) room->unpublishTrack(publication_sid);
  }

  std::shared_ptr<LiveKitVoiceRoomOwner> roomSnapshot(
    const std::string& session_id,
    std::uint64_t
  ) const {
    requireRuntimeReady();
    std::lock_guard lock(mutex_);
    // session_id is the Room connection epoch. Media generations are
    // actor-local stale-work fences and may advance without reconnecting it.
    if (voice_session_id_ != session_id) return {};
    return voice_room_;
  }

  std::shared_ptr<LiveKitVoiceRoomOwner> roomSnapshot() const {
    requireRuntimeReady();
    std::lock_guard lock(mutex_);
    return voice_room_;
  }

 private:
  void requireRuntimeReady() const {
    const auto lifetime = runtimeLifetimeToken();
    if (!lifetime || !lifetime->initialized()) {
      throw std::logic_error(
        "LiveKit voice session used without an initialized runtime lifetime"
      );
    }
  }

  mutable std::mutex mutex_;
  // Connect/disconnect own the lifecycle gate. Room operations use a separate
  // serialized gate, so contention waits instead of masquerading as a lost
  // connection, while teardown of an already-detached owner does not stall
  // JS-facing snapshots and controls.
  mutable std::mutex voice_lifecycle_mutex_;
  mutable std::mutex voice_operation_mutex_;
  std::shared_ptr<LiveKitVoiceRoomOwner> voice_room_;
  std::string voice_session_id_;
  std::uint64_t voice_generation_ = 0;
  std::string livekit_url_;
  std::string livekit_token_;
  LiveKitVoiceRoomOwnerFactory voice_room_factory_;
};

}  // namespace

std::shared_ptr<LiveKitVoiceSession> createRealLiveKitVoiceSession(
  std::shared_ptr<LiveKitRuntimeLifetime> runtime_lifetime,
  LiveKitVoiceRoomOwnerFactory voice_room_factory
) {
  if (!runtime_lifetime) {
    throw std::invalid_argument(
      "Real LiveKit voice session requires a runtime lifetime"
    );
  }
  auto voice_session = std::make_shared<RealLiveKitVoiceSession>(
    std::move(voice_room_factory)
  );
  voice_session->retainRuntimeLifetime(std::move(runtime_lifetime));
  return voice_session;
}

bool DeterministicFakeLiveKitVoiceSession::connectVoice(
  std::string session_id,
  std::uint64_t generation,
  const std::string& livekit_url,
  const std::string& livekit_token,
  InternalPost
) {
  {
    std::lock_guard lock(mutex_);
    if (voice_connected_) {
      if (voice_session_id_ != session_id || voice_generation_ != generation ||
          voice_livekit_url_ != livekit_url || voice_livekit_token_ != livekit_token) {
        throw std::runtime_error("voice_connection_conflict: fake voice Room owns another lease");
      }
      return true;
    }
  }
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
    if (voice_connected_) {
      voice_session_id_ = std::move(session_id);
      voice_generation_ = generation;
      voice_livekit_url_ = livekit_url;
      voice_livekit_token_ = livekit_token;
    }
  }
  return release.bool_result;
}

void DeterministicFakeLiveKitVoiceSession::requireVoiceSession(
  const std::string& session_id
) const {
  if (!isVoiceSessionCurrent(session_id)) {
    throw std::runtime_error("LiveKit voice Room is not connected");
  }
}

bool DeterministicFakeLiveKitVoiceSession::isVoiceConnected() const {
  std::lock_guard lock(mutex_);
  return voice_connected_;
}

void DeterministicFakeLiveKitVoiceSession::setVoiceDeafened(bool value) {
  std::lock_guard lock(mutex_);
  voice_deafened_ = value;
}

std::uint64_t DeterministicFakeLiveKitVoiceSession::setVoiceOutputDevice(
  std::string value
) {
  std::lock_guard lock(mutex_);
  voice_output_device_id_ = std::move(value);
  return ++voice_output_epoch_;
}

std::string
DeterministicFakeLiveKitVoiceSession::voiceOutputDeviceId() const {
  std::lock_guard lock(mutex_);
  return voice_output_device_id_;
}

void DeterministicFakeLiveKitVoiceSession::setVoiceOutputVolume(float) {}
void DeterministicFakeLiveKitVoiceSession::configureRemoteAudio(RemoteAudioSettings) {}

void DeterministicFakeLiveKitVoiceSession::releaseRemoteVideoFrame(
  std::string,
  std::uint64_t
) {}

void DeterministicFakeLiveKitVoiceSession::setRemoteVideoDemand(std::string, bool) {}
void DeterministicFakeLiveKitVoiceSession::reconcileRemotePublication(std::string) {}
void DeterministicFakeLiveKitVoiceSession::retryRemoteVideo(
  std::string,
  std::string
) {}

void DeterministicFakeLiveKitVoiceSession::startLocalCameraPreview(
  std::string,
  std::uint64_t,
  std::string,
  std::string,
  std::shared_ptr<livekit::LocalVideoTrack>
) {
  std::lock_guard lock(mutex_);
  local_camera_preview_start_count_ += 1;
}

void DeterministicFakeLiveKitVoiceSession::stopLocalCameraPreview(std::string) {
  std::lock_guard lock(mutex_);
  local_camera_preview_stop_count_ += 1;
}

void DeterministicFakeLiveKitVoiceSession::releaseLocalCameraPreviewFrame(
  std::string,
  std::uint64_t
) {}

void DeterministicFakeLiveKitVoiceSession::disconnectVoice() {
  {
    std::lock_guard lock(mutex_);
    disconnect_call_count_ += 1;
    if (voice_connect_pending_ > 0 && cancel_pending_connect_on_disconnect_) {
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
  voice_session_id_.clear();
  voice_generation_ = 0;
  voice_livekit_url_.clear();
  voice_livekit_token_.clear();
}

std::shared_ptr<livekit::LocalAudioTrack>
DeterministicFakeLiveKitVoiceSession::createMicrophoneTrack(
  const std::shared_ptr<livekit::AudioSource>&
) {
  return {};
}

std::string DeterministicFakeLiveKitVoiceSession::publishAudioTrack(
  const std::string& session_id,
  std::uint64_t,
  const std::shared_ptr<livekit::LocalAudioTrack>&,
  const livekit::TrackPublishOptions&
) {
  if (!isVoiceSessionCurrent(session_id)) {
    throw std::runtime_error("stale LiveKit voice connection epoch");
  }
  const auto release = enterGate(Operation::Publish);
  if (release.error_message) throw std::runtime_error(*release.error_message);
  return release.publication_sid;
}

std::string DeterministicFakeLiveKitVoiceSession::publishVideoTrack(
  const std::string& session_id,
  std::uint64_t generation,
  const std::shared_ptr<livekit::LocalVideoTrack>&,
  const livekit::TrackPublishOptions& options
) {
  return publishAudioTrack(session_id, generation, {}, options);
}

void DeterministicFakeLiveKitVoiceSession::unpublishTrack(
  const std::string& session_id,
  std::uint64_t,
  const std::string& publication_sid
) {
  if (!isVoiceSessionCurrent(session_id)) return;
  const auto release = enterGate(Operation::Unpublish);
  if (release.error_message) throw std::runtime_error(*release.error_message);
  recordUnpublishedPublicationSid(publication_sid);
}

void DeterministicFakeLiveKitVoiceSession::setBlocked(Operation operation, bool blocked) {
  {
    std::lock_guard lock(mutex_);
    gateState(operation).blocked = blocked;
  }
  changed_.notify_all();
}

void DeterministicFakeLiveKitVoiceSession::setCancelPendingConnectOnDisconnect(
  bool cancel
) {
  std::lock_guard lock(mutex_);
  cancel_pending_connect_on_disconnect_ = cancel;
}

void DeterministicFakeLiveKitVoiceSession::releaseNext(Operation operation, Release release) {
  {
    std::lock_guard lock(mutex_);
    gateState(operation).releases.push_back(std::move(release));
  }
  changed_.notify_all();
}

void DeterministicFakeLiveKitVoiceSession::waitUntilPending(
  Operation operation,
  std::size_t count,
  std::chrono::milliseconds timeout
) {
  std::unique_lock lock(mutex_);
  if (!changed_.wait_for(lock, timeout, [&] {
        return gateState(operation).pending >= count;
      })) {
    const auto& state = gateState(operation);
    throw std::runtime_error(
      "timed out waiting for fake LiveKit operation " +
      std::to_string(static_cast<int>(operation)) + " (pending=" +
      std::to_string(state.pending) + ", expected=" + std::to_string(count) + ")"
    );
  }
}

std::size_t DeterministicFakeLiveKitVoiceSession::pending(Operation operation) const {
  std::lock_guard lock(mutex_);
  return gateState(operation).pending;
}

std::vector<std::string>
DeterministicFakeLiveKitVoiceSession::unpublishedPublicationSids() const {
  std::lock_guard lock(mutex_);
  return unpublished_publication_sids_;
}

std::size_t DeterministicFakeLiveKitVoiceSession::localCameraPreviewStartCount() const {
  std::lock_guard lock(mutex_);
  return local_camera_preview_start_count_;
}

std::size_t DeterministicFakeLiveKitVoiceSession::localCameraPreviewStopCount() const {
  std::lock_guard lock(mutex_);
  return local_camera_preview_stop_count_;
}

std::size_t DeterministicFakeLiveKitVoiceSession::disconnectCallCount() const {
  std::lock_guard lock(mutex_);
  return disconnect_call_count_;
}

bool DeterministicFakeLiveKitVoiceSession::isVoiceSessionCurrent(
  const std::string& session_id
) const {
  std::lock_guard lock(mutex_);
  return voice_connected_ && voice_session_id_ == session_id;
}

void DeterministicFakeLiveKitVoiceSession::setVoiceSessionForTest(
  std::string session_id
) {
  std::lock_guard lock(mutex_);
  voice_connected_ = true;
  voice_session_id_ = std::move(session_id);
}

void DeterministicFakeLiveKitVoiceSession::recordUnpublishedPublicationSid(
  std::string publication_sid
) {
  std::lock_guard lock(mutex_);
  unpublished_publication_sids_.push_back(std::move(publication_sid));
}

DeterministicFakeLiveKitVoiceSession::Release
DeterministicFakeLiveKitVoiceSession::enterGate(Operation operation) {
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

DeterministicFakeLiveKitVoiceSession::GateState&
DeterministicFakeLiveKitVoiceSession::gateState(Operation operation) {
  switch (operation) {
    case Operation::Connect: return connect_;
    case Operation::Publish: return publish_;
    case Operation::Unpublish: return unpublish_;
    case Operation::Disconnect: return disconnect_;
  }
  throw std::logic_error("unknown LiveKit fake operation");
}

const DeterministicFakeLiveKitVoiceSession::GateState&
DeterministicFakeLiveKitVoiceSession::gateState(Operation operation) const {
  switch (operation) {
    case Operation::Connect: return connect_;
    case Operation::Publish: return publish_;
    case Operation::Unpublish: return unpublish_;
    case Operation::Disconnect: return disconnect_;
  }
  throw std::logic_error("unknown LiveKit fake operation");
}

}  // namespace syrnike::desktop_native::media
