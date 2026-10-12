#pragma once

#include "audio/remote_audio_playout.hpp"
#include "video/remote_video_owner.hpp"

namespace syrnike::windows_media {

// Fixed product composition: both reader inventories see the same Room events.
// Shared ownership keeps them alive until the transport has removed its delegate.
class ProductRoomObserver final : public LiveKitRoomObserver {
 public:
  ProductRoomObserver(std::shared_ptr<audio::RemoteAudioPlayout> audio,
                      std::shared_ptr<video::RemoteVideoOwner> video)
      : audio_(std::move(audio)), video_(std::move(video)) {}
  std::shared_ptr<LiveKitNetworkSampler> networkSampler() const { return network_; }

  bool attachRoom(const std::shared_ptr<livekit::Room>& room) override {
    network_->attachRoom(room);
    const bool audio = audio_->attachRoom(room);
    const bool video = video_->attachRoom(room);
    return audio && video;
  }
  bool seedConnectedRoom() override {
    const bool audio = audio_->seedConnectedRoom();
    const bool video = video_->seedConnectedRoom();
    return audio && video;
  }
  bool detachRoom() override {
    network_->detachRoom();
    const bool audio = audio_->detachRoom();
    const bool video = video_->detachRoom();
    return audio && video;
  }
  void stop() override {
    network_->detachRoom();
    audio_->beginStop();
    video_->beginStop();
    audio_->stop();
    video_->stop();
  }
  void onConnectionStateChanged(livekit::Room& room, const livekit::ConnectionStateChangedEvent& event) override {
    audio_->onConnectionStateChanged(room, event);
    video_->onConnectionStateChanged(room, event);
  }
  void onTrackPublished(livekit::Room& room, const livekit::TrackPublishedEvent& event) override {
    audio_->onTrackPublished(room, event);
    video_->onTrackPublished(room, event);
  }
  void onTrackUnpublished(livekit::Room& room, const livekit::TrackUnpublishedEvent& event) override {
    network_->onTrackUnpublished(room, event);
    audio_->onTrackUnpublished(room, event);
    video_->onTrackUnpublished(room, event);
  }
  void onTrackSubscribed(livekit::Room& room, const livekit::TrackSubscribedEvent& event) override {
    network_->onTrackSubscribed(room, event);
    audio_->onTrackSubscribed(room, event);
    video_->onTrackSubscribed(room, event);
  }
  void onTrackUnsubscribed(livekit::Room& room, const livekit::TrackUnsubscribedEvent& event) override {
    network_->onTrackUnsubscribed(room, event);
    audio_->onTrackUnsubscribed(room, event);
    video_->onTrackUnsubscribed(room, event);
  }
  void onTrackMuted(livekit::Room& room, const livekit::TrackMutedEvent& event) override {
    video_->onTrackMuted(room, event);
  }
  void onTrackUnmuted(livekit::Room& room, const livekit::TrackUnmutedEvent& event) override {
    video_->onTrackUnmuted(room, event);
  }
  void onTrackSubscriptionFailed(livekit::Room& room, const livekit::TrackSubscriptionFailedEvent& event) override {
    audio_->onTrackSubscriptionFailed(room, event);
  }
  void onParticipantDisconnected(livekit::Room& room, const livekit::ParticipantDisconnectedEvent& event) override {
    network_->onParticipantDisconnected(room, event);
    audio_->onParticipantDisconnected(room, event);
    video_->onParticipantDisconnected(room, event);
  }

 private:
  const std::shared_ptr<LiveKitNetworkSampler> network_ = std::make_shared<LiveKitNetworkSampler>();
  const std::shared_ptr<audio::RemoteAudioPlayout> audio_;
  const std::shared_ptr<video::RemoteVideoOwner> video_;
};
}  // namespace syrnike::windows_media
