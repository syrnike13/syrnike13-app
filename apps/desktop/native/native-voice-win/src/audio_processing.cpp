#include "audio_processing.hpp"

#include <algorithm>
#include <cmath>

#include "protocol.hpp"

namespace syrnike::voice {

std::int16_t clampToPcm16(float sample) {
  sample = std::max(-1.0f, std::min(1.0f, sample));
  return static_cast<std::int16_t>(std::lrint(sample * 32767.0f));
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

}  // namespace syrnike::voice
