#pragma once

#include <napi.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>

#include "runtime_types.hpp"
#include "native_message_bindings.hpp"

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

inline std::uint64_t positiveSafeIntegerField(
  const Napi::Object& object,
  const char* key
) {
  const auto value = object.Get(key);
  if (!value.IsNumber()) {
    throw std::invalid_argument(std::string(key) + " must be a positive integer");
  }
  const auto number = value.As<Napi::Number>().DoubleValue();
  constexpr auto kMaximumSafeInteger = 9'007'199'254'740'991.0;
  if (!std::isfinite(number) || number < 1 ||
      number > kMaximumSafeInteger || std::floor(number) != number) {
    throw std::invalid_argument(std::string(key) + " must be a positive safe integer");
  }
  return static_cast<std::uint64_t>(number);
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

inline std::string_view mediaRuntimeTransportLane(
  const NativeMessagePolicy<NativeCommandType>& policy
) {
  if (policy.lane == NativeMessageLane::VoiceControl) {
    return "voice-control";
  }
  switch (policy.destination) {
    case NativeMessageDestination::Runtime:
      return "runtime";
    case NativeMessageDestination::Voice:
      return "voice";
    case NativeMessageDestination::Microphone:
      return "microphone";
    case NativeMessageDestination::Screen:
      return "screen";
    case NativeMessageDestination::Camera:
      return "camera";
    case NativeMessageDestination::Query:
      return "query";
    case NativeMessageDestination::Hooks:
    case NativeMessageDestination::Node:
      break;
  }
  throw std::invalid_argument("command has no media runtime transport lane");
}

inline std::string_view trimContractShape(std::string_view value) noexcept {
  while (!value.empty() && value.front() == ' ') value.remove_prefix(1);
  while (!value.empty() && value.back() == ' ') value.remove_suffix(1);
  return value;
}

inline std::vector<std::string_view> splitContractShape(
  std::string_view value,
  char delimiter
) {
  std::vector<std::string_view> parts;
  std::size_t start = 0;
  int braces = 0;
  int brackets = 0;
  int parentheses = 0;
  bool quoted = false;
  bool escaped = false;
  for (std::size_t index = 0; index < value.size(); ++index) {
    const char current = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (current == '\\') escaped = true;
      else if (current == '"') quoted = false;
      continue;
    }
    if (current == '"') quoted = true;
    else if (current == '{') ++braces;
    else if (current == '}') --braces;
    else if (current == '[') ++brackets;
    else if (current == ']') --brackets;
    else if (current == '(') ++parentheses;
    else if (current == ')') --parentheses;
    else if (current == delimiter && braces == 0 && brackets == 0 &&
             parentheses == 0) {
      parts.push_back(trimContractShape(value.substr(start, index - start)));
      start = index + 1;
    }
  }
  parts.push_back(trimContractShape(value.substr(start)));
  return parts;
}

inline std::size_t contractShapeColon(std::string_view value) noexcept {
  int braces = 0;
  int brackets = 0;
  int parentheses = 0;
  for (std::size_t index = 0; index < value.size(); ++index) {
    const char current = value[index];
    if (current == '{') ++braces;
    else if (current == '}') --braces;
    else if (current == '[') ++brackets;
    else if (current == ']') --brackets;
    else if (current == '(') ++parentheses;
    else if (current == ')') --parentheses;
    else if (current == ':' && braces == 0 && brackets == 0 &&
             parentheses == 0) return index;
  }
  return std::string_view::npos;
}

inline bool validateNativeContractValue(
  const Napi::Value& value,
  std::string_view shape,
  bool allow_command_envelope = false
);

