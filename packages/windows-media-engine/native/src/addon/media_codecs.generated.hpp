#pragma once
// Generated from protocol/media-lifecycle.json. Do not edit.
#include <napi.h>
#include "core/media_models.generated.hpp"

namespace syrnike::windows_media::media_codec {
[[noreturn]] inline void invalid(Napi::Env env) {
  auto error = Napi::TypeError::New(env, "Invalid bounded media intent");
  error.Value().Set("code", "desired_state_invalid");
  error.Value().Set("stage", "binding_decode");
  error.Value().Set("retryable", false);
  throw error;
}
inline Napi::Object readObject(Napi::Env env, const Napi::Value& value) {
  if (!value.IsObject() || value.IsNull() || value.IsArray()) invalid(env);
  return value.As<Napi::Object>();
}
inline bool readBoolean(Napi::Env env, const Napi::Value& value) {
  if (!value.IsBoolean()) invalid(env);
  return value.As<Napi::Boolean>().Value();
}
inline double readNumber(Napi::Env env, const Napi::Value& value,
                         double minimum, double maximum, bool integer) {
  if (!value.IsNumber()) invalid(env);
  const auto number = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(number) || number < minimum || number > maximum ||
      (integer && std::floor(number) != number)) invalid(env);
  return number;
}
inline std::string readIdentifier(Napi::Env env, const Napi::Value& value) {
  if (!value.IsString()) invalid(env);
  std::size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length == 0 || length > 256) invalid(env);
  std::string text(length + 1, '\0');
  std::size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, text.data(), text.size(), &copied) != napi_ok ||
      copied != length) invalid(env);
  text.resize(length);
  if (!validMediaIdentifier(text)) invalid(env);
  return text;
}
template<typename T, typename Read>
std::vector<T> readArray(Napi::Env env, const Napi::Value& value, std::size_t maximum, Read read) {
  if (!value.IsArray()) invalid(env);
  const auto array = value.As<Napi::Array>();
  if (array.Length() > maximum) invalid(env);
  std::vector<T> entries;
  entries.reserve(array.Length());
  for (std::uint32_t index = 0; index < array.Length(); ++index)
    entries.push_back(read(env, array.Get(index)));
  return entries;
}

inline MicrophoneIntentState readMicrophoneIntentState(Napi::Env env, const Napi::Value& value) {
  const auto text = readIdentifier(env, value);
  if (text == "off") return MicrophoneIntentState::off;
  if (text == "warm") return MicrophoneIntentState::warm;
  if (text == "on") return MicrophoneIntentState::on;
  invalid(env);
}
inline Napi::String writeEnum(Napi::Env env, MicrophoneIntentState value) {
  switch (value) {
    case MicrophoneIntentState::off: return Napi::String::New(env, "off");
    case MicrophoneIntentState::warm: return Napi::String::New(env, "warm");
    case MicrophoneIntentState::on: return Napi::String::New(env, "on");
  }
  invalid(env);
}

inline CameraIntentState readCameraIntentState(Napi::Env env, const Napi::Value& value) {
  const auto text = readIdentifier(env, value);
  if (text == "off") return CameraIntentState::off;
  if (text == "on") return CameraIntentState::on;
  invalid(env);
}
inline Napi::String writeEnum(Napi::Env env, CameraIntentState value) {
  switch (value) {
    case CameraIntentState::off: return Napi::String::New(env, "off");
    case CameraIntentState::on: return Napi::String::New(env, "on");
  }
  invalid(env);
}

inline CameraIntentProfile readCameraIntentProfile(Napi::Env env, const Napi::Value& value) {
  const auto text = readIdentifier(env, value);
  if (text == "hd720p30") return CameraIntentProfile::hd720p30;
  if (text == "hd1080p30") return CameraIntentProfile::hd1080p30;
  invalid(env);
}
inline Napi::String writeEnum(Napi::Env env, CameraIntentProfile value) {
  switch (value) {
    case CameraIntentProfile::hd720p30: return Napi::String::New(env, "hd720p30");
    case CameraIntentProfile::hd1080p30: return Napi::String::New(env, "hd1080p30");
  }
  invalid(env);
}

