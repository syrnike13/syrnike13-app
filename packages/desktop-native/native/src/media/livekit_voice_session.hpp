#pragma once

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include <livekit/livekit.h>
#include <livekit/local_audio_track.h>
#include <livekit/local_video_track.h>

#include "../common/runtime_types.hpp"
#include "remote_audio_output.hpp"

namespace syrnike::desktop_native::media {

class LiveKitRuntimeLifetime;

enum class RemoteVideoRecoveryMode {
  LocalBridge,
  Subscription,
};

// The sole owner of the native voice Room and its connection epoch. Media
// actors submit scoped operations through this API; they never receive Room or
// LocalTrackPublication handles whose lifetime could escape the session.
class LiveKitVoiceSession {
 public:
  using InternalPost = std::function<bool(MediaCommand)>;

  virtual ~LiveKitVoiceSession() = default;

  void retainRuntimeLifetime(
    std::shared_ptr<LiveKitRuntimeLifetime> lifetime
  ) {
    if (!lifetime) {
      throw std::invalid_argument("LiveKit runtime lifetime is required");
    }
    if (runtime_lifetime_ && runtime_lifetime_ != lifetime) {
      throw std::logic_error(
        "LiveKit voice session cannot replace its runtime lifetime"
      );
    }
    runtime_lifetime_ = std::move(lifetime);
  }
  [[nodiscard]] std::shared_ptr<LiveKitRuntimeLifetime>
  runtimeLifetimeToken() const noexcept {
    return runtime_lifetime_;
  }

  virtual bool connectVoice(
    std::string session_id,
    std::uint64_t generation,
    const std::string& livekit_url,
    const std::string& livekit_token,
    InternalPost post
  ) = 0;
  virtual void requireVoiceSession(const std::string& session_id) const = 0;
  virtual bool isVoiceConnected() const = 0;
  virtual void setVoiceDeafened(bool deafened) = 0;
  virtual std::uint64_t setVoiceOutputDevice(
    std::string device_id,
    AudioOutputDeviceIntent intent
  ) = 0;
  virtual std::string voiceOutputDeviceId() const = 0;
  virtual bool isVoiceOutputEpochCurrent(std::uint64_t epoch) const = 0;
  virtual void setVoiceOutputVolume(float volume) = 0;
  virtual void configureRemoteAudio(RemoteAudioSettings settings) = 0;
  virtual void releaseRemoteVideoFrame(std::string track_id, std::uint64_t sequence) = 0;
  virtual void setRemoteVideoDemand(std::string track_id, bool demanded) = 0;
  virtual void retryRemoteVideo(
    std::string track_id,
    RemoteVideoRecoveryMode mode,
    std::string reason
  ) = 0;
  virtual void startLocalCameraPreview(
    std::string session_id,
    std::uint64_t generation,
    std::string track_id,
    std::string participant_identity,
    std::shared_ptr<livekit::LocalVideoTrack> track
  ) = 0;
  virtual void stopLocalCameraPreview(std::string track_id) = 0;
  virtual void releaseLocalCameraPreviewFrame(
    std::string track_id,
    std::uint64_t sequence
  ) = 0;
  virtual void disconnectVoice() = 0;

  virtual std::shared_ptr<livekit::LocalAudioTrack> createMicrophoneTrack(
    const std::shared_ptr<livekit::AudioSource>& source
  ) = 0;
  virtual std::string publishAudioTrack(
    const std::string& session_id,
    std::uint64_t generation,
    const std::shared_ptr<livekit::LocalAudioTrack>& track,
    const livekit::TrackPublishOptions& options
  ) = 0;
  virtual std::string publishVideoTrack(
    const std::string& session_id,
    std::uint64_t generation,
    const std::shared_ptr<livekit::LocalVideoTrack>& track,
    const livekit::TrackPublishOptions& options
  ) = 0;
  virtual void unpublishTrack(
    const std::string& session_id,
    std::uint64_t generation,
    const std::string& publication_sid
  ) = 0;

