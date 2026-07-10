#include "hooks_runtime.hpp"

#include <dwmapi.h>
#include <tlhelp32.h>
#include <windows.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>

#include "input_state.hpp"
#include "key_codes.hpp"

namespace syrnike::desktop_native::hooks {
namespace {

using syrnike::hotkeys::InputState;
using syrnike::hotkeys::NativeInputEvent;

class HotkeyActor;
thread_local HotkeyActor* current_hotkey_actor = nullptr;

class HotkeyActor {
 public:
  explicit HotkeyActor(SequencedEmitter& emitter) : emitter_(emitter) {}
  ~HotkeyActor() { stop(); }

  bool start(NativeError& error) {
    std::thread completed_thread;
    {
      std::lock_guard lock(lifecycle_mutex_);
      if (thread_.joinable() && installed_) return true;
      if (thread_.joinable()) completed_thread = std::move(thread_);
    }
    if (completed_thread.joinable()) completed_thread.join();

    std::unique_lock lock(lifecycle_mutex_);
    input_state_.reset();
    startup_complete_ = false;
    installed_ = false;
    stop_requested_ = false;
    thread_id_ = 0;
    thread_ = std::thread([this] { run(); });
    const bool started = startup_ready_.wait_for(
      lock,
      std::chrono::seconds(2),
      [&] { return startup_complete_; }
    );
    if (started && installed_) return true;
    error = NativeError{
      "hook_install_failed",
      startup_complete_ ? "Windows rejected the low-level input hooks" : "Input hook startup timed out",
      "startHotkeys",
      false,
    };
    lock.unlock();
    stop();
    return false;
  }

  void stop() {
    DWORD thread_id = 0;
    std::thread active_thread;
    {
      std::lock_guard lock(lifecycle_mutex_);
      stop_requested_ = true;
      thread_id = thread_id_;
      if (thread_.joinable()) active_thread = std::move(thread_);
    }
    if (thread_id != 0) PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
    if (active_thread.joinable()) active_thread.join();
    std::lock_guard lock(lifecycle_mutex_);
    thread_id_ = 0;
    installed_ = false;
    startup_complete_ = false;
    input_state_.reset();
  }

 private:
  static LRESULT CALLBACK keyboardProc(int code, WPARAM wparam, LPARAM lparam) {
    if (current_hotkey_actor) current_hotkey_actor->handleKeyboard(code, wparam, lparam);
    return CallNextHookEx(nullptr, code, wparam, lparam);
  }

  static LRESULT CALLBACK mouseProc(int code, WPARAM wparam, LPARAM lparam) {
    if (current_hotkey_actor) current_hotkey_actor->handleMouse(code, wparam, lparam);
    return CallNextHookEx(nullptr, code, wparam, lparam);
  }

  static HMODULE moduleHandle() {
    HMODULE module = nullptr;
    GetModuleHandleExW(
      GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
      reinterpret_cast<LPCWSTR>(&HotkeyActor::keyboardProc),
      &module
    );
    return module;
  }

  static std::optional<std::string> mouseCode(UINT message, DWORD mouse_data) {
    if (message == WM_MBUTTONDOWN || message == WM_MBUTTONUP) return "Mouse3";
    if (message != WM_XBUTTONDOWN && message != WM_XBUTTONUP) return std::nullopt;
    const auto button = HIWORD(mouse_data);
    if (button == XBUTTON1) return "Mouse4";
    if (button == XBUTTON2) return "Mouse5";
    return std::nullopt;
  }

  void handleKeyboard(int code, WPARAM wparam, LPARAM lparam) {
    if (code != HC_ACTION) return;
    const auto* info = reinterpret_cast<const KBDLLHOOKSTRUCT*>(lparam);
    if (syrnike::hotkeys::isInjectedKeyEvent(info->flags)) return;
    const auto message = static_cast<UINT>(wparam);
    const bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
    const bool up = message == WM_KEYUP || message == WM_SYSKEYUP;
    if (!down && !up) return;
    const auto key_code = syrnike::hotkeys::keyboardCode(
      info->vkCode,
      info->scanCode,
      info->flags
    );
    applyTransition(
      down,
      "keyboard",
      key_code,
      syrnike::hotkeys::labelForCode(key_code, info->vkCode)
    );
  }

