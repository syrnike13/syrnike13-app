#pragma once

#include "audio/remote_audio_mixer_worker.hpp"
#include "livekit/livekit_room_transport.hpp"

#include <array>
#include <atomic>
#include <condition_variable>
#include <mutex>

namespace syrnike::windows_media::audio {
struct RemoteAudioTracksStats {
  std::uint64_t decoded = 0;
  std::uint64_t rejected = 0;
  std::uint64_t track_failures = 0;
  std::uint32_t reading = 0;
  bool failed = false;
  std::uint64_t sdk_dropped = 0, sdk_stale = 0;
  std::uint64_t maximum_observed_sdk_queue = 0, maximum_observed_app_queue = 0;
};

// SDK reader/control owner; never runs on the mixer or renderer thread.
// attachRoom precedes connect; detachRoom must acknowledge before destroying
// that Room. Controls survive Room/track replacement until this owner dies.
class RemoteAudioTracks final : public LiveKitRoomObserver {
 public:
  explicit RemoteAudioTracks(RemoteAudioMixerWorker& mixer);
  ~RemoteAudioTracks() override;
  bool attachRoom(const std::shared_ptr<livekit::Room>& room) override;
  // Call after successful connect to seed publications predating this join.
  // Returns false if concurrent events prevented a consistent bounded seed.
  bool seedConnectedRoom() override;
  bool detachRoom() override;
  bool setScreenDemand(std::span<const RemoteVideoDemand> demand);
  bool setUserVolume(std::string_view participant, float volume, bool muted);
  // Replace the complete product mix atomically, including removal of saved
  // overrides. User and screen-audio controls are independent by participant.
  bool configureMix(const OutputIntent&);
  void setDeafened(bool enabled);
  RemoteAudioTracksStats stats() const noexcept;
  void beginStop();
  void stop() override;
  void onConnectionStateChanged(livekit::Room&, const livekit::ConnectionStateChangedEvent&) override;
  void onTrackPublished(livekit::Room&, const livekit::TrackPublishedEvent&) override;
  void onTrackUnpublished(livekit::Room&, const livekit::TrackUnpublishedEvent&) override;
  void onTrackSubscribed(livekit::Room&, const livekit::TrackSubscribedEvent&) override;
  void onTrackUnsubscribed(livekit::Room&, const livekit::TrackUnsubscribedEvent&) override;
  void onTrackSubscriptionFailed(livekit::Room&, const livekit::TrackSubscriptionFailedEvent&) override;
  void onParticipantDisconnected(livekit::Room&, const livekit::ParticipantDisconnectedEvent&) override;

 private:
  static constexpr std::size_t kPublicationCapacity = 64;
  // Voice Director admits 512 volume and 512 mute keys independently.
  static constexpr std::size_t kUserCapacity = 1024;
  struct Publication {
    std::string participant;
    std::shared_ptr<livekit::RemoteTrackPublication> publication;
    std::shared_ptr<livekit::Track> track;
    std::shared_ptr<RemoteAudioPcmPort> port;
    std::uint64_t generation = 0;
    bool failed = false;
  };
  bool desired(const Publication&) const;
  void addPublication(std::string_view participant, const std::shared_ptr<livekit::RemoteTrackPublication>& publication);
  void retire(Publication&);
  void clearRoom();
  void run() noexcept;
  RemoteAudioMixerWorker& mixer_;
  std::mutex mutex_;
  std::mutex join_mutex_;
  std::condition_variable changed_;
  std::shared_ptr<livekit::Room> room_;
  std::array<Publication, kPublicationCapacity> publications_{};
  std::vector<AudioMixSetting> users_, streams_;
  float output_volume_ = 1;
  std::array<RemoteVideoDemand, kRemoteAudioTrackCapacity> demand_{};
  std::size_t demand_count_ = 0;
  std::uint64_t next_generation_ = 0;
  std::uint64_t revision_ = 0, acknowledged_ = 0;
  bool connected_ = false, deafened_ = false, stopping_ = false, done_ = false;
  std::atomic_uint64_t decoded_{0}, rejected_{0}, track_failures_{0};
  std::atomic_uint32_t reading_{0};
  std::atomic_bool failed_{false};
  std::atomic_uint64_t sdk_dropped_{0}, sdk_stale_{0}, maximum_sdk_queue_{0}, maximum_app_queue_{0};
  std::thread worker_;
};
}  // namespace syrnike::windows_media::audio
