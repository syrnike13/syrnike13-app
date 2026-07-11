#pragma once

#include <napi.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>

#include "runtime_types.hpp"

namespace syrnike::desktop_native {

inline std::string stringField(const Napi::Object& object, const char* key) {
  const auto value = object.Get(key);
  return value.IsString() ? value.As<Napi::String>().Utf8Value() : std::string{};
}

inline bool boolField(const Napi::Object& object, const char* key, bool fallback) {
  const auto value = object.Get(key);
  return value.IsBoolean() ? value.As<Napi::Boolean>().Value() : fallback;
}

inline int intField(const Napi::Object& object, const char* key, int fallback) {
  const auto value = object.Get(key);
  return value.IsNumber() ? value.As<Napi::Number>().Int32Value() : fallback;
}

inline float floatField(const Napi::Object& object, const char* key, float fallback) {
  const auto value = object.Get(key);
  return value.IsNumber() ? value.As<Napi::Number>().FloatValue() : fallback;
}

inline std::uint32_t uint32Field(const Napi::Object& object, const char* key) {
  const auto value = object.Get(key);
  if (!value.IsNumber()) return 0;
  const auto number = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(number) || number < 0 ||
      number > static_cast<double>(std::numeric_limits<std::uint32_t>::max()) ||
      std::floor(number) != number) {
    throw std::invalid_argument(std::string(key) + " is out of range");
  }
  return value.As<Napi::Number>().Uint32Value();
}

inline bool hasField(const Napi::Object& object, const char* key) {
  return !object.Get(key).IsUndefined();
}

inline bool hasAllowedLiveKitScheme(const std::string& url) {
  return url.starts_with("wss://") || url.starts_with("ws://");
}

inline std::uint64_t uint64Field(const Napi::Object& object, const char* key) {
  const auto value = object.Get(key);
  if (value.IsBigInt()) {
    bool lossless = false;
    const auto result = value.As<Napi::BigInt>().Uint64Value(&lossless);
    return lossless ? result : 0;
  }
  if (value.IsNumber()) {
    const auto number = value.As<Napi::Number>().Int64Value();
    return number >= 0 ? static_cast<std::uint64_t>(number) : 0;
  }
  if (value.IsString()) {
    try {
      return std::stoull(value.As<Napi::String>().Utf8Value());
    } catch (...) {
      return 0;
    }
  }
  return 0;
}

inline std::string nestedStringField(
  const Napi::Object& object,
  const char* object_key,
  const char* value_key
) {
  const auto nested = object.Get(object_key);
  return nested.IsObject() ? stringField(nested.As<Napi::Object>(), value_key) : std::string{};
}

template <typename T, typename Parse>
inline std::unordered_map<std::string, T> settingsMap(
  const Napi::Object& settings, const char* key, Parse parse
) {
  std::unordered_map<std::string, T> result;
  const auto value = settings.Get(key);
  if (!value.IsObject() || value.IsArray()) throw std::invalid_argument(std::string(key) + " is required");
  const auto object = value.As<Napi::Object>();
  const auto names = object.GetPropertyNames();
  if (names.Length() > 512) throw std::invalid_argument(std::string(key) + " has too many entries");
  for (std::uint32_t index = 0; index < names.Length(); ++index) {
    const auto name = names.Get(index);
    if (!name.IsString()) throw std::invalid_argument(std::string(key) + " has invalid id");
    auto id = name.As<Napi::String>().Utf8Value();
    if (id.empty() || id.size() > 512) throw std::invalid_argument(std::string(key) + " has invalid id");
    result.emplace(std::move(id), parse(object.Get(name)));
  }
  return result;
}