inline ScreenIntentState readScreenIntentState(Napi::Env env, const Napi::Value& value) {
  const auto text = readIdentifier(env, value);
  if (text == "off") return ScreenIntentState::off;
  if (text == "on") return ScreenIntentState::on;
  invalid(env);
}
inline Napi::String writeEnum(Napi::Env env, ScreenIntentState value) {
  switch (value) {
    case ScreenIntentState::off: return Napi::String::New(env, "off");
    case ScreenIntentState::on: return Napi::String::New(env, "on");
  }
  invalid(env);
}

inline ScreenIntentAudioMode readScreenIntentAudioMode(Napi::Env env, const Napi::Value& value) {
  const auto text = readIdentifier(env, value);
  if (text == "none") return ScreenIntentAudioMode::none;
  if (text == "system") return ScreenIntentAudioMode::system;
  if (text == "process") return ScreenIntentAudioMode::process;
  invalid(env);
}
inline Napi::String writeEnum(Napi::Env env, ScreenIntentAudioMode value) {
  switch (value) {
    case ScreenIntentAudioMode::none: return Napi::String::New(env, "none");
    case ScreenIntentAudioMode::system: return Napi::String::New(env, "system");
    case ScreenIntentAudioMode::process: return Napi::String::New(env, "process");
  }
  invalid(env);
}

inline OutputIntentState readOutputIntentState(Napi::Env env, const Napi::Value& value) {
  const auto text = readIdentifier(env, value);
  if (text == "off") return OutputIntentState::off;
  if (text == "on") return OutputIntentState::on;
  invalid(env);
}
inline Napi::String writeEnum(Napi::Env env, OutputIntentState value) {
  switch (value) {
    case OutputIntentState::off: return Napi::String::New(env, "off");
    case OutputIntentState::on: return Napi::String::New(env, "on");
  }
  invalid(env);
}

inline Napi::Object writeModel(Napi::Env, const AudioMixSetting&);
inline Napi::Object writeModel(Napi::Env, const MicrophoneIntent&);
inline Napi::Object writeModel(Napi::Env, const CameraIntent&);
inline Napi::Object writeModel(Napi::Env, const ScreenIntent&);
inline Napi::Object writeModel(Napi::Env, const OutputIntent&);
template<typename T>
Napi::Array writeArray(Napi::Env env, const std::vector<T>& entries) {
  auto array = Napi::Array::New(env, entries.size());
  for (std::size_t index = 0; index < entries.size(); ++index)
    array.Set(static_cast<std::uint32_t>(index), writeModel(env, entries[index]));
  return array;
}

inline AudioMixSetting readAudioMixSetting(Napi::Env env, const Napi::Value& value) {
  const auto object = readObject(env, value);
  AudioMixSetting result;
  result.identity = readIdentifier(env, object.Get("identity"));
  result.volume = readNumber(env, object.Get("volume"), 0, 3, false);
  result.muted = readBoolean(env, object.Get("muted"));
  return result;
}
inline Napi::Object writeModel(Napi::Env env, const AudioMixSetting& value) {
  auto object = Napi::Object::New(env);
  object.Set("identity", value.identity);
  object.Set("volume", value.volume);
  object.Set("muted", value.muted);
  return object;
}

