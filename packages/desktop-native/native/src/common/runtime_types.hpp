#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace syrnike::desktop_native {

struct NativeError {
  std::string code;
  std::string message;
  std::string stage;
  bool retryable = false;
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

enum class NativeEventType : std::uint8_t {
  Reply,
  RuntimeError,
  Input,
  ForegroundWindow,
};

struct RuntimeEvent {
  NativeEventType type = NativeEventType::RuntimeError;
  std::uint64_t sequence = 0;
  std::string request_id;
  bool ok = true;
  std::optional<NativeError> error;
  std::optional<InputEvent> input;
  std::optional<ForegroundWindow> foreground_window;
  std::function<void()> on_drop;
};

enum class NativeCommandType : std::uint8_t {
  StartHotkeys,
  StopHotkeys,
  StartOverlay,
  StopOverlay,
  ProbeHooksRuntime,
  Shutdown,
};

struct HooksCommand {
  NativeCommandType type = NativeCommandType::ProbeHooksRuntime;
  std::string request_id;
};

inline std::optional<NativeCommandType> parseNativeCommandType(
  std::string_view value
) noexcept {
  if (value == "startHotkeys") return NativeCommandType::StartHotkeys;
  if (value == "stopHotkeys") return NativeCommandType::StopHotkeys;
  if (value == "startOverlay") return NativeCommandType::StartOverlay;
  if (value == "stopOverlay") return NativeCommandType::StopOverlay;
  if (value == "probeHooksRuntime") return NativeCommandType::ProbeHooksRuntime;
  if (value == "shutdown") return NativeCommandType::Shutdown;
  return std::nullopt;
}

inline const char* nativeCommandName(NativeCommandType type) noexcept {
  switch (type) {
    case NativeCommandType::StartHotkeys: return "startHotkeys";
    case NativeCommandType::StopHotkeys: return "stopHotkeys";
    case NativeCommandType::StartOverlay: return "startOverlay";
    case NativeCommandType::StopOverlay: return "stopOverlay";
    case NativeCommandType::ProbeHooksRuntime: return "probeHooksRuntime";
    case NativeCommandType::Shutdown: return "shutdown";
  }
  return "unknown";
}

}  // namespace syrnike::desktop_native