inline bool validateNativeContractObject(
  const Napi::Object& object,
  std::string_view shape,
  bool allow_command_envelope
) {
  if (shape.size() < 2 || shape.front() != '{' || shape.back() != '}') {
    return false;
  }
  const auto fields = splitContractShape(shape.substr(1, shape.size() - 2), ',');
  std::vector<std::string_view> declared;
  std::optional<std::string_view> string_index;
  for (const auto field : fields) {
    if (field.empty()) continue;
    const auto colon = contractShapeColon(field);
    if (colon == std::string_view::npos) return false;
    auto name = field.substr(0, colon);
    const auto field_shape = field.substr(colon + 1);
    if (name == "[string]") {
      string_index = field_shape;
      continue;
    }
    const bool optional = name.ends_with('?');
    if (optional) name.remove_suffix(1);
    declared.push_back(name);
    const auto property = object.Get(std::string(name));
    if (property.IsUndefined()) {
      if (!optional) return false;
      continue;
    }
    if (!validateNativeContractValue(property, field_shape)) return false;
  }
  const auto names = object.GetPropertyNames();
  for (std::uint32_t index = 0; index < names.Length(); ++index) {
    const auto key_value = names.Get(index);
    if (!key_value.IsString()) return false;
    const auto key = key_value.As<Napi::String>().Utf8Value();
    const bool envelope = allow_command_envelope &&
      (key == "requestId" || key == "lane" || key == "hostEpoch" ||
       key == "diagnostic");
    if (envelope) continue;
    const bool known = std::find(declared.begin(), declared.end(), key) !=
      declared.end();
    if (known) continue;
    if (!string_index ||
        !validateNativeContractValue(object.Get(key), *string_index)) {
      return false;
    }
  }
  return true;
}

inline bool validateNativeContractValue(
  const Napi::Value& value,
  std::string_view shape,
  bool allow_command_envelope
) {
  shape = trimContractShape(shape);
  for (const auto alternative : splitContractShape(shape, '|')) {
    if (alternative != shape &&
        validateNativeContractValue(value, alternative, allow_command_envelope)) {
      return true;
    }
  }
  if (splitContractShape(shape, '|').size() > 1) return false;
  if (shape.starts_with('{')) {
    return value.IsObject() && !value.IsArray() &&
      validateNativeContractObject(
        value.As<Napi::Object>(), shape, allow_command_envelope
      );
  }
  if (shape.starts_with('[') && shape.ends_with(']')) {
    if (!value.IsArray()) return false;
    const auto array = value.As<Napi::Array>();
    auto element_shape = trimContractShape(
      shape.substr(1, shape.size() - 2)
    );
    if (element_shape.starts_with("...")) element_shape.remove_prefix(3);
    for (std::uint32_t index = 0; index < array.Length(); ++index) {
      if (!validateNativeContractValue(array.Get(index), element_shape)) {
        return false;
      }
    }
    return true;
  }
  if (shape.starts_with("literal(") && shape.ends_with(')')) {
    auto literal = shape.substr(8, shape.size() - 9);
    if (literal == "true") return value.IsBoolean() &&
      value.As<Napi::Boolean>().Value();
    if (literal == "false") return value.IsBoolean() &&
      !value.As<Napi::Boolean>().Value();
    if (literal.size() >= 2 && literal.front() == '"' &&
        literal.back() == '"') {
      literal.remove_prefix(1);
      literal.remove_suffix(1);
      return value.IsString() &&
        value.As<Napi::String>().Utf8Value() == literal;
    }
    if (!value.IsNumber()) return false;
    try {
      return value.As<Napi::Number>().DoubleValue() == std::stod(std::string(literal));
    } catch (...) {
      return false;
    }
  }
  if (shape == "string" || shape == "template") return value.IsString();
  if (shape == "number") return value.IsNumber();
  if (shape == "boolean") return value.IsBoolean();
  if (shape == "bigint") return value.IsBigInt();
  if (shape == "null") return value.IsNull();
  if (shape == "undefined") return value.IsUndefined();
  if (shape == "object") return value.IsObject() && !value.IsNull();
  if (shape.starts_with("declaration(")) return value.IsObject();
  if (shape == "unknown" || shape == "any" || shape == "enum") return true;
  if (shape == "never") return false;
  return false;
}

