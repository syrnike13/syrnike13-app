#pragma once

#include "camera/camera_capture.hpp"

namespace syrnike::windows_media::camera {
struct CameraPipelineStats {
  CameraFailure failure = CameraFailure::none;
  bool publication_demand = false, preview_demand = false, active = false, candidate = false, retired = false;
  std::uint64_t commits = 0, rollbacks = 0, opened = 0, forwarded = 0;
  CameraCaptureStats capture;
  CameraFramePortStats publication, preview;
};

// One control owner, one frame forwarding worker. Preview/publication have
// independent latest-frame copies; neither consumer retains an MF sample.
// At most one active capture and one candidate. Old capture stays alive until
// the candidate has three healthy frames and the forwarding worker commits it.
class CameraPipeline final {
 public:
  explicit CameraPipeline(CameraReaderFactory = makeMediaFoundationCameraReader);
  ~CameraPipeline();
  CameraFailure selectDevice(CameraDeviceRegistry&, std::optional<CameraDeviceId>, CameraProfile, bool allow_downgrade = false);
  CameraFailure setDemand(bool publication, bool preview);
  CameraFailure reconcile(CameraDeviceRegistry&, std::uint64_t registry_revision);
  bool stop(std::chrono::steady_clock::time_point deadline) noexcept;
  CameraPipelineStats stats() const noexcept;
  std::shared_ptr<CameraFramePort> publication() const noexcept;
  std::shared_ptr<CameraFramePort> preview() const noexcept;
 private:
  struct State;
  static void run(const std::shared_ptr<State>&) noexcept;
  bool onOwner() const noexcept;
  bool bind(CameraFramePort*, std::uint64_t generation, bool publication, bool preview);
  CameraFailure openCandidate(const CameraEndpoint&, CameraProfile, bool allow_downgrade);
  CameraFailure closeActive();
  const std::thread::id owner_ = std::this_thread::get_id();
  CameraReaderFactory factory_;
  std::shared_ptr<State> state_;
  std::thread worker_;
  std::unique_ptr<CameraCapture> active_, candidate_;
  std::optional<CameraEndpoint> selected_;
  std::optional<CameraDeviceId> intent_;
  CameraProfile profile_;
  bool allow_downgrade_ = false;
  std::uint64_t next_generation_ = 0, command_revision_ = 0, registry_revision_ = 0;
  CameraPipelineStats stats_;
};
}  // namespace syrnike::windows_media::camera
