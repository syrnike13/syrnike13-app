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

int intField(const std::string& json, const std::string& key, int fallback) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(-?[0-9]+)");
  std::smatch match;
  if (!std::regex_search(json, match, pattern)) return fallback;
  try {
    return std::stoi(match[1].str());
  } catch (...) {
    return fallback;
  }
}

int clampAudioBitrate(int value) {
  if (value < 8000) return 8000;
  if (value > 96000) return 96000;
  return value;
}

uintptr_t uintptrField(const std::string& json, const std::string& key, uintptr_t fallback) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(?:\"([0-9]+)\"|([0-9]+))");
  std::smatch match;
  if (!std::regex_search(json, match, pattern)) return fallback;
  const std::string value = match[1].matched ? match[1].str() : match[2].str();
  try {
    return static_cast<uintptr_t>(std::stoull(value));
  } catch (...) {
    return fallback;
  }
}

}  // namespace

std::string jsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (unsigned char ch : value) {
    switch (ch) {
      case '\\':
      case '"':
        out.push_back('\\');
        out.push_back(static_cast<char>(ch));
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (ch < 0x20) {
          constexpr char hex[] = "0123456789abcdef";
          out += "\\u00";
          out.push_back(hex[ch >> 4]);
          out.push_back(hex[ch & 0x0f]);
        } else {
          out.push_back(static_cast<char>(ch));
        }
    }
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
  command.session_kind = stringField(json, "sessionKind");
  command.device_id = stringField(json, "deviceId");
  command.source_id = stringField(json, "sourceId");
  if (command.source_id.empty()) {
    command.source_id = stringField(json, "id");
  }
  command.livekit_url = stringField(json, "url");
  command.livekit_token = stringField(json, "token");
  command.participant_identity = stringField(json, "participantIdentity");
  command.width = intField(json, "width", 1920);
  command.height = intField(json, "height", 1080);
  command.fps = intField(json, "fps", 60);
  command.bitrate = intField(json, "bitrate", 8000000);
  command.audio_bitrate = clampAudioBitrate(intField(json, "audioBitrate", 64000));
  command.duration_ms = intField(json, "durationMs", 1000);
  command.exclude_process_id = intField(json, "excludeProcessId", 0);
  command.self_window_hwnd = uintptrField(json, "selfWindowHwnd", 0);
  command.audio_requested = boolField(json, "audio");
  command.echo_cancellation = boolField(json, "echoCancellation");
  command.input_volume = numberField(json, "inputVolume", 1.0f);
  command.voice_gate_enabled = boolField(json, "voiceGateEnabled", true);
  command.voice_gate_threshold_db = numberField(json, "voiceGateThresholdDb", -28.0f);
  command.muted = boolField(json, "muted");
  return command;
}

}  // namespace syrnike::voice
