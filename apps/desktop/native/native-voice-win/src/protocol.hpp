#pragma once

#include <cstdint>
#include <string>

namespace syrnike::voice {

struct StartCommand {
  std::string session_id;
  std::string session_kind;
  std::string device_id;
  std::string source_id;
  std::string livekit_url;
  std::string livekit_token;
  std::string participant_identity;
  int width = 1920;
  int height = 1080;
  int fps = 60;
  int bitrate = 8000000;
  int audio_bitrate = 64000;
  int duration_ms = 1000;
  int exclude_process_id = 0;
  uintptr_t self_window_hwnd = 0;
  bool audio_requested = false;
  bool noise_suppression = true;
  bool echo_cancellation = true;
  float input_volume = 1.0f;
  bool voice_gate_enabled = true;
  float voice_gate_threshold_db = -28.0f;
  bool muted = false;
};

std::string jsonEscape(const std::string& value);
void emit(const std::string& json);
void emitError(const std::string& code, const std::string& message);
bool commandMatches(const std::string& json, const std::string& command);
StartCommand parseStartCommand(const std::string& json);

}  // namespace syrnike::voice
