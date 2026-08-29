#include "livekit_voice_session.hpp"

#include <livekit/local_track_publication.h>
#include <livekit/remote_track_publication.h>
#include <livekit/room_delegate.h>

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <future>
#include <optional>
#include <shared_mutex>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <type_traits>
#include <unordered_map>
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

std::string qualityLimitationReason(
  livekit::QualityLimitationReason reason
) {
  switch (reason) {
    case livekit::QualityLimitationReason::None: return "none";
    case livekit::QualityLimitationReason::Cpu: return "cpu";
    case livekit::QualityLimitationReason::Bandwidth: return "bandwidth";
    case livekit::QualityLimitationReason::Other: return "other";
  }
  return "unknown";
}

std::string codecLabel(const livekit::RtcCodecStats& codec) {
  if (codec.codec.mime_type.empty()) return {};
  if (codec.codec.payload_type == 0) return codec.codec.mime_type;
  return codec.codec.mime_type + " (" +
    std::to_string(codec.codec.payload_type) + ")";
}

std::string candidateAddress(const livekit::RtcStats* stat) {
  if (!stat) return {};
  if (const auto* local = std::get_if<livekit::RtcLocalCandidateStats>(
        &stat->stats
      )) {
    return local->candidate.address.empty()
      ? std::string{}
      : local->candidate.address + ":" +
          std::to_string(local->candidate.port);
  }
  if (const auto* remote = std::get_if<livekit::RtcRemoteCandidateStats>(
        &stat->stats
      )) {
    return remote->candidate.address.empty()
      ? std::string{}
      : remote->candidate.address + ":" +
          std::to_string(remote->candidate.port);
  }
  return {};
}

