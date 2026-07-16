#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "screen_video_capture.hpp"

namespace syrnike::voice {

// CPU readback capture exists only for the manual before/after benchmark. It
// is deliberately excluded from the production media target.
struct ScreenVideoFrame {
  std::vector<std::uint8_t> bgra;
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

struct ScreenCaptureFrameResult {
  ScreenCaptureFrameStatus status = ScreenCaptureFrameStatus::NoFrame;
  ScreenCaptureFrameMetrics metrics;
  std::string method;
};

class ScreenVideoCapturer {
 public:
  static std::unique_ptr<ScreenVideoCapturer> create(
      const ScreenCaptureTarget& target,
      std::uint32_t width,
      std::uint32_t height);

  virtual ~ScreenVideoCapturer() = default;
  virtual ScreenCaptureFrameResult capture(ScreenVideoFrame& frame) = 0;
  virtual const char* method() const = 0;
};

}  // namespace syrnike::voice
