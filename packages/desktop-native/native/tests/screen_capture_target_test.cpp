#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>

#include "media/screen_video_capture.hpp"

namespace {

void requireSize(const RECT rect, std::uint32_t preset_width,
                 std::uint32_t preset_height, std::uint32_t expected_width,
                 std::uint32_t expected_height) {
  syrnike::voice::ScreenCaptureTarget target;
  target.rect = rect;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  syrnike::voice::resolveScreenCaptureSize(target, preset_width, preset_height,
                                           width, height);
  if (width != expected_width || height != expected_height) {
    throw std::runtime_error(
        "unexpected screen capture size: " + std::to_string(width) + "x" +
        std::to_string(height));
  }
}

} // namespace

int main() try {
  // A preset is an upper bound. Targets below it keep their native size.
  requireSize({0, 0, 1280, 720}, 1920, 1080, 1280, 720);
  requireSize({100, 200, 1762, 1280}, 1920, 1080, 1662, 1080);

  // Larger targets are fitted inside the preset without changing aspect ratio.
  requireSize({0, 0, 2560, 1440}, 1920, 1080, 1920, 1080);
  requireSize({0, 0, 2560, 1080}, 1920, 1080, 1920, 810);
  requireSize({0, 0, 1080, 1920}, 1920, 1080, 608, 1080);

  // NV12 requires even dimensions, so odd target/preset edges round down only.
  requireSize({0, 0, 1663, 1081}, 1920, 1080, 1660, 1080);
  requireSize({0, 0, 2560, 1440}, 1919, 1079, 1918, 1078);

  std::cout << "screen capture preset-bound sizing tests passed\n";
  return 0;
} catch (const std::exception &error) {
  std::cerr << error.what() << '\n';
  return 1;
}
