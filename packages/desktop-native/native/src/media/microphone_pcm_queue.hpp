#pragma once

#include <algorithm>
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <span>

#include "audio_constants.hpp"

namespace syrnike::desktop_native::media {

enum class MicrophonePcmQueuePush {
  Queued,
  Full,
  InvalidFrame,
};

template <
    std::size_t Samples = syrnike::voice::kSamplesPer10Ms,
    std::size_t Capacity = 8>
class MicrophonePcmQueue final {
 public:
  static_assert(Samples > 0);
  static_assert(Capacity > 0);

  [[nodiscard]] MicrophonePcmQueuePush push(
      std::span<const std::int16_t> frame) noexcept {
    if (frame.size() != Samples) return MicrophonePcmQueuePush::InvalidFrame;
    const auto write = write_sequence_.value.load(std::memory_order_relaxed);
    const auto read = read_sequence_.value.load(std::memory_order_acquire);
    if (write - read >= Capacity) return MicrophonePcmQueuePush::Full;
    std::copy(frame.begin(), frame.end(), frames_[write % Capacity].begin());
    write_sequence_.value.store(write + 1, std::memory_order_release);
    return MicrophonePcmQueuePush::Queued;
  }

  [[nodiscard]] bool pop(std::span<std::int16_t> destination) noexcept {
    if (destination.size() != Samples) return false;
    const auto read = read_sequence_.value.load(std::memory_order_relaxed);
    const auto write = write_sequence_.value.load(std::memory_order_acquire);
    if (read == write) return false;
    std::copy(frames_[read % Capacity].begin(), frames_[read % Capacity].end(),
              destination.begin());
    read_sequence_.value.store(read + 1, std::memory_order_release);
    return true;
  }

  // Consumer-only: advancing the read cursor drops every frame that was fully
  // published before this snapshot while preserving concurrent later writes.
  void clear() noexcept {
    read_sequence_.value.store(
      write_sequence_.value.load(std::memory_order_acquire),
      std::memory_order_release
    );
  }

  [[nodiscard]] bool empty() const noexcept { return size() == 0; }
  [[nodiscard]] std::size_t size() const noexcept {
    const auto read = read_sequence_.value.load(std::memory_order_acquire);
    const auto write = write_sequence_.value.load(std::memory_order_acquire);
    return write - read;
  }
  [[nodiscard]] static constexpr std::size_t capacity() noexcept {
    return Capacity;
  }

 private:
  static constexpr std::size_t cache_line_bytes = 64;
  struct alignas(cache_line_bytes) Cursor {
    std::atomic_size_t value{0};
    std::array<
      std::byte,
      cache_line_bytes - sizeof(std::atomic_size_t)
    > reserved{};
  };
  static_assert(sizeof(Cursor) == cache_line_bytes);

  Cursor read_sequence_;
  Cursor write_sequence_;
  std::array<std::array<std::int16_t, Samples>, Capacity> frames_{};
};

}  // namespace syrnike::desktop_native::media