inline MicrophoneIntent readMicrophoneIntent(Napi::Env env, const Napi::Value& value) {
  const auto object = readObject(env, value);
  MicrophoneIntent result;
  result.state = readMicrophoneIntentState(env, object.Get("state"));
  if (result.state == MicrophoneIntentState::off) return result;
  if (!object.Get("deviceId").IsNull()) result.device_id = readIdentifier(env, object.Get("deviceId"));
  result.muted = readBoolean(env, object.Get("muted"));
  result.push_to_talk = readBoolean(env, object.Get("pushToTalk"));
  result.push_to_talk_held = readBoolean(env, object.Get("pushToTalkHeld"));
  result.bypass_system_processing = readBoolean(env, object.Get("bypassSystemProcessing"));
  result.automatic_gain_control = readBoolean(env, object.Get("automaticGainControl"));
  result.noise_suppression = readBoolean(env, object.Get("noiseSuppression"));
  result.echo_cancellation = readBoolean(env, object.Get("echoCancellation"));
  result.input_volume = readNumber(env, object.Get("inputVolume"), 0, 4, false);
  result.gate_enabled = readBoolean(env, object.Get("gateEnabled"));
  result.gate_threshold_db = readNumber(env, object.Get("gateThresholdDb"), -100, 0, false);
  result.gate_auto_threshold = readBoolean(env, object.Get("gateAutoThreshold"));
  result.meter_demand = readBoolean(env, object.Get("meterDemand"));
  result.retry_revision = static_cast<std::uint64_t>(readNumber(env, object.Get("retryRevision"), 0, 9007199254740991, true));
  return result;
}
inline Napi::Object writeModel(Napi::Env env, const MicrophoneIntent& value) {
  auto object = Napi::Object::New(env);
  object.Set("state", writeEnum(env, value.state));
  if (value.state == MicrophoneIntentState::off) return object;
  if (value.device_id) object.Set("deviceId", *value.device_id);
  else object.Set("deviceId", env.Null());
  object.Set("muted", value.muted);
  object.Set("pushToTalk", value.push_to_talk);
  object.Set("pushToTalkHeld", value.push_to_talk_held);
  object.Set("bypassSystemProcessing", value.bypass_system_processing);
  object.Set("automaticGainControl", value.automatic_gain_control);
  object.Set("noiseSuppression", value.noise_suppression);
  object.Set("echoCancellation", value.echo_cancellation);
  object.Set("inputVolume", value.input_volume);
  object.Set("gateEnabled", value.gate_enabled);
  object.Set("gateThresholdDb", value.gate_threshold_db);
  object.Set("gateAutoThreshold", value.gate_auto_threshold);
  object.Set("meterDemand", value.meter_demand);
  object.Set("retryRevision", Napi::Number::New(env, static_cast<double>(value.retry_revision)));
  return object;
}

inline CameraIntent readCameraIntent(Napi::Env env, const Napi::Value& value) {
  const auto object = readObject(env, value);
  CameraIntent result;
  result.state = readCameraIntentState(env, object.Get("state"));
  if (result.state == CameraIntentState::off) return result;
  if (!object.Get("deviceId").IsNull()) result.device_id = readIdentifier(env, object.Get("deviceId"));
  result.profile = readCameraIntentProfile(env, object.Get("profile"));
  result.publication = readBoolean(env, object.Get("publication"));
  if (!object.Get("previewRendererId").IsNull()) result.preview_renderer_id = readIdentifier(env, object.Get("previewRendererId"));
  result.retry_revision = static_cast<std::uint64_t>(readNumber(env, object.Get("retryRevision"), 0, 9007199254740991, true));
  return result;
}
inline Napi::Object writeModel(Napi::Env env, const CameraIntent& value) {
  auto object = Napi::Object::New(env);
  object.Set("state", writeEnum(env, value.state));
  if (value.state == CameraIntentState::off) return object;
  if (value.device_id) object.Set("deviceId", *value.device_id);
  else object.Set("deviceId", env.Null());
  object.Set("profile", writeEnum(env, value.profile));
  object.Set("publication", value.publication);
  if (value.preview_renderer_id) object.Set("previewRendererId", *value.preview_renderer_id);
  else object.Set("previewRendererId", env.Null());
  object.Set("retryRevision", Napi::Number::New(env, static_cast<double>(value.retry_revision)));
  return object;
}