void appendVoiceRtcStats(
  const std::vector<livekit::RtcStats>& records,
  const std::string& role,
  VoiceRtcTransportTelemetry& transport,
  std::vector<VoiceRtcStreamTelemetry>& outbound,
  std::vector<VoiceRtcStreamTelemetry>& inbound
) {
  std::unordered_map<std::string, const livekit::RtcStats*> by_id;
  std::unordered_map<std::string, std::string> codecs;
  std::unordered_map<std::string, livekit::RemoteInboundRtpStreamStats>
    remote_inbound;
  const livekit::CandidatePairStats* selected_pair = nullptr;
  std::string selected_pair_id;

  for (const auto& record : records) {
    std::visit([&](const auto& typed) {
      by_id.emplace(typed.rtc.id, &record);
      using Typed = std::decay_t<decltype(typed)>;
      if constexpr (std::is_same_v<Typed, livekit::RtcCodecStats>) {
        codecs.emplace(typed.rtc.id, codecLabel(typed));
      } else if constexpr (
        std::is_same_v<Typed, livekit::RtcRemoteInboundRtpStats>
      ) {
        remote_inbound.emplace(
          typed.remote_inbound.local_id,
          typed.remote_inbound
        );
      } else if constexpr (
        std::is_same_v<Typed, livekit::RtcCandidatePairStats>
      ) {
        const bool succeeded =
          typed.candidate_pair.state ==
          livekit::IceCandidatePairState::Succeeded;
        if (
          typed.candidate_pair.nominated ||
          (!selected_pair && succeeded)
        ) {
          selected_pair = &typed.candidate_pair;
          selected_pair_id = typed.rtc.id;
        }
      }
    }, record.stats);
  }

  if (selected_pair) {
    transport.available = true;
    transport.bytes_sent += selected_pair->bytes_sent;
    transport.bytes_received += selected_pair->bytes_received;
    transport.packets_sent += selected_pair->packets_sent;
    transport.packets_received += selected_pair->packets_received;
    transport.available_outgoing_bitrate = std::max(
      transport.available_outgoing_bitrate,
      selected_pair->available_outgoing_bitrate
    );
    transport.available_incoming_bitrate = std::max(
      transport.available_incoming_bitrate,
      selected_pair->available_incoming_bitrate
    );
    const auto ping_ms = selected_pair->current_round_trip_time * 1000.0;
    if (ping_ms > 0.0) {
      transport.ping_ms = std::max(transport.ping_ms, ping_ms);
    }
    if (transport.selected_candidate_pair_id.empty()) {
      transport.selected_candidate_pair_id = selected_pair_id;
      const auto local = by_id.find(selected_pair->local_candidate_id);
      const auto remote = by_id.find(selected_pair->remote_candidate_id);
      transport.local_address = candidateAddress(
        local == by_id.end() ? nullptr : local->second
      );
      transport.remote_address = candidateAddress(
        remote == by_id.end() ? nullptr : remote->second
      );
    }
  }

  for (const auto& record : records) {
    if (const auto* typed = std::get_if<livekit::RtcOutboundRtpStats>(
          &record.stats
        )) {
      VoiceRtcStreamTelemetry stream;
      stream.id = role + ":" + typed->rtc.id;
      stream.pc_role = role;
      stream.kind = typed->stream.kind;
      stream.ssrc = typed->stream.ssrc;
      stream.mid = typed->outbound.mid;
      stream.codec = codecs[typed->stream.codec_id];
      stream.target_bitrate = typed->outbound.target_bitrate;
      stream.bytes_sent = typed->sent.bytes_sent;
      stream.packets_sent = typed->sent.packets_sent;
      stream.retransmitted_packets_sent =
        typed->outbound.retransmitted_packets_sent;
      stream.retransmitted_bytes_sent =
        typed->outbound.retransmitted_bytes_sent;
      stream.nack_count = typed->outbound.nack_count;
      stream.fir_count = typed->outbound.fir_count;
      stream.pli_count = typed->outbound.pli_count;
      stream.frames_sent = typed->outbound.frames_sent;
      stream.frames_encoded = typed->outbound.frames_encoded;
      stream.frames_per_second = typed->outbound.frames_per_second;
      stream.frame_width = typed->outbound.frame_width;
      stream.frame_height = typed->outbound.frame_height;
      stream.quality_limitation_reason = qualityLimitationReason(
        typed->outbound.quality_limitation_reason
      );
      stream.encoder_implementation = typed->outbound.encoder_implementation;
      const auto remote = remote_inbound.find(typed->rtc.id);
      if (remote != remote_inbound.end()) {
        stream.has_remote_inbound = true;
        stream.packet_loss_percent = std::max(
          0.0,
          remote->second.fraction_lost * 100.0
        );
        stream.round_trip_time_ms = std::max(
          0.0,
          remote->second.round_trip_time * 1000.0
        );
      }
      outbound.push_back(std::move(stream));
      continue;
    }

    if (const auto* typed = std::get_if<livekit::RtcInboundRtpStats>(
          &record.stats
        )) {
      VoiceRtcStreamTelemetry stream;
      stream.id = role + ":" + typed->rtc.id;
      stream.pc_role = role;
      stream.kind = typed->stream.kind;
      stream.ssrc = typed->stream.ssrc;
      stream.mid = typed->inbound.mid;
      stream.track_identifier = typed->inbound.track_identifier;
      stream.codec = codecs[typed->stream.codec_id];
      stream.bytes_received = typed->inbound.bytes_received;
      stream.packets_received = typed->received.packets_received;
      stream.packets_lost = typed->received.packets_lost;
      stream.jitter = typed->received.jitter;
      stream.retransmitted_packets_received =
        typed->inbound.retransmitted_packets_received;
      stream.retransmitted_bytes_received =
        typed->inbound.retransmitted_bytes_received;
      stream.packets_discarded = typed->inbound.packets_discarded;
      stream.nack_count = typed->inbound.nack_count;
      stream.fir_count = typed->inbound.fir_count;
      stream.pli_count = typed->inbound.pli_count;
      stream.frames_received = typed->inbound.frames_received;
      stream.frames_rendered = typed->inbound.frames_rendered;
      stream.frames_decoded = typed->inbound.frames_decoded;
      stream.frames_dropped = typed->inbound.frames_dropped;
      stream.frames_per_second = typed->inbound.frames_per_second;
      stream.frame_width = typed->inbound.frame_width;
      stream.frame_height = typed->inbound.frame_height;
      stream.audio_level = typed->inbound.audio_level;
      stream.total_audio_energy = typed->inbound.total_audio_energy;
      stream.total_samples_duration = typed->inbound.total_samples_duration;
      stream.total_samples_received = typed->inbound.total_samples_received;
      stream.concealed_samples = typed->inbound.concealed_samples;
      stream.silent_concealed_samples =
        typed->inbound.silent_concealed_samples;
      stream.concealment_events = typed->inbound.concealment_events;
      stream.jitter_buffer_delay = typed->inbound.jitter_buffer_delay;
      stream.jitter_buffer_target_delay =
        typed->inbound.jitter_buffer_target_delay;
      stream.jitter_buffer_emitted_count =
        typed->inbound.jitter_buffer_emitted_count;
      stream.freeze_count = typed->inbound.freeze_count;
      stream.total_freeze_duration = typed->inbound.total_freeze_duration;
      stream.pause_count = typed->inbound.pause_count;
      stream.total_pause_duration = typed->inbound.total_pause_duration;
      stream.decoder_implementation = typed->inbound.decoder_implementation;
      inbound.push_back(std::move(stream));
    }
  }
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
    NativeCommandType terminal_type,
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
      terminal_post_(terminal_type_, session_id_, generation_, post_),
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
          NativeCommandType::LocalCameraPreviewFrame,
          NativeCommandType::LocalCameraPreviewTrackRemoved,
          NativeCommandType::LocalCameraPreviewFailed,
          "Local camera preview"
        }
      ) {
    remote_video_.updateIdentity(session_id_, generation_);
  }

  ~PostedRoomDelegate() override {
    terminal_post_.cancel();
    stopAudioRetryScheduler();
  }

  void publishTerminalIncarnation() {
    terminal_post_.publish();
  }

  void onConnectionStateChanged(
    livekit::Room&,
    const livekit::ConnectionStateChangedEvent& event
  ) override {
    CallbackGuard callback(*this);
    if (!callback) return;
    std::string session_id;
    std::uint64_t generation = 0;
    bool resumed_from_reconnect = false;
    {
      std::lock_guard lock(mutex_);
      resumed_from_reconnect =
        state_ == livekit::ConnectionState::Reconnecting &&
        event.state == livekit::ConnectionState::Connected;
      state_ = event.state;
      if (state_ == livekit::ConnectionState::Disconnected) disconnected_ = true;
      session_id = session_id_;
      generation = generation_;
    }
    changed_.notify_all();
    if (event.state == livekit::ConnectionState::Connected) {
      if (resumed_from_reconnect) {
        remote_publications_.resetAudioRetriesForReconnect();
        notifyAudioRetryScheduler();
      }
      requestAllRemotePublicationReconcile();
    }
    if (event.state == livekit::ConnectionState::Connected ||
        event.state == livekit::ConnectionState::Reconnecting) {
      MediaCommand command;
      command.type = NativeCommandType::VoiceConnectionStateChanged;
      command.session_id = session_id;
      command.generation = generation;
      command.status = event.state == livekit::ConnectionState::Connected
                         ? "connected"
                         : "reconnecting";
      post_(std::move(command));
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
    postTerminal(terminal_message);
  }

  void onTrackPublished(livekit::Room&, const livekit::TrackPublishedEvent& event) override {
    CallbackGuard callback(*this);
    if (!callback || !event.publication) return;
    registerRemotePublication(
      event.publication,
      event.participant ? event.participant->identity() : std::string{}
    );
  }

  void onLocalTrackUnpublished(
    livekit::Room&,
    const livekit::LocalTrackUnpublishedEvent& event
  ) override {
    CallbackGuard callback(*this);
    if (
      !callback ||
      !event.publication ||
      event.publication->source() != livekit::TrackSource::SOURCE_MICROPHONE
    ) {
      return;
    }
    MediaCommand command;
    command.type = NativeCommandType::LocalMicrophoneUnpublished;
    {
      std::lock_guard lock(mutex_);
      command.session_id = session_id_;
      command.generation = generation_;
    }
    command.track_id = event.publication->sid();
    post_(std::move(command));
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
    if (!removed) return;
    notifyAudioRetryScheduler();
    if (!removed->is_video) {
      audio_output_.removeTrack(publication_id);
      return;
    }
    remote_video_.removeTrack(publication_id);
    postRemoteVideoPublication(
                               NativeCommandType::RemoteVideoPublicationUnavailable,
                               publication_id,
                               removed->participant_identity, removed->source);
    if (removed->source == livekit::TrackSource::SOURCE_SCREENSHARE) {
      for (const auto& dependent_id :
           remote_publications_.syncScreenAudioDemand(
             removed->participant_identity
           )) {
        requestRemotePublicationReconcile(dependent_id);
      }
      notifyAudioRetryScheduler();
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
      if (!remote_publications_.contains(publication_id)) {
        registerRemotePublication(
          event.publication,
          event.participant ? event.participant->identity() : std::string{}
        );
      }
    }
    const auto subscribed = remote_publications_.onTrackSubscribed(
      publication_id,
      event.publication,
      event.track
    );
    if (!subscribed.matched) return;
    notifyAudioRetryScheduler();
    if (!subscribed.demanded) {
      requestRemotePublicationReconcile(publication_id);
      return;
    }
    if (!subscribed.is_video && !subscribed.duplicate) {
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
    notifyAudioRetryScheduler();
    if (!unsubscribed.is_video) {
      if (unsubscribed.current) {
        audio_output_.removeTrack(publication_id);
      }
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
    handleRemotePublicationSubscriptionFailure(
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
    command.type = NativeCommandType::VoiceActiveSpeakers;
    {
      std::lock_guard lock(mutex_);
      command.session_id = session_id_;
      command.generation = generation_;
    }
    command.participant_identities = std::move(identities);
    post_(std::move(command));
  }

  void setDeafened(bool value) { audio_output_.setDeafened(value); }
  void postStats(livekit::SessionStats stats) {
    MediaCommand command;
    command.type = NativeCommandType::VoiceStats;
    {
      std::lock_guard lock(mutex_);
      command.session_id = session_id_;
      command.generation = generation_;
    }
    appendVoiceRtcStats(
      stats.publisher_stats,
      "publisher",
      command.voice_rtc_transport,
      command.voice_rtc_outbound,
      command.voice_rtc_inbound
    );
    appendVoiceRtcStats(
      stats.subscriber_stats,
      "subscriber",
      command.voice_rtc_transport,
      command.voice_rtc_outbound,
      command.voice_rtc_inbound
    );
    post_(std::move(command));
  }
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
    notifyAudioRetryScheduler();
    if (!demanded) remote_video_.removeTrack(track_id);
    reconcileRemotePublication(track_id);
    if (publication->source == livekit::TrackSource::SOURCE_SCREENSHARE) {
      for (const auto& dependent_id :
           remote_publications_.syncScreenAudioDemand(
             publication->participant_identity
           )) {
        reconcileRemotePublication(dependent_id);
      }
      notifyAudioRetryScheduler();
    }
    // Re-announce before the asynchronous subscription can produce frames so
    // the renderer can lift its unsubscribe tombstone without losing inventory.
    if (demanded) {
      postRemoteVideoPublication(
                                 NativeCommandType::RemoteVideoPublicationAvailable,
                                 track_id,
                                 publication->participant_identity,
                                 publication->source);
    }
  }

  void reconcileRegisteredRemotePublications() {
    for (const auto& publication_id : remote_publications_.publicationIds()) {
      try {
        reconcileRemotePublication(publication_id);
      } catch (const std::exception& error) {
        logDelegate(
          kind_,
          "remote_publication_commit_reconcile_failed",
          {
            {"publicationId", publication_id},
            {"error", error.what()}
          }
        );
        if (!remote_publications_.audioFailureOwnsReconcile(publication_id)) {
          requestRemotePublicationReconcile(publication_id);
        }
      } catch (...) {
        logDelegate(
          kind_,
          "remote_publication_commit_reconcile_failed",
          {{"publicationId", publication_id}}
        );
        if (!remote_publications_.audioFailureOwnsReconcile(publication_id)) {
          requestRemotePublicationReconcile(publication_id);
        }
      }
    }
  }

  void reconcileRemotePublication(
    const std::string& track_id,
    std::uint64_t expected_revision = 0
  ) {
    const auto plan = remote_publications_.planReconcile(
      track_id,
      expected_revision
    );
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
      const auto retry = remote_publications_.markReconcileFailed(plan);
      if (retry) notifyAudioRetryScheduler();
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

  bool waitConnected(
    std::chrono::milliseconds timeout,
    const livekit::OperationCancellation& cancellation
  ) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] {
      return cancellation.isCancellationRequested() ||
        state_ == livekit::ConnectionState::Connected || disconnected_;
    }) && !cancellation.isCancellationRequested() &&
      state_ == livekit::ConnectionState::Connected;
  }

  void notifyConnectionWaiters() { changed_.notify_all(); }

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
    stopAudioRetryScheduler();
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
  void handleRemotePublicationSubscriptionFailure(
    const std::string& publication_id,
    std::string_view reason,
    const std::string& error
  ) {
    const auto failure = remote_publications_.markSubscriptionFailed(
      publication_id,
      reason == "subscription_failed"
    );
    if (!failure) return;
    notifyAudioRetryScheduler();
    const auto& publication = failure->publication;
    logDelegate(
      kind_,
      "remote_publication_subscription_failed",
      {
        {"publicationId", publication_id},
        {"participantIdentity", publication.participant_identity},
        {"reason", std::string(reason)},
        {"error", error}
      }
    );
    if (!publication.is_video) {
      logDelegate(
        kind_,
        "remote_audio_subscription_retry_planned",
        {
          {"publicationId", publication_id},
          {"source", static_cast<std::uint64_t>(publication.source)},
          {"retryAttempt", failure->retry
             ? static_cast<std::uint64_t>(failure->retry->attempt)
             : 0},
          {"retryExhausted", failure->retry_exhausted}
        }
      );
      return;
    }
    const auto video_source =
      publication.source == livekit::TrackSource::SOURCE_SCREENSHARE
        ? "screen"
        : "camera";
    MediaCommand failed;
    failed.type = NativeCommandType::RemoteVideoFailed;
    failed.track_id = publication_id;
    failed.participant_identity = publication.participant_identity;
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
    const bool replacing_publication =
      remote_publications_.contains(publication_id) &&
      !remote_publications_.matches(publication_id, publication);
    const auto registered = remote_publications_.registerPublication(
      publication,
      participant_identity
    );
    if (!registered) return;
    if (replacing_publication && !registered->is_video) {
      audio_output_.removeTrack(publication_id);
    }
    notifyAudioRetryScheduler();
    if (!remote_publications_.audioFailureOwnsReconcile(publication_id)) {
      requestRemotePublicationReconcile(publication_id);
    }
    if (registered->is_video) {
      postRemoteVideoPublication(
                                 NativeCommandType::RemoteVideoPublicationAvailable,
                                 publication_id,
                                 registered->participant_identity,
                                 registered->source);
    }
  }

  bool requestRemotePublicationReconcile(
    const std::string& publication_id,
    std::uint64_t expected_revision = 0
  ) {
    MediaCommand command;
    command.type = NativeCommandType::ReconcileRemotePublication;
    command.track_id = publication_id;
    // Delegate identity is immutable, so the deadline scheduler doesn't take
    // Room/session/voice operation locks to publish its actor command.
    command.session_id = session_id_;
    command.generation = generation_;
    command.internal_epoch = expected_revision;
    return post_(std::move(command));
  }

  void requestAllRemotePublicationReconcile() {
    for (const auto& publication_id : remote_publications_.publicationIds()) {
      if (!remote_publications_.audioFailureOwnsReconcile(publication_id)) {
        requestRemotePublicationReconcile(publication_id);
      }
    }
  }

  void notifyAudioRetryScheduler() {
    {
      std::lock_guard lock(audio_retry_mutex_);
      if (audio_retry_stopping_) return;
      if (!audio_retry_thread_.joinable() &&
          remote_publications_.nextAudioRetryDeadline()) {
        audio_retry_thread_ = std::jthread([this](std::stop_token stop) {
          audioRetryLoop(stop);
        });
      }
      ++audio_retry_wake_revision_;
    }
    audio_retry_changed_.notify_one();
  }

  void stopAudioRetryScheduler() {
    bool join = false;
    {
      std::lock_guard lock(audio_retry_mutex_);
      if (audio_retry_stopping_) return;
      audio_retry_stopping_ = true;
      join = audio_retry_thread_.joinable();
      if (join) audio_retry_thread_.request_stop();
      ++audio_retry_wake_revision_;
    }
    audio_retry_changed_.notify_all();
    if (join) audio_retry_thread_.join();
  }

  void audioRetryLoop(std::stop_token stop) noexcept {
    std::unique_lock lock(audio_retry_mutex_);
    while (!stop.stop_requested()) {
      const auto observed_revision = audio_retry_wake_revision_;
      const auto deadline = remote_publications_.nextAudioRetryDeadline();
      if (!deadline) {
        audio_retry_changed_.wait(lock, [&] {
          return stop.stop_requested() ||
            audio_retry_wake_revision_ != observed_revision;
        });
        continue;
      }
      if (audio_retry_changed_.wait_until(lock, *deadline, [&] {
            return stop.stop_requested() ||
              audio_retry_wake_revision_ != observed_revision;
          })) {
        continue;
      }

      lock.unlock();
      const auto now = std::chrono::steady_clock::now();
      for (const auto& retry : remote_publications_.takeDueAudioRetries(now)) {
        if (stop.stop_requested()) break;
        bool accepted = false;
        try {
          accepted = requestRemotePublicationReconcile(
            retry.publication_id,
            retry.revision
          );
        } catch (...) {
          accepted = false;
        }
        if (accepted) continue;
        const auto rescheduled =
          remote_publications_.markAudioRetryDispatchFailed(
            retry,
            std::chrono::steady_clock::now()
          );
        logDelegate(
          kind_,
          "remote_audio_retry_post_rejected",
          {
            {"publicationId", retry.publication_id},
            {"attempt", static_cast<std::uint64_t>(retry.attempt)},
            {"rescheduled", rescheduled.has_value()}
          }
        );
      }
      lock.lock();
    }
  }

  void postRemoteVideoPublication(
    NativeCommandType type,
    std::string publication_id,
    std::string participant_identity,
    livekit::TrackSource source
  ) {
    MediaCommand command;
    command.type = type;
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
        NativeCommandType::RemoteVideoPublicationUnavailable,
        publication_id,
        removed.participant_identity,
        removed.source
      );
    }
    notifyAudioRetryScheduler();
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
        NativeCommandType::RemoteVideoPublicationUnavailable,
        publication_id,
        removed.participant_identity,
        removed.source
      );
    }
    notifyAudioRetryScheduler();
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

  void postTerminal(std::string message) {
    logDelegate(
      kind_,
      "post_or_buffer_terminal",
      {
        {"sessionId", session_id_},
        {"generation", generation_}
      }
    );
    terminal_post_.post(std::move(message));
  }

  void postOutputState(RemoteAudioOutputState state) {
    MediaCommand command;
    command.type = NativeCommandType::VoiceOutputStateChanged;
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
    command.type = NativeCommandType::VoiceRemoteAudioTrackFailed;
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

  const std::string kind_;
  const NativeCommandType terminal_type_;
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  const std::string session_id_;
  const std::uint64_t generation_;
  livekit::ConnectionState state_ = livekit::ConnectionState::Disconnected;
  bool disconnected_ = false;
  bool intentional_ = false;
  std::mutex callback_mutex_;
  std::condition_variable callbacks_changed_;
  std::size_t active_callbacks_ = 0;
  bool shutting_down_ = false;
  std::shared_ptr<PostedCommandGate> post_gate_;
  LiveKitVoiceSession::InternalPost post_;
  VoiceTerminalPostGate terminal_post_;
  std::shared_ptr<LiveKitRuntimeLifetime> sdk_runtime_lifetime_;
  RemoteAudioOutput audio_output_;
  RemoteVideoBridge remote_video_;
  RemoteVideoBridge local_camera_preview_;
  RemotePublicationReconciler remote_publications_;
  std::mutex audio_retry_mutex_;
  std::condition_variable audio_retry_changed_;
  std::uint64_t audio_retry_wake_revision_ = 0;
  bool audio_retry_stopping_ = false;
  std::jthread audio_retry_thread_;
};

