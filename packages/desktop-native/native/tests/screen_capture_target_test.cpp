#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

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

  const std::vector<syrnike::voice::ScreenMonitorIdentity> listed = {
      {{0, 0, 1920, 1080}, R"(\\?\DISPLAY#PANEL_A)"},
      {{1920, 0, 4480, 1440}, R"(\\?\DISPLAY#PANEL_B)"},
  };
  const std::string selected_source = "screen:" + listed[1].device_id;
  const std::vector<syrnike::voice::ScreenMonitorIdentity> reordered = {
      {{-2560, 0, 0, 1440}, R"(\\?\DISPLAY#PANEL_B)"},
      {{0, 0, 1920, 1080}, R"(\\?\DISPLAY#PANEL_A)"},
  };
  const auto stable_target =
      syrnike::voice::resolveScreenMonitorTarget(selected_source, reordered);
  if (stable_target.screen_index != 1 ||
      !EqualRect(&stable_target.rect, &reordered[0].rect) ||
      stable_target.monitor_device_id != listed[1].device_id) {
    throw std::runtime_error(
        "stable monitor DeviceID did not survive enumeration reorder");
  }

  const std::vector<syrnike::voice::ScreenMonitorIdentity> unplugged = {
      {{-2560, 0, 0, 1440}, R"(\\?\DISPLAY#PANEL_A)"},
  };
  if (syrnike::voice::screenMonitorTargetMatches(
          stable_target, unplugged.front())) {
    throw std::runtime_error(
        "monitor recovery substituted the nearest remaining display");
  }
  if (!syrnike::voice::screenMonitorTargetMatches(
          stable_target, reordered.front())) {
    throw std::runtime_error(
        "monitor recovery did not follow the stable DeviceID");
  }

  const auto legacy_target =
      syrnike::voice::resolveScreenMonitorTarget("screen:2", reordered);
  if (legacy_target.screen_index != 2 ||
      !EqualRect(&legacy_target.rect, &reordered[1].rect) ||
      legacy_target.monitor_device_id != reordered[1].device_id) {
    throw std::runtime_error("legacy screen:N selection is not compatible");
  }

  std::cout << "screen capture preset-bound sizing tests passed\n";
  return 0;
} catch (const std::exception &error) {
  std::cerr << error.what() << '\n';
  return 1;
}
