#include "input_state.hpp"
#include "key_codes.hpp"
#include "protocol.hpp"

#include <windows.h>

#include <iostream>
#include <mutex>
#include <optional>
#include <string>

namespace {

syrnike::hotkeys::InputState g_input_state;
std::mutex g_input_state_mutex;
HHOOK g_keyboard_hook = nullptr;
HHOOK g_mouse_hook = nullptr;

void emitEvent(const syrnike::hotkeys::NativeInputEvent& event) {
  std::cout << syrnike::hotkeys::eventToJson(event) << std::endl;
}

void applyInputTransition(
  bool down,
  const std::string& source,
  const std::string& code,
  const std::string& label
) {
  std::optional<syrnike::hotkeys::NativeInputEvent> event;
  {
    std::lock_guard lock(g_input_state_mutex);
    event = down
      ? g_input_state.applyDown(source, code, label)
      : g_input_state.applyUp(source, code, label);
  }

  if (event.has_value()) emitEvent(*event);
}

LRESULT CALLBACK keyboardProc(int code, WPARAM wparam, LPARAM lparam) {
  if (code == HC_ACTION) {
    const auto* info = reinterpret_cast<const KBDLLHOOKSTRUCT*>(lparam);
    if (!syrnike::hotkeys::isInjectedKeyEvent(info->flags)) {
      const auto message = static_cast<UINT>(wparam);
      const bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
      const bool up = message == WM_KEYUP || message == WM_SYSKEYUP;

      if (down || up) {
        const auto key_code = syrnike::hotkeys::keyboardCode(
          info->vkCode,
          info->scanCode,
          info->flags
        );
        const auto label = syrnike::hotkeys::labelForCode(key_code, info->vkCode);
        applyInputTransition(down, "keyboard", key_code, label);
      }
    }
  }

  return CallNextHookEx(nullptr, code, wparam, lparam);
}

std::optional<std::string> mouseCode(UINT message, DWORD mouse_data) {
  if (message == WM_MBUTTONDOWN || message == WM_MBUTTONUP) return "Mouse3";

  if (message != WM_XBUTTONDOWN && message != WM_XBUTTONUP) return std::nullopt;
  const auto xbutton = HIWORD(mouse_data);
  if (xbutton == XBUTTON1) return "Mouse4";
  if (xbutton == XBUTTON2) return "Mouse5";
  return std::nullopt;
}

LRESULT CALLBACK mouseProc(int code, WPARAM wparam, LPARAM lparam) {
  if (code == HC_ACTION) {
    const auto message = static_cast<UINT>(wparam);
    const auto* info = reinterpret_cast<const MSLLHOOKSTRUCT*>(lparam);
    if (syrnike::hotkeys::isInjectedMouseEvent(info->flags)) {
      return CallNextHookEx(nullptr, code, wparam, lparam);
    }

    const auto button_code = mouseCode(message, info->mouseData);

    if (button_code.has_value()) {
      const bool down = message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN;
      applyInputTransition(down, "mouse", *button_code, *button_code);
    }
  }

  return CallNextHookEx(nullptr, code, wparam, lparam);
}

class HookGuard {
 public:
  ~HookGuard() {
    if (g_keyboard_hook) UnhookWindowsHookEx(g_keyboard_hook);
    if (g_mouse_hook) UnhookWindowsHookEx(g_mouse_hook);
  }
};

}  // namespace

int main() {
  const HINSTANCE instance = GetModuleHandleW(nullptr);
  g_keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, keyboardProc, instance, 0);
  g_mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, mouseProc, instance, 0);
  HookGuard hook_guard;

  if (!g_keyboard_hook || !g_mouse_hook) {
    std::cerr << "failed to install low level hooks" << std::endl;
    return 1;
  }

  MSG message;
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  return 0;
}
