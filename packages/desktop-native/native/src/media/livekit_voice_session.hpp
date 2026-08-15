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
#include <utility>
#include <vector>

#include <livekit/livekit.h>
#include <livekit/local_audio_track.h>
#include <livekit/local_video_track.h>

#include "../common/runtime_types.hpp"
#include "livekit_voice_session_ports.hpp"
#include "remote_audio_output.hpp"

namespace syrnike::desktop_native::media {

class LiveKitRuntimeLifetime;

enum class LiveKitVoiceRoomOperationErrorCode {
  Timeout,
  Cancelled,
  Failed,
};

struct LiveKitVoiceRoomOperationError {
  LiveKitVoiceRoomOperationErrorCode code =
    LiveKitVoiceRoomOperationErrorCode::Failed;
  std::string message;
};

template <typename T>
using LiveKitVoiceRoomOperationResult =
  livekit::Result<T, LiveKitVoiceRoomOperationError>;

// The sole logical owner of the native voice Room and its connection epoch.
// Port references are stable for this object's lifetime. An implementation may
// copy a short-lived shared Room lease while holding its owner-snapshot lock,
// but it releases that lock before every external SDK call; only publication
// has an ordering gate, and every acquisition of that gate has a finite
// deadline. Media actors never receive Room or LocalTrackPublication handles
// whose lifetime could escape this module.
class LiveKitVoiceSession {
 public:
  using InternalPost = LiveKitVoiceLifecyclePort::InternalPost;

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

  virtual LiveKitVoiceLifecyclePort& lifecycle() noexcept = 0;
  virtual const LiveKitVoiceLifecyclePort& lifecycle() const noexcept = 0;
  virtual LiveKitVoicePublicationPort& publication() noexcept = 0;
  virtual LiveKitVoiceOutputPort& output() noexcept = 0;
  virtual const LiveKitVoiceOutputPort& output() const noexcept = 0;
  virtual LiveKitRemoteFrameReleasePort& remoteFrameRelease() noexcept = 0;
  virtual LiveKitCameraPreviewPort& cameraPreview() noexcept = 0;
  virtual LiveKitRemoteDemandPort& remoteDemand() noexcept = 0;

  // Bind actor-local work to the current Room owner. The returned call carries
  // the caller's media generation for correlation and the exact Room token for
  // stale-owner rejection; all work derived from one resource must retain this
  // call instead of rebinding during cleanup.
  [[nodiscard]] SessionPortResult<SessionPortCall> bindCurrentOwner(
    std::string session_id,
    std::uint64_t generation,
    std::chrono::milliseconds budget = std::chrono::seconds(10)
  );

 private:
 std::shared_ptr<LiveKitRuntimeLifetime> runtime_lifetime_;
};

// Owns the production terminal command and commit gate used by a room
// delegate. The candidate may report a disconnect before actor commit, so the
// terminal is buffered until the owner and incarnation become authoritative.
class VoiceTerminalPostGate final {
 public:
  VoiceTerminalPostGate(
    NativeCommandType terminal_type,
    std::string session_id,
    std::uint64_t generation,
    LiveKitVoiceSession::InternalPost post
  ) : terminal_type_(terminal_type),
      session_id_(std::move(session_id)),
      generation_(generation),
      terminal_incarnation_(nextTerminalIncarnation()),
      terminal_commit_(
        terminalIncarnationFence(), NativeTerminalProducer::VoiceRoom,
        terminal_incarnation_
      ),
      post_(std::move(post)) {}

  void publish() {
    auto pending = terminal_commit_.publish();
    if (pending) static_cast<void>(post_(std::move(*pending)));
  }

  void post(std::string message) {
    MediaCommand command;
    command.type = terminal_type_;
    command.terminal_producer = NativeTerminalProducer::VoiceRoom;
    command.session_id = session_id_;
    command.generation = generation_;
    command.terminal_incarnation = terminal_incarnation_;
    command.internal_message = std::move(message);
    auto accepted = terminal_commit_.submit(std::move(command));
    if (accepted) static_cast<void>(post_(std::move(*accepted)));
  }

