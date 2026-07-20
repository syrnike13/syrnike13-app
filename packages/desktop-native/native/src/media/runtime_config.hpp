#pragma once

namespace syrnike::voice {

struct RuntimeConfig {
  float input_volume = 1.0f;
  bool voice_gate_enabled = true;
  float voice_gate_threshold_db = -28.0f;
  bool voice_gate_auto_threshold = true;
  bool noise_suppression_enabled = true;
  bool echo_cancellation_enabled = false;
  bool bypass_system_audio_input_processing = true;
  bool automatic_gain_control_enabled = true;
};

}  // namespace syrnike::voice
