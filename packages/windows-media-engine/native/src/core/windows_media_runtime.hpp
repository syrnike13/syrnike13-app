#pragma once

#include "core/media_runtime.hpp"
#include "audio/audio_device_catalog.hpp"
#include "audio/microphone_owner.hpp"
#include "audio/output_owner.hpp"
#include "audio/screen_audio_owner.hpp"
#include "camera/camera_owner.hpp"
#include "screen/screen_owner.hpp"
#include "livekit/product_room_observer.hpp"
#include "video/frame_export_owner.hpp"
#include "sources/thumbnail_owner.hpp"

namespace syrnike::windows_media {

class WindowsMediaRuntime final : public MediaRuntime {
 public:
  WindowsMediaRuntime();
  ~WindowsMediaRuntime() override;
  void apply(const EngineDesiredState&, std::optional<std::uint64_t>) override;
  void beginStop() override;
  MediaRuntimeSnapshot snapshot() const override;
  std::shared_ptr<LiveKitRoomTransport> transport() const { return transport_; }
  audio::AudioDeviceSnapshot audioDevices() const { return catalog_.snapshot(); }
  camera::CameraDeviceSnapshot cameraDevices() const { return camera_.devices(); }
  screen::ScreenSourcesSnapshot screenSources() const { return screen_.sources(); }
  void queryScreenSources(std::uint64_t revision, sources::EnumerationOptions options) {
    screen_.querySources(revision, options);
  }
  video::RemoteVideoOwnerSnapshot remoteVideo() const { return video_->snapshot(); }
  audio::MicrophoneOwnerSnapshot microphone() const { return microphone_.snapshot(); }
  std::vector<video::ExportedFrame> takeFrames() { return frames_.take(); }
  bool releaseFrame(const video::ExportRelease& release) { return frames_.release(release); }
  sources::ThumbnailSnapshot queryThumbnail(std::uint64_t revision, std::optional<std::string> source_id) {
    return thumbnails_.query(revision, std::move(source_id));
  }
  sources::ThumbnailStats thumbnailStats() const { return thumbnails_.stats(); }

 private:
  void run() noexcept;
  void updateScreenAudio(const screen::ScreenOwnerSnapshot&);
  // Borrowers join before their catalog, mixer and transport are destroyed.
  audio::AudioDeviceCatalog catalog_;
  const std::shared_ptr<audio::RemoteAudioMixerWorker> mixer_;
  const std::shared_ptr<audio::RemoteAudioTracks> audio_;
  const std::shared_ptr<video::RemoteVideoOwner> video_;
  const std::shared_ptr<ProductRoomObserver> observer_;
  const std::shared_ptr<LiveKitRoomTransport> transport_;
  audio::MicrophoneOwner microphone_;
  audio::OutputOwner output_;
  capture::ThumbnailAdmission thumbnail_admission_;
  camera::CameraOwner camera_;
  screen::ScreenOwner screen_;
  sources::ThumbnailOwner thumbnails_;
  audio::ScreenAudioOwner screen_audio_;
  video::FrameExportOwner frames_;
  std::shared_ptr<audio::AudioProcessIdentity> client_process_;
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  EngineDesiredState desired_;
  std::optional<std::uint64_t> room_generation_;
  std::uint64_t device_revision_ = 0, audio_revision_ = 0, audio_retry_revision_ = 0;
  std::optional<audio::ScreenAudioIntent> audio_intent_;
  std::optional<EngineFailure> audio_target_failure_;
  MediaRuntimeSnapshot snapshot_;
  bool stopping_ = false, done_ = false;
  std::thread worker_;
};
}  // namespace syrnike::windows_media