  void handleMouse(int code, WPARAM wparam, LPARAM lparam) {
    if (code != HC_ACTION) return;
    const auto* info = reinterpret_cast<const MSLLHOOKSTRUCT*>(lparam);
    if (syrnike::hotkeys::isInjectedMouseEvent(info->flags)) return;
    const auto message = static_cast<UINT>(wparam);
    const auto button = mouseCode(message, info->mouseData);
    if (!button) return;
    const bool down = message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN;
    applyTransition(down, "mouse", *button, *button);
  }

  void applyTransition(
    bool down,
    const std::string& source,
    const std::string& code,
    const std::string& label
  ) {
    const auto event = down
      ? input_state_.applyDown(source, code, label)
      : input_state_.applyUp(source, code, label);
    if (!event) return;
    RuntimeEvent runtime_event;
    runtime_event.type = "input";
    runtime_event.input = InputEvent{
      event->type,
      event->source,
      event->code,
      event->label,
      event->pressed_codes,
    };
    emitter_.emit(std::move(runtime_event));
  }

  void run() {
    current_hotkey_actor = this;
    MSG queue_message{};
    PeekMessageW(&queue_message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
    const auto thread_id = GetCurrentThreadId();
    {
      std::lock_guard lock(lifecycle_mutex_);
      thread_id_ = thread_id;
      if (stop_requested_) {
        startup_complete_ = true;
      }
    }
    startup_ready_.notify_all();
    {
      std::lock_guard lock(lifecycle_mutex_);
      if (stop_requested_) {
        current_hotkey_actor = nullptr;
        thread_id_ = 0;
        return;
      }
    }

    const auto module = moduleHandle();
    HHOOK keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, keyboardProc, module, 0);
    HHOOK mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, mouseProc, module, 0);
    bool should_stop = false;
    {
      std::lock_guard lock(lifecycle_mutex_);
      installed_ = keyboard_hook != nullptr && mouse_hook != nullptr;
      startup_complete_ = true;
      should_stop = stop_requested_;
    }
    startup_ready_.notify_all();

    int message_result = 1;
    if (keyboard_hook && mouse_hook && !should_stop) {
      MSG message{};
      while ((message_result = GetMessageW(&message, nullptr, 0, 0)) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
      }
    }

    if (keyboard_hook) UnhookWindowsHookEx(keyboard_hook);
    if (mouse_hook) UnhookWindowsHookEx(mouse_hook);
    bool unexpected_exit = false;
    {
      std::lock_guard lock(lifecycle_mutex_);
      unexpected_exit = keyboard_hook && mouse_hook && !stop_requested_ && message_result <= 0;
      installed_ = false;
      thread_id_ = 0;
    }
    current_hotkey_actor = nullptr;
    if (unexpected_exit) {
      RuntimeEvent event;
      event.type = "runtimeError";
      event.error = NativeError{
        "hotkey_loop_stopped",
        message_result < 0
          ? "Windows input hook message loop failed"
          : "Windows input hook message loop stopped unexpectedly",
        "hotkeys",
        true,
      };
      emitter_.emit(std::move(event));
      std::terminate();
    }
  }

  SequencedEmitter& emitter_;
  InputState input_state_;
  std::mutex lifecycle_mutex_;
  std::condition_variable startup_ready_;
  std::thread thread_;
  DWORD thread_id_ = 0;
  bool startup_complete_ = false;
  bool installed_ = false;
  bool stop_requested_ = false;
};

std::string utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(
    CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr
  );
  if (size <= 0) return {};
  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(
    CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr
  );
  return result;
}

std::wstring windowText(HWND hwnd) {
  const int length = GetWindowTextLengthW(hwnd);
  if (length <= 0) return {};
  std::wstring result(static_cast<std::size_t>(length) + 1, L'\0');
  const int copied = GetWindowTextW(hwnd, result.data(), length + 1);
  result.resize(copied > 0 ? static_cast<std::size_t>(copied) : 0);
  return result;
}

std::wstring className(HWND hwnd) {
  wchar_t buffer[256]{};
  const int copied = GetClassNameW(hwnd, buffer, static_cast<int>(std::size(buffer)));
  return copied > 0 ? std::wstring(buffer, static_cast<std::size_t>(copied)) : std::wstring{};
}

