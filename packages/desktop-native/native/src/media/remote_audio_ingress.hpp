#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

#include <livekit/audio_frame_sink.h>

namespace syrnike::desktop_native::media {

inline constexpr std::uint32_t kRemoteAudioIngressSampleRate = 48'000;
inline constexpr std::uint32_t kRemoteAudioIngressChannels = 2;
inline constexpr std::size_t kRemoteAudioIngressFramesPerPacket = 480;
inline constexpr std::size_t kRemoteAudioIngressSamplesPerPacket =
  kRemoteAudioIngressFramesPerPacket * kRemoteAudioIngressChannels;
inline constexpr std::size_t kRemoteAudioIngressSlotCount = 16;
inline constexpr std::size_t kRemoteAudioIngressRecoveryPackets = 2;
// The normal renderer target is 20-30 ms. Eighty milliseconds leaves room for
// one scheduler hiccup and endpoint padding, while preventing a sub-overflow
// backlog from taking minutes to drain at the 1000-ppm clock-correction cap.
inline constexpr std::uint64_t kRemoteAudioLocalPlayoutAgeBudgetUs = 80'000;

using RemoteAudioSteadyNowUs = std::uint64_t (*)() noexcept;

std::uint64_t remoteAudioSteadyNowUs() noexcept;

struct RemoteAudioIngressFrame {
  std::array<std::int16_t, kRemoteAudioIngressSamplesPerPacket> samples{};
  std::uint64_t sequence = 0;
  std::uint64_t ingress_steady_us = 0;
};

struct RemoteAudioIngressFreshness {
  bool recovered = false;
  std::uint64_t scheduled_playout_age_us = 0;
  std::uint64_t oldest_queued_age_us = 0;
  std::size_t queued_packets = 0;
  std::size_t discarded_packets = 0;
};

struct RemoteAudioIngressTelemetry {
  std::uint64_t accepted_frames = 0;
  std::uint64_t dropped_frames = 0;
  std::uint64_t suspended_frames = 0;
  std::uint64_t invalid_frames = 0;
  std::uint64_t discontinuities = 0;
  std::uint64_t freshness_recoveries = 0;
  std::uint64_t stale_frames_discarded = 0;
  std::uint64_t last_scheduled_playout_age_us = 0;
  std::uint64_t maximum_scheduled_playout_age_us = 0;
  std::uint64_t last_oldest_queued_age_us = 0;
  std::uint64_t last_queued_packets = 0;
};

enum class RemoteAudioIngressReadResult {
  Empty,
  Frame,
  Discontinuity,
};

// Single-producer/single-consumer decoded-audio ingress. WebRTC owns the
// producer thread and the WASAPI renderer owns the consumer thread.
class RemoteAudioIngress final : public livekit::DecodedAudioFrameSink {
 public:
  explicit RemoteAudioIngress(
    RemoteAudioSteadyNowUs steady_now = &remoteAudioSteadyNowUs
  ) noexcept;
  ~RemoteAudioIngress() override = default;
  RemoteAudioIngress(const RemoteAudioIngress&) = delete;
  RemoteAudioIngress& operator=(const RemoteAudioIngress&) = delete;

  void onAudioFrame(const livekit::DecodedAudioFrameView& frame) noexcept override;

  void activate(std::uint64_t renderer_epoch) noexcept;
  void suspend() noexcept;
  RemoteAudioIngressReadResult tryRead(
    RemoteAudioIngressFrame& destination,
    std::uint64_t renderer_epoch
  ) noexcept;
  std::size_t queuedFrames() const noexcept;
  RemoteAudioIngressFreshness enforceFreshness(
    std::uint64_t now_us,
    std::size_t scheduled_frames,
    std::uint64_t current_frame_ingress_us = 0,
    std::size_t current_frame_remaining = 0,
    std::uint64_t renderer_epoch = 0
  ) noexcept;
  void discardQueued(std::uint64_t renderer_epoch = 0) noexcept;
  [[nodiscard]] bool activeFor(std::uint64_t renderer_epoch) const noexcept;
  RemoteAudioIngressTelemetry telemetry() const noexcept;

 private:
  void recoverFromDiscontinuity(std::uint64_t discontinuity_epoch) noexcept;
  void resetQueue() noexcept;

  // The frame storage separates the producer-owned write cursor from the
  // consumer-owned read cursor, avoiding false sharing without over-aligning
  // this polymorphic sink object.
  std::atomic_flag producer_gate_ = ATOMIC_FLAG_INIT;
  std::atomic_flag consumer_gate_ = ATOMIC_FLAG_INIT;
  std::atomic<std::uint64_t> renderer_epoch_{0};
  std::atomic<std::uint32_t> write_index_{0};
  std::array<RemoteAudioIngressFrame, kRemoteAudioIngressSlotCount> slots_{};
  std::atomic<std::uint32_t> read_index_{0};
  std::atomic<std::uint64_t> discontinuity_epoch_{0};
  std::atomic<std::uint64_t> flush_discontinuity_epoch_{0};
  std::uint64_t consumed_discontinuity_epoch_ = 0;
  std::uint64_t consumed_flush_discontinuity_epoch_ = 0;
  std::atomic<std::uint64_t> accepted_frames_{0};
  std::atomic<std::uint64_t> dropped_frames_{0};
  std::atomic<std::uint64_t> suspended_frames_{0};
  std::atomic<std::uint64_t> invalid_frames_{0};
  std::atomic<std::uint64_t> freshness_recoveries_{0};
  std::atomic<std::uint64_t> stale_frames_discarded_{0};
  std::atomic<std::uint64_t> last_scheduled_playout_age_us_{0};
  std::atomic<std::uint64_t> maximum_scheduled_playout_age_us_{0};
  std::atomic<std::uint64_t> last_oldest_queued_age_us_{0};
  std::atomic<std::uint64_t> last_queued_packets_{0};
  RemoteAudioSteadyNowUs steady_now_ = &remoteAudioSteadyNowUs;
  std::uint64_t next_sequence_ = 0;
  std::uint64_t last_ingress_steady_us_ = 0;
};

}  // namespace syrnike::desktop_native::media
