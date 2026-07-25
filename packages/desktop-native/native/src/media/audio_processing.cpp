#include "audio_processing.hpp"

#include <algorithm>
#include <cmath>

namespace syrnike::voice {

std::int16_t clampToPcm16(float sample) {
  const float clamped = std::clamp(sample, -1.0f, 1.0f);
  return static_cast<std::int16_t>(std::lrint(clamped * 32767.0f));
}

float softLimitSample(float sample) {
  constexpr float knee = 0.8912509f;
  const float magnitude = std::abs(sample);
  if (magnitude <= knee) return sample;
  const float excess = magnitude - knee;
  const float limited = knee + excess / (1.0f + excess * 8.0f);
  return std::copysign(std::min(limited, 1.0f), sample);
}

float rmsToDb(float rms) {
  if (rms <= 0.000001f) return -60.0f;
  return std::clamp(20.0f * std::log10(rms), -60.0f, 0.0f);
}

VoiceGateConfig voiceGateConfigFromRuntimeConfig(const RuntimeConfig& config) {
  VoiceGateConfig gate;
  gate.enabled = config.voice_gate_enabled;
  gate.auto_threshold = config.voice_gate_auto_threshold;
  gate.manual_threshold_db = config.voice_gate_threshold_db;
  gate.auto_margin_db = config.voice_gate_auto_margin_db;
  gate.hysteresis_db = config.voice_gate_hysteresis_db;
  gate.attack_ms = config.voice_gate_attack_ms;
  gate.hold_ms = config.voice_gate_hold_ms;
  gate.release_ms = config.voice_gate_release_ms;
  gate.lookahead_ms = config.voice_gate_lookahead_ms;
  return gate;
}

}  // namespace syrnike::voice
