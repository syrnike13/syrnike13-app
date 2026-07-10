#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace syrnike::desktop_native {

struct NativeError {
  std::string code;
  std::string message;
  std::string stage;
  bool retryable = false;
  std::string session_id;
  std::optional<std::uint64_t> generation;
};

struct DeviceInfo {
  std::string device_id;
  std::string label;
  std::string kind;
  bool is_default = false;
};

struct DisplaySourceInfo {
  std::string id;
  std::string name;
  std::string source_type;
  std::uint64_t native_handle = 0;
  std::uint32_t process_id = 0;
  std::optional<std::string> thumbnail_data_url;
  std::optional<std::string> app_icon_data_url;
  std::optional<std::string> process_path;
  std::string classification;
  bool audio_available = false;
  std::string audio_mode = "none";
};

struct InputEvent {
  std::string event_type;
  std::string source;
  std::string code;
  std::string label;
  std::vector<std::string> pressed_codes;
};

struct Rect {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;

  bool operator==(const Rect&) const = default;
};

struct ForegroundWindow {
  std::uint32_t process_id = 0;
  std::string process_name;
  std::optional<std::string> process_path;
  std::string title;
  std::string class_name;
  bool visible = false;
  bool fullscreen_like = false;
  Rect bounds;

  bool operator==(const ForegroundWindow&) const = default;
};

struct RuntimeEvent {
  std::string type;
  std::uint64_t sequence = 0;
  std::string request_id;
  std::string session_id;
  std::uint64_t generation = 0;
  std::string kind;
  std::string status;
  std::string state;
  std::string detail;
  bool ok = true;
  std::optional<NativeError> error;
  std::vector<DeviceInfo> devices;
  std::vector<DisplaySourceInfo> sources;
  std::optional<InputEvent> input;
  std::optional<ForegroundWindow> foreground_window;
  double input_db = -120.0;
  double threshold_db = -28.0;
  bool gate_open = false;
  std::uint64_t frames = 0;
  std::uint64_t packets = 0;
  std::uint64_t audio_frames = 0;
  std::uint64_t audio_packets = 0;
  double audio_peak_db = -120.0;
  double audio_rms_db = -120.0;
  int width = 0;
  int height = 0;
  int fps = 0;
  int bitrate = 0;
  std::string native_participant_identity;
  std::string capture_method;
  std::string reason;
  std::string audio_mode;
  std::string loopback_mode;
  std::uint32_t audio_target_process_id = 0;
  std::string noise_suppression = "disabled";
  std::string echo_cancellation = "disabled";
  std::uint64_t method_wgc = 0;
  std::uint64_t method_dxgi = 0;
  std::uint64_t method_gdi_blt = 0;
};

struct MediaCommand {
  std::string type;
  std::string request_id;
  std::string session_id;
  std::uint64_t generation = 0;
  std::string device_id;
  std::string source_id;
  std::string livekit_url;
  std::string livekit_token;
  std::string participant_identity;
  int width = 1920;
  int height = 1080;
  int fps = 60;
  int bitrate = 8'000'000;
  int audio_bitrate = 64'000;
  std::uint32_t exclude_process_id = 0;
  std::uint64_t self_window_handle = 0;
  bool audio_requested = false;
  bool noise_suppression = true;
  bool echo_cancellation = true;
  float input_volume = 1.0f;
  bool voice_gate_enabled = true;
  float voice_gate_threshold_db = -28.0f;
  bool voice_gate_auto_threshold = true;
  bool muted = false;
  bool has_noise_suppression = false;
  bool has_echo_cancellation = false;
  bool has_input_volume = false;
  bool has_voice_gate_enabled = false;
  bool has_voice_gate_threshold_db = false;
  bool has_voice_gate_auto_threshold = false;
  bool has_muted = false;
  bool force = false;
  bool terminal = false;
  std::string internal_message;
  std::uint64_t internal_epoch = 0;
};

struct HooksCommand {
  std::string type;
  std::string request_id;
};

}  // namespace syrnike::desktop_native
