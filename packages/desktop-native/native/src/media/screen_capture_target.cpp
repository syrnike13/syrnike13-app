#include "screen_video_capture.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <vector>

namespace syrnike::voice {
namespace {

std::vector<RECT> monitorRects() {
  std::vector<RECT> rects;
  EnumDisplayMonitors(
      nullptr,
      nullptr,
      [](HMONITOR monitor, HDC, LPRECT, LPARAM data) -> BOOL {
        auto* out = reinterpret_cast<std::vector<RECT>*>(data);
        MONITORINFOEXW info{};
        info.cbSize = sizeof(info);
        if (GetMonitorInfoW(monitor, &info)) out->push_back(info.rcMonitor);
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&rects));
  return rects;
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

  const auto rects = monitorRects();
  const int index = parseIndex(source_id, "screen:");
  if (index <= 0 || index > static_cast<int>(rects.size())) {
    throw std::runtime_error("selected screen is no longer available");
  }
  target.screen_index = index;
  target.rect = rects[static_cast<std::size_t>(index - 1)];
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
