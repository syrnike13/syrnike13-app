#pragma once

#include <algorithm>
#include <cstdint>

namespace syrnike::desktop_native::media::detail {

class RemoteAudioRenderFillPlan final {
 public:
  constexpr RemoteAudioRenderFillPlan(
    std::uint32_t capacity_frames,
    std::uint32_t padding_frames,
    std::uint32_t maximum_chunk_frames,
    std::uint32_t target_padding_frames
  ) noexcept
    : capacity_frames_(capacity_frames),
      padding_frames_(std::min(capacity_frames, padding_frames)),
      maximum_chunk_frames_(std::max<std::uint32_t>(
        1,
        maximum_chunk_frames
      )),
      remaining_frames_(writableFrames(
        capacity_frames_,
        padding_frames_,
        target_padding_frames
      )),
      write_frames_(remaining_frames_) {}

  [[nodiscard]] constexpr std::uint32_t capacityFrames() const noexcept {
    return capacity_frames_;
  }

  [[nodiscard]] constexpr std::uint32_t paddingFrames() const noexcept {
    return padding_frames_;
  }

  [[nodiscard]] constexpr std::uint32_t totalFrames() const noexcept {
    return write_frames_;
  }

  [[nodiscard]] constexpr std::uint32_t catchUpFrames() const noexcept {
    const auto total = totalFrames();
    return total > maximum_chunk_frames_
      ? total - maximum_chunk_frames_
      : 0;
  }

  [[nodiscard]] constexpr bool bufferEmpty() const noexcept {
    return capacity_frames_ != 0 && padding_frames_ == 0;
  }

  [[nodiscard]] constexpr bool complete() const noexcept {
    return remaining_frames_ == 0;
  }

  constexpr std::uint32_t nextChunk() noexcept {
    const auto chunk = std::min(remaining_frames_, maximum_chunk_frames_);
    remaining_frames_ -= chunk;
    return chunk;
  }

 private:
  static constexpr std::uint32_t writableFrames(
    std::uint32_t capacity_frames,
    std::uint32_t padding_frames,
    std::uint32_t target_padding_frames
  ) noexcept {
    const auto available = capacity_frames - padding_frames;
    // An empty buffer is an underrun: restore the full jitter capacity.
    // Steady-state wakes only top up to the padding target.
    if (padding_frames == 0) return available;
    const auto target = target_padding_frames == 0 ||
        target_padding_frames > capacity_frames
      ? capacity_frames
      : target_padding_frames;
    if (padding_frames >= target) return 0;
    return std::min(available, target - padding_frames);
  }

  std::uint32_t capacity_frames_;
  std::uint32_t padding_frames_;
  std::uint32_t maximum_chunk_frames_;
  std::uint32_t remaining_frames_;
  std::uint32_t write_frames_;
};

}  // namespace syrnike::desktop_native::media::detail