class RealLiveKitRoomOwner final : public LiveKitVoiceRoomOwner {
 public:
  RealLiveKitRoomOwner(
    std::string kind,
    NativeCommandType terminal_type,
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
    stopStats();
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

  bool connectCancellable(
    const std::string& livekit_url,
    const std::string& livekit_token,
    const livekit::RoomOptions& options,
    const livekit::OperationCancellation& cancellation
  ) override {
    return room_.connect(
      livekit_url, livekit_token, options, cancellation
    );
  }

  bool isConnected() const override {
    return delegate_->isConnected();
  }

  void publishTerminalIncarnation() override {
    delegate_->publishTerminalIncarnation();
  }

  bool waitConnected(std::chrono::milliseconds timeout) override {
    const bool connected = delegate_->waitConnected(timeout);
    if (connected) {
      delegate_->registerInitialRemotePublications(room_);
      startStats();
    }
    return connected;
  }

  bool waitConnectedCancellable(
    std::chrono::milliseconds timeout,
    const livekit::OperationCancellation& cancellation
  ) override {
    [[maybe_unused]] const auto cancellation_subscription =
      cancellation.subscribe([delegate = delegate_] {
        delegate->notifyConnectionWaiters();
      });
    const bool connected = delegate_->waitConnected(timeout, cancellation);
    if (connected) {
      delegate_->registerInitialRemotePublications(room_);
      startStats();
    }
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

  LiveKitVoiceRoomOperationResult<std::string> publishAudioTrackUntil(
    const std::shared_ptr<livekit::LocalAudioTrack>& track,
    const livekit::TrackPublishOptions& options,
    std::chrono::steady_clock::time_point deadline,
    const livekit::OperationCancellation& cancellation
  ) override {
    auto participant = room_.localParticipant().lock();
    if (!participant) {
      return LiveKitVoiceRoomOperationResult<std::string>::failure({
        LiveKitVoiceRoomOperationErrorCode::Failed,
        "LiveKit local participant is unavailable"
      });
    }
    const auto result = participant->publishTrackUntil(
      track, options, deadline, cancellation
    );
    if (result.hasError()) {
      return LiveKitVoiceRoomOperationResult<std::string>::failure(
        mapPublicationError(result.error())
      );
    }
    const auto publication = track ? track->publication() : nullptr;
    return LiveKitVoiceRoomOperationResult<std::string>::success(
      publication ? publication->sid() : std::string{}
    );
  }

  LiveKitVoiceRoomOperationResult<std::string> publishVideoTrackUntil(
    const std::shared_ptr<livekit::LocalVideoTrack>& track,
    const livekit::TrackPublishOptions& options,
    std::chrono::steady_clock::time_point deadline,
    const livekit::OperationCancellation& cancellation
  ) override {
    auto participant = room_.localParticipant().lock();
    if (!participant) {
      return LiveKitVoiceRoomOperationResult<std::string>::failure({
        LiveKitVoiceRoomOperationErrorCode::Failed,
        "LiveKit local participant is unavailable"
      });
    }
    const auto result = participant->publishTrackUntil(
      track, options, deadline, cancellation
    );
    if (result.hasError()) {
      return LiveKitVoiceRoomOperationResult<std::string>::failure(
        mapPublicationError(result.error())
      );
    }
    const auto publication = track ? track->publication() : nullptr;
    return LiveKitVoiceRoomOperationResult<std::string>::success(
      publication ? publication->sid() : std::string{}
    );
  }

  LiveKitVoiceRoomOperationResult<void> unpublishTrackUntil(
    const std::string& publication_sid,
    std::chrono::steady_clock::time_point deadline,
    const livekit::OperationCancellation& cancellation
  ) override {
    auto participant = room_.localParticipant().lock();
    if (!participant) {
      return LiveKitVoiceRoomOperationResult<void>::failure({
        LiveKitVoiceRoomOperationErrorCode::Failed,
        "LiveKit local participant is unavailable"
      });
    }
    const auto result = participant->unpublishTrackUntil(
      publication_sid, deadline, cancellation
    );
    if (result.hasError()) {
      return LiveKitVoiceRoomOperationResult<void>::failure(
        mapPublicationError(result.error())
      );
    }
    return LiveKitVoiceRoomOperationResult<void>::success();
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
  void reconcileRemotePublication(
    std::string track_id,
    std::uint64_t expected_revision
  ) override {
    delegate_->reconcileRemotePublication(track_id, expected_revision);
  }
  void reconcileRegisteredRemotePublications() override {
    delegate_->reconcileRegisteredRemotePublications();
  }
  void retryRemoteVideo(
    std::string track_id,
    std::string reason
  ) override {
    delegate_->retryRemoteVideo(track_id, reason);
  }

  void disconnect() override {
    stopStats();
    close();
  }

 private:
  static LiveKitVoiceRoomOperationError mapPublicationError(
    const livekit::TrackPublicationOperationError& error
  ) {
    auto code = LiveKitVoiceRoomOperationErrorCode::Failed;
    if (error.code == livekit::TrackPublicationOperationErrorCode::Timeout) {
      code = LiveKitVoiceRoomOperationErrorCode::Timeout;
    } else if (
      error.code == livekit::TrackPublicationOperationErrorCode::Cancelled
    ) {
      code = LiveKitVoiceRoomOperationErrorCode::Cancelled;
    }
    return {code, error.message};
  }

  void startStats() {
    if (stats_thread_.joinable()) return;
    stats_thread_ = std::jthread([this](std::stop_token stop) {
      std::optional<std::future<livekit::SessionStats>> pending;
      auto next_request = std::chrono::steady_clock::now();
      while (!stop.stop_requested()) {
        const auto now = std::chrono::steady_clock::now();
        if (
          pending &&
          pending->wait_for(std::chrono::milliseconds(0)) ==
            std::future_status::ready
        ) {
          try {
            delegate_->postStats(pending->get());
          } catch (...) {
          }
          pending.reset();
        }
        if (!pending && now >= next_request) {
          next_request = now + std::chrono::seconds(1);
          try {
            pending.emplace(room_.getStats());
          } catch (...) {
          }
        }
        for (int tick = 0; tick < 2 && !stop.stop_requested(); ++tick) {
          std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
      }
    });
  }

  void stopStats() {
    if (!stats_thread_.joinable()) return;
    stats_thread_.request_stop();
    stats_thread_.join();
  }

  void close() {
    closeUntil(
      std::chrono::steady_clock::now() + std::chrono::seconds(2)
    );
  }

  void closeUntil(std::chrono::steady_clock::time_point deadline) {
    if (disconnect_finished_.load(std::memory_order_acquire)) return;
    if (!disconnect_requested_.exchange(true)) {
      if (!room_.disconnectUntil(deadline)) {
        disconnect_finished_.store(true, std::memory_order_release);
        return;
      }
    }
    const auto now = std::chrono::steady_clock::now();
    delegate_->waitDisconnected(
      now < deadline
        ? std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now)
        : std::chrono::milliseconds::zero()
    );
    disconnect_finished_.store(true, std::memory_order_release);
  }

  std::shared_ptr<PostedRoomDelegate> delegate_;
  livekit::Room room_;
  std::jthread stats_thread_;
  std::atomic_bool disconnect_requested_{false};
  std::atomic_bool disconnect_finished_{false};
};

struct VoiceConnectAttempt {
  std::uint64_t attempt_id = 0;
  std::string session_id;
  std::uint64_t generation = 0;
  std::uint64_t owner_token = 0;
  std::uint64_t room_instance_token = 0;
  std::string livekit_url;
  std::string livekit_token;
  std::shared_ptr<LiveKitVoiceRoomOwner> room;
  livekit::OperationCancellation cancellation;
};

SessionPortReceipt portReceipt(
  SessionEpoch epoch,
  SessionPortStage stage
) {
  return SessionPortReceipt{std::move(epoch), stage};
}

SessionPortStatus portSuccess(SessionEpoch epoch, SessionPortStage stage) {
  return SessionPortStatus::success(portReceipt(std::move(epoch), stage));
}

template <typename T>
SessionPortResult<T> portSuccess(
  SessionEpoch epoch,
  SessionPortStage stage,
  T value
) {
  return SessionPortResult<T>::success(
    SessionPortValue<T>{portReceipt(std::move(epoch), stage), std::move(value)}
  );
}

SessionPortError portError(
  SessionEpoch epoch,
  SessionPortStage stage,
  SessionPortErrorCode code,
  std::string message
) {
  return SessionPortError{
    portReceipt(std::move(epoch), stage), code, std::move(message)
  };
}

SessionPortStatus portFailure(
  SessionEpoch epoch,
  SessionPortStage stage,
  SessionPortErrorCode code,
  std::string message
) {
  return SessionPortStatus::failure(portError(
    std::move(epoch), stage, code, std::move(message)
  ));
}

template <typename T>
SessionPortResult<T> portFailure(
  SessionEpoch epoch,
  SessionPortStage stage,
  SessionPortErrorCode code,
  std::string message
) {
  return SessionPortResult<T>::failure(portError(
    std::move(epoch), stage, code, std::move(message)
  ));
}

class RealLiveKitVoiceSession final
  : public LiveKitVoiceSession,
    private LiveKitVoiceLifecyclePort,
    private LiveKitVoicePublicationPort,
    private LiveKitVoiceOutputPort,
    private LiveKitRemoteFrameReleasePort,
    private LiveKitCameraPreviewPort,
    private LiveKitRemoteDemandPort {
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

  LiveKitVoiceLifecyclePort& lifecycle() noexcept override { return *this; }
  const LiveKitVoiceLifecyclePort& lifecycle() const noexcept override {
    return *this;
  }
  LiveKitVoicePublicationPort& publication() noexcept override { return *this; }
  LiveKitVoiceOutputPort& output() noexcept override { return *this; }
  const LiveKitVoiceOutputPort& output() const noexcept override { return *this; }
  LiveKitRemoteFrameReleasePort& remoteFrameRelease() noexcept override {
    return *this;
  }
  LiveKitCameraPreviewPort& cameraPreview() noexcept override { return *this; }
  LiveKitRemoteDemandPort& remoteDemand() noexcept override { return *this; }

  SessionPortResult<bool> connect(
    SessionPortCall call,
    const std::string& livekit_url,
    const std::string& livekit_token,
    LiveKitVoiceSession::InternalPost post
  ) override {
    auto session_id = call.expected_epoch.session_id;
    const auto generation = call.expected_epoch.generation;
    const auto requested_epoch = call.expected_epoch;
    requireRuntimeReady();
    if (requested_epoch.owner_token == 0) {
      return portFailure<bool>(
        requested_epoch,
        SessionPortStage::LifecycleConnect,
        SessionPortErrorCode::Failed,
        "connection owner token is required"
      );
    }
    if (call.cancellation.isCancellationRequested()) {
      return portFailure<bool>(
        requested_epoch,
        SessionPortStage::LifecycleConnect,
        SessionPortErrorCode::Cancelled,
        "connection was cancelled before it started"
      );
    }
    std::shared_ptr<LiveKitVoiceRoomOwner> reusable_room;
    {
      std::lock_guard lock(mutex_);
      if (voice_room_) {
        if (session_id == voice_session_id_ &&
            generation == voice_generation_) {
          reusable_room = voice_room_;
        }
        if (session_id == voice_session_id_ &&
            generation < voice_generation_) {
          return portFailure<bool>(
            requested_epoch,
            SessionPortStage::LifecycleConnect,
            SessionPortErrorCode::StaleOwner,
            "connection generation is stale"
          );
        }
      }
      if (
        connect_attempt_ && session_id == connect_attempt_->session_id &&
        generation == connect_attempt_->generation &&
        (livekit_url != connect_attempt_->livekit_url ||
         livekit_token != connect_attempt_->livekit_token)
      ) {
        return portFailure<bool>(
          requested_epoch,
          SessionPortStage::LifecycleConnect,
          SessionPortErrorCode::Failed,
          "pending connection owns different credentials"
        );
      }
    }
    if (reusable_room && reusable_room->isConnected()) {
      std::unique_lock<std::shared_timed_mutex> transfer_gate(
        owner_operation_mutex_, std::defer_lock
      );
      if (!transfer_gate.try_lock_until(call.deadline)) {
        return portFailure<bool>(
          requested_epoch,
          SessionPortStage::LifecycleConnect,
          SessionPortErrorCode::Timeout,
          "Room ownership transfer deadline expired"
        );
      }
      std::lock_guard lock(mutex_);
      if (voice_room_ == reusable_room &&
          session_id == voice_session_id_ &&
          generation == voice_generation_) {
        if (call.cancellation.isCancellationRequested()) {
          return portFailure<bool>(
            requested_epoch,
            SessionPortStage::LifecycleConnect,
            SessionPortErrorCode::Cancelled,
            "connection was cancelled before ownership transfer"
          );
        }
        if (livekit_url != livekit_url_ || livekit_token != livekit_token_) {
          return portFailure<bool>(
            requested_epoch,
            SessionPortStage::LifecycleConnect,
            SessionPortErrorCode::Failed,
            "connected Room owns different credentials"
          );
        }
        // A same-generation retry may transfer ownership only while the
        // retained Room is still connected. SDK terminal disconnects retain
        // the owner briefly, so reusing a non-null pointer alone can report a
        // false running state and fence its replacement cleanup.
        voice_owner_token_ = requested_epoch.owner_token;
        auto transferred_epoch = requested_epoch;
        transferred_epoch.room_instance_token = voice_room_instance_token_;
        return portSuccess<bool>(
          std::move(transferred_epoch),
          SessionPortStage::LifecycleConnect,
          true
        );
      }
    }

    std::shared_ptr<VoiceConnectAttempt> superseded_attempt;
    std::uint64_t attempt_id = 0;
    {
      std::lock_guard lock(mutex_);
      attempt_id = next_connect_attempt_id_++;
      latest_connect_attempt_id_ = attempt_id;
      superseded_attempt = std::exchange(connect_attempt_, {});
    }
    if (superseded_attempt) {
      superseded_attempt->cancellation.requestCancel();
    }

    auto room = voice_room_factory_(
      "voice",
      NativeCommandType::VoiceTerminal,
      session_id,
      generation,
      std::move(post)
    );
    room->retainRuntimeLifetime(runtimeLifetimeToken());
    auto attempt = std::make_shared<VoiceConnectAttempt>();
    attempt->attempt_id = attempt_id;
    attempt->session_id = session_id;
    attempt->generation = generation;
    attempt->owner_token = requested_epoch.owner_token;
    attempt->room_instance_token = attempt_id;
    attempt->livekit_url = livekit_url;
    attempt->livekit_token = livekit_token;
    attempt->room = room;
    [[maybe_unused]] const auto external_cancellation_subscription =
      call.cancellation.subscribe([
        attempt_cancellation = attempt->cancellation
      ] {
        attempt_cancellation.requestCancel();
      });

    std::shared_ptr<LiveKitVoiceRoomOwner> retired_room;
    livekit::OperationCancellation retired_cancellation;
    bool registered = false;
    bool existing_connection = false;
    bool cancelled_before_registration = false;
    SessionEpoch existing_epoch;
    std::shared_ptr<LiveKitVoiceRoomOwner> registration_room;
    {
      std::lock_guard lock(mutex_);
      if (latest_connect_attempt_id_ == attempt_id && voice_room_ &&
          session_id == voice_session_id_ &&
          generation == voice_generation_ &&
          livekit_url == livekit_url_ && livekit_token == livekit_token_) {
        registration_room = voice_room_;
      }
    }
    const bool registration_room_connected =
      registration_room && registration_room->isConnected();
    std::unique_lock<std::shared_timed_mutex> registration_transfer_gate(
      owner_operation_mutex_, std::defer_lock
    );
    if (registration_room_connected &&
        !registration_transfer_gate.try_lock_until(call.deadline)) {
      retireRoom(std::move(room));
      return portFailure<bool>(
        requested_epoch,
        SessionPortStage::LifecycleConnect,
        SessionPortErrorCode::Timeout,
        "Room ownership transfer deadline expired"
      );
    }
    {
      std::lock_guard lock(mutex_);
      if (latest_connect_attempt_id_ != attempt_id) {
        registered = false;
      } else if (attempt->cancellation.isCancellationRequested()) {
        cancelled_before_registration = true;
      } else if (registration_room_connected &&
          voice_room_ == registration_room &&
          session_id == voice_session_id_ &&
          generation == voice_generation_ &&
          livekit_url == livekit_url_ && livekit_token == livekit_token_) {
        existing_connection = true;
        voice_owner_token_ = requested_epoch.owner_token;
        existing_epoch = requested_epoch;
        existing_epoch.room_instance_token = voice_room_instance_token_;
      } else {
        connect_attempt_ = attempt;
        retired_cancellation = voice_room_cancellation_;
        voice_room_cancellation_ = livekit::OperationCancellation{};
        retired_room = std::move(voice_room_);
        clearVoiceLeaseLocked();
        registered = true;
      }
    }
    if (cancelled_before_registration) {
      retireRoom(std::move(room));
      return portFailure<bool>(
        requested_epoch,
        SessionPortStage::LifecycleConnect,
        SessionPortErrorCode::Cancelled,
        "connection was cancelled before Room registration"
      );
    }
    if (existing_connection) {
      return portSuccess<bool>(
        std::move(existing_epoch), SessionPortStage::LifecycleConnect, true
      );
    }
    if (!registered) {
      retireRoom(std::move(room));
      return portFailure<bool>(
        requested_epoch,
        SessionPortStage::LifecycleConnect,
        SessionPortErrorCode::Cancelled,
        "connection was superseded before registration"
      );
    }
    retired_cancellation.requestCancel();
    retireRoom(std::move(retired_room));

    std::jthread deadline_thread([
      deadline = call.deadline,
      attempt_cancellation = attempt->cancellation
    ](std::stop_token stop) {
      std::mutex deadline_mutex;
      std::condition_variable_any deadline_changed;
      std::unique_lock lock(deadline_mutex);
      deadline_changed.wait_until(
        lock, stop, deadline, [] { return false; }
      );
      if (!stop.stop_requested()) attempt_cancellation.requestCancel();
    });

    const auto started_at = LiveKitConnectPolicy::Clock::now();
    auto options = LiveKitConnectPolicy::roomOptions(
      LiveKitConnectPolicy::remainingConnectTimeout(started_at, started_at)
    );
    bool connected = false;
    try {
      connected =
        room->connectCancellable(
          livekit_url,
          livekit_token,
          options,
          attempt->cancellation
        ) &&
        room->waitConnectedCancellable(
          LiveKitConnectPolicy::remainingPostConnectWait(
            started_at, LiveKitConnectPolicy::Clock::now()
          ),
          attempt->cancellation
        );
    } catch (const std::exception& error) {
      finishConnectAttempt(attempt);
      retireRoom(std::move(room));
      return portFailure<bool>(
        requested_epoch,
        SessionPortStage::LifecycleConnect,
        SessionPortErrorCode::Failed,
        error.what()
      );
    }
    if (!connected) {
      finishConnectAttempt(attempt);
      retireRoom(std::move(room));
      const auto timed_out = SessionPortCall::Clock::now() >= call.deadline;
      return portFailure<bool>(
        requested_epoch,
        SessionPortStage::LifecycleConnect,
        timed_out ? SessionPortErrorCode::Timeout
                  : SessionPortErrorCode::Cancelled,
        timed_out ? "connection deadline expired" : "connection was cancelled"
      );
    }
    if (!commitConnectAttempt(attempt)) {
      retireRoom(std::move(room));
      return portFailure<bool>(
        requested_epoch,
        SessionPortStage::LifecycleConnect,
        SessionPortErrorCode::StaleOwner,
        "connection completed after its owner was retired"
      );
    }
    return portSuccess<bool>(
      roomSnapshot().epoch, SessionPortStage::LifecycleConnect, true
    );
  }

  SessionPortStatus require(SessionPortCall call) const override {
    const auto stage = SessionPortStage::LifecycleStatus;
    const auto snapshot = roomSnapshot();
    if (!matchesLifecycleExpected(snapshot.epoch, call.expected_epoch) || !snapshot.room) {
      return portFailure(
        call.expected_epoch, stage, SessionPortErrorCode::StaleOwner,
        "the requested Room owner is not current"
      );
    }
    try {
      if (!snapshot.room->isConnected()) {
        return portFailure(
          snapshot.epoch, stage, SessionPortErrorCode::Failed,
          "the current Room is not connected"
        );
      }
      return portSuccess(snapshot.epoch, stage);
    } catch (const std::exception& error) {
      return portFailure(
        snapshot.epoch, stage, SessionPortErrorCode::Failed, error.what()
      );
    }
  }

  SessionPortResult<bool> status(SessionPortCall call) const override {
    const auto stage = SessionPortStage::LifecycleStatus;
    const auto snapshot = roomSnapshot();
    if (!matchesLifecycleExpected(snapshot.epoch, call.expected_epoch)) {
      return portFailure<bool>(
        call.expected_epoch, stage, SessionPortErrorCode::StaleOwner,
        "the requested Room owner is not current"
      );
    }
    try {
      return portSuccess<bool>(
        snapshot.epoch, stage, snapshot.room && snapshot.room->isConnected()
      );
    } catch (const std::exception& error) {
      return portFailure<bool>(
        snapshot.epoch, stage, SessionPortErrorCode::Failed, error.what()
      );
    }
  }

  SessionPortStatus setDeafened(SessionPortCall call, bool value) override {
    return invokeOptionalRoom(
      std::move(call), SessionPortStage::OutputDeafen,
      [value](LiveKitVoiceRoomOwner& room) { room.setDeafened(value); }
    );
  }

  SessionPortResult<std::uint64_t> setDevice(
    SessionPortCall call,
    std::string value
  ) override {
    return invokeOptionalRoom<std::uint64_t>(
      std::move(call), SessionPortStage::OutputDevice, 0,
      [value = std::move(value)](LiveKitVoiceRoomOwner& room) mutable {
        return room.setOutputDevice(std::move(value));
      }
    );
  }

  SessionPortResult<std::string> deviceId(SessionPortCall call) const override {
    return invokeOptionalRoom<std::string>(
      std::move(call), SessionPortStage::OutputDeviceQuery, "default",
      [](LiveKitVoiceRoomOwner& room) { return room.outputDeviceId(); }
    );
  }

  SessionPortStatus setVolume(SessionPortCall call, float value) override {
    return invokeOptionalRoom(
      std::move(call), SessionPortStage::OutputVolume,
      [value](LiveKitVoiceRoomOwner& room) { room.setOutputVolume(value); }
    );
  }

  SessionPortStatus configureRemoteAudio(
    SessionPortCall call,
    RemoteAudioSettings settings
  ) override {
    return invokeOptionalRoom(
      std::move(call), SessionPortStage::OutputConfigureRemoteAudio,
      [settings = std::move(settings)](LiveKitVoiceRoomOwner& room) mutable {
        room.configureRemoteAudio(std::move(settings));
      }
    );
  }

  SessionPortStatus releaseRemoteFrame(
    SessionPortCall call,
    std::string track_id,
    std::uint64_t sequence
  ) override {
    return invokeOptionalRoom(
      std::move(call), SessionPortStage::RemoteFrameRelease,
      [track_id = std::move(track_id), sequence](LiveKitVoiceRoomOwner& room) mutable {
        room.releaseRemoteVideoFrame(std::move(track_id), sequence);
      },
      RoomCallAuthority::RoomCleanup
    );
  }

  SessionPortStatus set(
    SessionPortCall call,
    std::string track_id,
    bool demanded
  ) override {
    return invokeOptionalRoom(
      std::move(call), SessionPortStage::DemandSet,
      [track_id = std::move(track_id), demanded](LiveKitVoiceRoomOwner& room) mutable {
        room.setRemoteVideoDemand(std::move(track_id), demanded);
      }
    );
  }

  SessionPortStatus reconcile(
    SessionPortCall call,
    std::string track_id,
    std::uint64_t expected_revision
  ) override {
    return invokeOptionalRoom(
      std::move(call), SessionPortStage::DemandReconcile,
      [track_id = std::move(track_id), expected_revision](LiveKitVoiceRoomOwner& room) mutable {
        room.reconcileRemotePublication(std::move(track_id), expected_revision);
      }
    );
  }

  SessionPortStatus retry(
    SessionPortCall call,
    std::string track_id,
    std::string reason
  ) override {
    return invokeOptionalRoom(
      std::move(call), SessionPortStage::DemandRetry,
      [track_id = std::move(track_id), reason = std::move(reason)](
        LiveKitVoiceRoomOwner& room
      ) mutable {
        room.retryRemoteVideo(std::move(track_id), std::move(reason));
      }
    );
  }

  SessionPortStatus start(
    SessionPortCall call,
    std::string track_id,
    std::string participant_identity,
    std::shared_ptr<livekit::LocalVideoTrack> track
  ) override {
    auto owner_lease = acquireOwnerOperation(call, SessionPortStage::CameraPreviewStart);
    if (owner_lease.hasError()) {
      return SessionPortStatus::failure(owner_lease.error());
    }
    const auto snapshot = roomSnapshot();
    if (!matchesExpectedOwner(snapshot.epoch, call.expected_epoch) || !snapshot.room) {
      return portFailure(
        call.expected_epoch, SessionPortStage::CameraPreviewStart,
        SessionPortErrorCode::StaleOwner,
        "the requested Room owner is not current"
      );
    }
    try {
      snapshot.room->startLocalCameraPreview(
        snapshot.epoch.session_id,
        call.expected_epoch.generation,
        std::move(track_id),
        std::move(participant_identity),
        track
      );
      if (!isCurrent(snapshot)) {
        return portFailure(
          snapshot.epoch, SessionPortStage::CameraPreviewStart,
          SessionPortErrorCode::StaleOwner,
          "camera preview start completed after ownership transfer"
        );
      }
      return portSuccess(snapshot.epoch, SessionPortStage::CameraPreviewStart);
    } catch (const std::exception& error) {
      return portFailure(
        snapshot.epoch, SessionPortStage::CameraPreviewStart,
        SessionPortErrorCode::Failed, error.what()
      );
    }
  }

  SessionPortStatus stop(SessionPortCall call, std::string track_id) override {
    return invokeOptionalRoom(
      std::move(call), SessionPortStage::CameraPreviewStop,
      [track_id = std::move(track_id)](LiveKitVoiceRoomOwner& room) {
        room.stopLocalCameraPreview(track_id);
      },
      RoomCallAuthority::RoomCleanup
    );
  }

  SessionPortStatus releasePreviewFrame(
    SessionPortCall call,
    std::string track_id,
    std::uint64_t sequence
  ) override {
    return invokeOptionalRoom(
      std::move(call), SessionPortStage::CameraPreviewRelease,
      [track_id = std::move(track_id), sequence](LiveKitVoiceRoomOwner& room) mutable {
        room.releaseLocalCameraPreviewFrame(std::move(track_id), sequence);
      },
      RoomCallAuthority::RoomCleanup
    );
  }

  SessionPortStatus disconnect(SessionPortCall call) override {
    requireRuntimeReady();
    std::shared_ptr<VoiceConnectAttempt> attempt;
    RoomSnapshot retired;
    SessionEpoch retired_epoch;
    livekit::OperationCancellation retired_cancellation;
    {
      std::lock_guard lock(mutex_);
      const auto current = roomSnapshotLocked();
      const auto pending_epoch = connect_attempt_
        ? SessionEpoch{
            connect_attempt_->session_id,
            connect_attempt_->generation,
            connect_attempt_->owner_token
          }
        : SessionEpoch{};
      const bool owns_pending = connect_attempt_ &&
        matchesExactOwner(pending_epoch, call.expected_epoch);
      const bool owns_room = current.room &&
        matchesExactOwner(current.epoch, call.expected_epoch);
      if (!owns_pending && !owns_room) {
        return portFailure(
          call.expected_epoch,
          SessionPortStage::LifecycleDisconnect,
          SessionPortErrorCode::StaleOwner,
          "disconnect cannot retire a replacement Room owner"
        );
      }
      if (owns_pending) {
        latest_connect_attempt_id_ = next_connect_attempt_id_++;
        retired_epoch = pending_epoch;
        attempt = std::exchange(connect_attempt_, {});
      }
      if (owns_room) {
        retired = current;
        retired_epoch = current.epoch;
        retired_cancellation = voice_room_cancellation_;
        voice_room_cancellation_ = livekit::OperationCancellation{};
        voice_room_.reset();
        clearVoiceLeaseLocked();
      }
    }
    if (attempt) attempt->cancellation.requestCancel();
    retired_cancellation.requestCancel();
    std::unique_lock<std::timed_mutex> publication_drain(
      publication_mutex_, std::defer_lock
    );
    const bool publication_drained = publication_drain.try_lock_until(
      call.deadline
    );
    retireRoom(std::move(retired.room));
    if (!publication_drained) {
      return portFailure(
        retired_epoch,
        SessionPortStage::LifecycleDisconnect,
        SessionPortErrorCode::Timeout,
        "publication cancellation did not drain before disconnect deadline"
      );
    }
    return portSuccess(
      std::move(retired_epoch), SessionPortStage::LifecycleDisconnect
    );
  }

  SessionPortResult<std::shared_ptr<livekit::LocalAudioTrack>>
  createMicrophoneTrack(
    SessionPortCall call,
    const std::shared_ptr<livekit::AudioSource>& source
  ) override {
    const auto stage = SessionPortStage::PublicationCreateMicrophone;
    if (call.cancellation.isCancellationRequested()) {
      return portFailure<std::shared_ptr<livekit::LocalAudioTrack>>(
        call.expected_epoch, stage, SessionPortErrorCode::Cancelled,
        "track creation was cancelled"
      );
    }
    try {
      return portSuccess<std::shared_ptr<livekit::LocalAudioTrack>>(
        call.expected_epoch,
        stage,
        livekit::LocalAudioTrack::createLocalAudioTrack("microphone", source)
      );
    } catch (const std::exception& error) {
      return portFailure<std::shared_ptr<livekit::LocalAudioTrack>>(
        call.expected_epoch, stage, SessionPortErrorCode::Failed, error.what()
      );
    }
  }

  void captureMicrophoneFrame(
    const std::shared_ptr<livekit::AudioSource>& source,
    const livekit::AudioFrame& frame,
    bool discontinuity
  ) override {
    if (!source) {
      throw std::invalid_argument("microphone audio source is required");
    }
    if (discontinuity) source->clearQueue();
    source->captureFrame(frame);
  }

  SessionPortResult<std::string> publishAudioTrack(
    SessionPortCall call,
    const std::shared_ptr<livekit::LocalAudioTrack>& track,
    const livekit::TrackPublishOptions& options
  ) override {
    return publishTrack(
      std::move(call), SessionPortStage::PublicationPublishAudio,
      [&](LiveKitVoiceRoomOwner& room, const auto& cancellation, auto deadline) {
        return room.publishAudioTrackUntil(track, options, deadline, cancellation);
      }
    );
  }

  SessionPortResult<std::string> publishVideoTrack(
    SessionPortCall call,
    const std::shared_ptr<livekit::LocalVideoTrack>& track,
    const livekit::TrackPublishOptions& options
  ) override {
    return publishTrack(
      std::move(call), SessionPortStage::PublicationPublishVideo,
      [&](LiveKitVoiceRoomOwner& room, const auto& cancellation, auto deadline) {
        return room.publishVideoTrackUntil(track, options, deadline, cancellation);
      }
    );
  }

  SessionPortStatus unpublishTrack(
    SessionPortCall call,
    const std::string& publication_sid
  ) override {
    const auto stage = SessionPortStage::PublicationUnpublish;
    auto gate = acquirePublicationGate(call, stage);
    if (gate.hasError()) return SessionPortStatus::failure(gate.error());
    const auto snapshot = roomSnapshot();
    if (!matchesCleanupRoom(snapshot.epoch, call.expected_epoch) || !snapshot.room) {
      return portFailure(
        call.expected_epoch, stage, SessionPortErrorCode::StaleOwner,
        "the requested Room owner is not current"
      );
    }
    auto cancellation = livekit::OperationCancellation{};
    [[maybe_unused]] auto caller_cancel = call.cancellation.subscribe(
      [cancellation] { cancellation.requestCancel(); }
    );
    [[maybe_unused]] auto owner_cancel = snapshot.cancellation.subscribe(
      [cancellation] { cancellation.requestCancel(); }
    );
    const auto result = snapshot.room->unpublishTrackUntil(
      publication_sid, call.deadline, cancellation
    );
    if (result.hasError()) {
      return mapRoomFailure(snapshot.epoch, stage, result.error());
    }
    if (!isCurrent(snapshot, RoomCallAuthority::RoomCleanup)) {
      return portFailure(
        snapshot.epoch, stage, SessionPortErrorCode::StaleOwner,
        "unpublish completed after its Room owner was retired"
      );
    }
    return portSuccess(snapshot.epoch, stage);
  }

 private:
  enum class RoomCallAuthority {
    OwnerMutation,
    RoomCleanup,
  };

  struct RoomSnapshot {
    std::shared_ptr<LiveKitVoiceRoomOwner> room;
    SessionEpoch epoch;
    livekit::OperationCancellation cancellation;
  };

  [[nodiscard]] RoomSnapshot roomSnapshotLocked() const {
    return RoomSnapshot{
      voice_room_,
      SessionEpoch{
        voice_session_id_, voice_generation_, voice_owner_token_,
        voice_room_instance_token_
      },
      voice_room_cancellation_
    };
  }

  [[nodiscard]] RoomSnapshot roomSnapshot() const {
    requireRuntimeReady();
    std::lock_guard lock(mutex_);
    return roomSnapshotLocked();
  }

  static bool matchesExpectedOwner(
    const SessionEpoch& actual,
    const SessionEpoch& expected
  ) noexcept {
    // Media generations are actor-local stale-work fences and can advance
    // without reconnecting the Room. The exact token is the Room-owner epoch;
    // both generations remain attached to the result for incident correlation.
    return expected.owner_token != 0 &&
      actual.session_id == expected.session_id &&
      actual.owner_token == expected.owner_token;
  }

  static bool matchesCleanupRoom(
    const SessionEpoch& actual,
    const SessionEpoch& expected
  ) noexcept {
    return expected.room_instance_token != 0 &&
      actual.session_id == expected.session_id &&
      actual.room_instance_token == expected.room_instance_token;
  }

  static bool matchesLifecycleExpected(
    const SessionEpoch& actual,
    const SessionEpoch& expected
  ) noexcept {
    return expected.session_id.empty() ||
      matchesExpectedOwner(actual, expected);
  }

  static bool matchesExactOwner(
    const SessionEpoch& actual,
    const SessionEpoch& expected
  ) noexcept {
    return expected.owner_token != 0 &&
      actual.session_id == expected.session_id &&
      actual.generation == expected.generation &&
      actual.owner_token == expected.owner_token;
  }

  static bool matchesAuthority(
    const SessionEpoch& actual,
    const SessionEpoch& expected,
    RoomCallAuthority authority
  ) noexcept {
    return authority == RoomCallAuthority::RoomCleanup
      ? matchesCleanupRoom(actual, expected)
      : matchesExpectedOwner(actual, expected);
  }

  [[nodiscard]] bool isCurrent(
    const RoomSnapshot& snapshot,
    RoomCallAuthority authority = RoomCallAuthority::OwnerMutation
  ) const {
    std::lock_guard lock(mutex_);
    return voice_room_ == snapshot.room &&
      matchesAuthority(roomSnapshotLocked().epoch, snapshot.epoch, authority) &&
      !snapshot.cancellation.isCancellationRequested();
  }

  template <typename Function>
  SessionPortStatus invokeOptionalRoom(
    SessionPortCall call,
    SessionPortStage stage,
    Function&& function,
    RoomCallAuthority authority = RoomCallAuthority::OwnerMutation
  ) const {
    auto owner_lease = acquireOwnerOperation(call, stage, authority);
    if (owner_lease.hasError()) {
      return SessionPortStatus::failure(owner_lease.error());
    }
    const auto snapshot = roomSnapshot();
    if (!matchesAuthority(snapshot.epoch, call.expected_epoch, authority)) {
      return portFailure(
        call.expected_epoch, stage, SessionPortErrorCode::StaleOwner,
        "the requested Room owner is not current"
      );
    }
    if (call.cancellation.isCancellationRequested()) {
      return portFailure(
        snapshot.epoch, stage, SessionPortErrorCode::Cancelled,
        "the port call was cancelled"
      );
    }
    if (SessionPortCall::Clock::now() >= call.deadline) {
      return portFailure(
        snapshot.epoch, stage, SessionPortErrorCode::Timeout,
        "the port deadline expired before dispatch"
      );
    }
    if (!snapshot.room) return portSuccess(snapshot.epoch, stage);
    try {
      std::forward<Function>(function)(*snapshot.room);
      if (!isCurrent(snapshot, authority)) {
        return portFailure(
          snapshot.epoch, stage, SessionPortErrorCode::StaleOwner,
          "the port call completed after its Room owner was retired"
        );
      }
      return portSuccess(snapshot.epoch, stage);
    } catch (const std::exception& error) {
      return portFailure(
        snapshot.epoch, stage, SessionPortErrorCode::Failed, error.what()
      );
    }
  }

  template <typename T, typename Function>
  SessionPortResult<T> invokeOptionalRoom(
    SessionPortCall call,
    SessionPortStage stage,
    T disconnected_value,
    Function&& function,
    RoomCallAuthority authority = RoomCallAuthority::OwnerMutation
  ) const {
    auto owner_lease = acquireOwnerOperation(call, stage, authority);
    if (owner_lease.hasError()) {
      return SessionPortResult<T>::failure(owner_lease.error());
    }
    const auto snapshot = roomSnapshot();
    if (!matchesAuthority(snapshot.epoch, call.expected_epoch, authority)) {
      return portFailure<T>(
        call.expected_epoch, stage, SessionPortErrorCode::StaleOwner,
        "the requested Room owner is not current"
      );
    }
    if (call.cancellation.isCancellationRequested()) {
      return portFailure<T>(
        snapshot.epoch, stage, SessionPortErrorCode::Cancelled,
        "the port call was cancelled"
      );
    }
    if (SessionPortCall::Clock::now() >= call.deadline) {
      return portFailure<T>(
        snapshot.epoch, stage, SessionPortErrorCode::Timeout,
        "the port deadline expired before dispatch"
      );
    }
    if (!snapshot.room) {
      return portSuccess<T>(snapshot.epoch, stage, std::move(disconnected_value));
    }
    try {
      auto value = std::forward<Function>(function)(*snapshot.room);
      if (!isCurrent(snapshot, authority)) {
        return portFailure<T>(
          snapshot.epoch, stage, SessionPortErrorCode::StaleOwner,
          "the port call completed after its Room owner was retired"
        );
      }
      return portSuccess<T>(snapshot.epoch, stage, std::move(value));
    } catch (const std::exception& error) {
      return portFailure<T>(
        snapshot.epoch, stage, SessionPortErrorCode::Failed, error.what()
      );
    }
  }

  SessionPortResult<std::unique_lock<std::timed_mutex>> acquirePublicationGate(
    const SessionPortCall& call,
    SessionPortStage stage
  ) {
    const auto snapshot = roomSnapshot();
    if (call.cancellation.isCancellationRequested()) {
      return portFailure<std::unique_lock<std::timed_mutex>>(
        snapshot.epoch, stage, SessionPortErrorCode::Cancelled,
        "publication was cancelled before ordering-gate acquisition"
      );
    }
    std::unique_lock<std::timed_mutex> gate(publication_mutex_, std::defer_lock);
    if (!gate.try_lock_until(call.deadline)) {
      return portFailure<std::unique_lock<std::timed_mutex>>(
        snapshot.epoch,
        SessionPortStage::PublicationAcquire,
        SessionPortErrorCode::Timeout,
        "publication ordering-gate deadline expired"
      );
    }
    if (call.cancellation.isCancellationRequested()) {
      return portFailure<std::unique_lock<std::timed_mutex>>(
        snapshot.epoch, stage, SessionPortErrorCode::Cancelled,
        "publication was cancelled during ordering-gate acquisition"
      );
    }
    return portSuccess<std::unique_lock<std::timed_mutex>>(
      snapshot.epoch, stage, std::move(gate)
    );
  }

  SessionPortResult<std::shared_lock<std::shared_timed_mutex>>
  acquireOwnerOperation(
    const SessionPortCall& call,
    SessionPortStage stage,
    RoomCallAuthority authority = RoomCallAuthority::OwnerMutation
  ) const {
    std::shared_lock<std::shared_timed_mutex> lease(
      owner_operation_mutex_, std::defer_lock
    );
    if (authority == RoomCallAuthority::RoomCleanup) {
      return portSuccess<std::shared_lock<std::shared_timed_mutex>>(
        call.expected_epoch, stage, std::move(lease)
      );
    }
    if (!lease.try_lock_until(call.deadline)) {
      return portFailure<std::shared_lock<std::shared_timed_mutex>>(
        call.expected_epoch, stage, SessionPortErrorCode::Timeout,
        "Room owner operation deadline expired"
      );
    }
    if (call.cancellation.isCancellationRequested()) {
      return portFailure<std::shared_lock<std::shared_timed_mutex>>(
        call.expected_epoch, stage, SessionPortErrorCode::Cancelled,
        "Room owner operation was cancelled"
      );
    }
    return portSuccess<std::shared_lock<std::shared_timed_mutex>>(
      call.expected_epoch, stage, std::move(lease)
    );
  }

  static SessionPortError mapRoomError(
    SessionEpoch epoch,
    SessionPortStage stage,
    const LiveKitVoiceRoomOperationError& error
  ) {
    auto code = SessionPortErrorCode::Failed;
    if (error.code == LiveKitVoiceRoomOperationErrorCode::Timeout) {
      code = SessionPortErrorCode::Timeout;
    } else if (error.code == LiveKitVoiceRoomOperationErrorCode::Cancelled) {
      code = SessionPortErrorCode::Cancelled;
    }
    return portError(std::move(epoch), stage, code, error.message);
  }

  static SessionPortStatus mapRoomFailure(
    SessionEpoch epoch,
    SessionPortStage stage,
    const LiveKitVoiceRoomOperationError& error
  ) {
    return SessionPortStatus::failure(mapRoomError(
      std::move(epoch), stage, error
    ));
  }

  template <typename Function>
  SessionPortResult<std::string> publishTrack(
    SessionPortCall call,
    SessionPortStage stage,
    Function&& function
  ) {
    auto gate = acquirePublicationGate(call, stage);
    if (gate.hasError()) {
      return SessionPortResult<std::string>::failure(gate.error());
    }
    auto owner_lease = acquireOwnerOperation(call, stage);
    if (owner_lease.hasError()) {
      return SessionPortResult<std::string>::failure(owner_lease.error());
    }
    const auto snapshot = roomSnapshot();
    if (!matchesExpectedOwner(snapshot.epoch, call.expected_epoch) || !snapshot.room) {
      return portFailure<std::string>(
        call.expected_epoch, stage, SessionPortErrorCode::StaleOwner,
        "the requested Room owner is not current"
      );
    }
    auto cancellation = livekit::OperationCancellation{};
    [[maybe_unused]] auto caller_cancel = call.cancellation.subscribe(
      [cancellation] { cancellation.requestCancel(); }
    );
    [[maybe_unused]] auto owner_cancel = snapshot.cancellation.subscribe(
      [cancellation] { cancellation.requestCancel(); }
    );
    const auto result = std::forward<Function>(function)(
      *snapshot.room, cancellation, call.deadline
    );
    if (result.hasError()) {
      return SessionPortResult<std::string>::failure(
        mapRoomError(snapshot.epoch, stage, result.error())
      );
    }
    if (!isCurrent(snapshot)) {
      return portFailure<std::string>(
        snapshot.epoch, stage, SessionPortErrorCode::StaleOwner,
        "publication completed after its Room owner was retired"
      );
    }
    return portSuccess<std::string>(
      snapshot.epoch, stage, result.value()
    );
  }

  bool commitConnectAttempt(
    const std::shared_ptr<VoiceConnectAttempt>& attempt
  ) {
    {
      std::lock_guard lock(mutex_);
      if (
        connect_attempt_ != attempt ||
        latest_connect_attempt_id_ != attempt->attempt_id ||
        attempt->cancellation.isCancellationRequested()
      ) {
        return false;
      }
      connect_attempt_.reset();
      voice_room_cancellation_ = livekit::OperationCancellation{};
      voice_room_ = attempt->room;
      voice_session_id_ = attempt->session_id;
      voice_generation_ = attempt->generation;
      voice_owner_token_ = attempt->owner_token;
      voice_room_instance_token_ = attempt->room_instance_token;
      livekit_url_ = attempt->livekit_url;
      livekit_token_ = attempt->livekit_token;
      voice_room_->publishTerminalIncarnation();
    }
    // LiveKit can publish initial remote tracks from its callback threads
    // before this connected owner becomes visible to the voice actor. Those
    // early mailbox reconciles observe no current Room, so replay the complete
    // inventory after the attempt wins the commit seam.
    attempt->room->reconcileRegisteredRemotePublications();
    return true;
  }

  void finishConnectAttempt(
    const std::shared_ptr<VoiceConnectAttempt>& attempt
  ) {
    std::lock_guard lock(mutex_);
    if (connect_attempt_ == attempt) connect_attempt_.reset();
  }

  static void retireRoom(
    std::shared_ptr<LiveKitVoiceRoomOwner> room
  ) noexcept {
    if (!room) return;
    try { room->markIntentionalDisconnect(); } catch (...) {}
    try { room->stopAudio(); } catch (...) {}
    try { room->disconnect(); } catch (...) {}
  }

  void clearVoiceLeaseLocked() {
    voice_session_id_.clear();
    voice_generation_ = 0;
    voice_owner_token_ = 0;
    voice_room_instance_token_ = 0;
    livekit_url_.clear();
    livekit_token_.clear();
  }

  void requireRuntimeReady() const {
    const auto lifetime = runtimeLifetimeToken();
    if (!lifetime || !lifetime->initialized()) {
      throw std::logic_error(
        "LiveKit voice session used without an initialized runtime lifetime"
      );
    }
  }

  mutable std::mutex mutex_;
  // The pending attempt is an implementation-local generation owner. Slow SDK
  // waits never hold either mutex; disconnect and a newer connect can cancel it
  // under a short state transition, and only the latest attempt may commit.
  std::shared_ptr<VoiceConnectAttempt> connect_attempt_;
  std::uint64_t next_connect_attempt_id_ = 1;
  std::uint64_t latest_connect_attempt_id_ = 0;
  // Only publication is ordered. Its finite gate and per-owner cancellation
  // cannot delay output, release, demand/recovery, preview, or liveness ports.
  std::timed_mutex publication_mutex_;
  mutable std::shared_timed_mutex owner_operation_mutex_;
  std::shared_ptr<LiveKitVoiceRoomOwner> voice_room_;
  livekit::OperationCancellation voice_room_cancellation_;
  std::string voice_session_id_;
  std::uint64_t voice_generation_ = 0;
  std::uint64_t voice_owner_token_ = 0;
  std::uint64_t voice_room_instance_token_ = 0;
  std::string livekit_url_;
  std::string livekit_token_;
  LiveKitVoiceRoomOwnerFactory voice_room_factory_;
};

}  // namespace

SessionPortResult<SessionPortCall> LiveKitVoiceSession::bindCurrentOwner(
  std::string session_id,
  std::uint64_t generation,
  std::chrono::milliseconds budget
) {
  const auto deadline = SessionPortCall::Clock::now() + budget;
  SessionEpoch desired_epoch;
  desired_epoch.session_id = std::move(session_id);
  desired_epoch.generation = generation;
  auto status_call = SessionPortCall{{}, deadline, {}};
  auto status = lifecycle().status(std::move(status_call));
  if (status.hasError()) {
    return SessionPortResult<SessionPortCall>::failure(status.error());
  }
  const auto& current = status.value();
  if (!current.value || current.epoch.owner_token == 0 ||
      current.epoch.session_id != desired_epoch.session_id) {
    return portFailure<SessionPortCall>(
      desired_epoch,
      SessionPortStage::LifecycleStatus,
      SessionPortErrorCode::StaleOwner,
      "the requested session has no current connected Room owner"
    );
  }
  auto bound_epoch = SessionEpoch{
    desired_epoch.session_id, generation, current.epoch.owner_token,
    current.epoch.room_instance_token
  };
  auto bound_call = SessionPortCall{bound_epoch, deadline, {}};
  return portSuccess<SessionPortCall>(
    std::move(bound_epoch),
    SessionPortStage::LifecycleStatus,
    std::move(bound_call)
  );
}

LiveKitVoiceRoomOperationResult<std::string>
LiveKitVoiceRoomOwner::publishAudioTrackUntil(
  const std::shared_ptr<livekit::LocalAudioTrack>& track,
  const livekit::TrackPublishOptions& options,
  std::chrono::steady_clock::time_point deadline,
  const livekit::OperationCancellation& cancellation
) {
  if (cancellation.isCancellationRequested()) {
    return LiveKitVoiceRoomOperationResult<std::string>::failure({
      LiveKitVoiceRoomOperationErrorCode::Cancelled,
      "audio publication was cancelled"
    });
  }
  if (std::chrono::steady_clock::now() >= deadline) {
    return LiveKitVoiceRoomOperationResult<std::string>::failure({
      LiveKitVoiceRoomOperationErrorCode::Timeout,
      "audio publication deadline expired"
    });
  }
  try {
    return LiveKitVoiceRoomOperationResult<std::string>::success(
      publishAudioTrack(track, options)
    );
  } catch (const std::exception& error) {
    return LiveKitVoiceRoomOperationResult<std::string>::failure({
      LiveKitVoiceRoomOperationErrorCode::Failed, error.what()
    });
  }
}

LiveKitVoiceRoomOperationResult<std::string>
LiveKitVoiceRoomOwner::publishVideoTrackUntil(
  const std::shared_ptr<livekit::LocalVideoTrack>& track,
  const livekit::TrackPublishOptions& options,
  std::chrono::steady_clock::time_point deadline,
  const livekit::OperationCancellation& cancellation
) {
  if (cancellation.isCancellationRequested()) {
    return LiveKitVoiceRoomOperationResult<std::string>::failure({
      LiveKitVoiceRoomOperationErrorCode::Cancelled,
      "video publication was cancelled"
    });
  }
  if (std::chrono::steady_clock::now() >= deadline) {
    return LiveKitVoiceRoomOperationResult<std::string>::failure({
      LiveKitVoiceRoomOperationErrorCode::Timeout,
      "video publication deadline expired"
    });
  }
  try {
    return LiveKitVoiceRoomOperationResult<std::string>::success(
      publishVideoTrack(track, options)
    );
  } catch (const std::exception& error) {
    return LiveKitVoiceRoomOperationResult<std::string>::failure({
      LiveKitVoiceRoomOperationErrorCode::Failed, error.what()
    });
  }
}

LiveKitVoiceRoomOperationResult<void> LiveKitVoiceRoomOwner::unpublishTrackUntil(
  const std::string& publication_sid,
  std::chrono::steady_clock::time_point deadline,
  const livekit::OperationCancellation& cancellation
) {
  if (cancellation.isCancellationRequested()) {
    return LiveKitVoiceRoomOperationResult<void>::failure({
      LiveKitVoiceRoomOperationErrorCode::Cancelled,
      "unpublication was cancelled"
    });
  }
  if (std::chrono::steady_clock::now() >= deadline) {
    return LiveKitVoiceRoomOperationResult<void>::failure({
      LiveKitVoiceRoomOperationErrorCode::Timeout,
      "unpublication deadline expired"
    });
  }
  try {
    unpublishTrack(publication_sid);
    return LiveKitVoiceRoomOperationResult<void>::success();
  } catch (const std::exception& error) {
    return LiveKitVoiceRoomOperationResult<void>::failure({
      LiveKitVoiceRoomOperationErrorCode::Failed, error.what()
    });
  }
}

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

SessionPortResult<bool> DeterministicFakeLiveKitVoiceSession::connect(
  SessionPortCall call,
  const std::string& livekit_url,
  const std::string& livekit_token,
  LiveKitVoiceSession::InternalPost
) {
  auto session_id = call.expected_epoch.session_id;
  const auto generation = call.expected_epoch.generation;
  if (call.expected_epoch.owner_token == 0) {
    return portFailure<bool>(
      call.expected_epoch,
      SessionPortStage::LifecycleConnect,
      SessionPortErrorCode::Failed,
      "fake connection owner token is required"
    );
  }
  {
    std::lock_guard lock(mutex_);
    if (voice_connected_) {
      if (voice_session_id_ != session_id || voice_generation_ != generation ||
          voice_livekit_url_ != livekit_url || voice_livekit_token_ != livekit_token) {
        return portFailure<bool>(
          call.expected_epoch,
          SessionPortStage::LifecycleConnect,
          SessionPortErrorCode::StaleOwner,
          "fake Room owns another lease"
        );
      }
      voice_owner_token_ = call.expected_epoch.owner_token;
      auto transferred_epoch = call.expected_epoch;
      transferred_epoch.room_instance_token = voice_room_instance_token_;
      return portSuccess<bool>(
        std::move(transferred_epoch),
        SessionPortStage::LifecycleConnect,
        true
      );
    }
  }
  Release release;
  {
    std::unique_lock lock(mutex_);
    connect_.pending += 1;
    voice_connect_pending_ += 1;
    pending_connect_epochs_.push_back(call.expected_epoch);
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
    const auto pending = std::find_if(
      pending_connect_epochs_.begin(), pending_connect_epochs_.end(),
      [&](const SessionEpoch& epoch) {
        return epoch.owner_token == call.expected_epoch.owner_token;
      }
    );
    if (pending != pending_connect_epochs_.end()) {
      pending_connect_epochs_.erase(pending);
    }
    changed_.notify_all();
  }
  if (release.error_message) {
    return portFailure<bool>(
      call.expected_epoch,
      SessionPortStage::LifecycleConnect,
      SessionPortErrorCode::Failed,
      *release.error_message
    );
  }
  {
    std::lock_guard lock(mutex_);
    voice_connected_ = release.bool_result;
    if (voice_connected_) {
      voice_session_id_ = std::move(session_id);
      voice_generation_ = generation;
      voice_owner_token_ = call.expected_epoch.owner_token;
      voice_room_instance_token_ = next_voice_room_instance_token_++;
      voice_livekit_url_ = livekit_url;
      voice_livekit_token_ = livekit_token;
    }
  }
  if (!release.bool_result) {
    return portFailure<bool>(
      call.expected_epoch,
      SessionPortStage::LifecycleConnect,
      SessionPortErrorCode::Cancelled,
      "fake connection was cancelled"
    );
  }
  auto connected_epoch = call.expected_epoch;
  {
    std::lock_guard lock(mutex_);
    connected_epoch.room_instance_token = voice_room_instance_token_;
  }
  return portSuccess<bool>(
    std::move(connected_epoch), SessionPortStage::LifecycleConnect, true
  );
}

SessionPortStatus DeterministicFakeLiveKitVoiceSession::require(
  SessionPortCall call
) const {
  if (!isVoiceSessionCurrent(call.expected_epoch.session_id)) {
    return portFailure(
      call.expected_epoch,
      SessionPortStage::LifecycleStatus,
      SessionPortErrorCode::StaleOwner,
      "fake Room is not connected"
    );
  }
  return portSuccess(call.expected_epoch, SessionPortStage::LifecycleStatus);
}

SessionPortResult<bool> DeterministicFakeLiveKitVoiceSession::status(
  SessionPortCall
) const {
  std::lock_guard lock(mutex_);
  const SessionEpoch epoch{
    voice_session_id_, voice_generation_, voice_owner_token_,
    voice_room_instance_token_
  };
  return portSuccess<bool>(epoch, SessionPortStage::LifecycleStatus, voice_connected_);
}

SessionPortStatus DeterministicFakeLiveKitVoiceSession::setDeafened(
  SessionPortCall,
  bool value
) {
  std::lock_guard lock(mutex_);
  voice_deafened_ = value;
  return portSuccess(
    {voice_session_id_, voice_generation_}, SessionPortStage::OutputDeafen
  );
}

SessionPortResult<std::uint64_t> DeterministicFakeLiveKitVoiceSession::setDevice(
  SessionPortCall,
  std::string value
) {
  std::lock_guard lock(mutex_);
  voice_output_device_id_ = std::move(value);
  return portSuccess<std::uint64_t>(
    {voice_session_id_, voice_generation_},
    SessionPortStage::OutputDevice,
    ++voice_output_epoch_
  );
}

SessionPortResult<std::string>
DeterministicFakeLiveKitVoiceSession::deviceId(SessionPortCall) const {
  std::lock_guard lock(mutex_);
  return portSuccess<std::string>(
    {voice_session_id_, voice_generation_},
    SessionPortStage::OutputDeviceQuery,
    voice_output_device_id_
  );
}

SessionPortStatus DeterministicFakeLiveKitVoiceSession::setVolume(
  SessionPortCall call,
  float
) {
  return portSuccess(call.expected_epoch, SessionPortStage::OutputVolume);
}
SessionPortStatus DeterministicFakeLiveKitVoiceSession::configureRemoteAudio(
  SessionPortCall call,
  RemoteAudioSettings
) {
  return portSuccess(
    call.expected_epoch, SessionPortStage::OutputConfigureRemoteAudio
  );
}

SessionPortStatus DeterministicFakeLiveKitVoiceSession::releaseRemoteFrame(
  SessionPortCall call,
  std::string,
  std::uint64_t
) {
  return portSuccess(call.expected_epoch, SessionPortStage::RemoteFrameRelease);
}

SessionPortStatus DeterministicFakeLiveKitVoiceSession::set(
  SessionPortCall call,
  std::string,
  bool
) {
  return portSuccess(call.expected_epoch, SessionPortStage::DemandSet);
}
SessionPortStatus DeterministicFakeLiveKitVoiceSession::reconcile(
  SessionPortCall call,
  std::string,
  std::uint64_t
) {
  return portSuccess(call.expected_epoch, SessionPortStage::DemandReconcile);
}
SessionPortStatus DeterministicFakeLiveKitVoiceSession::retry(
  SessionPortCall call,
  std::string,
  std::string
) {
  return portSuccess(call.expected_epoch, SessionPortStage::DemandRetry);
}

SessionPortStatus DeterministicFakeLiveKitVoiceSession::start(
  SessionPortCall call,
  std::string,
  std::string,
  std::shared_ptr<livekit::LocalVideoTrack>
) {
  std::lock_guard lock(mutex_);
  local_camera_preview_start_count_ += 1;
  return portSuccess(call.expected_epoch, SessionPortStage::CameraPreviewStart);
}

SessionPortStatus DeterministicFakeLiveKitVoiceSession::stop(
  SessionPortCall call,
  std::string
) {
  std::lock_guard lock(mutex_);
  local_camera_preview_stop_count_ += 1;
  return portSuccess(call.expected_epoch, SessionPortStage::CameraPreviewStop);
}

SessionPortStatus DeterministicFakeLiveKitVoiceSession::releasePreviewFrame(
  SessionPortCall call,
  std::string,
  std::uint64_t
) {
  return portSuccess(call.expected_epoch, SessionPortStage::CameraPreviewRelease);
}

SessionPortStatus DeterministicFakeLiveKitVoiceSession::disconnect(
  SessionPortCall call
) {
  {
    std::lock_guard lock(mutex_);
    disconnect_call_count_ += 1;
    const auto pending = std::find_if(
      pending_connect_epochs_.begin(), pending_connect_epochs_.end(),
      [&](const SessionEpoch& epoch) {
        return epoch.session_id == call.expected_epoch.session_id &&
          epoch.generation == call.expected_epoch.generation &&
          epoch.owner_token != 0 &&
          epoch.owner_token == call.expected_epoch.owner_token;
      }
    );
    if (pending != pending_connect_epochs_.end() &&
        cancel_pending_connect_on_disconnect_) {
      Release cancelled;
      cancelled.bool_result = false;
      connect_.releases.push_back(std::move(cancelled));
      changed_.notify_all();
      return portSuccess(
        call.expected_epoch, SessionPortStage::LifecycleDisconnect
      );
    }
    if (!voice_connected_ ||
        voice_session_id_ != call.expected_epoch.session_id ||
        voice_generation_ != call.expected_epoch.generation ||
        voice_owner_token_ == 0 ||
        voice_owner_token_ != call.expected_epoch.owner_token) {
      return portFailure(
        call.expected_epoch,
        SessionPortStage::LifecycleDisconnect,
        SessionPortErrorCode::StaleOwner,
        "fake disconnect cannot retire a replacement Room owner"
      );
    }
  }
  const auto release = enterGate(Operation::Disconnect);
  if (release.error_message) {
    return portFailure(
      call.expected_epoch,
      SessionPortStage::LifecycleDisconnect,
      SessionPortErrorCode::Failed,
      *release.error_message
    );
  }
  std::lock_guard lock(mutex_);
  voice_connected_ = false;
  voice_session_id_.clear();
  voice_generation_ = 0;
  voice_owner_token_ = 0;
  voice_room_instance_token_ = 0;
  voice_livekit_url_.clear();
  voice_livekit_token_.clear();
  return portSuccess(
    call.expected_epoch, SessionPortStage::LifecycleDisconnect
  );
}

SessionPortResult<std::shared_ptr<livekit::LocalAudioTrack>>
DeterministicFakeLiveKitVoiceSession::createMicrophoneTrack(
  SessionPortCall call,
  const std::shared_ptr<livekit::AudioSource>&
) {
  return portSuccess<std::shared_ptr<livekit::LocalAudioTrack>>(
    call.expected_epoch, SessionPortStage::PublicationCreateMicrophone, {}
  );
}

void DeterministicFakeLiveKitVoiceSession::captureMicrophoneFrame(
  const std::shared_ptr<livekit::AudioSource>&,
  const livekit::AudioFrame&,
  bool discontinuity
) {
  std::unique_lock lock(mutex_);
  ++microphone_frame_submission_pending_;
  changed_.notify_all();
  changed_.wait(lock, [&] {
    return !microphone_frame_submission_blocked_;
  });
  --microphone_frame_submission_pending_;
  ++microphone_frame_count_;
  if (discontinuity) ++microphone_discontinuity_count_;
  lock.unlock();
  changed_.notify_all();
}

SessionPortResult<std::string>
DeterministicFakeLiveKitVoiceSession::publishAudioTrack(
  SessionPortCall call,
  const std::shared_ptr<livekit::LocalAudioTrack>&,
  const livekit::TrackPublishOptions&
) {
  if (!isVoiceSessionCurrent(call.expected_epoch.session_id)) {
    return portFailure<std::string>(
      call.expected_epoch,
      SessionPortStage::PublicationPublishAudio,
      SessionPortErrorCode::StaleOwner,
      "fake Room owner is stale"
    );
  }
  const auto release = enterGate(Operation::Publish);
  if (release.error_message) {
    return portFailure<std::string>(
      call.expected_epoch,
      SessionPortStage::PublicationPublishAudio,
      SessionPortErrorCode::Failed,
      *release.error_message
    );
  }
  return portSuccess<std::string>(
    call.expected_epoch,
    SessionPortStage::PublicationPublishAudio,
    release.publication_sid
  );
}

SessionPortResult<std::string>
DeterministicFakeLiveKitVoiceSession::publishVideoTrack(
  SessionPortCall call,
  const std::shared_ptr<livekit::LocalVideoTrack>&,
  const livekit::TrackPublishOptions& options
) {
  auto result = publishAudioTrack(std::move(call), {}, options);
  if (result.hasError()) return result;
  auto value = std::move(result).value();
  value.stage = SessionPortStage::PublicationPublishVideo;
  return SessionPortResult<std::string>::success(std::move(value));
}

SessionPortStatus DeterministicFakeLiveKitVoiceSession::unpublishTrack(
  SessionPortCall call,
  const std::string& publication_sid
) {
  if (!isVoiceSessionCurrent(call.expected_epoch.session_id)) {
    return portFailure(
      call.expected_epoch,
      SessionPortStage::PublicationUnpublish,
      SessionPortErrorCode::StaleOwner,
      "fake Room owner is stale"
    );
  }
  const auto release = enterGate(Operation::Unpublish, &call);
  if (release.error_message) {
    return portFailure(
      call.expected_epoch,
      SessionPortStage::PublicationUnpublish,
      SessionPortErrorCode::Failed,
      *release.error_message
    );
  }
  recordUnpublishedPublicationSid(publication_sid);
  return portSuccess(call.expected_epoch, SessionPortStage::PublicationUnpublish);
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

std::size_t DeterministicFakeLiveKitVoiceSession::microphoneFrameCount() const {
  std::lock_guard lock(mutex_);
  return microphone_frame_count_;
}

std::size_t
DeterministicFakeLiveKitVoiceSession::microphoneDiscontinuityCount() const {
  std::lock_guard lock(mutex_);
  return microphone_discontinuity_count_;
}

void DeterministicFakeLiveKitVoiceSession::setMicrophoneFrameSubmissionBlocked(
  bool blocked
) {
  {
    std::lock_guard lock(mutex_);
    microphone_frame_submission_blocked_ = blocked;
  }
  changed_.notify_all();
}

void DeterministicFakeLiveKitVoiceSession::setCancellationAware(
    Operation operation,
    bool aware) {
  {
    std::lock_guard lock(mutex_);
    gateState(operation).cancellation_aware = aware;
  }
  changed_.notify_all();
}

void DeterministicFakeLiveKitVoiceSession::
waitUntilMicrophoneFrameSubmissionPending(
  std::size_t count,
  std::chrono::milliseconds timeout
) {
  std::unique_lock lock(mutex_);
  if (!changed_.wait_for(lock, timeout, [&] {
        return microphone_frame_submission_pending_ >= count;
      })) {
    throw std::runtime_error(
      "timed out waiting for fake microphone frame submission"
    );
  }
}

void DeterministicFakeLiveKitVoiceSession::waitUntilMicrophoneFrameCount(
  std::size_t count,
  std::chrono::milliseconds timeout
) {
  std::unique_lock lock(mutex_);
  if (!changed_.wait_for(lock, timeout, [&] {
        return microphone_frame_count_ >= count;
      })) {
    throw std::runtime_error(
      "timed out waiting for fake microphone publication frames"
    );
  }
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
  voice_owner_token_ = 1;
}

void DeterministicFakeLiveKitVoiceSession::recordUnpublishedPublicationSid(
  std::string publication_sid
) {
  std::lock_guard lock(mutex_);
  unpublished_publication_sids_.push_back(std::move(publication_sid));
}

DeterministicFakeLiveKitVoiceSession::Release
DeterministicFakeLiveKitVoiceSession::enterGate(
    Operation operation,
    const SessionPortCall* call) {
  std::unique_lock lock(mutex_);
  auto& gate = gateState(operation);
  gate.pending += 1;
  changed_.notify_all();
  while (gate.blocked && gate.releases.empty()) {
    if (gate.cancellation_aware && call &&
        (call->cancellation.isCancellationRequested() ||
         SessionPortCall::Clock::now() >= call->deadline)) {
      gate.pending -= 1;
      changed_.notify_all();
      return Release{
        .error_message = "fake operation cancelled by its call deadline"
      };
    }
    changed_.wait_for(lock, std::chrono::milliseconds(1));
  }
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
