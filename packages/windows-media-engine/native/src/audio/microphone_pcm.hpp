#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <optional>
#include <span>

namespace syrnike::windows_media::audio {
inline constexpr std::uint32_t kMicrophoneRate = 48'000;
inline constexpr std::size_t kMicrophoneFrameSamples = 480;
inline constexpr std::int64_t kMicrophoneMaximumAge100ns = 500'000; // 50 ms
struct MicrophoneFrame {
  std::array<std::int16_t, kMicrophoneFrameSamples> samples{};
  std::uint64_t generation = 0;
  std::uint64_t sequence = 0;
  std::int64_t timestamp_100ns = 0;
  bool discontinuity = false;
};

// Single producer, single consumer. Three owned values: writer, exchange slot,
// reader. Publication swaps indices, never waits and never touches the reader's
// value. A slow consumer receives the newest complete 10 ms frame. Neither side
// allocates, locks, logs, retries or retains a borrowed Windows capture buffer.
// Construct a new port for each capture generation; never reset a live port.
class MicrophonePcmPort final {
 public:
  void publish(const MicrophoneFrame& frame) noexcept {
    frames_[write_] = frame;
    write_ = middle_.exchange(write_ | kDirty, std::memory_order_acq_rel) & kIndexMask;
  }
  std::optional<MicrophoneFrame> take() noexcept {
    if (!(middle_.load(std::memory_order_acquire) & kDirty)) return {};
    read_ = middle_.exchange(read_, std::memory_order_acq_rel) & kIndexMask;
    return frames_[read_];
  }
  std::uint32_t pendingFrames() const noexcept {
    return (middle_.load(std::memory_order_relaxed) & kDirty) ? 1u : 0u;
  }
 private:
  static constexpr unsigned kDirty = 4;
  static constexpr unsigned kIndexMask = 3;
  static_assert(std::atomic<unsigned>::is_always_lock_free);
  std::array<MicrophoneFrame, 3> frames_{};
  unsigned write_ = 2;
  unsigned read_ = 0;
  std::atomic<unsigned> middle_{1};
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
