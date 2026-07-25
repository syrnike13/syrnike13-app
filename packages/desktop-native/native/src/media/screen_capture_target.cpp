#include "screen_video_capture.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <vector>

namespace syrnike::voice {
namespace {

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
      nullptr);
  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(
      CP_UTF8,
      0,
      value.data(),
      static_cast<int>(value.size()),
      result.data(),
      size,
      nullptr,
      nullptr);
  return result;
}

std::vector<ScreenMonitorIdentity> monitors() {
  std::vector<ScreenMonitorIdentity> result;
  EnumDisplayMonitors(
      nullptr,
      nullptr,
      [](HMONITOR monitor, HDC, LPRECT, LPARAM data) -> BOOL {
        auto* out =
            reinterpret_cast<std::vector<ScreenMonitorIdentity>*>(data);
        MONITORINFOEXW info{};
        info.cbSize = sizeof(info);
        if (!GetMonitorInfoW(monitor, &info)) return TRUE;
        DISPLAY_DEVICEW display{};
        display.cb = sizeof(display);
        std::wstring device_id(info.szDevice);
        if (EnumDisplayDevicesW(
                info.szDevice,
                0,
                &display,
                EDD_GET_DEVICE_INTERFACE_NAME) &&
            display.DeviceID[0] != L'\0') {
          device_id = display.DeviceID;
        }
        out->push_back({info.rcMonitor, utf8(device_id)});
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&result));
  return result;
}

int parseIndex(const std::string& value, const std::string& prefix) {
  if (value.rfind(prefix, 0) != 0) return 0;
  try {
    return std::stoi(value.substr(prefix.size()));
  } catch (...) {
    return 0;
  }
}

HWND parseWindowHandle(const std::string& source_id) {
  const bool window = source_id.rfind("window:", 0) == 0;
  const bool game = source_id.rfind("game:", 0) == 0;
  if (!window && !game) return nullptr;
  try {
    const auto raw = static_cast<std::uintptr_t>(
        std::stoull(source_id.substr(window ? 7 : 5)));
    return reinterpret_cast<HWND>(raw);
  } catch (...) {
    return nullptr;
  }
}

std::uint32_t evenDimension(std::uint32_t value) {
  return std::max(2U, value & ~1U);
}

}  // namespace

ScreenCaptureTarget resolveScreenCaptureTarget(const std::string& source_id) {
  ScreenCaptureTarget target;
  if (source_id.rfind("window:", 0) == 0 || source_id.rfind("game:", 0) == 0) {
    target.window = true;
    target.hwnd = parseWindowHandle(source_id);
    if (!target.hwnd || !IsWindow(target.hwnd) ||
        !GetWindowRect(target.hwnd, &target.rect)) {
      throw std::runtime_error("selected window is no longer available");
    }
    GetWindowThreadProcessId(target.hwnd, &target.process_id);
    return target;
  }

  return resolveScreenMonitorTarget(source_id, monitors());
}

ScreenCaptureTarget resolveScreenMonitorTarget(
    const std::string& source_id,
    std::span<const ScreenMonitorIdentity> available) {
  ScreenCaptureTarget target;
  const auto requested = source_id.rfind("screen:", 0) == 0
      ? source_id.substr(7)
      : std::string{};
  const bool legacy_index = !requested.empty() &&
      std::all_of(requested.begin(), requested.end(), [](unsigned char value) {
        return value >= '0' && value <= '9';
      });
  if (legacy_index) {
    const int index = parseIndex(source_id, "screen:");
    if (index <= 0 || index > static_cast<int>(available.size())) {
      throw std::runtime_error("selected screen is no longer available");
    }
    target.screen_index = index;
    target.rect = available[static_cast<std::size_t>(index - 1)].rect;
    return target;
  }
  const auto found = std::find_if(
      available.begin(), available.end(), [&](const ScreenMonitorIdentity& monitor) {
        return _stricmp(monitor.device_id.c_str(), requested.c_str()) == 0;
      });
  if (found == available.end()) {
    throw std::runtime_error("selected screen is no longer available");
  }
  target.screen_index =
      static_cast<int>(std::distance(available.begin(), found)) + 1;
  target.rect = found->rect;
  return target;
}

void resolveScreenCaptureSize(
    const ScreenCaptureTarget& target,
    std::uint32_t max_width,
    std::uint32_t max_height,
    std::uint32_t& width,
    std::uint32_t& height) {
  const auto source_width = static_cast<std::uint32_t>(
      std::max(1L, target.rect.right - target.rect.left));
  const auto source_height = static_cast<std::uint32_t>(
      std::max(1L, target.rect.bottom - target.rect.top));
  max_width = std::max(2U, max_width);
  max_height = std::max(2U, max_height);
  const double scale = std::min({
      1.0,
      static_cast<double>(max_width) / source_width,
      static_cast<double>(max_height) / source_height,
  });
  width = evenDimension(static_cast<std::uint32_t>(std::round(source_width * scale)));
  height = evenDimension(static_cast<std::uint32_t>(std::round(source_height * scale)));
}

}  // namespace syrnike::voice
