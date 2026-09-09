#pragma once

#include "video/remote_video_track.hpp"
#include <array>
#include <map>

namespace syrnike::windows_media::video {
struct RemoteVideoPublication {
  std::string participant_identity, publication_id;
  bool screen = false;
  bool operator==(const RemoteVideoPublication&) const = default;
};
struct RemoteVideoOwnerSnapshot {
  MediaPathSnapshot path;
  std::uint64_t inventory_revision = 0;
  std::vector<RemoteVideoPublication> publications;
  bool stopped = true;
  std::array<DiagnosticMetric, 10> metrics{};
};

// Bounded publication inventory and demanded decoder owners. SDK callbacks
// update value slots; creating/joining decoders belongs to the owner thread.
class RemoteVideoOwner final : public LiveKitRoomObserver {
 public:
  RemoteVideoOwner();
  ~RemoteVideoOwner() override;
  void apply(std::uint64_t revision, std::span<const RemoteVideoDemand>, bool room_connected);
  void beginStop();
  RemoteVideoOwnerSnapshot snapshot() const;
  std::optional<TextureLease> takeFrame(const std::string& publication_id);
  bool attachRoom(const std::shared_ptr<livekit::Room>&) override;
  bool seedConnectedRoom() override;
  bool detachRoom() override;
  void stop() override;
  void onConnectionStateChanged(livekit::Room&, const livekit::ConnectionStateChangedEvent&) override;
  void onTrackPublished(livekit::Room&, const livekit::TrackPublishedEvent&) override;
  void onTrackUnpublished(livekit::Room&, const livekit::TrackUnpublishedEvent&) override;
  void onTrackSubscribed(livekit::Room&, const livekit::TrackSubscribedEvent&) override;
  void onTrackUnsubscribed(livekit::Room&, const livekit::TrackUnsubscribedEvent&) override;
  void onParticipantDisconnected(livekit::Room&, const livekit::ParticipantDisconnectedEvent&) override;
 private:
  struct Publication {
    RemoteVideoPublication value;
    std::shared_ptr<livekit::RemoteTrackPublication> publication;
    std::shared_ptr<livekit::Track> track;
  };
  using Owners = std::map<std::string, std::shared_ptr<RemoteVideoTrack>>;
  void addPublication(std::string_view participant, std::shared_ptr<livekit::RemoteTrackPublication>);
  void run() noexcept;
  mutable std::mutex mutex_;
  std::mutex join_mutex_;
  std::condition_variable changed_;
  std::shared_ptr<livekit::Room> room_;
  std::vector<Publication> publications_;
  std::vector<RemoteVideoDemand> demand_;
  std::shared_ptr<const Owners> owners_ = std::make_shared<Owners>();
  std::uint64_t revision_ = 0, acknowledged_ = 0, desired_revision_ = 0, inventory_revision_ = 0;
  RemoteVideoOwnerSnapshot snapshot_;
  bool connected_ = false, allowed_ = false, stopping_ = false, done_ = false, failed_ = false;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::video
