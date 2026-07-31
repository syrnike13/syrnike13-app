#pragma once

#include <windows.h>

#include <cstdint>
#include <span>
#include <string>
#include <vector>

namespace syrnike::voice {

struct ScreenCaptureTarget {
  bool window = false;
  HWND hwnd = nullptr;
  DWORD process_id = 0;
  RECT rect{};
  int screen_index = 0;
  std::string monitor_device_id;
};

struct ScreenMonitorIdentity {
  RECT rect{};
  std::string device_id;
};

struct ScreenCaptureFrameMetrics {
  uint32_t source_width = 0;
  uint32_t source_height = 0;
  uint32_t content_width = 0;
  uint32_t content_height = 0;
  uint32_t output_width = 0;
  uint32_t output_height = 0;
  int capture_us = 0;
  int readback_us = 0;
  int scale_us = 0;
  int duplication_hold_us = 0;
  std::uint32_t gpu_pool_slots_available = 0;
  std::uint32_t gpu_pool_slots_total = 0;
  long hresult = 0;
};

ScreenCaptureTarget resolveScreenCaptureTarget(const std::string& source_id);
ScreenCaptureTarget resolveScreenMonitorTarget(
    const std::string& source_id,
    std::span<const ScreenMonitorIdentity> monitors);
bool screenMonitorTargetMatches(
    const ScreenCaptureTarget& target,
    const ScreenMonitorIdentity& monitor) noexcept;
HMONITOR resolveScreenMonitorHandle(const ScreenCaptureTarget& target);
void resolveScreenCaptureSize(
    const ScreenCaptureTarget& target,
    uint32_t max_width,
    uint32_t max_height,
    uint32_t& width,
    uint32_t& height);

}  // namespace syrnike::voice
