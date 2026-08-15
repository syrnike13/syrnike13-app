#pragma once

#include <cstdint>
#include <string_view>

#include "runtime_config.hpp"
#include "voice_gate.hpp"

namespace syrnike::voice {

struct MicrophoneProcessingStatus {
  std::string_view noise_suppression = "disabled";
  std::string_view echo_cancellation = "disabled";
};

std::int16_t clampToPcm16(float sample);
float softLimitSample(float sample);
float rmsToDb(float rms);
VoiceGateConfig voiceGateConfigFromRuntimeConfig(const RuntimeConfig& config);

}  // namespace syrnike::voice