 private:
  std::shared_ptr<LiveKitRuntimeLifetime> runtime_lifetime_;
};

class LiveKitVoiceRoomOwner {
 public:
  virtual ~LiveKitVoiceRoomOwner() = default;
  void retainRuntimeLifetime(
    std::shared_ptr<LiveKitRuntimeLifetime> lifetime
  ) noexcept {
    runtime_lifetime_ = std::move(lifetime);
  }
  [[nodiscard]] std::shared_ptr<LiveKitRuntimeLifetime>
  runtimeLifetimeToken() const noexcept {
    return runtime_lifetime_;
  }
  virtual bool connect(const std::string&, const std::string&, const livekit::RoomOptions&) = 0;
  virtual bool isConnected() const = 0;
  virtual bool waitConnected(std::chrono::milliseconds) = 0;
  virtual void markIntentionalDisconnect() = 0;
  virtual void stopAudio() = 0;
  virtual void disconnect() = 0;
  virtual void setDeafened(bool) = 0;
  virtual std::uint64_t setOutputDevice(std::string, AudioOutputDeviceIntent) = 0;
  virtual std::string outputDeviceId() const = 0;
  virtual bool isOutputEpochCurrent(std::uint64_t) const = 0;
  virtual void setOutputVolume(float) = 0;
  virtual void configureRemoteAudio(RemoteAudioSettings) = 0;
  virtual void releaseRemoteVideoFrame(std::string, std::uint64_t) = 0;
  virtual void setRemoteVideoDemand(std::string, bool) = 0;
  virtual void retryRemoteVideo(
    std::string,
    RemoteVideoRecoveryMode,
    std::string
  ) = 0;
  virtual void startLocalCameraPreview(
    std::string, std::uint64_t, std::string, std::string,
    const std::shared_ptr<livekit::LocalVideoTrack>&
  ) = 0;
  virtual void stopLocalCameraPreview(const std::string&) = 0;
  virtual void releaseLocalCameraPreviewFrame(std::string, std::uint64_t) = 0;
  virtual std::string publishAudioTrack(
    const std::shared_ptr<livekit::LocalAudioTrack>&,
    const livekit::TrackPublishOptions&
  ) = 0;
  virtual std::string publishVideoTrack(
    const std::shared_ptr<livekit::LocalVideoTrack>&,
    const livekit::TrackPublishOptions&
  ) = 0;
  virtual void unpublishTrack(const std::string&) = 0;

 private:
  std::shared_ptr<LiveKitRuntimeLifetime> runtime_lifetime_;
};

using LiveKitVoiceRoomOwnerFactory = std::function<
  std::shared_ptr<LiveKitVoiceRoomOwner>(
    std::string,
    std::string,
    std::string,
    std::uint64_t,
    LiveKitVoiceSession::InternalPost
  )
>;

std::shared_ptr<LiveKitVoiceSession> createRealLiveKitVoiceSession(
  std::shared_ptr<LiveKitRuntimeLifetime> runtime_lifetime,
  LiveKitVoiceRoomOwnerFactory voice_room_factory = {}
);

class DeterministicFakeLiveKitVoiceSession final : public LiveKitVoiceSession {
 public:
  enum class Operation {
    Connect,
    Publish,
    Unpublish,
    Disconnect,
  };

  struct Release {
    bool bool_result = true;
    std::string publication_sid = "fake-publication";
    std::optional<std::string> error_message;
  };

  DeterministicFakeLiveKitVoiceSession() = default;

