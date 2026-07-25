#include <chrono>
#include <cstddef>
#include <iostream>
#include <stdexcept>

#include <windows.h>

#include "media/display_source_window_probe.hpp"

int main() try {
  using namespace std::chrono_literals;
  using syrnike::desktop_native::media::WindowMessageIconResult;
  using syrnike::desktop_native::media::queryWindowMessageIcon;

  constexpr std::size_t synthetic_windows = 30;
  auto virtual_elapsed = 0ms;
  std::size_t calls = 0;
  const auto wall_started = std::chrono::steady_clock::now();
  for (std::size_t index = 0; index < synthetic_windows; ++index) {
    const auto icon = queryWindowMessageIcon(
        [&](std::uintptr_t, std::chrono::milliseconds timeout) {
          ++calls;
          virtual_elapsed += timeout;
          return WindowMessageIconResult{false, 0};
        });
    if (icon != 0) {
      throw std::runtime_error("hung synthetic window returned an icon");
    }
  }
  const auto wall_elapsed = std::chrono::steady_clock::now() - wall_started;
  if (calls != synthetic_windows || virtual_elapsed != 300ms ||
      virtual_elapsed >= 500ms || wall_elapsed >= 500ms) {
    throw std::runtime_error(
        "30 hung windows exceeded the listDisplaySources icon budget");
  }

  std::cout << "display source hung-window budget test passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
