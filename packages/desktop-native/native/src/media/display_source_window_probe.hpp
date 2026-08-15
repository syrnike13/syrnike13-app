#pragma once

#include <windows.h>

#include <chrono>
#include <cstdint>

namespace syrnike::desktop_native::media {

struct WindowMessageIconResult {
  bool delivered = false;
  std::uintptr_t icon = 0;
};

inline constexpr auto kWindowIconMessageTimeout =
    std::chrono::milliseconds(10);

struct DisplayWindowProbeFacts {
  bool visible = false;
  bool root_window = false;
  bool excluded = false;
  bool cloaked = false;
  bool tool_window = false;
  bool no_activate = false;
  bool has_bounds = false;
  int width = 0;
  int height = 0;
  bool has_title = false;
};

inline bool shouldIncludeDisplayWindow(
    const DisplayWindowProbeFacts& facts) noexcept {
  return facts.visible && facts.root_window && !facts.excluded &&
      !facts.cloaked && !facts.tool_window && !facts.no_activate &&
      facts.has_bounds && facts.width >= 80 && facts.height >= 80 &&
      facts.has_title;
}

template <typename SendMessage>
std::uintptr_t queryWindowMessageIcon(SendMessage&& send_message) {
  const auto small2 = send_message(ICON_SMALL2, kWindowIconMessageTimeout);
  if (!small2.delivered) return 0;
  if (small2.icon != 0) return small2.icon;
  const auto small_icon = send_message(ICON_SMALL, kWindowIconMessageTimeout);
  return small_icon.delivered ? small_icon.icon : 0;
}

}  // namespace syrnike::desktop_native::media
