#pragma once
#include <livekit/livekit.h>

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <optional>
#include <thread>

#include "livekit/livekit_room_transport.hpp"
#include "video/shared_texture_pool.hpp"

namespace syrnike::windows_media::video {
// One explicitly selected remote video owner. The Room transport owns this
// delegate. SDK callbacks only replace bounded control values; subscription,
// stream teardown and upload execute on this owner's worker, not the FFI lane.
class RemoteVideoTrack final : public LiveKitRoomObserver {
 public:
  RemoteVideoTrack(std::string participant, std::string track_name);
  ~RemoteVideoTrack() override;
  void demand(bool enabled);
  void stop() override;
  std::optional<TextureLease> takeFrame();
  std::uint64_t decoded() const { return decoded_.load(); }
  bool failed() const { return failed_.load(); }
  std::uint64_t generation() const { return generation_.load(); }
  void onTrackPublished(livekit::Room&,
                        const livekit::TrackPublishedEvent&) override;
  void onTrackUnpublished(livekit::Room&,
                          const livekit::TrackUnpublishedEvent&) override;
  void onTrackSubscribed(livekit::Room&,
                         const livekit::TrackSubscribedEvent&) override;
  void onTrackUnsubscribed(livekit::Room&,
                           const livekit::TrackUnsubscribedEvent&) override;
  void onParticipantDisconnected(
      livekit::Room&, const livekit::ParticipantDisconnectedEvent&) override;

 private:
  friend class RemoteVideoFaultInjector;
  bool acceptDecoded(std::uint64_t revision, livekit::VideoFrameEvent event);
  void run() noexcept;
  const std::string participant_;
  const std::string track_name_;
  std::mutex mutex_;
  std::condition_variable changed_;
  std::atomic<std::uint64_t> revision_{0};
  std::atomic<std::uint64_t> decoded_{0};
  std::atomic<std::uint64_t> generation_{0};
  std::atomic<bool> failed_{false};
  bool enabled_ = false;
  bool stopping_ = false;
  std::shared_ptr<livekit::RemoteTrackPublication> publication_;
  std::shared_ptr<livekit::Track> track_;
  std::optional<livekit::VideoFrameEvent> newest_;
  std::int64_t newest_ingress_us_ = 0;
  std::optional<TextureLease> output_;
  std::uint64_t output_revision_ = 0;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::video
