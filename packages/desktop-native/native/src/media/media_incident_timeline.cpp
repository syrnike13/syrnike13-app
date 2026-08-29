#include "media_incident_timeline.hpp"

#include <array>
#include <charconv>
#include <string_view>

#include "../common/diagnostic_log.hpp"

namespace syrnike::desktop_native::media {
namespace {

constexpr std::uint32_t kFnvOffsetBasis = 0x811c9dc5U;
constexpr std::uint32_t kFnvPrime = 0x01000193U;
constexpr std::uint32_t kFrameSampleModulus = 120U;

const char* stageName(MediaTimelineVideoStage stage) noexcept {
  switch (stage) {
    case MediaTimelineVideoStage::Decoded:
      return "decoded";
    case MediaTimelineVideoStage::GpuSubmitted:
      return "gpu_submitted";
    case MediaTimelineVideoStage::NativePublished:
      return "native_published";
    case MediaTimelineVideoStage::GpuCompletionTimeout:
      return "gpu_completion_timeout";
    case MediaTimelineVideoStage::GpuRecycled:
      return "gpu_recycled";
  }
  return "unknown";
}

void appendHash(std::uint32_t& hash, std::string_view value) noexcept {
  for (const auto character : value) {
    hash ^= static_cast<unsigned char>(character);
    hash *= kFnvPrime;
  }
}

void appendSeparator(std::uint32_t& hash) noexcept {
  hash ^= 0U;
  hash *= kFnvPrime;
}

void appendNumber(std::uint32_t& hash, std::uint64_t value) noexcept {
  std::array<char, 32> buffer{};
  const auto result = std::to_chars(buffer.data(), buffer.data() + buffer.size(), value);
  if (result.ec == std::errc{}) {
    appendHash(hash, std::string_view(buffer.data(), result.ptr));
  }
}

void writeVideoObservation(
    const MediaTimelineVideoObservation& observation) noexcept {
  diagnostics::DiagnosticLog::instance().write(
      "media_timeline",
      {
          {"category", "video"},
          {"stage", stageName(observation.stage)},
          {"sessionId", observation.session_id},
          {"generation", observation.generation},
          {"trackId", observation.track_id},
          {"frameSequence", observation.frame_sequence},
          {"nativeCaptureTimestampUs",
           observation.native_capture_timestamp_us},
          {"anomaly", observation.anomaly},
          {"reason", observation.reason},
          {"gpuCompletionUs", observation.gpu_completion_us},
          {"activeLeases", observation.active_leases},
          {"retiredLeases", observation.retired_leases},
          {"poolGenerations", observation.pool_generations},
          {"estimatedBackingBytes", observation.estimated_backing_bytes},
          {"gpuCompletionTimeouts", observation.gpu_completion_timeouts},
          {"rollovers", observation.rollovers},
      });
}

}  // namespace

MediaIncidentTimeline::MediaIncidentTimeline(Sink sink)
    : sink_(sink ? std::move(sink) : Sink{writeVideoObservation}) {}

void MediaIncidentTimeline::recordVideo(
    MediaTimelineVideoObservation observation) const noexcept {
  try {
    if (observation.gpu_completion_us >= kGpuCompletionTimeoutUs) {
      observation.anomaly = true;
      if (observation.reason.empty()) {
        observation.reason = "gpu-completion-timeout";
      }
    }
    if (observation.stage == MediaTimelineVideoStage::GpuCompletionTimeout) {
      observation.anomaly = true;
      if (observation.reason.empty()) {
        observation.reason = "gpu-completion-timeout";
      }
    }
    if (observation.stage == MediaTimelineVideoStage::GpuRecycled) {
      observation.anomaly = true;
      if (observation.reason.empty()) observation.reason = "gpu-recycled";
    }
    if (!observation.anomaly && !isFrameSampled(observation)) return;
    sink_(observation);
  } catch (...) {
    // Diagnostic allocation or sinks must never change media behavior.
  }
}

bool MediaIncidentTimeline::isFrameSampled(
    const MediaTimelineVideoObservation& observation) noexcept {
  std::uint32_t hash = kFnvOffsetBasis;
  appendHash(hash, observation.session_id);
  appendSeparator(hash);
  appendNumber(hash, observation.generation);
  appendSeparator(hash);
  appendHash(hash, observation.track_id);
  appendSeparator(hash);
  appendNumber(hash, observation.native_capture_timestamp_us);
  return hash % kFrameSampleModulus == 0U;
}

MediaIncidentTimeline& mediaIncidentTimeline() noexcept {
  static MediaIncidentTimeline timeline;
  return timeline;
}

}  // namespace syrnike::desktop_native::media
