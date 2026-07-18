#pragma once

#include <atomic>
#include <cstddef>
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

struct CameraFormat {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t frame_rate_numerator = 0;
  std::uint32_t frame_rate_denominator = 1;

  bool operator==(const CameraFormat&) const = default;
};

std::vector<CameraFormat> rankCameraOutputFormats(
  CameraFormat requested,
  std::vector<CameraFormat> native_formats
);

std::vector<std::uint8_t> copyCameraBgraRows(
  const std::uint8_t* scanline_zero,
  std::ptrdiff_t stride,
  std::uint32_t width,
  std::uint32_t height
);

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
