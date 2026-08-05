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

struct RemoteAudioIngressFrame {
  std::array<std::int16_t, kRemoteAudioIngressSamplesPerPacket> samples{};
};

struct RemoteAudioIngressTelemetry {
  std::uint64_t accepted_frames = 0;
  std::uint64_t dropped_frames = 0;
  std::uint64_t suspended_frames = 0;
  std::uint64_t invalid_frames = 0;
  std::uint64_t discontinuities = 0;
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
  RemoteAudioIngress() = default;
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
  void discardQueued() noexcept;
  RemoteAudioIngressTelemetry telemetry() const noexcept;

 private:
  void resetQueue() noexcept;

  // The frame storage separates the producer-owned write cursor from the
  // consumer-owned read cursor, avoiding false sharing without over-aligning
  // this polymorphic sink object.
  std::atomic_flag producer_gate_ = ATOMIC_FLAG_INIT;
  std::atomic<std::uint64_t> renderer_epoch_{0};
  std::atomic<std::uint32_t> write_index_{0};
  std::array<RemoteAudioIngressFrame, kRemoteAudioIngressSlotCount> slots_{};
  std::atomic<std::uint32_t> read_index_{0};
  std::atomic<std::uint64_t> discontinuity_epoch_{0};
  std::uint64_t consumed_discontinuity_epoch_ = 0;
  std::atomic<std::uint64_t> accepted_frames_{0};
  std::atomic<std::uint64_t> dropped_frames_{0};
  std::atomic<std::uint64_t> suspended_frames_{0};
  std::atomic<std::uint64_t> invalid_frames_{0};
};

}  // namespace syrnike::desktop_native::media
