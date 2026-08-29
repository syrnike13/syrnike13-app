#pragma once

#include <cstdint>
#include <functional>
#include <string>

namespace syrnike::desktop_native::media {

enum class MediaTimelineVideoStage : std::uint8_t {
  Decoded,
  GpuSubmitted,
  NativePublished,
  GpuCompletionTimeout,
  GpuRecycled,
};

struct MediaTimelineVideoObservation {
  MediaTimelineVideoStage stage = MediaTimelineVideoStage::Decoded;
  std::string session_id;
  std::uint64_t generation = 0;
  std::string track_id;
  std::uint64_t frame_sequence = 0;
  std::uint64_t native_capture_timestamp_us = 0;
  bool anomaly = false;
  std::string reason;
  std::uint64_t gpu_completion_us = 0;
  std::uint64_t active_leases = 0;
  std::uint64_t retired_leases = 0;
  std::uint64_t pool_generations = 0;
  std::uint64_t estimated_backing_bytes = 0;
  std::uint64_t gpu_completion_timeouts = 0;
  std::uint64_t rollovers = 0;
};

// Owns the native half of the cross-process media timeline contract. Normal
// frames are sampled from immutable correlation fields, so Electron can make
// the same decision without another per-frame transport field. Ownership and
// liveness anomalies bypass sampling but still flow through the bounded native
// diagnostic writer.
class MediaIncidentTimeline final {
 public:
  using Sink = std::function<void(const MediaTimelineVideoObservation&)>;

  static constexpr std::uint64_t kGpuCompletionTimeoutUs = 500'000;

  explicit MediaIncidentTimeline(Sink sink = {});

  void recordVideo(MediaTimelineVideoObservation observation) const noexcept;

  [[nodiscard]] static bool isFrameSampled(
      const MediaTimelineVideoObservation& observation) noexcept;

 private:
  Sink sink_;
};

MediaIncidentTimeline& mediaIncidentTimeline() noexcept;

}  // namespace syrnike::desktop_native::media
