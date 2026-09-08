#pragma once

#include "camera/camera_capture.hpp"

namespace syrnike::windows_media::lab {
struct SyntheticCameraControl {
  bool supports_1080 = true;
  bool fail_open = false;
  bool emit_late_callback = false;
  std::uint8_t color = 80;
  std::atomic_uint32_t delay_ms{0};
  std::atomic_uint32_t copy_delay_ms{0};
  std::atomic<camera::CameraFailure> next_failure{camera::CameraFailure::none};
  std::atomic_uint64_t opens{0}, closes{0}, callbacks{0}, late_callbacks{0}, samples_alive{0};
  std::atomic_uint32_t readers_alive{0}, maximum_readers{0};
};
camera::CameraReaderFactory syntheticCameraReader(std::shared_ptr<SyntheticCameraControl>);
}  // namespace syrnike::windows_media::lab
