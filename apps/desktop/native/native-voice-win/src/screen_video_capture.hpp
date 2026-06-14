#pragma once

#include <windows.h>

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace syrnike::voice {

struct StartCommand;

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

struct ScreenCaptureProbeResult {
  std::string source_id;
  std::string method;
  bool captured = false;
  uint32_t width = 0;
  uint32_t height = 0;
  int fps = 0;
  int duration_ms = 0;
  uint32_t attempts = 0;
  uint32_t captured_frames = 0;
  uint32_t late_frames = 0;
  int avg_capture_us = 0;
  size_t bytes = 0;
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

ScreenCaptureProbeResult runScreenCaptureProbe(const StartCommand& command);
void emitScreenCaptureProbe(const StartCommand& command);

}  // namespace syrnike::voice