  void cancel() noexcept { terminal_commit_.cancel(); }

 private:
  const NativeCommandType terminal_type_;
  const std::string session_id_;
  const std::uint64_t generation_;
  const std::uint64_t terminal_incarnation_;
  NativeTerminalCommitGate terminal_commit_;
  LiveKitVoiceSession::InternalPost post_;
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
  virtual bool connectCancellable(
    const std::string& livekit_url,
    const std::string& livekit_token,
    const livekit::RoomOptions& options,
    const livekit::OperationCancellation& cancellation
  ) {
    if (cancellation.isCancellationRequested()) return false;
    return connect(livekit_url, livekit_token, options);
  }
  virtual bool isConnected() const = 0;
  virtual bool waitConnected(std::chrono::milliseconds) = 0;
  virtual bool waitConnectedCancellable(
    std::chrono::milliseconds timeout,
    const livekit::OperationCancellation& cancellation
  ) {
    if (cancellation.isCancellationRequested()) return false;
    return waitConnected(timeout);
  }
  virtual void publishTerminalIncarnation() {}
  virtual void markIntentionalDisconnect() = 0;
  virtual void stopAudio() = 0;
  virtual void disconnect() = 0;
  virtual void setDeafened(bool) = 0;
  virtual std::uint64_t setOutputDevice(std::string) = 0;
  virtual std::string outputDeviceId() const = 0;
  virtual void setOutputVolume(float) = 0;
  virtual void configureRemoteAudio(RemoteAudioSettings) = 0;
  virtual void releaseRemoteVideoFrame(std::string, std::uint64_t) = 0;
  virtual void reconcileRemotePublication(std::string, std::uint64_t) = 0;
  virtual void reconcileRegisteredRemotePublications() = 0;
  virtual void setRemoteVideoDemand(std::string, bool) = 0;
  virtual void retryRemoteVideo(
    std::string,
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
  virtual LiveKitVoiceRoomOperationResult<std::string> publishAudioTrackUntil(
    const std::shared_ptr<livekit::LocalAudioTrack>& track,
    const livekit::TrackPublishOptions& options,
    std::chrono::steady_clock::time_point deadline,
    const livekit::OperationCancellation& cancellation
  );
  virtual LiveKitVoiceRoomOperationResult<std::string> publishVideoTrackUntil(
    const std::shared_ptr<livekit::LocalVideoTrack>& track,
    const livekit::TrackPublishOptions& options,
    std::chrono::steady_clock::time_point deadline,
    const livekit::OperationCancellation& cancellation
  );
  virtual LiveKitVoiceRoomOperationResult<void> unpublishTrackUntil(
    const std::string& publication_sid,
    std::chrono::steady_clock::time_point deadline,
    const livekit::OperationCancellation& cancellation
  );

 private:
  std::shared_ptr<LiveKitRuntimeLifetime> runtime_lifetime_;
};

using LiveKitVoiceRoomOwnerFactory = std::function<
  std::shared_ptr<LiveKitVoiceRoomOwner>(
    std::string,
    NativeCommandType,
    std::string,
    std::uint64_t,
    LiveKitVoiceSession::InternalPost
  )
>;

std::shared_ptr<LiveKitVoiceSession> createRealLiveKitVoiceSession(
  std::shared_ptr<LiveKitRuntimeLifetime> runtime_lifetime,
  LiveKitVoiceRoomOwnerFactory voice_room_factory = {}
);

class DeterministicFakeLiveKitVoiceSession final
  : public LiveKitVoiceSession,
    private LiveKitVoiceLifecyclePort,
    private LiveKitVoicePublicationPort,
    private LiveKitVoiceOutputPort,
    private LiveKitRemoteFrameReleasePort,
    private LiveKitCameraPreviewPort,
    private LiveKitRemoteDemandPort {
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
  ) override;
  SessionPortStatus require(SessionPortCall call) const override;
  SessionPortResult<bool> status(SessionPortCall call) const override;
  SessionPortStatus setDeafened(SessionPortCall call, bool deafened) override;
  SessionPortResult<std::uint64_t> setDevice(
    SessionPortCall call,
    std::string device_id
  ) override;
  SessionPortResult<std::string> deviceId(SessionPortCall call) const override;
  SessionPortStatus setVolume(SessionPortCall call, float volume) override;
  SessionPortStatus configureRemoteAudio(
    SessionPortCall call,
    RemoteAudioSettings settings
  ) override;
  SessionPortStatus releaseRemoteFrame(
    SessionPortCall call,
    std::string track_id,
    std::uint64_t sequence
  ) override;
  SessionPortStatus reconcile(
    SessionPortCall call,
    std::string track_id,
    std::uint64_t expected_revision = 0
  ) override;
  SessionPortStatus set(
    SessionPortCall call,
    std::string track_id,
    bool demanded
  ) override;
  SessionPortStatus retry(
    SessionPortCall call,
    std::string track_id,
    std::string reason
  ) override;
  SessionPortStatus start(
    SessionPortCall call,
    std::string track_id,
    std::string participant_identity,
    std::shared_ptr<livekit::LocalVideoTrack> track
  ) override;
  SessionPortStatus stop(SessionPortCall call, std::string track_id) override;
  SessionPortStatus releasePreviewFrame(
    SessionPortCall call,
    std::string track_id,
    std::uint64_t sequence
  ) override;
  SessionPortStatus disconnect(SessionPortCall call) override;