std::wstring processPath(DWORD process_id) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
  if (!process) return {};
  wchar_t buffer[32768]{};
  DWORD size = static_cast<DWORD>(std::size(buffer));
  std::wstring result;
  if (QueryFullProcessImageNameW(process, 0, buffer, &size)) result.assign(buffer, size);
  CloseHandle(process);
  return result;
}

std::string processNameFromSnapshot(DWORD process_id) {
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return {};
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  std::string result;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == process_id) {
        result = utf8(entry.szExeFile);
        break;
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return result;
}

Rect windowBounds(HWND hwnd) {
  RECT rect{};
  if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &rect, sizeof(rect)))) {
    GetWindowRect(hwnd, &rect);
  }
  return Rect{rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top};
}

Rect monitorBounds(HWND hwnd) {
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  const auto monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  if (!GetMonitorInfoW(monitor, &info)) return {};
  return Rect{
    info.rcMonitor.left,
    info.rcMonitor.top,
    info.rcMonitor.right - info.rcMonitor.left,
    info.rcMonitor.bottom - info.rcMonitor.top,
  };
}

bool fullscreenLike(const Rect& window, const Rect& monitor) {
  if (window.width <= 0 || window.height <= 0 || monitor.width <= 0 || monitor.height <= 0) {
    return false;
  }
  return window.width >= static_cast<int>(monitor.width * 0.85) &&
    window.height >= static_cast<int>(monitor.height * 0.85) &&
    window.x <= monitor.x + static_cast<int>(monitor.width * 0.08) &&
    window.y <= monitor.y + static_cast<int>(monitor.height * 0.08);
}

ForegroundWindow readForegroundWindow() {
  const HWND hwnd = GetForegroundWindow();
  if (!hwnd || !IsWindow(hwnd)) return {};
  DWORD process_id = 0;
  GetWindowThreadProcessId(hwnd, &process_id);
  const auto path = processPath(process_id);
  auto process_name = path.empty()
    ? processNameFromSnapshot(process_id)
    : utf8(std::filesystem::path(path).filename().wstring());
  const auto bounds = windowBounds(hwnd);
  const auto monitor = monitorBounds(hwnd);
  const bool visible = IsWindowVisible(hwnd) && bounds.width > 0 && bounds.height > 0;
  return ForegroundWindow{
    process_id,
    std::move(process_name),
    path.empty() ? std::nullopt : std::optional<std::string>(utf8(path)),
    utf8(windowText(hwnd)),
    utf8(className(hwnd)),
    visible,
    visible && fullscreenLike(bounds, monitor),
    bounds,
  };
}

class OverlayActor {
 public:
  explicit OverlayActor(SequencedEmitter& emitter) : emitter_(emitter) {}
  ~OverlayActor() { stop(); }

  void start() {
    std::lock_guard lock(lifecycle_mutex_);
    if (thread_.joinable()) return;
    stopping_ = false;
    thread_ = std::thread([this] { run(); });
  }

  void stop() {
    {
      std::lock_guard lock(lifecycle_mutex_);
      stopping_ = true;
    }
    wake_.notify_all();
    if (thread_.joinable()) thread_.join();
  }

 private:
  void run() {
    ForegroundWindow last;
    bool has_last = false;
    while (true) {
      {
        std::lock_guard lock(lifecycle_mutex_);
        if (stopping_) break;
      }
      ForegroundWindow current;
      try {
        current = readForegroundWindow();
      } catch (...) {
        current = {};
      }
      if (!has_last || !(current == last)) {
        RuntimeEvent event;
        event.type = "foregroundWindow";
        event.foreground_window = current;
        emitter_.emit(std::move(event));
        last = std::move(current);
        has_last = true;
      }
      std::unique_lock lock(lifecycle_mutex_);
      if (wake_.wait_for(lock, std::chrono::milliseconds(250), [&] { return stopping_; })) break;
    }
  }

  SequencedEmitter& emitter_;
  std::mutex lifecycle_mutex_;
  std::condition_variable wake_;
  std::thread thread_;
  bool stopping_ = false;
};

