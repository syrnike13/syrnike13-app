#pragma once

#include "camera/camera_pipeline.hpp"
#include "camera/camera_preview.hpp"
#include "camera/camera_publication.hpp"
#include "capture/thumbnail_admission.hpp"

namespace syrnike::windows_media::camera {

struct CameraOwnerSnapshot {
  MediaPathSnapshot path, preview_path;
  CameraPipelineStats pipeline;
  CameraPublicationStats publication;
  CameraPreviewStats preview;
  bool publication_stopped = true;
  bool stopped = true;
};

// One replaceable desired slot. All device and SDK lifecycle operations run
// on the actor; the shared Room transport must outlive this joined owner.
class CameraOwner final {
 public:
  CameraOwner(std::shared_ptr<LiveKitRoomTransport>, capture::ThumbnailAdmission&);
  ~CameraOwner();
  void apply(std::uint64_t revision, const CameraIntent&,
             std::optional<std::uint64_t> room_generation);
  void beginStop();
  void stop();
  CameraOwnerSnapshot snapshot() const;
  CameraDeviceSnapshot devices() const;
  // Existing preview lease contract: consumer releases GPU key 0 before
  // destroying the lease. Take/release may enter the existing GPU mutex;
  // neither operation holds the intent/snapshot mutex.
  std::optional<CameraPreviewLease> takePreview(const std::string& renderer_id);
 private:
  struct Desired {
    std::uint64_t revision = 0;
    std::uint64_t publication_epoch = 0;
    CameraIntent intent;
    std::optional<std::uint64_t> room_generation;
  };
  void run() noexcept;
  std::shared_ptr<LiveKitRoomTransport> transport_;
  capture::ThumbnailAdmission& admission_;
  mutable std::mutex mutex_;
  std::mutex join_mutex_;
  std::condition_variable changed_;
  Desired desired_;
  CameraOwnerSnapshot snapshot_;
  CameraDeviceSnapshot devices_;
  std::shared_ptr<CameraPublication> publication_;
  std::mutex preview_mutex_;
  // Borrowed only while preview_mutex_ is held; actor retains sole ownership.
  CameraPreview* preview_ = nullptr;
  std::optional<std::string> preview_renderer_;
  bool stopping_ = false, done_ = false;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::camera
