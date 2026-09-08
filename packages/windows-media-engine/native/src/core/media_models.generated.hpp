#pragma once
// Generated from protocol/media-lifecycle.json. Do not edit.
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace syrnike::windows_media {
enum class MicrophoneIntentState { off, warm, on };
enum class CameraIntentState { off, on };
enum class CameraIntentProfile { hd720p30, hd1080p30 };
enum class ScreenIntentState { off, on };
enum class ScreenIntentAudioMode { none, system, process };
enum class OutputIntentState { off, on };

struct AudioMixSetting {
  std::string identity{};
  double volume{};
  bool muted{};
  bool operator==(const AudioMixSetting&) const = default;
};

struct MicrophoneIntent {
  MicrophoneIntentState state = MicrophoneIntentState::off;
  std::optional<std::string> device_id{};
  bool muted{};
  bool push_to_talk{};
  bool push_to_talk_held{};
  bool bypass_system_processing{};
  bool automatic_gain_control{};
  bool noise_suppression{};
  bool echo_cancellation{};
  double input_volume{};
  bool gate_enabled{};
  double gate_threshold_db{};
  bool gate_auto_threshold{};
  bool meter_demand{};
  std::uint64_t retry_revision{};
  bool operator==(const MicrophoneIntent&) const = default;
};

struct CameraIntent {
  CameraIntentState state = CameraIntentState::off;
  std::optional<std::string> device_id{};
  CameraIntentProfile profile{};
  bool publication{};
  std::optional<std::string> preview_renderer_id{};
  std::uint64_t retry_revision{};
  bool operator==(const CameraIntent&) const = default;
};

struct ScreenIntent {
  ScreenIntentState state = ScreenIntentState::off;
  std::string source_id{};
  std::uint64_t width{};
  std::uint64_t height{};
  std::uint64_t fps{};
  std::uint64_t bitrate{};
  ScreenIntentAudioMode audio_mode{};
  std::uint64_t audio_bitrate{};
  std::optional<std::string> preview_renderer_id{};
  std::uint64_t retry_revision{};
  std::uint64_t audio_retry_revision{};
  bool operator==(const ScreenIntent&) const = default;
};

struct OutputIntent {
  OutputIntentState state = OutputIntentState::off;
  std::optional<std::string> device_id{};
  bool deafened{};
  double volume{};
  std::vector<AudioMixSetting> users{};
  std::vector<AudioMixSetting> streams{};
  std::uint64_t retry_revision{};
  bool operator==(const OutputIntent&) const = default;
};

inline bool validMediaIdentifier(const std::string& value) {
  if (value.empty() || value.size() > 256) return false;
  for (const unsigned char character : value) {
    if (character < 0x21 || character > 0x7e) return false;
  }
  return true;
}

inline bool validMediaModel(const AudioMixSetting& value) {
  if (!validMediaIdentifier(value.identity)) return false;
  if (!(std::isfinite(value.volume) && value.volume >= 0 && value.volume <= 3)) return false;
  return true;
}

inline bool validMediaModel(const MicrophoneIntent& value) {
  if (value.state == MicrophoneIntentState::off) return true;
  if (value.state != MicrophoneIntentState::warm && value.state != MicrophoneIntentState::on) return false;
  if (value.device_id && !validMediaIdentifier(*value.device_id)) return false;
  if (!(std::isfinite(value.input_volume) && value.input_volume >= 0 && value.input_volume <= 4)) return false;
  if (!(std::isfinite(value.gate_threshold_db) && value.gate_threshold_db >= -100 && value.gate_threshold_db <= 0)) return false;
  if (!(value.retry_revision >= 0ULL && value.retry_revision <= 9007199254740991ULL)) return false;
  return true;
}

inline bool validMediaModel(const CameraIntent& value) {
  if (value.state == CameraIntentState::off) return true;
  if (value.state != CameraIntentState::on) return false;
  if (value.device_id && !validMediaIdentifier(*value.device_id)) return false;
  if (!(value.profile == CameraIntentProfile::hd720p30 || value.profile == CameraIntentProfile::hd1080p30)) return false;
  if (value.preview_renderer_id && !validMediaIdentifier(*value.preview_renderer_id)) return false;
  if (!(value.retry_revision >= 0ULL && value.retry_revision <= 9007199254740991ULL)) return false;
  return true;
}

inline bool validMediaModel(const ScreenIntent& value) {
  if (value.state == ScreenIntentState::off) return true;
  if (value.state != ScreenIntentState::on) return false;
  if (!validMediaIdentifier(value.source_id)) return false;
  if (!(value.width >= 64ULL && value.width <= 7680ULL)) return false;
  if (!(value.height >= 64ULL && value.height <= 4320ULL)) return false;
  if (!(value.fps >= 1ULL && value.fps <= 240ULL)) return false;
  if (!(value.bitrate >= 32000ULL && value.bitrate <= 100000000ULL)) return false;
  if (!(value.audio_mode == ScreenIntentAudioMode::none || value.audio_mode == ScreenIntentAudioMode::system || value.audio_mode == ScreenIntentAudioMode::process)) return false;
  if (!(value.audio_bitrate >= 6000ULL && value.audio_bitrate <= 512000ULL)) return false;
  if (value.preview_renderer_id && !validMediaIdentifier(*value.preview_renderer_id)) return false;
  if (!(value.retry_revision >= 0ULL && value.retry_revision <= 9007199254740991ULL)) return false;
  if (!(value.audio_retry_revision >= 0ULL && value.audio_retry_revision <= 9007199254740991ULL)) return false;
  return true;
}

inline bool validMediaModel(const OutputIntent& value) {
  if (value.state == OutputIntentState::off) return true;
  if (value.state != OutputIntentState::on) return false;
  if (value.device_id && !validMediaIdentifier(*value.device_id)) return false;
  if (!(std::isfinite(value.volume) && value.volume >= 0 && value.volume <= 3)) return false;
  if (value.users.size() > 1024) return false;
  for (const auto& entry : value.users) if (!validMediaModel(entry)) return false;
  if (value.streams.size() > 1024) return false;
  for (const auto& entry : value.streams) if (!validMediaModel(entry)) return false;
  if (!(value.retry_revision >= 0ULL && value.retry_revision <= 9007199254740991ULL)) return false;
  return true;
}
} // namespace syrnike::windows_media
