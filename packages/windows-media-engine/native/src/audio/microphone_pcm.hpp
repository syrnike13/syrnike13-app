#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <optional>
#include <span>

namespace syrnike::windows_media::audio {
inline constexpr std::uint32_t kMicrophoneRate = 48'000;
inline constexpr std::size_t kMicrophoneFrameSamples = 480;
// A frame older than this is dropped instead of sent late. It covers the port
// capacity so a briefly descheduled consumer catches up rather than losing audio.
inline constexpr std::int64_t kMicrophoneMaximumAge100ns = 1'000'000; // 100 ms
struct MicrophoneFrame {
  std::array<std::int16_t, kMicrophoneFrameSamples> samples{};
  std::uint64_t generation = 0;
  std::uint64_t sequence = 0;
  std::int64_t timestamp_100ns = 0;
  bool discontinuity = false;
};

// Single producer, single consumer, in order. Every captured 10 ms frame is
// sent: a consumer that wakes late drains the queue instead of losing all but
// the newest frame. Overflow drops the oldest frame. The spin lock is held
// only to copy one frame. Neither side allocates, logs or retains a borrowed
// Windows capture buffer. Construct a new port per capture generation.
class MicrophonePcmPort final {
 public:
  static constexpr std::size_t kCapacity = 8;
  void publish(const MicrophoneFrame& frame) noexcept {
    while (busy_.test_and_set(std::memory_order_acquire)) {}
    if (depth_ == kCapacity) {
      head_ = (head_ + 1) % kCapacity;
      --depth_;
    }
    frames_[(head_ + depth_) % kCapacity] = frame;
    ++depth_;
    depth_published_.store(static_cast<std::uint32_t>(depth_), std::memory_order_relaxed);
    busy_.clear(std::memory_order_release);
  }
  std::optional<MicrophoneFrame> take() noexcept {
    if (!depth_published_.load(std::memory_order_relaxed)) return {};
    while (busy_.test_and_set(std::memory_order_acquire)) {}
    std::optional<MicrophoneFrame> frame;
    if (depth_) {
      frame = frames_[head_];
      head_ = (head_ + 1) % kCapacity;
      --depth_;
    }
    depth_published_.store(static_cast<std::uint32_t>(depth_), std::memory_order_relaxed);
    busy_.clear(std::memory_order_release);
    return frame;
  }
  std::uint32_t pendingFrames() const noexcept { return depth_published_.load(std::memory_order_relaxed); }
 private:
  std::array<MicrophoneFrame, kCapacity> frames_{};
  std::atomic_flag busy_ = ATOMIC_FLAG_INIT;
  std::size_t head_ = 0, depth_ = 0;
  std::atomic<std::uint32_t> depth_published_{0};
};

struct MicrophonePacketizerStats {
  std::uint64_t frames = 0;
  std::uint64_t discontinuities = 0;
  std::uint64_t invalid_timestamps = 0;
  std::uint64_t invalid_buffers = 0;
  std::uint32_t consecutive_healthy_frames = 0;
};
class MicrophonePacketizer final {
 public:
  MicrophonePacketizer(MicrophonePcmPort& port, std::uint64_t generation) : port_(port) {
    pending_.generation = generation;
  }
  // Windows supplies converted PCM16/mono. Silence never dereferences data.
  // A timestamp error or discontinuity discards any partial pre-gap frame.
  void ingest(std::span<const std::int16_t> samples, std::uint32_t frames,
              std::uint64_t position, std::int64_t timestamp_100ns,
              bool silent, bool discontinuity, bool timestamp_error) noexcept;
  MicrophonePacketizerStats stats() const noexcept { return stats_; }
 private:
  MicrophonePcmPort& port_;
  MicrophoneFrame pending_;
  std::size_t filled_ = 0;
  std::optional<std::uint64_t> previous_position_;
  std::optional<std::int64_t> expected_timestamp_100ns_;
  MicrophonePacketizerStats stats_;
};
}  // namespace syrnike::windows_media::audio
