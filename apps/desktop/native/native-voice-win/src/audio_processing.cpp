#include "audio_processing.hpp"

#include <algorithm>
#include <cmath>

#include "protocol.hpp"

namespace syrnike::voice {

std::int16_t clampToPcm16(float sample) {
  sample = std::max(-1.0f, std::min(1.0f, sample));
  return static_cast<std::int16_t>(std::lrint(sample * 32767.0f));
}

float softLimitSample(float sample) {
  if (!std::isfinite(sample)) return 0.0f;
  constexpr float kKnee = 0.80f;
  constexpr float kLimit = 0.98f;
  const float magnitude = std::abs(sample);
  if (magnitude <= kKnee) return sample;

  const float compressed = kKnee +
    (kLimit - kKnee) *
      (1.0f - std::exp(-(magnitude - kKnee) / (kLimit - kKnee)));
  return std::copysign(std::min(kLimit, compressed), sample);
}

float rmsToDb(float rms) {
  if (!std::isfinite(rms) || rms <= 0.0000001f) return -60.0f;
  return std::max(-60.0f, std::min(0.0f, 20.0f * std::log10(rms)));
}

bool gateOpen(float input_db, const RuntimeConfig& config) {
  if (!config.voice_gate_enabled) return true;
  return input_db >= config.voice_gate_threshold_db;
}

void emitMicrophoneMetrics(
  const std::string& session_id,
  float input_db,
  float threshold_db,
  bool open
) {
  emit("{\"type\":\"microphone_metrics\",\"session_id\":\"" + jsonEscape(session_id) +
       "\",\"input_db\":" + std::to_string(input_db) +
       ",\"threshold_db\":" + std::to_string(threshold_db) +
       ",\"open\":" + (open ? "true" : "false") + "}");
}

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
  const RuntimeConfig& config
) {
  emit("{\"type\":\"microphone_diagnostics\",\"session_id\":\"" + jsonEscape(session_id) +
       "\",\"mode\":\"" + jsonEscape(mode) +
       "\",\"frames\":" + std::to_string(frames) +
       ",\"interval_frames\":" + std::to_string(interval_frames) +
       ",\"input_db\":" + std::to_string(input_db) +
       ",\"output_peak\":" + std::to_string(output_peak) +
       ",\"clipped_samples\":" + std::to_string(clipped_samples) +
       ",\"gated_frames\":" + std::to_string(gated_frames) +
       ",\"max_frame_gap_ms\":" + std::to_string(max_frame_gap_ms) +
       ",\"max_capture_frame_us\":" + std::to_string(max_capture_frame_us) +
       ",\"input_volume\":" + std::to_string(config.input_volume) +
       ",\"voice_gate_enabled\":" + (config.voice_gate_enabled ? "true" : "false") +
       ",\"voice_gate_threshold_db\":" + std::to_string(config.voice_gate_threshold_db) +
       "}");
}

}  // namespace syrnike::voice
