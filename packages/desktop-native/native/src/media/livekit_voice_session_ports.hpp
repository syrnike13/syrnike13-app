#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>

#include <livekit/livekit.h>
#include <livekit/local_audio_track.h>
#include <livekit/local_video_track.h>
#include <livekit/result.h>

#include "../common/runtime_types.hpp"
#include "remote_audio_output.hpp"

namespace syrnike::desktop_native::media {

// A Native Media Session has one connection epoch, but independent liveness
// ports. The epoch fences a borrowed Room snapshot; the stage makes every
// success and failure correlatable without exposing the Room to an actor.
struct SessionEpoch {
  std::string session_id;
  std::uint64_t generation = 0;
  // A connection owner is narrower than a media generation. The lifecycle
  // actor assigns a new non-zero token to every connect attempt, so cleanup
  // from an older attempt cannot retire a replacement Room that reused the
  // same session id and generation.
  std::uint64_t owner_token = 0;
  // Stable for the physical Room across a same-Room owner transfer. Delayed
  // resource cleanup validates this capability, while state-changing calls
  // continue to require the current owner_token.
  std::uint64_t room_instance_token = 0;
};

enum class SessionPortStage {
  LifecycleConnect,
  LifecycleStatus,
  LifecycleDisconnect,
  PublicationCreateMicrophone,
  PublicationAcquire,
  PublicationPublishAudio,
  PublicationPublishVideo,
  PublicationUnpublish,
  OutputDeafen,
  OutputDevice,
  OutputDeviceQuery,
  OutputVolume,
  OutputConfigureRemoteAudio,
  RemoteFrameRelease,
  CameraPreviewStart,
  CameraPreviewStop,
  CameraPreviewRelease,
  DemandSet,
  DemandReconcile,
  DemandRetry,
};

enum class SessionPortErrorCode {
  StaleOwner,
  Timeout,
  Cancelled,
  Failed,
};

struct SessionPortReceipt {
  SessionEpoch epoch;
  SessionPortStage stage = SessionPortStage::LifecycleStatus;
};

struct SessionPortError : SessionPortReceipt {
  SessionPortErrorCode code = SessionPortErrorCode::Failed;
  std::string message;
};

template <typename T>
struct SessionPortValue : SessionPortReceipt {
  T value;
};

using SessionPortStatus = livekit::Result<SessionPortReceipt, SessionPortError>;

template <typename T>
using SessionPortResult = livekit::Result<SessionPortValue<T>, SessionPortError>;

struct SessionPortCall {
  using Clock = std::chrono::steady_clock;

  SessionEpoch expected_epoch;
  Clock::time_point deadline;
  livekit::OperationCancellation cancellation;

  static SessionPortCall current(
    std::chrono::milliseconds budget = std::chrono::seconds(2)
  ) {
    return SessionPortCall{{}, Clock::now() + budget, {}};
  }

  static SessionPortCall forOwner(
    SessionEpoch owner,
    std::chrono::milliseconds budget = std::chrono::seconds(10)
  ) {
    return SessionPortCall{
      std::move(owner), Clock::now() + budget, {}
    };
  }

  static SessionPortCall forOwner(
    std::string session_id,
    std::uint64_t generation,
    std::uint64_t owner_token,
    std::chrono::milliseconds budget = std::chrono::seconds(10)
  ) {
    return forOwner(
      SessionEpoch{std::move(session_id), generation, owner_token}, budget
    );
  }
};

inline const char* sessionPortStageName(SessionPortStage stage) noexcept {
  switch (stage) {
    case SessionPortStage::LifecycleConnect: return "lifecycle.connect";
    case SessionPortStage::LifecycleStatus: return "lifecycle.status";
    case SessionPortStage::LifecycleDisconnect: return "lifecycle.disconnect";
    case SessionPortStage::PublicationCreateMicrophone:
      return "publication.create_microphone";
    case SessionPortStage::PublicationAcquire: return "publication.acquire";
    case SessionPortStage::PublicationPublishAudio:
      return "publication.publish_audio";
    case SessionPortStage::PublicationPublishVideo:
      return "publication.publish_video";
    case SessionPortStage::PublicationUnpublish:
      return "publication.unpublish";
    case SessionPortStage::OutputDeafen: return "output.deafen";
    case SessionPortStage::OutputDevice: return "output.device";
    case SessionPortStage::OutputDeviceQuery: return "output.device_query";
    case SessionPortStage::OutputVolume: return "output.volume";
    case SessionPortStage::OutputConfigureRemoteAudio:
      return "output.configure_remote_audio";
    case SessionPortStage::RemoteFrameRelease: return "remote_frame.release";
    case SessionPortStage::CameraPreviewStart: return "camera_preview.start";
    case SessionPortStage::CameraPreviewStop: return "camera_preview.stop";
    case SessionPortStage::CameraPreviewRelease: return "camera_preview.release";
    case SessionPortStage::DemandSet: return "demand.set";
    case SessionPortStage::DemandReconcile: return "demand.reconcile";
    case SessionPortStage::DemandRetry: return "demand.retry";
  }
  return "unknown";
}

inline std::string describeSessionPortError(const SessionPortError& error) {
  std::ostringstream message;
  message << sessionPortStageName(error.stage) << " failed for session '"
          << error.epoch.session_id << "' generation "
          << error.epoch.generation << " owner " << error.epoch.owner_token
          << ": " << error.message;
  return message.str();
}

inline void requireSessionPortSuccess(const SessionPortStatus& result) {
  if (result.hasError()) {
    throw std::runtime_error(describeSessionPortError(result.error()));
  }
}

template <typename T>
T requireSessionPortValue(SessionPortResult<T> result) {
  if (result.hasError()) {
    throw std::runtime_error(describeSessionPortError(result.error()));
  }
  return std::move(result).value().value;
}

class LiveKitVoiceLifecyclePort {
 public:
  using InternalPost = std::function<bool(MediaCommand)>;
  virtual ~LiveKitVoiceLifecyclePort() = default;

