#pragma once

#include <cstdint>
#include <string>

#include "runtime_config.hpp"
#include "voice_gate.hpp"

namespace syrnike::voice {

struct MicrophoneProcessingStatus {
  std::string noise_suppression = "disabled";
  std::string echo_cancellation = "disabled";
};

std::int16_t clampToPcm16(float sample);
float softLimitSample(float sample);
float rmsToDb(float rms);
VoiceGateConfig voiceGateConfigFromRuntimeConfig(const RuntimeConfig& config);
void emitMicrophoneMetrics(
  const std::string& session_id,
  float input_db,
  float threshold_db,
  bool open
);
void emitMicrophoneDiagnostics(
  const std::string& session_id,
  const std::string& mode,
  std::uint64_t frames,
  std::uint32_t interval_frames,
  float input_db,
  float output_peak,
  std::uint32_t clipped_samples,
  std::uint32_t gated_frames,
  std::uint32_t max_frame_gap_ms,
  std::uint32_t max_capture_frame_us,
  const RuntimeConfig& config,
  const MicrophoneProcessingStatus& processing_status
);

}  // namespace syrnike::voice
