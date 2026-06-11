#include <dwmapi.h>
#include <tlhelp32.h>
#include <windows.h>

#include <chrono>
#include <exception>
#include <filesystem>
#include <iostream>
#include <iterator>
#include <string>
#include <thread>

namespace {

struct Rect {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;
};

std::string utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(
    CP_UTF8,
    0,
    value.data(),
    static_cast<int>(value.size()),
    nullptr,
    0,
    nullptr,
    nullptr
  );
  if (size <= 0) return {};

  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(
    CP_UTF8,
    0,
    value.data(),
    static_cast<int>(value.size()),
    result.data(),
    size,
    nullptr,
    nullptr
  );
  return result;
}

std::string jsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (const char ch : value) {
    switch (ch) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
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
        if (static_cast<unsigned char>(ch) < 0x20) {
          out += ' ';
        } else {
          out += ch;
        }
    }
  }
  return out;
}

std::wstring windowText(HWND hwnd) {
  const int length = GetWindowTextLengthW(hwnd);
  if (length <= 0) return {};
  std::wstring text(static_cast<std::size_t>(length), L'\0');
  GetWindowTextW(hwnd, text.data(), length + 1);
  return text;
}

std::wstring className(HWND hwnd) {
  wchar_t buffer[256] = {};
  GetClassNameW(hwnd, buffer, static_cast<int>(std::size(buffer)));
  return buffer;
}

std::wstring processPath(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return {};

  wchar_t buffer[MAX_PATH * 4] = {};
  DWORD size = static_cast<DWORD>(std::size(buffer));
  std::wstring result;
  if (QueryFullProcessImageNameW(process, 0, buffer, &size)) {
    result.assign(buffer, size);
  }
  CloseHandle(process);
  return result;
}

std::string processName(const std::wstring& full_path) {
  if (full_path.empty()) return {};
  return utf8(std::filesystem::path(full_path).filename().wstring());
}

std::string processNameFromSnapshot(DWORD pid) {
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return {};

  PROCESSENTRY32W entry = {};
  entry.dwSize = sizeof(entry);
  std::string result;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == pid) {
        result = utf8(entry.szExeFile);
        break;
      }
    } while (Process32NextW(snapshot, &entry));
  }

  CloseHandle(snapshot);
  return result;
}

Rect windowBounds(HWND hwnd) {
  RECT rect = {};
  if (FAILED(DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &rect,
        sizeof(rect)
      ))) {
    GetWindowRect(hwnd, &rect);
  }

  return Rect{
    rect.left,
    rect.top,
    rect.right - rect.left,
    rect.bottom - rect.top,
  };
}

Rect monitorBounds(HWND hwnd) {
  MONITORINFO info = {};
  info.cbSize = sizeof(info);
  const HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  if (!GetMonitorInfoW(monitor, &info)) return {};

  return Rect{
    info.rcMonitor.left,
    info.rcMonitor.top,
    info.rcMonitor.right - info.rcMonitor.left,
    info.rcMonitor.bottom - info.rcMonitor.top,
  };
}

bool isFullscreenLike(const Rect& window, const Rect& monitor) {
  if (window.width <= 0 || window.height <= 0) return false;
  if (monitor.width <= 0 || monitor.height <= 0) return false;

  const bool covers_width = window.width >= static_cast<int>(monitor.width * 0.85);
  const bool covers_height = window.height >= static_cast<int>(monitor.height * 0.85);
  const bool near_x = window.x <= monitor.x + static_cast<int>(monitor.width * 0.08);
  const bool near_y = window.y <= monitor.y + static_cast<int>(monitor.height * 0.08);
  return covers_width && covers_height && near_x && near_y;
}

std::string emptyEvent() {
  return "{\"pid\":0,\"processName\":\"\",\"processPath\":null,\"title\":\"\","
         "\"className\":\"\",\"visible\":false,\"fullscreenLike\":false,"
         "\"bounds\":{\"x\":0,\"y\":0,\"width\":0,\"height\":0}}";
}

std::string foregroundEvent() {
  const HWND hwnd = GetForegroundWindow();
  if (!hwnd || !IsWindow(hwnd)) return emptyEvent();

  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);

  const auto path = processPath(pid);
  const auto path_name = processName(path);
  const auto name = path_name.empty() ? processNameFromSnapshot(pid) : path_name;
  const auto bounds = windowBounds(hwnd);
  const auto monitor = monitorBounds(hwnd);
  const bool visible = IsWindowVisible(hwnd) && bounds.width > 0 && bounds.height > 0;
  const bool fullscreen_like = visible && isFullscreenLike(bounds, monitor);

  return "{\"pid\":" + std::to_string(pid) +
         ",\"processName\":\"" + jsonEscape(name) +
         "\",\"processPath\":" +
         (path.empty() ? "null" : ("\"" + jsonEscape(utf8(path)) + "\"")) +
         ",\"title\":\"" + jsonEscape(utf8(windowText(hwnd))) +
         "\",\"className\":\"" + jsonEscape(utf8(className(hwnd))) +
         "\",\"visible\":" + (visible ? "true" : "false") +
         ",\"fullscreenLike\":" + (fullscreen_like ? "true" : "false") +
         ",\"bounds\":{\"x\":" + std::to_string(bounds.x) +
         ",\"y\":" + std::to_string(bounds.y) +
         ",\"width\":" + std::to_string(bounds.width) +
         ",\"height\":" + std::to_string(bounds.height) + "}}";
}

}  // namespace

int main() {
  std::string last_event;
  while (true) {
    std::string event;
    try {
      event = foregroundEvent();
    } catch (const std::exception& error) {
      std::cerr << "[overlay-detector] foreground poll failed: "
                << error.what() << std::endl;
      event = emptyEvent();
    } catch (...) {
      std::cerr << "[overlay-detector] foreground poll failed" << std::endl;
      event = emptyEvent();
    }
    if (event != last_event) {
      std::cout << event << std::endl;
      last_event = event;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
}
