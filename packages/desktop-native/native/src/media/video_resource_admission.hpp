#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace syrnike::desktop_native::media {

enum class VideoResourceClass {
  D3dDevices,
  GpuGenerations,
  Textures,
  TextureBackingBytes,
  HardwareEncoderSessions,
};

enum class VideoResourceOwner {
  ScreenCapture,
  ScreenPreview,
  ScreenEncoder,
  CameraCapture,
  CameraEncoder,
  RemoteVideo,
};

enum class VideoTextureFormat {
  Bgra8,
  Nv12,
};

[[nodiscard]] const char* videoResourceClassName(
    VideoResourceClass resource_class) noexcept;
[[nodiscard]] const char* videoResourceOwnerName(
    VideoResourceOwner owner) noexcept;

struct VideoTextureLayout {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint64_t count = 0;
  VideoTextureFormat format = VideoTextureFormat::Bgra8;

  friend bool operator==(const VideoTextureLayout&, const VideoTextureLayout&) =
      default;
};

struct VideoResourceUsage {
  std::uint64_t d3d_devices = 0;
  std::uint64_t gpu_generations = 0;
  std::uint64_t textures = 0;
  std::uint64_t texture_backing_bytes = 0;
  std::uint64_t hardware_encoder_sessions = 0;

  friend bool operator==(const VideoResourceUsage&, const VideoResourceUsage&) =
      default;
};

struct VideoResourceLimits {
  std::uint64_t maximum_d3d_devices = 0;
  std::uint64_t maximum_gpu_generations = 0;
  std::uint64_t maximum_textures = 0;
  std::uint64_t maximum_texture_backing_bytes = 0;
  std::uint64_t maximum_hardware_encoder_sessions = 0;

  friend bool operator==(const VideoResourceLimits&, const VideoResourceLimits&) =
      default;
};

// The process permits a 4K screen active/candidate pair, one camera, and
// several 1080p remote pools, while remaining finite under stalled fences and
// cleanup. Tests construct their own budget with narrower limits.
inline constexpr VideoResourceLimits kProductionVideoResourceLimits{
    .maximum_d3d_devices = 16,
    .maximum_gpu_generations = 32,
    .maximum_textures = 192,
    .maximum_texture_backing_bytes = 1'073'741'824,
    .maximum_hardware_encoder_sessions = 2,
};

[[nodiscard]] constexpr VideoResourceLimits productionVideoResourceLimits()
    noexcept {
  return kProductionVideoResourceLimits;
}

struct VideoResourceRequest {
  VideoResourceOwner owner = VideoResourceOwner::RemoteVideo;
  std::string owner_id;
  std::uint64_t d3d_devices = 0;
  std::uint64_t gpu_generations = 0;
  std::uint64_t hardware_encoder_sessions = 0;
  std::vector<VideoTextureLayout> textures;
};

struct VideoResourceLeaseIdentity {
  std::uint64_t reservation_id = 0;
  VideoResourceOwner owner = VideoResourceOwner::RemoteVideo;
  std::string owner_id;
  VideoResourceUsage usage;

  friend bool operator==(
      const VideoResourceLeaseIdentity&,
      const VideoResourceLeaseIdentity&) = default;
};

struct VideoResourceSaturation {
  VideoResourceClass resource_class = VideoResourceClass::D3dDevices;
  VideoResourceOwner owner = VideoResourceOwner::RemoteVideo;
  std::string owner_id;
  VideoResourceUsage requested_usage;
  std::uint64_t current = 0;
  std::uint64_t requested = 0;
  std::uint64_t limit = 0;

  [[nodiscard]] std::string code() const;
  [[nodiscard]] std::string message() const;
};

class VideoResourceSaturationError final : public std::runtime_error {
 public:
  explicit VideoResourceSaturationError(VideoResourceSaturation saturation);

  [[nodiscard]] const VideoResourceSaturation& saturation() const noexcept {
    return saturation_;
  }

 private:
  VideoResourceSaturation saturation_;
};

struct VideoResourceBudgetSnapshot {
  VideoResourceLimits limits;
  VideoResourceUsage current;
  VideoResourceUsage peak;
  std::uint64_t active_reservations = 0;
  std::uint64_t rejected_admissions = 0;
  std::vector<VideoResourceLeaseIdentity> reservations;
};

struct VideoResourceBudgetState;

class VideoResourceLease final {
 public:
  ~VideoResourceLease();

  VideoResourceLease(const VideoResourceLease&) = delete;
  VideoResourceLease& operator=(const VideoResourceLease&) = delete;
  VideoResourceLease(VideoResourceLease&&) = delete;
  VideoResourceLease& operator=(VideoResourceLease&&) = delete;

  [[nodiscard]] std::uint64_t reservationId() const noexcept {
    return identity_.reservation_id;
  }
  [[nodiscard]] VideoResourceOwner owner() const noexcept {
    return identity_.owner;
  }
  [[nodiscard]] const std::string& ownerId() const noexcept {
    return identity_.owner_id;
  }
  [[nodiscard]] const VideoResourceUsage& usage() const noexcept {
    return identity_.usage;
  }
  [[nodiscard]] const VideoResourceLeaseIdentity& identity() const noexcept {
    return identity_;
  }

 private:
  friend class VideoResourceAdmissionBudget;
  VideoResourceLease(
      std::shared_ptr<VideoResourceBudgetState> state,
      VideoResourceLeaseIdentity identity);

  std::shared_ptr<VideoResourceBudgetState> state_;
  VideoResourceLeaseIdentity identity_;
};

struct VideoResourceAdmission {
  std::shared_ptr<VideoResourceLease> lease;
  std::optional<VideoResourceSaturation> saturation;

  [[nodiscard]] bool admitted() const noexcept {
    return static_cast<bool>(lease);
  }
};

// Returns the configured conservative backing bound used before constructing
// each single-mip shared texture. It includes process-policy row-pitch and
// per-allocation padding; it is not a post-hoc driver heap measurement.
[[nodiscard]] std::uint64_t configuredVideoTextureBytes(
    const VideoTextureLayout& layout);

class VideoResourceAdmissionBudget final {
 public:
  explicit VideoResourceAdmissionBudget(VideoResourceLimits limits);

  [[nodiscard]] VideoResourceAdmission tryAcquire(
      const VideoResourceRequest& request);
  [[nodiscard]] VideoResourceBudgetSnapshot snapshot() const;
  // Owner IDs are diagnostic grouping keys, never reservation or fence
  // identities. This aggregate includes active, retired, and renderer-held
  // reservations so callers report whole-pool backing instead of multiplying
  // the count of currently delivered frames.
  [[nodiscard]] VideoResourceUsage usageFor(
      VideoResourceOwner owner,
      std::string_view owner_id) const;

 private:
  std::shared_ptr<VideoResourceBudgetState> state_;
};

[[nodiscard]] std::shared_ptr<VideoResourceLease>
requireVideoResourceAdmission(
    VideoResourceAdmissionBudget& budget,
    const VideoResourceRequest& request);

// Production callers opt into this named process-wide instance explicitly.
// Deterministic tests inject a separate VideoResourceAdmissionBudget so no
// singleton state can leak between test cases.
[[nodiscard]] VideoResourceAdmissionBudget& processVideoResourceAdmissionBudget();

}  // namespace syrnike::desktop_native::media
