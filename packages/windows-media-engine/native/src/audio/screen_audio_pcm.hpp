#pragma once

#include <array>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <optional>
#include <span>

namespace syrnike::windows_media::audio {
inline constexpr std::uint32_t kAudioRate = 48'000;
inline constexpr std::uint32_t kAudioChannels = 2;
inline constexpr std::uint32_t kAudioPacketFrames = 480;
inline constexpr std::size_t kAudioQueueCapacity = 8;
inline constexpr std::int64_t kAudioMaximumAge100ns = 1'000'000;

struct PcmPacket {
  std::array<std::int16_t, kAudioPacketFrames * kAudioChannels> samples{};
  std::uint64_t generation = 0, sequence = 0;
  std::int64_t capture_timestamp_100ns = 0;
  bool discontinuity = false;
};
struct PcmQueueStats {
  std::uint64_t accepted = 0, consumed = 0, superseded = 0, stale = 0, fenced = 0;
  std::size_t depth = 0, maximum_depth = 0;
};

// Owns eight complete packets; no borrowed capture buffers cross this port.
class PcmQueue final {
 public:
  void begin(std::uint64_t generation) noexcept;
  void stop() noexcept;
  bool push(const PcmPacket&, std::int64_t now_100ns) noexcept;
  std::optional<PcmPacket> take(std::int64_t now_100ns) noexcept;
  void discardBacklogExceptLatest() noexcept;
  void wait(std::chrono::milliseconds timeout);
  PcmQueueStats stats() const noexcept;
  bool stopped() const noexcept;

 private:
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::array<PcmPacket, kAudioQueueCapacity> packets_{};
  std::size_t head_ = 0;
  std::uint64_t generation_ = 0;
  bool stopped_ = true;
  PcmQueueStats stats_;
};

// Windows performs endpoint conversion to PCM16/48k/stereo. This owner only
// packetizes, keeping sample positions and QPC timestamps instead of wall time.
class PcmPacketizer final {
 public:
  explicit PcmPacketizer(PcmQueue& queue) : queue_(queue) {}
  void begin(std::uint64_t generation) noexcept;
  void ingest(std::span<const std::int16_t> samples, std::uint32_t frames,
              std::uint64_t device_position, std::int64_t qpc_100ns, bool silent,
              bool discontinuity, bool timestamp_error, std::int64_t now_100ns) noexcept;

 private:
  PcmQueue& queue_;
  PcmPacket pending_;
  std::uint32_t filled_ = 0;
  std::optional<std::uint64_t> next_position_;
};
}  // namespace syrnike::windows_media::audio
