#include "camera/camera_frame.hpp"

#include <algorithm>
#include <cstring>
#include <limits>

namespace syrnike::windows_media::camera {
bool validCameraProfile(const CameraProfile& value) noexcept {
  return ((value.width == 1280 && value.height == 720) ||
          (value.width == 1920 && value.height == 1080)) && value.fps == 30;
}
std::size_t cameraBgraBytes(std::uint32_t width, std::uint32_t height) noexcept {
  if (!width || !height || width > kMaximumCameraWidth || height > kMaximumCameraHeight ||
      width % 2 || height % 2) return 0;
  return static_cast<std::size_t>(width) * height * 4;
}
namespace {
bool validRows(const CameraBufferView& input, std::uint32_t rows, std::size_t row_bytes) noexcept {
  if (!rows || !input.stride || input.row_zero > input.bytes.size()) return false;
  const auto stride = static_cast<std::int64_t>(input.stride);
  const auto magnitude = stride < 0 ? -stride : stride;
  if (static_cast<std::uint64_t>(magnitude) < row_bytes) return false;
  const auto first = static_cast<std::int64_t>(input.row_zero);
  const auto last = first + stride * (rows - 1);
  const auto low = (std::min)(first, last);
  const auto high = (std::max)(first, last);
  return low >= 0 && static_cast<std::uint64_t>(high) <= input.bytes.size() &&
      row_bytes <= input.bytes.size() - static_cast<std::size_t>(high);
}
void yuvPixel(std::uint8_t y, std::uint8_t u, std::uint8_t v, CameraColorMatrix matrix,
              std::uint8_t* output) noexcept {
  const int luma = (std::max)(0, static_cast<int>(y) - 16) * 298;
  const int blue = static_cast<int>(u) - 128, red = static_cast<int>(v) - 128;
  const bool hd = matrix == CameraColorMatrix::bt709;
  output[0] = static_cast<std::uint8_t>((std::clamp)((luma + (hd ? 541 : 516) * blue + 128) >> 8, 0, 255));
  output[1] = static_cast<std::uint8_t>((std::clamp)((luma - (hd ? 55 : 100) * blue - (hd ? 136 : 208) * red + 128) >> 8, 0, 255));
  output[2] = static_cast<std::uint8_t>((std::clamp)((luma + (hd ? 459 : 409) * red + 128) >> 8, 0, 255));
  output[3] = 255;
}
}  // namespace
bool convertCameraToBgra(const CameraBufferView& input, std::span<std::uint8_t> output) noexcept {
  const auto required = cameraBgraBytes(input.width, input.height);
  if (!required || output.size() < required || input.bytes.size() > kMaximumCameraBytes * 2) return false;
  const auto row_bytes = static_cast<std::size_t>(input.width) *
      (input.format == CameraPixelFormat::bgra ? 4 : input.format == CameraPixelFormat::yuy2 ? 2 : 1);
  const auto rows = input.format == CameraPixelFormat::nv12 ? input.height * 3 / 2 : input.height;
  if (input.format == CameraPixelFormat::nv12 && input.stride < 0) return false;
  if (!validRows(input, rows, row_bytes)) return false;
  for (std::uint32_t row = 0; row < input.height; ++row) {
    const auto offset = static_cast<std::int64_t>(input.row_zero) + static_cast<std::int64_t>(input.stride) * row;
    const auto* source = input.bytes.data() + offset;
    auto* target = output.data() + static_cast<std::size_t>(row) * input.width * 4;
    if (input.format == CameraPixelFormat::bgra) {
      std::memcpy(target, source, row_bytes);
      for (std::uint32_t column = 0; column < input.width; ++column) target[column * 4 + 3] = 255;
      continue;
    }
    const auto* chroma = input.format == CameraPixelFormat::nv12 ? input.bytes.data() + input.row_zero +
        static_cast<std::size_t>(input.stride) * (input.height + row / 2) : nullptr;
    for (std::uint32_t column = 0; column < input.width; column += 2) {
      if (chroma) {
        yuvPixel(source[column], chroma[column], chroma[column + 1], input.matrix, target + column * 4);
        yuvPixel(source[column + 1], chroma[column], chroma[column + 1], input.matrix, target + (column + 1) * 4);
      } else {
        const auto* packed = source + column * 2;
        yuvPixel(packed[0], packed[1], packed[3], input.matrix, target + column * 4);
        yuvPixel(packed[2], packed[1], packed[3], input.matrix, target + (column + 1) * 4);
      }
    }
  }
  return true;
}
CameraFramePort::CameraFramePort() : pixels_(kMaximumCameraBytes) {}
void CameraFramePort::selectGeneration(std::uint64_t generation) noexcept {
  if (generation_.exchange(generation, std::memory_order_acq_rel) != generation)
    pending_.store(false, std::memory_order_relaxed);
}
std::uint64_t CameraFramePort::generation() const noexcept { return generation_.load(std::memory_order_acquire); }
bool CameraFramePort::publish(const CameraFrameMetadata& metadata, std::span<const std::uint8_t> bytes) noexcept {
  const auto size = cameraBgraBytes(metadata.width, metadata.height);
  if (!metadata.generation || metadata.generation != generation() || !metadata.sequence ||
      metadata.captured_100ns <= 0 || !size || bytes.size() < size) { ++rejected_; return false; }
  if (busy_.test_and_set(std::memory_order_acquire)) { ++contention_; return false; }
  if (metadata.generation != generation() ||
      (metadata_.generation == metadata.generation && metadata.sequence <= metadata_.sequence)) {
    busy_.clear(std::memory_order_release);
    ++rejected_;
    return false;
  }
  if (pending_) ++overwritten_;
  std::memcpy(pixels_.data(), bytes.data(), size);
  metadata_ = metadata;
  pending_.store(true, std::memory_order_relaxed);
  ++accepted_;
  busy_.clear(std::memory_order_release);
  return true;
}
bool CameraFramePort::take(CameraFrameMetadata& metadata, std::span<std::uint8_t> bytes,
                           std::int64_t now_100ns) noexcept {
  if (!pending_.load(std::memory_order_relaxed)) return false;
  if (busy_.test_and_set(std::memory_order_acquire)) { ++contention_; return false; }
  const auto size = cameraBgraBytes(metadata_.width, metadata_.height);
  const bool fresh = pending_.load(std::memory_order_relaxed) && size && bytes.size() >= size &&
      metadata_.generation == generation() && metadata_.captured_100ns <= now_100ns &&
      now_100ns - metadata_.captured_100ns <= kMaximumCameraAge100ns;
  if (fresh) {
    std::memcpy(bytes.data(), pixels_.data(), size);
    metadata = metadata_;
  } else ++stale_;
  pending_.store(false, std::memory_order_relaxed);
  busy_.clear(std::memory_order_release);
  return fresh && metadata.generation == generation();
}
CameraFramePortStats CameraFramePort::stats() const noexcept {
  return {accepted_.load(), overwritten_.load(), contention_.load(), rejected_.load(), stale_.load(),
          generation() && pending_.load() ? 1u : 0u, kMaximumCameraBytes};
}
}  // namespace syrnike::windows_media::camera
