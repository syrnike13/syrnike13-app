#pragma once

#include "audio/remote_audio_tracks.hpp"
#include "video/remote_video_owner.hpp"

namespace syrnike::windows_media {

// Fixed product composition: both reader inventories see the same Room events.
// Shared ownership keeps them alive until the transport has removed its delegate.
class ProductRoomObserver final : public LiveKitRoomObserver {
 public:
  ProductRoomObserver(std::shared_ptr<audio::RemoteAudioMixerWorker> mixer,
                      std::shared_ptr<audio::RemoteAudioTracks> audio,
                      std::shared_ptr<video::RemoteVideoOwner> video)
      : mixer_(std::move(mixer)), audio_(std::move(audio)), video_(std::move(video)) {}

  bool attachRoom(const std::shared_ptr<livekit::Room>& room) override {
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
    const bool audio = audio_->detachRoom();
    const bool video = video_->detachRoom();
    return audio && video;
  }
  void stop() override {
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
    audio_->onTrackUnpublished(room, event);
    video_->onTrackUnpublished(room, event);
  }
  void onTrackSubscribed(livekit::Room& room, const livekit::TrackSubscribedEvent& event) override {
    audio_->onTrackSubscribed(room, event);
    video_->onTrackSubscribed(room, event);
  }
  void onTrackUnsubscribed(livekit::Room& room, const livekit::TrackUnsubscribedEvent& event) override {
    audio_->onTrackUnsubscribed(room, event);
    video_->onTrackUnsubscribed(room, event);
  }
  void onTrackSubscriptionFailed(livekit::Room& room, const livekit::TrackSubscriptionFailedEvent& event) override {
    audio_->onTrackSubscriptionFailed(room, event);
  }
  void onParticipantDisconnected(livekit::Room& room, const livekit::ParticipantDisconnectedEvent& event) override {
    audio_->onParticipantDisconnected(room, event);
    video_->onParticipantDisconnected(room, event);
  }

 private:
  const std::shared_ptr<audio::RemoteAudioMixerWorker> mixer_;
  const std::shared_ptr<audio::RemoteAudioTracks> audio_;
  const std::shared_ptr<video::RemoteVideoOwner> video_;
};
}  // namespace syrnike::windows_media
