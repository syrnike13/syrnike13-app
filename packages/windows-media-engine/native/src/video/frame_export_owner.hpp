#pragma once

#include "camera/camera_owner.hpp"
#include "screen/screen_owner.hpp"
#include "video/remote_video_owner.hpp"
#include <variant>

namespace syrnike::windows_media::video {
enum class ExportKind { remote, screen_preview, camera_preview };
struct ExportedFrame {
  ExportKind kind = ExportKind::remote;
  std::uint64_t generation = 0, sequence = 0, revision = 0;
  std::uint32_t slot = 0, width = 0, height = 0;
  std::int64_t timestamp_us = 0, ingress_us = 0;
  std::uintptr_t handle = 0;
  std::string renderer_id, publication_id, participant_identity;
};
struct ExportRelease {
  std::uint64_t generation = 0, sequence = 0;
  std::uint32_t slot = 0;
};

// A separate data lane performs GPU takes/releases. Addon calls only copy
// bounded cached envelopes or mark a retained lease for release.
class FrameExportOwner final {
 public:
  static constexpr std::size_t kCapacity = 68;
  static constexpr std::size_t kBatchCapacity = 16;
  FrameExportOwner(camera::CameraOwner&, screen::ScreenOwner&, RemoteVideoOwner&);
  ~FrameExportOwner();
  void apply(const EngineDesiredState&, bool room_connected);
  void beginStop();
  void stop();
  std::vector<ExportedFrame> take();
  bool release(const ExportRelease&);

 private:
  using NativeLease = std::variant<TextureLease, screen::PreviewFrame, camera::CameraPreviewLease>;
  struct Entry {
    ExportedFrame frame;
    NativeLease lease;
    bool delivered = false, release_requested = false;
    std::chrono::steady_clock::time_point cached_at = std::chrono::steady_clock::now();
  };
  struct StreamGeneration {
    std::uint64_t native_generation = 0, exported_generation = 0;
    std::string renderer;
  };
  struct Demand {
    std::uint64_t revision = 0;
    std::optional<std::string> renderer_id;
    std::string participant_identity = "local";
    bool camera_preview = false, screen_preview = false;
    std::vector<RemoteVideoDemand> remote_video_demand;
  };
  void run() noexcept;
  void releaseNative(NativeLease&);
  bool wanted(const ExportedFrame&) const;
  camera::CameraOwner& camera_;
  screen::ScreenOwner& screen_;
  RemoteVideoOwner& video_;
  mutable std::mutex mutex_;
  std::mutex join_mutex_;
  std::condition_variable changed_;
  Demand desired_;
  std::vector<Entry> entries_;
  std::map<std::string, StreamGeneration> generations_;
  std::uint64_t next_generation_ = 0;
  bool stopping_ = false, finishing_ = false, done_ = false;
  bool room_connected_ = false;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::video
