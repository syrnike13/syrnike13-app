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

}  // namespace syrnike::voice
