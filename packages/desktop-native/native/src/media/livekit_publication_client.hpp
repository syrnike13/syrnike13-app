#pragma once

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include <livekit/livekit.h>
#include <livekit/local_audio_track.h>
#include <livekit/local_video_track.h>

#include "../common/runtime_types.hpp"

namespace syrnike::desktop_native::media {

class LiveKitRoomSession {
 public:
  virtual ~LiveKitRoomSession() = default;

  virtual void updateIdentity(std::string session_id, std::uint64_t generation) = 0;
  virtual bool connect(
    const std::string& livekit_url,
    const std::string& livekit_token,
    const livekit::RoomOptions& options
  ) = 0;
  virtual bool isConnected() const = 0;
  virtual bool waitConnected(std::chrono::milliseconds timeout) = 0;
  virtual std::string publishAudioTrack(
    const std::shared_ptr<livekit::LocalAudioTrack>& track,
    const livekit::TrackPublishOptions& options
  ) = 0;
  virtual std::string publishVideoTrack(
    const std::shared_ptr<livekit::LocalVideoTrack>& track,
    const livekit::TrackPublishOptions& options
  ) = 0;
  virtual void unpublishTrack(const std::string& publication_sid) = 0;
  virtual void markIntentionalDisconnect() = 0;
  virtual void disconnect() = 0;
};

class LiveKitPublicationClient {
 public:
  using InternalPost = std::function<bool(MediaCommand)>;

  virtual ~LiveKitPublicationClient() = default;

  virtual std::shared_ptr<livekit::LocalAudioTrack> createMicrophoneTrack(
    const std::shared_ptr<livekit::AudioSource>& source
  ) = 0;

  virtual std::unique_ptr<LiveKitRoomSession> createMicrophoneSession(
    std::string session_id,
    std::uint64_t generation,
    InternalPost post
  ) = 0;
  virtual std::unique_ptr<LiveKitRoomSession> createScreenSession(
    std::string session_id,
    std::uint64_t generation,
    InternalPost post
  ) = 0;
};

std::shared_ptr<LiveKitPublicationClient> createRealLiveKitPublicationClient();

class DeterministicFakeLiveKitPublicationClient final : public LiveKitPublicationClient {
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

  DeterministicFakeLiveKitPublicationClient() = default;

  std::shared_ptr<livekit::LocalAudioTrack> createMicrophoneTrack(
    const std::shared_ptr<livekit::AudioSource>& source
  ) override;

  std::unique_ptr<LiveKitRoomSession> createMicrophoneSession(
    std::string session_id,
    std::uint64_t generation,
    InternalPost post
  ) override;
  std::unique_ptr<LiveKitRoomSession> createScreenSession(
    std::string session_id,
    std::uint64_t generation,
    InternalPost post
  ) override;

  void setBlocked(Operation operation, bool blocked);
  void releaseNext(Operation operation, Release release = {});
  void waitUntilPending(
    Operation operation,
    std::size_t count,
    std::chrono::milliseconds timeout = std::chrono::seconds(1)
  );
  std::size_t pending(Operation operation) const;
  std::vector<std::string> unpublishedPublicationSids() const;
  Release enterGate(Operation operation);
  void recordUnpublishedPublicationSid(std::string publication_sid);

 private:
  struct GateState {
    bool blocked = false;
    std::size_t pending = 0;
    std::deque<Release> releases;
  };

  GateState& gateState(Operation operation);
  const GateState& gateState(Operation operation) const;

  mutable std::mutex mutex_;
  std::condition_variable changed_;
  GateState connect_;
  GateState publish_;
  GateState unpublish_;
  GateState disconnect_;
  std::vector<std::string> unpublished_publication_sids_;
};

}  // namespace syrnike::desktop_native::media