  SessionPortResult<std::shared_ptr<livekit::LocalAudioTrack>>
  createMicrophoneTrack(
    SessionPortCall call,
    const std::shared_ptr<livekit::AudioSource>& source
  ) override;
  void captureMicrophoneFrame(
    const std::shared_ptr<livekit::AudioSource>& source,
    const livekit::AudioFrame& frame,
    bool discontinuity
  ) override;

  SessionPortResult<std::string> publishAudioTrack(
    SessionPortCall call,
    const std::shared_ptr<livekit::LocalAudioTrack>& track,
    const livekit::TrackPublishOptions& options
  ) override;
  SessionPortResult<std::string> publishVideoTrack(
    SessionPortCall call,
    const std::shared_ptr<livekit::LocalVideoTrack>& track,
    const livekit::TrackPublishOptions& options
  ) override;
  SessionPortStatus unpublishTrack(
    SessionPortCall call,
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
  std::size_t microphoneFrameCount() const;
  std::size_t microphoneDiscontinuityCount() const;
  void setMicrophoneFrameSubmissionBlocked(bool blocked);
  void waitUntilMicrophoneFrameSubmissionPending(
    std::size_t count,
    std::chrono::milliseconds timeout = std::chrono::seconds(1)
  );
  void waitUntilMicrophoneFrameCount(
    std::size_t count,
    std::chrono::milliseconds timeout = std::chrono::seconds(1)
  );
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
  bool microphone_frame_submission_blocked_ = false;
  std::size_t microphone_frame_submission_pending_ = 0;
  std::size_t microphone_frame_count_ = 0;
  std::size_t microphone_discontinuity_count_ = 0;
  std::size_t voice_connect_pending_ = 0;
  std::vector<SessionEpoch> pending_connect_epochs_;
  bool cancel_pending_connect_on_disconnect_ = true;
  bool voice_connected_ = false;
  std::string voice_session_id_;
  std::uint64_t voice_generation_ = 0;
  std::uint64_t voice_owner_token_ = 0;
  std::uint64_t voice_room_instance_token_ = 0;
  std::uint64_t next_voice_room_instance_token_ = 1;
  std::string voice_livekit_url_;
  std::string voice_livekit_token_;
  bool voice_deafened_ = false;
  std::string voice_output_device_id_ = "default";
  std::uint64_t voice_output_epoch_ = 0;
};

}  // namespace syrnike::desktop_native::media
