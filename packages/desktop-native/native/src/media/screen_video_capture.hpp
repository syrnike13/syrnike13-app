#pragma once

#include <windows.h>

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace syrnike::voice {

struct ScreenCaptureTarget {
  bool window = false;
  HWND hwnd = nullptr;
  DWORD process_id = 0;
  RECT rect{};
  int screen_index = 0;
};

struct ScreenVideoFrame {
  std::vector<uint8_t> bgra;
  std::string method;
};

enum class ScreenCaptureFrameStatus {
  NewFrame,
  NoFrame,
  RepeatedFrame,
  RecoverableLost,
  TargetClosed,
  FatalError,
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
  long hresult = 0;
};

struct ScreenCaptureFrameResult {
  ScreenCaptureFrameStatus status = ScreenCaptureFrameStatus::NoFrame;
  ScreenCaptureFrameMetrics metrics;
  std::string method;
};

ScreenCaptureTarget resolveScreenCaptureTarget(const std::string& source_id);
void resolveScreenCaptureSize(
    const ScreenCaptureTarget& target,
    uint32_t max_width,
    uint32_t max_height,
    uint32_t& width,
    uint32_t& height);

class ScreenVideoCapturer {
public:
  static std::unique_ptr<ScreenVideoCapturer> create(
      const ScreenCaptureTarget& target,
      uint32_t width,
      uint32_t height);

  virtual ~ScreenVideoCapturer() = default;
  virtual ScreenCaptureFrameResult capture(ScreenVideoFrame& frame) = 0;
  virtual const char* method() const = 0;
};

}  // namespace syrnike::voice