inline ScreenIntent readScreenIntent(Napi::Env env, const Napi::Value& value) {
  const auto object = readObject(env, value);
  ScreenIntent result;
  result.state = readScreenIntentState(env, object.Get("state"));
  if (result.state == ScreenIntentState::off) return result;
  result.source_id = readIdentifier(env, object.Get("sourceId"));
  result.width = static_cast<std::uint64_t>(readNumber(env, object.Get("width"), 64, 7680, true));
  result.height = static_cast<std::uint64_t>(readNumber(env, object.Get("height"), 64, 4320, true));
  result.fps = static_cast<std::uint64_t>(readNumber(env, object.Get("fps"), 1, 240, true));
  result.bitrate = static_cast<std::uint64_t>(readNumber(env, object.Get("bitrate"), 32000, 100000000, true));
  result.audio_mode = readScreenIntentAudioMode(env, object.Get("audioMode"));
  result.audio_bitrate = static_cast<std::uint64_t>(readNumber(env, object.Get("audioBitrate"), 6000, 512000, true));
  if (!object.Get("previewRendererId").IsNull()) result.preview_renderer_id = readIdentifier(env, object.Get("previewRendererId"));
  result.retry_revision = static_cast<std::uint64_t>(readNumber(env, object.Get("retryRevision"), 0, 9007199254740991, true));
  result.audio_retry_revision = static_cast<std::uint64_t>(readNumber(env, object.Get("audioRetryRevision"), 0, 9007199254740991, true));
  return result;
}
inline Napi::Object writeModel(Napi::Env env, const ScreenIntent& value) {
  auto object = Napi::Object::New(env);
  object.Set("state", writeEnum(env, value.state));
  if (value.state == ScreenIntentState::off) return object;
  object.Set("sourceId", value.source_id);
  object.Set("width", Napi::Number::New(env, static_cast<double>(value.width)));
  object.Set("height", Napi::Number::New(env, static_cast<double>(value.height)));
  object.Set("fps", Napi::Number::New(env, static_cast<double>(value.fps)));
  object.Set("bitrate", Napi::Number::New(env, static_cast<double>(value.bitrate)));
  object.Set("audioMode", writeEnum(env, value.audio_mode));
  object.Set("audioBitrate", Napi::Number::New(env, static_cast<double>(value.audio_bitrate)));
  if (value.preview_renderer_id) object.Set("previewRendererId", *value.preview_renderer_id);
  else object.Set("previewRendererId", env.Null());
  object.Set("retryRevision", Napi::Number::New(env, static_cast<double>(value.retry_revision)));
  object.Set("audioRetryRevision", Napi::Number::New(env, static_cast<double>(value.audio_retry_revision)));
  return object;
}

inline OutputIntent readOutputIntent(Napi::Env env, const Napi::Value& value) {
  const auto object = readObject(env, value);
  OutputIntent result;
  result.state = readOutputIntentState(env, object.Get("state"));
  if (result.state == OutputIntentState::off) return result;
  if (!object.Get("deviceId").IsNull()) result.device_id = readIdentifier(env, object.Get("deviceId"));
  result.deafened = readBoolean(env, object.Get("deafened"));
  result.volume = readNumber(env, object.Get("volume"), 0, 3, false);
  result.users = readArray<AudioMixSetting>(env, object.Get("users"), 1024, readAudioMixSetting);
  result.streams = readArray<AudioMixSetting>(env, object.Get("streams"), 1024, readAudioMixSetting);
  result.retry_revision = static_cast<std::uint64_t>(readNumber(env, object.Get("retryRevision"), 0, 9007199254740991, true));
  return result;
}
inline Napi::Object writeModel(Napi::Env env, const OutputIntent& value) {
  auto object = Napi::Object::New(env);
  object.Set("state", writeEnum(env, value.state));
  if (value.state == OutputIntentState::off) return object;
  if (value.device_id) object.Set("deviceId", *value.device_id);
  else object.Set("deviceId", env.Null());
  object.Set("deafened", value.deafened);
  object.Set("volume", value.volume);
  object.Set("users", writeArray(env, value.users));
  object.Set("streams", writeArray(env, value.streams));
  object.Set("retryRevision", Napi::Number::New(env, static_cast<double>(value.retry_revision)));
  return object;
}
} // namespace syrnike::windows_media::media_codec