inline void requireNativeContractShape(
  const Napi::Object& object,
  NativeMessageSchema schema,
  bool allow_command_envelope
) {
  const auto* contract = nativeExternalFieldShape(schema);
  if (!contract || !validateNativeContractValue(
        object, contract->shape, allow_command_envelope
      )) {
    throw std::invalid_argument("native message does not match its Effect Schema shape");
  }
}

inline MediaCommand parseMediaCommand(const Napi::Object& object) {
  MediaCommand command;
  const auto wire_type = stringField(object, "type");
  const auto parsed_type = parseNativeCommandType(wire_type);
  if (!parsed_type) {
    throw std::invalid_argument(
      "command.type is absent from the typed native policy"
    );
  }
  command.type = *parsed_type;
  const auto native_type = command.type;
  const auto& policy = nativeCommandPolicy(native_type);
  if (nativeCommandTypeForSchema(policy.schema) != native_type ||
      nativeCommandTypeForAction(policy.action) != native_type) {
    throw std::invalid_argument(
      "command.type has no concrete schema or dispatch binding"
    );
  }
  if (policy.visibility !=
        NativeMessageVisibility::External ||
      policy.destination ==
        NativeMessageDestination::Hooks) {
    throw std::invalid_argument("command.type is not supported by the media runtime");
  }
  requireNativeContractShape(object, policy.schema, true);
  command.request_id = stringField(object, "requestId");
  command.transport_lane = stringField(object, "lane");
  const auto expected_lane = mediaRuntimeTransportLane(policy);
  if (command.transport_lane != expected_lane) {
    throw std::invalid_argument("command lane does not match the typed native policy");
  }
  command.diagnostic_host_epoch = uint64Field(object, "hostEpoch");
  if (command.diagnostic_host_epoch == 0) {
    throw std::invalid_argument("hostEpoch is required");
  }
  const auto diagnostic_value = object.Get("diagnostic");
  if (diagnostic_value.IsObject()) {
    const auto diagnostic = diagnostic_value.As<Napi::Object>();
    command.diagnostic_action_id = stringField(diagnostic, "actionId");
    command.diagnostic_operation_id = stringField(diagnostic, "operationId");
    const auto diagnostic_host_epoch = uint64Field(diagnostic, "hostEpoch");
    if (diagnostic_host_epoch != command.diagnostic_host_epoch) {
      throw std::invalid_argument(
        "diagnostic hostEpoch does not match the utility host epoch"
      );
    }
    if (hasField(diagnostic, "revision")) {
      command.diagnostic_revision = uint64Field(diagnostic, "revision");
    }
  }
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
  if (command.source_id.empty()) command.source_id = stringField(object, "sourceId");
  command.display_source_action = stringField(object, "action");
  command.display_enumeration_id = stringField(object, "enumerationId");
  command.display_page = uint64Field(object, "page");
  if (command.type == NativeCommandType::ConnectVoice) {
    command.livekit_url = nestedStringField(settings, "livekit", "url");
    command.livekit_token = nestedStringField(settings, "livekit", "token");
    command.participant_identity = nestedStringField(
      settings, "livekit", "participantIdentity"
    );
  } else {
    if (!settings.Get("livekit").IsUndefined()) {
      throw std::invalid_argument(
        "LiveKit credentials are only accepted by connectVoice"
      );
    }
    command.participant_identity = stringField(settings, "participantIdentity");
  }
  command.track_id = stringField(object, "trackId");
  if (
    command.type == NativeCommandType::ReleaseRemoteVideoFrame ||
    command.type == NativeCommandType::ReleaseLocalScreenPreviewFrame ||
    command.type == NativeCommandType::ReleaseLocalCameraPreviewFrame
  ) {
    if (command.track_id.empty()) {
      throw std::invalid_argument("trackId is required for frame release");
    }
    command.frame_sequence = positiveSafeIntegerField(object, "sequence");
  } else {
    command.frame_sequence = uint64Field(object, "sequence");
  }
  command.width = intField(settings, "width", command.width);
  command.height = intField(settings, "height", command.height);
  command.fps = intField(settings, "fps", command.fps);
  command.bitrate = intField(settings, "bitrate", command.bitrate);
  command.audio_bitrate = intField(settings, "audioBitrate", command.audio_bitrate);
  command.exclude_process_id = uint32Field(object, "excludeProcessId");
  command.self_window_handle = uint64Field(object, "selfWindowHwnd");
  command.electron_main_pid = uint32Field(object, "electronMainPid");
  command.audio_requested = boolField(settings, "audioRequested", false);
  const auto audio = settings.Get("audio");
  if (audio.IsBoolean()) command.audio_requested = audio.As<Napi::Boolean>().Value();
  if (audio.IsObject()) {
    command.audio_requested = boolField(audio.As<Napi::Object>(), "requested", command.audio_requested);
  }
  command.noise_suppression = boolField(settings, "noiseSuppression", true);
  command.echo_cancellation = boolField(settings, "echoCancellation", false);
  command.bypass_system_audio_input_processing = boolField(
    settings,
    "bypassSystemAudioInputProcessing",
    true
  );
  command.automatic_gain_control = boolField(settings, "automaticGainControl", true);
  command.input_volume = floatField(settings, "inputVolume", 1.0f);
  command.output_volume = floatField(object, "volume", 1.0f);
  command.voice_gate_enabled = boolField(settings, "voiceGateEnabled", true);
  command.voice_gate_threshold_db = floatField(settings, "voiceGateThresholdDb", -28.0f);
  command.voice_gate_auto_threshold = boolField(settings, "voiceGateAutoThreshold", true);
  command.muted = boolField(object, "muted", false);
  command.deafened = boolField(object, "deafened", false);
  command.has_noise_suppression = hasField(settings, "noiseSuppression");
  command.has_echo_cancellation = hasField(settings, "echoCancellation");
  command.has_bypass_system_audio_input_processing = hasField(
    settings,
    "bypassSystemAudioInputProcessing"
  );
  command.has_automatic_gain_control = hasField(settings, "automaticGainControl");
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
  if (command.type == NativeCommandType::RetryRemoteVideo ||
      command.type == NativeCommandType::RetryLocalCameraPreview) {
    command.internal_message = stringField(object, "reason");
  }
  if (command.type == NativeCommandType::ConfigureRemoteAudio) {
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

  if (command.request_id.empty()) throw std::invalid_argument("command.requestId is required");
  if (command.request_id.size() > 256) throw std::invalid_argument("requestId is too long");
  if (command.diagnostic_action_id.size() > 128) {
    throw std::invalid_argument("diagnostic.actionId is too long");
  }
  if (command.diagnostic_operation_id.size() > 128) {
    throw std::invalid_argument("diagnostic.operationId is too long");
  }
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
  const auto wire_type = stringField(object, "type");
  const auto parsed_type = parseNativeCommandType(wire_type);
  if (!parsed_type) {
    throw std::invalid_argument(
      "command.type is absent from the typed native policy"
    );
  }
  command.type = *parsed_type;
  command.request_id = stringField(object, "requestId");
  if (command.request_id.empty()) throw std::invalid_argument("command.requestId is required");
  const auto native_type = command.type;
  const auto& policy = nativeCommandPolicy(native_type);
  if (nativeCommandTypeForSchema(policy.schema) != native_type ||
      nativeCommandTypeForAction(policy.action) != native_type) {
    throw std::invalid_argument(
      "command.type has no concrete schema or dispatch binding"
    );
  }
  if (policy.visibility !=
        NativeMessageVisibility::External ||
      (policy.destination !=
         NativeMessageDestination::Hooks &&
       native_type != NativeCommandType::Shutdown)) {
    throw std::invalid_argument("command.type is not supported by the hooks runtime");
  }
  requireNativeContractShape(object, policy.schema, true);
  return command;
}

}  // namespace syrnike::desktop_native
