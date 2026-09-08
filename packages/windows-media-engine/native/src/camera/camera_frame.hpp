#pragma once

#include <atomic>
#include <cstdint>
#include <span>
#include <vector>

namespace syrnike::windows_media::camera {
inline constexpr std::uint32_t kMaximumCameraWidth = 1920;
inline constexpr std::uint32_t kMaximumCameraHeight = 1080;
inline constexpr std::size_t kMaximumCameraBytes = kMaximumCameraWidth * kMaximumCameraHeight * 4;
inline constexpr std::int64_t kMaximumCameraAge100ns = 1'500'000;

struct CameraProfile {
  std::uint32_t width = 1280, height = 720, fps = 30;
  bool operator==(const CameraProfile&) const = default;
};
enum class CameraPixelFormat { bgra, nv12, yuy2 };
enum class CameraColorMatrix { bt601, bt709 };
struct CameraBufferView {
  std::span<const std::uint8_t> bytes;
  std::uint32_t width = 0, height = 0;
  // Offset of displayed row zero, including bottom-up packed RGB buffers.
  std::size_t row_zero = 0;
  std::int32_t stride = 0;
  CameraPixelFormat format = CameraPixelFormat::bgra;
  CameraColorMatrix matrix = CameraColorMatrix::bt709;
};
struct CameraFrameMetadata {
  std::uint64_t generation = 0, sequence = 0;
  std::int64_t captured_100ns = 0;
  std::uint32_t width = 0, height = 0;
};

bool validCameraProfile(const CameraProfile&) noexcept;
std::size_t cameraBgraBytes(std::uint32_t width, std::uint32_t height) noexcept;
// All source rows and destination capacity are checked before any pixel access.
// MJPEG decoding belongs to Media Foundation; its output enters here as NV12.
bool convertCameraToBgra(const CameraBufferView&, std::span<std::uint8_t> output) noexcept;

struct CameraFramePortStats {
  std::uint64_t accepted = 0, overwritten = 0, contention = 0, rejected = 0, stale = 0;
  std::uint32_t queued = 0;
  std::uint64_t backing_bytes = kMaximumCameraBytes;
};

// One producer and one consumer. Exactly one owned latest frame, allocated at
// construction. Both sides try once; neither waits for a consumer/callback.
// Copies are bounded by 1080p BGRA. No MF sample or renderer lease is retained.
class CameraFramePort final {
 public:
  CameraFramePort();
  void selectGeneration(std::uint64_t generation) noexcept;
  std::uint64_t generation() const noexcept;
  bool publish(const CameraFrameMetadata&, std::span<const std::uint8_t>) noexcept;
  bool take(CameraFrameMetadata&, std::span<std::uint8_t>, std::int64_t now_100ns) noexcept;
  CameraFramePortStats stats() const noexcept;
 private:
  std::vector<std::uint8_t> pixels_;
  CameraFrameMetadata metadata_;
  std::atomic_flag busy_ = ATOMIC_FLAG_INIT;
  std::atomic_uint64_t generation_{0};
  std::atomic_bool pending_{false};
  std::atomic_uint64_t accepted_{0}, overwritten_{0}, contention_{0}, rejected_{0}, stale_{0};
};
}  // namespace syrnike::windows_media::camera