  virtual SessionPortResult<bool> connect(
    SessionPortCall call,
    const std::string& livekit_url,
    const std::string& livekit_token,
    InternalPost post
  ) = 0;
  virtual SessionPortResult<bool> status(SessionPortCall call) const = 0;
  virtual SessionPortStatus require(SessionPortCall call) const = 0;
  virtual SessionPortStatus disconnect(SessionPortCall call) = 0;
};

class LiveKitVoicePublicationPort {
 public:
  virtual ~LiveKitVoicePublicationPort() = default;

  virtual SessionPortResult<std::shared_ptr<livekit::LocalAudioTrack>>
  createMicrophoneTrack(
    SessionPortCall call,
    const std::shared_ptr<livekit::AudioSource>& source
  ) = 0;
  // Own the capture-queue discontinuity policy at the publication adapter so
  // the microphone worker has one observable, replaceable SDK boundary.
  virtual void captureMicrophoneFrame(
    const std::shared_ptr<livekit::AudioSource>& source,
    const livekit::AudioFrame& frame,
    bool discontinuity
  ) = 0;
  virtual SessionPortResult<std::string> publishAudioTrack(
    SessionPortCall call,
    const std::shared_ptr<livekit::LocalAudioTrack>& track,
    const livekit::TrackPublishOptions& options
  ) = 0;
  virtual SessionPortResult<std::string> publishVideoTrack(
    SessionPortCall call,
    const std::shared_ptr<livekit::LocalVideoTrack>& track,
    const livekit::TrackPublishOptions& options
  ) = 0;
  virtual SessionPortStatus unpublishTrack(
    SessionPortCall call,
    const std::string& publication_sid
  ) = 0;
};

class LiveKitVoiceOutputPort {
 public:
  virtual ~LiveKitVoiceOutputPort() = default;
  virtual SessionPortStatus setDeafened(SessionPortCall call, bool value) = 0;
  virtual SessionPortResult<std::uint64_t> setDevice(
    SessionPortCall call,
    std::string value
  ) = 0;
  virtual SessionPortResult<std::string> deviceId(SessionPortCall call) const = 0;
  virtual SessionPortStatus setVolume(SessionPortCall call, float value) = 0;
  virtual SessionPortStatus configureRemoteAudio(
    SessionPortCall call,
    RemoteAudioSettings settings
  ) = 0;
};

class LiveKitRemoteFrameReleasePort {
 public:
  virtual ~LiveKitRemoteFrameReleasePort() = default;
  virtual SessionPortStatus releaseRemoteFrame(
    SessionPortCall call,
    std::string track_id,
    std::uint64_t sequence
  ) = 0;
};

class LiveKitCameraPreviewPort {
 public:
  virtual ~LiveKitCameraPreviewPort() = default;
  virtual SessionPortStatus start(
    SessionPortCall call,
    std::string track_id,
    std::string participant_identity,
    std::shared_ptr<livekit::LocalVideoTrack> track
  ) = 0;
  virtual SessionPortStatus stop(SessionPortCall call, std::string track_id) = 0;
  virtual SessionPortStatus releasePreviewFrame(
    SessionPortCall call,
    std::string track_id,
    std::uint64_t sequence
  ) = 0;
};

class LiveKitRemoteDemandPort {
 public:
  virtual ~LiveKitRemoteDemandPort() = default;
  virtual SessionPortStatus set(
    SessionPortCall call,
    std::string track_id,
    bool demanded
  ) = 0;
  virtual SessionPortStatus reconcile(
    SessionPortCall call,
    std::string track_id,
    std::uint64_t expected_revision = 0
  ) = 0;
  virtual SessionPortStatus retry(
    SessionPortCall call,
    std::string track_id,
    std::string reason
  ) = 0;
};

}  // namespace syrnike::desktop_native::media