inline MediaCommand parseMediaCommand(const Napi::Object& object) {
  MediaCommand command;
  command.type = stringField(object, "type");
  command.request_id = stringField(object, "requestId");
  command.session_id = stringField(object, "sessionId");
  command.generation = uint64Field(object, "generation");
  const auto options_value = object.Get("options");
  const auto config_value = object.Get("config");
  auto settings = options_value.IsObject()
    ? options_value.As<Napi::Object>()
    : config_value.IsObject()
      ? config_value.As<Napi::Object>()
      : Napi::Object::New(object.Env());
  const auto revision_value = object.Get("revision");
  if (!revision_value.IsUndefined()) {
    command.revision = uint64Field(object, "revision");
    command.has_revision = true;
  }
  command.device_id = stringField(settings, "deviceId");
  if (command.device_id.empty()) command.device_id = stringField(object, "deviceId");
  command.device_kind = stringField(object, "kind");
  command.source_id = stringField(settings, "sourceId");
  command.livekit_url = nestedStringField(settings, "livekit", "url");
  command.livekit_token = nestedStringField(settings, "livekit", "token");
  command.participant_identity = nestedStringField(settings, "livekit", "participantIdentity");
  command.track_id = stringField(object, "trackId");
  command.frame_sequence = uint64Field(object, "sequence");
  command.width = intField(settings, "width", command.width);
  command.height = intField(settings, "height", command.height);
  command.fps = intField(settings, "fps", command.fps);
  command.bitrate = intField(settings, "bitrate", command.bitrate);
  command.audio_bitrate = intField(settings, "audioBitrate", command.audio_bitrate);
  command.exclude_process_id = uint32Field(object, "excludeProcessId");
  command.self_window_handle = uint64Field(object, "selfWindowHwnd");
  command.audio_requested = boolField(settings, "audioRequested", false);
  const auto audio = settings.Get("audio");
  if (audio.IsBoolean()) command.audio_requested = audio.As<Napi::Boolean>().Value();
  if (audio.IsObject()) {
    command.audio_requested = boolField(audio.As<Napi::Object>(), "requested", command.audio_requested);
  }
  command.noise_suppression = boolField(settings, "noiseSuppression", true);
  command.echo_cancellation = boolField(settings, "echoCancellation", true);
  command.input_volume = floatField(settings, "inputVolume", 1.0f);
  command.output_volume = floatField(object, "volume", 1.0f);
  command.voice_gate_enabled = boolField(settings, "voiceGateEnabled", true);
  command.voice_gate_threshold_db = floatField(settings, "voiceGateThresholdDb", -28.0f);
  command.voice_gate_auto_threshold = boolField(settings, "voiceGateAutoThreshold", true);
  command.muted = boolField(object, "muted", false);
  command.deafened = boolField(object, "deafened", false);
  command.has_noise_suppression = hasField(settings, "noiseSuppression");
  command.has_echo_cancellation = hasField(settings, "echoCancellation");
  command.has_input_volume = hasField(settings, "inputVolume");
  command.has_output_volume = hasField(object, "volume");
  command.has_voice_gate_enabled = hasField(settings, "voiceGateEnabled");
  command.has_voice_gate_threshold_db = hasField(settings, "voiceGateThresholdDb");
  command.has_voice_gate_auto_threshold = hasField(settings, "voiceGateAutoThreshold");
  command.has_muted = hasField(object, "muted");
  command.has_deafened = hasField(object, "deafened");
  command.force = boolField(object, "force", false);
  command.demanded = boolField(object, "demanded", true);
  command.terminal = boolField(object, "terminal", false);
  if (command.type == "configureRemoteAudio") {
    const auto remote_value = object.Get("settings");
    if (!remote_value.IsObject()) throw std::invalid_argument("settings is required");
    const auto remote = remote_value.As<Napi::Object>();
    command.revision = uint64Field(remote, "revision");
    command.has_revision = hasField(remote, "revision");
    const auto volume = [](const Napi::Value& value) {
      if (!value.IsNumber()) throw std::invalid_argument("volume must be a number");
      const auto number = value.As<Napi::Number>().DoubleValue();
      if (!std::isfinite(number) || number < 0.0 || number > 3.0) throw std::invalid_argument("volume is out of range");
      return static_cast<float>(number);
    };
    const auto muted = [](const Napi::Value& value) {
      if (!value.IsBoolean()) throw std::invalid_argument("mute must be boolean");
      return value.As<Napi::Boolean>().Value();
    };
    command.user_volumes = settingsMap<float>(remote, "userVolumes", volume);
    command.user_mutes = settingsMap<bool>(remote, "userMutes", muted);
    command.stream_volumes = settingsMap<float>(remote, "streamVolumes", volume);
    command.stream_mutes = settingsMap<bool>(remote, "streamMutes", muted);
  }
  if (options_value.IsObject()) {
    command.muted = boolField(settings, "muted", command.muted);
    command.has_muted = command.has_muted || hasField(settings, "muted");
  }

  if (command.type.empty()) throw std::invalid_argument("command.type is required");
  if (command.request_id.empty()) throw std::invalid_argument("command.requestId is required");
  if (command.request_id.size() > 256) throw std::invalid_argument("requestId is too long");
  if (command.session_id.size() > 256) throw std::invalid_argument("sessionId is too long");
  if (command.device_id.size() > 2'048) throw std::invalid_argument("deviceId is too long");
  if (!command.device_kind.empty() && command.device_kind != "audioinput" &&
      command.device_kind != "audiooutput" && command.device_kind != "videoinput") {
    throw std::invalid_argument("unsupported device kind");
  }
  if (command.source_id.size() > 2'048) throw std::invalid_argument("sourceId is too long");
  if (command.livekit_url.size() > 2'048) throw std::invalid_argument("LiveKit URL is too long");
  if (command.livekit_token.size() > 32'768) throw std::invalid_argument("LiveKit token is too long");
  if (command.participant_identity.size() > 512) {
    throw std::invalid_argument("participantIdentity is too long");
  }
  if (!command.livekit_url.empty() && !hasAllowedLiveKitScheme(command.livekit_url)) {
    throw std::invalid_argument("LiveKit URL scheme is not allowed");
  }
  if (command.width < 16 || command.width > 7680) throw std::invalid_argument("width is out of range");
  if (command.height < 16 || command.height > 4320) throw std::invalid_argument("height is out of range");
  if (command.fps < 1 || command.fps > 240) throw std::invalid_argument("fps is out of range");
  if (command.bitrate < 32'000 || command.bitrate > 100'000'000) {
    throw std::invalid_argument("bitrate is out of range");
  }
  if (command.audio_bitrate < 6'000 || command.audio_bitrate > 512'000) {
    throw std::invalid_argument("audioBitrate is out of range");
  }
  if (!std::isfinite(command.input_volume) ||
      command.input_volume < 0.0f || command.input_volume > 4.0f) {
    throw std::invalid_argument("inputVolume is out of range");
  }
  if (!std::isfinite(command.output_volume) ||
      command.output_volume < 0.0f || command.output_volume > 3.0f) {
    throw std::invalid_argument("output volume is out of range");
  }
  if (!std::isfinite(command.voice_gate_threshold_db) ||
      command.voice_gate_threshold_db < -100.0f ||
      command.voice_gate_threshold_db > 0.0f) {
    throw std::invalid_argument("voiceGateThresholdDb is out of range");
  }
  return command;
}

inline HooksCommand parseHooksCommand(const Napi::Object& object) {
  HooksCommand command;
  command.type = stringField(object, "type");
  command.request_id = stringField(object, "requestId");
  if (command.type.empty()) throw std::invalid_argument("command.type is required");
  if (command.request_id.empty()) throw std::invalid_argument("command.requestId is required");
  return command;
}

}  // namespace syrnike::desktop_native
