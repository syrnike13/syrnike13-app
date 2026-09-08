#pragma once

#include "camera/camera_frame.hpp"
#include <chrono>
#include <memory>
#include <optional>
#include <thread>

namespace syrnike::windows_media::camera {
struct CameraPreviewState;
enum class CameraPreviewFailure { none, budget_exhausted, gpu_failed, gpu_stalled, consumer_stalled };
struct CameraPreviewStats {
  CameraPreviewFailure failure = CameraPreviewFailure::none;
  std::uint64_t submitted = 0, delivered = 0, dropped = 0, backing_bytes = 0;
  std::uint32_t outstanding = 0, quarantined = 0;
  std::uint32_t last_gpu_result = 0;
};

// The consumer opens the NT handle and acquires key 1, then releases key 0
// before releasing this lease. A held lease retains its backing after stop.
class CameraPreviewLease final {
 public:
  CameraPreviewLease(CameraPreviewLease&&) noexcept;
  CameraPreviewLease& operator=(CameraPreviewLease&&) noexcept;
  ~CameraPreviewLease();
  CameraPreviewLease(const CameraPreviewLease&) = delete;
  CameraPreviewLease& operator=(const CameraPreviewLease&) = delete;
  std::uintptr_t handle() const noexcept { return handle_; }
  const CameraFrameMetadata& metadata() const noexcept { return metadata_; }
  static constexpr std::uint32_t width = 640, height = 360;
 private:
  friend class CameraPreview;
  CameraPreviewLease(std::shared_ptr<CameraPreviewState>, std::uint32_t,
                     std::uintptr_t, CameraFrameMetadata);
  void release() noexcept;
  std::shared_ptr<CameraPreviewState> state_;
  std::uint32_t slot_ = 0;
  std::uintptr_t handle_ = 0;
  CameraFrameMetadata metadata_;
};

// Independent worker and two bounded textures. No renderer operation runs on
// capture/publication workers. Stop joins the worker; leases may outlive it.
class CameraPreview final {
 public:
  explicit CameraPreview(std::shared_ptr<CameraFramePort>);
  ~CameraPreview();
  std::optional<CameraPreviewLease> take();
  CameraPreviewStats stats() const;
  bool stop(std::chrono::steady_clock::time_point deadline) noexcept;
 private:
  static void run(const std::shared_ptr<CameraPreviewState>&) noexcept;
  const std::thread::id owner_ = std::this_thread::get_id();
  std::shared_ptr<CameraPreviewState> state_;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::camera