  bool connectVoice(
    std::string session_id,
    std::uint64_t generation,
    const std::string& livekit_url,
    const std::string& livekit_token,
    InternalPost post
  ) override;
  void requireVoiceSession(const std::string& session_id) const override;
  bool isVoiceConnected() const override;
  void setVoiceDeafened(bool deafened) override;
  std::uint64_t setVoiceOutputDevice(
    std::string device_id,
    AudioOutputDeviceIntent intent
  ) override;
  std::string voiceOutputDeviceId() const override;
  bool isVoiceOutputEpochCurrent(std::uint64_t epoch) const override;
  void setVoiceOutputVolume(float volume) override;
  void configureRemoteAudio(RemoteAudioSettings settings) override;
  void releaseRemoteVideoFrame(std::string track_id, std::uint64_t sequence) override;
  void setRemoteVideoDemand(std::string track_id, bool demanded) override;
  void retryRemoteVideo(
    std::string track_id,
    RemoteVideoRecoveryMode mode,
    std::string reason
  ) override;
  void startLocalCameraPreview(
    std::string session_id,
    std::uint64_t generation,
    std::string track_id,
    std::string participant_identity,
    std::shared_ptr<livekit::LocalVideoTrack> track
  ) override;
  void stopLocalCameraPreview(std::string track_id) override;
  void releaseLocalCameraPreviewFrame(
    std::string track_id,
    std::uint64_t sequence
  ) override;
  void disconnectVoice() override;

  std::shared_ptr<livekit::LocalAudioTrack> createMicrophoneTrack(
    const std::shared_ptr<livekit::AudioSource>& source
  ) override;

  std::string publishAudioTrack(
    const std::string& session_id,
    std::uint64_t generation,
    const std::shared_ptr<livekit::LocalAudioTrack>& track,
    const livekit::TrackPublishOptions& options
  ) override;
  std::string publishVideoTrack(
    const std::string& session_id,
    std::uint64_t generation,
    const std::shared_ptr<livekit::LocalVideoTrack>& track,
    const livekit::TrackPublishOptions& options
  ) override;
  void unpublishTrack(
    const std::string& session_id,
    std::uint64_t generation,
    const std::string& publication_sid
  ) override;

  void setBlocked(Operation operation, bool blocked);
  void setCancelPendingConnectOnDisconnect(bool cancel);
  void releaseNext(Operation operation, Release release = {});
  void waitUntilPending(
    Operation operation,
    std::size_t count,
    std::chrono::milliseconds timeout = std::chrono::seconds(1)
  );
  std::size_t pending(Operation operation) const;
  std::vector<std::string> unpublishedPublicationSids() const;
  std::size_t localCameraPreviewStartCount() const;
  std::size_t localCameraPreviewStopCount() const;
  std::size_t disconnectCallCount() const;
  void setVoiceSessionForTest(std::string session_id);

 private:
  struct GateState {
    bool blocked = false;
    std::size_t pending = 0;
    std::deque<Release> releases;
  };

  GateState& gateState(Operation operation);
  const GateState& gateState(Operation operation) const;
  Release enterGate(Operation operation);
  void recordUnpublishedPublicationSid(std::string publication_sid);
  bool isVoiceSessionCurrent(const std::string& session_id) const;

  mutable std::mutex mutex_;
  std::condition_variable changed_;
  GateState connect_;
  GateState publish_;
  GateState unpublish_;
  GateState disconnect_;
  std::vector<std::string> unpublished_publication_sids_;
  std::size_t local_camera_preview_start_count_ = 0;
  std::size_t local_camera_preview_stop_count_ = 0;
  std::size_t disconnect_call_count_ = 0;
  std::size_t voice_connect_pending_ = 0;
  bool cancel_pending_connect_on_disconnect_ = true;
  bool voice_connected_ = false;
  std::string voice_session_id_;
  std::uint64_t voice_generation_ = 0;
  std::string voice_livekit_url_;
  std::string voice_livekit_token_;
  bool voice_deafened_ = false;
  std::string voice_output_device_id_ = "default";
  std::uint64_t voice_output_epoch_ = 0;
};

}  // namespace syrnike::desktop_native::media
