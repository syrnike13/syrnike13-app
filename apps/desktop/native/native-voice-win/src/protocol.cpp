#include "protocol.hpp"

#include <iostream>
#include <regex>

namespace syrnike::voice {
namespace {

std::string stringField(const std::string& json, const std::string& key) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
  std::smatch match;
  if (!std::regex_search(json, match, pattern)) return {};
  return match[1].str();
}

bool boolField(const std::string& json, const std::string& key, bool fallback = false) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(true|false)");
  std::smatch match;
  if (!std::regex_search(json, match, pattern)) return fallback;
  return match[1].str() == "true";
}

float numberField(const std::string& json, const std::string& key, float fallback) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)");
  std::smatch match;
  if (!std::regex_search(json, match, pattern)) return fallback;
  try {
    return std::stof(match[1].str());
  } catch (...) {
    return fallback;
  }
}

}  // namespace

std::string jsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (char ch : value) {
    if (ch == '\\' || ch == '"') {
      out.push_back('\\');
    }
    out.push_back(ch);
  }
  return out;
}

void emit(const std::string& json) {
  std::cout << json << std::endl;
}

void emitError(const std::string& code, const std::string& message) {
  emit("{\"type\":\"error\",\"code\":\"" + jsonEscape(code) +
       "\",\"message\":\"" + jsonEscape(message) + "\"}");
}

bool commandMatches(const std::string& json, const std::string& command) {
  return json.find("\"cmd\":\"" + command + "\"") != std::string::npos ||
         json.find("\"cmd\": \"" + command + "\"") != std::string::npos;
}

StartCommand parseStartCommand(const std::string& json) {
  StartCommand command;
  command.session_id = stringField(json, "sessionId");
  command.device_id = stringField(json, "deviceId");
  command.livekit_url = stringField(json, "url");
  command.livekit_token = stringField(json, "token");
  command.participant_identity = stringField(json, "participantIdentity");
  command.echo_cancellation = boolField(json, "echoCancellation");
  command.input_volume = numberField(json, "inputVolume", 1.0f);
  command.voice_gate_enabled = boolField(json, "voiceGateEnabled", true);
  command.voice_gate_threshold_db = numberField(json, "voiceGateThresholdDb", -28.0f);
  return command;
}

}  // namespace syrnike::voice
