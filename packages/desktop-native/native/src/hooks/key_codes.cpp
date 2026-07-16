#include "key_codes.hpp"

#include <string>

namespace syrnike::hotkeys {
namespace {

bool hasExtendedFlag(std::uint32_t flags) {
  return (flags & kLlkhfExtended) != 0;
}

std::string functionKeyCode(std::uint32_t vk_code) {
  return "F" + std::to_string(vk_code - 0x6f);
}

}  // namespace

bool isInjectedKeyEvent(std::uint32_t flags) {
  return (flags & (kLlkhfInjected | kLlkhfLowerIlInjected)) != 0;
}

bool isInjectedMouseEvent(std::uint32_t flags) {
  return (flags & (kLlmhfInjected | kLlmhfLowerIlInjected)) != 0;
}

std::string keyboardCode(
  std::uint32_t vk_code,
  std::uint32_t scan_code,
  std::uint32_t flags
) {
  if (vk_code >= 0x41 && vk_code <= 0x5a) {
    return std::string("Key") + static_cast<char>(vk_code);
  }
  if (vk_code >= 0x30 && vk_code <= 0x39) {
    return std::string("Digit") + static_cast<char>(vk_code);
  }

  switch (vk_code) {
    case 0xa2:
      return "ControlLeft";
    case 0xa3:
      return "ControlRight";
    case 0x11:
      return hasExtendedFlag(flags) ? "ControlRight" : "ControlLeft";
    case 0xa4:
      return "AltLeft";
    case 0xa5:
      return "AltRight";
    case 0x12:
      return hasExtendedFlag(flags) ? "AltRight" : "AltLeft";
    case 0xa0:
      return "ShiftLeft";
    case 0xa1:
      return "ShiftRight";
    case 0x10:
      return scan_code == 0x36 ? "ShiftRight" : "ShiftLeft";
    case 0x5b:
      return "MetaLeft";
    case 0x5c:
      return "MetaRight";
    case 0x1b:
      return "Escape";
    case 0x20:
      return "Space";
    case 0x21:
      return "PageUp";
    case 0x22:
      return "PageDown";
    case 0x23:
      return "End";
    case 0x24:
      return "Home";
    case 0x25:
      return "ArrowLeft";
    case 0x26:
      return "ArrowUp";
    case 0x27:
      return "ArrowRight";
    case 0x28:
      return "ArrowDown";
    case 0x2d:
      return "Insert";
    case 0x2e:
      return "Delete";
    default:
      break;
  }

  if (vk_code >= 0x70 && vk_code <= 0x7b) return functionKeyCode(vk_code);
  return "Scan" + std::to_string(scan_code);
}

std::string labelForCode(const std::string& code, std::uint32_t vk_code) {
  if (vk_code >= 0x41 && vk_code <= 0x5a) return std::string(1, static_cast<char>(vk_code));
  if (vk_code >= 0x30 && vk_code <= 0x39) return std::string(1, static_cast<char>(vk_code));

  if (code == "ControlLeft") return "Left Ctrl";
  if (code == "ControlRight") return "Right Ctrl";
  if (code == "AltLeft") return "Left Alt";
  if (code == "AltRight") return "Right Alt";
  if (code == "ShiftLeft") return "Left Shift";
  if (code == "ShiftRight") return "Right Shift";
  if (code == "MetaLeft") return "Left Meta";
  if (code == "MetaRight") return "Right Meta";
  if (code == "Space") return "Space";
  if (code == "Escape") return "Esc";
  return code;
}

}  // namespace syrnike::hotkeys
