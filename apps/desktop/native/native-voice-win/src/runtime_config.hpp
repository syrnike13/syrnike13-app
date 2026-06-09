#pragma once

#include <atomic>

#include "protocol.hpp"

namespace syrnike::voice {

struct RuntimeConfig {
  float input_volume = 1.0f;
  bool voice_gate_enabled = true;
  float voice_gate_threshold_db = -28.0f;
  bool noise_suppression_enabled = true;
  bool echo_cancellation_enabled = true;
};

extern std::atomic<bool> g_running;

RuntimeConfig readRuntimeConfig();
void updateRuntimeConfig(const StartCommand& command);

}  // namespace syrnike::voice