RuntimeEvent successfulReply(const HooksCommand& command) {
  RuntimeEvent event;
  event.type = "reply";
  event.request_id = command.request_id;
  event.ok = true;
  return event;
}

RuntimeEvent failedReply(const HooksCommand& command, NativeError error) {
  RuntimeEvent event;
  event.type = "reply";
  event.request_id = command.request_id;
  event.ok = false;
  event.error = std::move(error);
  return event;
}

}  // namespace

class HooksRuntime::Implementation {
 public:
  explicit Implementation(EventSinkPtr sink)
    : emitter_(std::move(sink)), hotkeys_(emitter_), overlay_(emitter_), worker_([this] { run(); }) {}

  ~Implementation() { shutdownAndWait(); }

  bool dispatch(HooksCommand command) {
    if (shutting_down_.load()) return false;
    const bool is_shutdown = command.type == "shutdown";
    if (is_shutdown && shutting_down_.exchange(true)) return false;
    if (is_shutdown) {
      {
        std::lock_guard lock(shutdown_command_mutex_);
        shutdown_command_ = std::move(command);
      }
      commands_.closeAndDiscard();
      return true;
    }
    if (commands_.tryPush(std::move(command))) return true;
    if (is_shutdown) shutting_down_.store(false);
    return false;
  }

  void requestShutdown() {
    shutting_down_.store(true);
    commands_.closeAndDiscard();
  }

  void shutdownAndWait() {
    std::lock_guard lock(shutdown_mutex_);
    requestShutdown();
    if (worker_.joinable() && worker_.get_id() != std::this_thread::get_id()) worker_.join();
  }

 private:
  void runtimeError(NativeError error) {
    RuntimeEvent event;
    event.type = "runtimeError";
    event.error = std::move(error);
    emitter_.emit(std::move(event));
  }

  bool handle(const HooksCommand& command) {
    try {
      if (command.type == "startHotkeys") {
        NativeError error;
        if (!hotkeys_.start(error)) {
          emitter_.emit(failedReply(command, error));
          runtimeError(std::move(error));
        } else {
          emitter_.emit(successfulReply(command));
        }
        return true;
      }
      if (command.type == "stopHotkeys") {
        hotkeys_.stop();
        emitter_.emit(successfulReply(command));
        return true;
      }
      if (command.type == "startOverlay") {
        overlay_.start();
        emitter_.emit(successfulReply(command));
        return true;
      }
      if (command.type == "stopOverlay") {
        overlay_.stop();
        emitter_.emit(successfulReply(command));
        return true;
      }
      emitter_.emit(failedReply(command, NativeError{
        "unknown_command", "Unknown hooks runtime command: " + command.type, "dispatch", false,
      }));
    } catch (const std::exception& error) {
      NativeError native_error{"hooks_command_failed", error.what(), command.type, true};
      emitter_.emit(failedReply(command, native_error));
      runtimeError(std::move(native_error));
    }
    return true;
  }

  void run() {
    while (const auto command = commands_.waitPop()) {
      if (!handle(*command)) break;
    }
    hotkeys_.stop();
    overlay_.stop();
    std::optional<HooksCommand> shutdown_command;
    {
      std::lock_guard lock(shutdown_command_mutex_);
      shutdown_command = std::move(shutdown_command_);
    }
    if (shutdown_command) emitter_.emit(successfulReply(*shutdown_command));
  }

  SequencedEmitter emitter_;
  HotkeyActor hotkeys_;
  OverlayActor overlay_;
  BoundedQueue<HooksCommand, 256> commands_;
  std::thread worker_;
  std::mutex shutdown_mutex_;
  std::mutex shutdown_command_mutex_;
  std::optional<HooksCommand> shutdown_command_;
  std::atomic_bool shutting_down_{false};
};

HooksRuntime::HooksRuntime(EventSinkPtr sink)
  : implementation_(std::make_unique<Implementation>(std::move(sink))) {}

HooksRuntime::~HooksRuntime() = default;

bool HooksRuntime::dispatch(HooksCommand command) {
  return implementation_->dispatch(std::move(command));
}

void HooksRuntime::requestShutdown() {
  implementation_->requestShutdown();
}

void HooksRuntime::shutdownAndWait() {
  implementation_->shutdownAndWait();
}

}  // namespace syrnike::desktop_native::hooks
