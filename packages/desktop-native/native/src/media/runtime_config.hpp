#pragma once

namespace syrnike::voice {

struct RuntimeConfig {
  float input_volume = 1.0f;
  bool voice_gate_enabled = true;
  float voice_gate_threshold_db = -28.0f;
  bool voice_gate_auto_threshold = true;
  float voice_gate_auto_margin_db = 8.0f;
  float voice_gate_hysteresis_db = 6.0f;
  int voice_gate_attack_ms = 4;
  int voice_gate_hold_ms = 240;
  int voice_gate_release_ms = 120;
  int voice_gate_lookahead_ms = 20;
  bool noise_suppression_enabled = true;
  bool echo_cancellation_enabled = false;
  bool bypass_system_audio_input_processing = true;
  bool automatic_gain_control_enabled = true;
};

}  // namespace syrnike::voice
