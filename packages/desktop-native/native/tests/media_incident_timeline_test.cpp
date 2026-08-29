#include <cstdint>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "media/media_incident_timeline.hpp"

namespace {

using syrnike::desktop_native::media::MediaIncidentTimeline;
using syrnike::desktop_native::media::MediaTimelineVideoObservation;
using syrnike::desktop_native::media::MediaTimelineVideoStage;

#ifndef SYRNIKE_MEDIA_TIMELINE_SAMPLER_GOLDEN_VECTORS
#error "media timeline sampler golden-vector path is required"
#endif

struct SamplerGoldenVector {
  std::string session_id;
  std::uint64_t generation = 0;
  std::string track_id;
  std::uint64_t native_capture_timestamp_us = 0;
  bool sampled = false;
};

std::vector<std::string> splitTabs(const std::string& line) {
  std::vector<std::string> fields;
  std::size_t begin = 0;
  while (true) {
    const auto separator = line.find('\t', begin);
    fields.push_back(line.substr(begin, separator - begin));
    if (separator == std::string::npos) return fields;
    begin = separator + 1;
  }
}

std::vector<SamplerGoldenVector> loadSamplerGoldenVectors() {
  std::ifstream input(
      SYRNIKE_MEDIA_TIMELINE_SAMPLER_GOLDEN_VECTORS,
      std::ios::binary);
  if (!input) throw std::runtime_error("sampler golden-vector artifact is missing");

  std::string line;
  if (!std::getline(input, line)) {
    throw std::runtime_error("sampler golden-vector header is missing");
  }
  if (!line.empty() && line.back() == '\r') line.pop_back();
  if (line != "session_id\tgeneration\ttrack_id\t"
              "native_capture_timestamp_us\tsampled") {
    throw std::runtime_error("sampler golden-vector header is invalid");
  }

  std::vector<SamplerGoldenVector> vectors;
  while (std::getline(input, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) continue;
    const auto fields = splitTabs(line);
    if (fields.size() != 5 || (fields[4] != "0" && fields[4] != "1")) {
      throw std::runtime_error("sampler golden-vector row is invalid");
    }
    vectors.push_back({
        fields[0],
        std::stoull(fields[1]),
        fields[2],
        std::stoull(fields[3]),
        fields[4] == "1",
    });
  }
  if (vectors.empty()) {
    throw std::runtime_error("sampler golden-vector artifact is empty");
  }
  return vectors;
}

MediaTimelineVideoObservation observation(
    std::uint64_t timestamp_us,
    MediaTimelineVideoStage stage = MediaTimelineVideoStage::Decoded) {
  return {
    .stage = stage,
    .session_id = "session-7",
    .generation = 3,
    .track_id = "track-video",
    .frame_sequence = 91,
    .native_capture_timestamp_us = timestamp_us,
  };
}

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main() try {
  for (const auto& golden : loadSamplerGoldenVectors()) {
    MediaTimelineVideoObservation candidate{
        .session_id = golden.session_id,
        .generation = golden.generation,
        .track_id = golden.track_id,
        .native_capture_timestamp_us = golden.native_capture_timestamp_us,
    };
    require(
        MediaIncidentTimeline::isFrameSampled(candidate) == golden.sampled,
        "native sampler disagreed with the shared golden-vector artifact");
  }

  std::vector<MediaTimelineVideoObservation> emitted;
  MediaIncidentTimeline timeline([&](const auto& record) {
    emitted.push_back(record);
  });

  timeline.recordVideo(observation(95));
  require(emitted.empty(), "ordinary unsampled frame was emitted");

  auto sampled = observation(94, MediaTimelineVideoStage::NativePublished);
  sampled.frame_sequence = 7'001;
  sampled.gpu_completion_us = 4'200;
  sampled.active_leases = 2;
  sampled.retired_leases = 3;
  sampled.pool_generations = 2;
  sampled.estimated_backing_bytes = 8'388'608;
  timeline.recordVideo(sampled);
  require(emitted.size() == 1, "cross-language sampled frame was omitted");
  require(
      emitted.back().session_id == "session-7" &&
          emitted.back().generation == 3 &&
          emitted.back().track_id == "track-video" &&
          emitted.back().frame_sequence == 7'001 &&
          emitted.back().native_capture_timestamp_us == 94,
      "sampled frame lost its exact correlation");

  auto delayed = observation(95, MediaTimelineVideoStage::NativePublished);
  delayed.gpu_completion_us = MediaIncidentTimeline::kGpuCompletionTimeoutUs;
  timeline.recordVideo(delayed);
  require(
      emitted.size() == 2 && emitted.back().anomaly &&
          emitted.back().reason == "gpu-completion-timeout",
      "delayed GPU completion did not force anomaly sampling");

  auto recycled = observation(95, MediaTimelineVideoStage::GpuRecycled);
  recycled.reason = "all-upload-slots-quarantined";
  recycled.gpu_completion_timeouts = 4;
  recycled.rollovers = 2;
  timeline.recordVideo(recycled);
  require(
      emitted.size() == 3 && emitted.back().anomaly &&
          emitted.back().gpu_completion_timeouts == 4 &&
          emitted.back().rollovers == 2,
      "GPU recycle did not preserve bounded ownership metrics");

  MediaIncidentTimeline failing_sink([](const auto&) {
    throw std::runtime_error("injected diagnostic sink failure");
  });
  failing_sink.recordVideo(delayed);

  return 0;
} catch (const std::exception& error) {
  std::cerr << "media incident timeline test failed: " << error.what()
            << '\n';
  return 1;
}
