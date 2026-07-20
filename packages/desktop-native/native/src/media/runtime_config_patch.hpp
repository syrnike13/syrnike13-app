#pragma once

#include "common/runtime_types.hpp"
#include "runtime_config.hpp"

namespace syrnike::desktop_native::media {

inline syrnike::voice::RuntimeConfig mergeRuntimeConfig(
  syrnike::voice::RuntimeConfig current,
  const MediaCommand& command
) {
  if (command.has_input_volume) current.input_volume = command.input_volume;
  if (command.has_voice_gate_enabled) {
    current.voice_gate_enabled = command.voice_gate_enabled;
  }
  if (command.has_voice_gate_threshold_db) {
    current.voice_gate_threshold_db = command.voice_gate_threshold_db;
  }
  if (command.has_voice_gate_auto_threshold) {
    current.voice_gate_auto_threshold = command.voice_gate_auto_threshold;
  }
  if (command.has_noise_suppression) {
    current.noise_suppression_enabled = command.noise_suppression;
  }
  if (command.has_echo_cancellation) {
    current.echo_cancellation_enabled = command.echo_cancellation;
  }
  if (command.has_bypass_system_audio_input_processing) {
    current.bypass_system_audio_input_processing =
      command.bypass_system_audio_input_processing;
  }
  if (command.has_automatic_gain_control) {
    current.automatic_gain_control_enabled = command.automatic_gain_control;
  }
  return current;
}

inline bool microphoneCaptureConfigRequiresRestart(
  const syrnike::voice::RuntimeConfig& current,
  const syrnike::voice::RuntimeConfig& desired
) {
  return current.bypass_system_audio_input_processing !=
    desired.bypass_system_audio_input_processing;
}

}  // namespace syrnike::desktop_native::media
