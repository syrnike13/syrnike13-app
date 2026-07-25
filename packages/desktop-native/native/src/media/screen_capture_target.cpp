#include "screen_video_capture.hpp"

#include <algorithm>
#include <cmath>
#include <iterator>
#include <stdexcept>
#include <vector>

namespace syrnike::voice {
namespace {

struct EnumeratedMonitor {
  HMONITOR handle = nullptr;
  ScreenMonitorIdentity identity;
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

std::vector<EnumeratedMonitor> monitors() {
  std::vector<EnumeratedMonitor> result;
  EnumDisplayMonitors(
      nullptr,
      nullptr,
      [](HMONITOR monitor, HDC, LPRECT, LPARAM data) -> BOOL {
        auto* out =
            reinterpret_cast<std::vector<EnumeratedMonitor>*>(data);
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
        out->push_back({
            monitor,
            {info.rcMonitor, utf8(device_id)},
        });
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

  const auto current = monitors();
  std::vector<ScreenMonitorIdentity> identities;
  identities.reserve(current.size());
  std::transform(
      current.begin(),
      current.end(),
      std::back_inserter(identities),
      [](const EnumeratedMonitor& monitor) {
        return monitor.identity;
      });
  return resolveScreenMonitorTarget(source_id, identities);
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
    const auto& selected = available[static_cast<std::size_t>(index - 1)];
    target.rect = selected.rect;
    target.monitor_device_id = selected.device_id;
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
  target.monitor_device_id = found->device_id;
  return target;
}

bool screenMonitorTargetMatches(
    const ScreenCaptureTarget& target,
    const ScreenMonitorIdentity& monitor) noexcept {
  if (target.window) return false;
  if (!target.monitor_device_id.empty()) {
    return _stricmp(
        target.monitor_device_id.c_str(),
        monitor.device_id.c_str()) == 0;
  }
  return EqualRect(&target.rect, &monitor.rect) != FALSE;
}

HMONITOR resolveScreenMonitorHandle(const ScreenCaptureTarget& target) {
  if (target.window) return nullptr;
  const auto current = monitors();
  const auto found = std::find_if(
      current.begin(),
      current.end(),
      [&](const EnumeratedMonitor& monitor) {
        return screenMonitorTargetMatches(target, monitor.identity);
      });
  return found == current.end() ? nullptr : found->handle;
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
