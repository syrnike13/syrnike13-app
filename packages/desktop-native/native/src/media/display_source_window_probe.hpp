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

template <typename SendMessage>
std::uintptr_t queryWindowMessageIcon(SendMessage&& send_message) {
  const auto small2 = send_message(ICON_SMALL2, kWindowIconMessageTimeout);
  if (!small2.delivered) return 0;
  if (small2.icon != 0) return small2.icon;
  const auto small_icon = send_message(ICON_SMALL, kWindowIconMessageTimeout);
  return small_icon.delivered ? small_icon.icon : 0;
}

}  // namespace syrnike::desktop_native::media
