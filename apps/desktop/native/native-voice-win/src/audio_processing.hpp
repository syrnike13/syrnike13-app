#pragma once

#include <cstdint>
#include <string>

#include "runtime_config.hpp"

namespace syrnike::voice {

std::int16_t clampToPcm16(float sample);
float softLimitSample(float sample);
float rmsToDb(float rms);
bool gateOpen(float input_db, const RuntimeConfig& config);
void emitMicrophoneMetrics(
  const std::string& session_id,
  float input_db,
  float threshold_db,
  bool open
);

}  // namespace syrnike::voice
