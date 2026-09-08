#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <optional>
#include <span>

namespace syrnike::windows_media::audio {
inline constexpr std::uint32_t kRemoteAudioRate = 48'000;
inline constexpr std::size_t kRemoteAudioChannels = 2;
inline constexpr std::size_t kRemoteAudioFrames = 480;
inline constexpr std::size_t kRemoteAudioSamples = kRemoteAudioFrames * kRemoteAudioChannels;
inline constexpr std::size_t kRemoteAudioQueueCapacity = 4;
inline constexpr std::size_t kRemoteAudioTrackCapacity = 32;
inline constexpr std::int64_t kRemoteAudioMaximumAge100ns = 600'000;

struct RemoteAudioFrame {
  std::array<std::int16_t, kRemoteAudioSamples> samples{};
  std::uint64_t generation = 0;
  std::uint64_t sequence = 0;
  // QPC domain, stamped at decoded ingress, before any application queue/wait.
  std::int64_t decoded_timestamp_100ns = 0;
  bool discontinuity = false;
};
struct RemoteAudioQueueStats {
  std::uint64_t accepted = 0;
  std::uint64_t overrun = 0;
  std::uint64_t stale = 0;
  std::uint64_t rejected = 0;
  std::uint64_t producer_contention = 0;
  std::uint64_t consumer_contention = 0;
  std::uint32_t depth = 0;
};

// One decoder producer and one mixer consumer per source generation. The
// fixed ring uses a single try operation, never a spin/wait. If the other side
// owns it, the producer drops this frame or the consumer emits silence. Each
// critical section copies at most one frame and inspects at most four headers.
// Retire a port on track removal; never reset/reuse it for another generation.
class RemoteAudioPcmPort final {
 public:
  explicit RemoteAudioPcmPort(std::uint64_t generation, std::size_t capacity = kRemoteAudioQueueCapacity)
      : generation_(generation), capacity_(capacity), active_(capacity > 0 && capacity <= kRemoteAudioQueueCapacity) {}
  bool publish(const RemoteAudioFrame&) noexcept;
  std::optional<RemoteAudioFrame> take(std::int64_t now_100ns,
                                       std::int64_t minimum_timestamp_100ns) noexcept;
  void retire() noexcept { active_.store(false, std::memory_order_release); }
  bool active() const noexcept { return active_.load(std::memory_order_acquire); }
  std::uint64_t generation() const noexcept { return generation_; }
  RemoteAudioQueueStats stats() const noexcept;
 private:
  const std::uint64_t generation_;
  const std::size_t capacity_;
  std::atomic_bool active_{true};
  std::atomic_flag busy_ = ATOMIC_FLAG_INIT;
  std::array<RemoteAudioFrame, kRemoteAudioQueueCapacity> frames_{};
  std::size_t head_ = 0;
  std::size_t depth_ = 0;
  std::uint64_t last_sequence_ = 0; // producer only
  bool producer_gap_ = false; // producer only
  std::uint64_t consumed_sequence_ = 0; // consumer only
  std::atomic_uint64_t accepted_{0}, overrun_{0}, stale_{0}, rejected_{0};
  std::atomic_uint64_t producer_contention_{0}, consumer_contention_{0};
  std::atomic_uint32_t published_depth_{0};
};

struct RemoteAudioMixInput {
  // Borrowed for the whole configuration's lifetime. Control owner must retain
  // ports until a subsequent setInputs() has acknowledged their removal.
  RemoteAudioPcmPort* port = nullptr;
  float volume = 1.0f;
  bool muted = false;
};
struct RemoteAudioMixStats {
  std::uint64_t frames = 0;
  std::uint64_t source_frames = 0;
  std::uint64_t discontinuities = 0;
  std::uint64_t limited_frames = 0;
  std::int64_t maximum_age_100ns = 0;
  // <=10,20,30,40,50,60 ms, plus above 60 ms (must remain zero).
  std::array<std::uint64_t, 7> age_histogram{};
  std::uint32_t inputs = 0;
};

// All methods belong to the playout worker. Device and subscription owners
// commit configuration between frames. PCM copying/mixing allocates nothing.
class RemoteAudioMixer final {
 public:
  bool setInputs(std::span<const RemoteAudioMixInput>) noexcept;
  void setDeafened(bool enabled) noexcept { deafened_ = enabled; }
  RemoteAudioFrame mix(std::int64_t now_100ns, std::int64_t minimum_timestamp_100ns,
                       std::uint64_t renderer_epoch) noexcept;
  RemoteAudioMixStats stats() const noexcept { return stats_; }
 private:
  std::array<RemoteAudioMixInput, kRemoteAudioTrackCapacity> inputs_{};
  std::size_t count_ = 0;
  bool deafened_ = false;
  RemoteAudioMixStats stats_;
};
}  // namespace syrnike::windows_media::audio
