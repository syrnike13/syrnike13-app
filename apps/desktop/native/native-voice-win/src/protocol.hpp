#pragma once

#include <string>

namespace syrnike::voice {

struct StartCommand {
  std::string session_id;
  std::string device_id;
  std::string livekit_url;
  std::string livekit_token;
  std::string participant_identity;
  bool echo_cancellation = false;
  float input_volume = 1.0f;
  bool voice_gate_enabled = true;
  float voice_gate_threshold_db = -28.0f;
};

std::string jsonEscape(const std::string& value);
void emit(const std::string& json);
void emitError(const std::string& code, const std::string& message);
bool commandMatches(const std::string& json, const std::string& command);
StartCommand parseStartCommand(const std::string& json);

}  // namespace syrnike::voice
