#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "../common/runtime_types.hpp"

namespace syrnike::desktop_native::media {

struct CameraFrame {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> bgra;
};

class CameraCapture {
 public:
  virtual ~CameraCapture() = default;
  virtual bool read(CameraFrame& frame, const std::atomic_bool& running) = 0;
};

class CameraCaptureFactory {
 public:
  virtual ~CameraCaptureFactory() = default;
  virtual std::unique_ptr<CameraCapture> create(
    const std::string& device_id,
    std::uint32_t width,
    std::uint32_t height,
    int fps
  ) = 0;
};

std::shared_ptr<CameraCaptureFactory> createMediaFoundationCameraCaptureFactory();
std::vector<DeviceInfo> listCameraDevices();

}  // namespace syrnike::desktop_native::media
