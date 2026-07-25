#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "../common/runtime_types.hpp"

namespace syrnike::desktop_native::media {

struct CameraFormat {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t frame_rate_numerator = 0;
  std::uint32_t frame_rate_denominator = 1;

  bool operator==(const CameraFormat&) const = default;
};

struct CameraFrame {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::vector<std::uint8_t> bgra;

  // Set for the D3D11/NV12 path. The texture uses producer key 0 and consumer
  // key 1, matching D3D11H264VideoSource's shared-texture contract.
  bool gpu = false;
  std::uint64_t sequence = 0;
  std::uint64_t timestamp_us = 0;
  std::uint32_t slot = 0;
  std::uintptr_t shared_texture_handle = 0;
  std::uint64_t adapter_luid = 0;
};

struct CameraCaptureInfo {
  CameraFormat format;
  bool gpu = false;
  std::uint64_t adapter_luid = 0;
  std::string native_subtype;
  std::string output_subtype;
};

class CameraCaptureError final : public std::runtime_error {
 public:
  CameraCaptureError(std::string code, std::string message)
      : std::runtime_error(std::move(message)), code_(std::move(code)) {}

  [[nodiscard]] const std::string& code() const noexcept { return code_; }

 private:
  std::string code_;
};

std::vector<CameraFormat> rankCameraOutputFormats(
    CameraFormat requested,
    std::vector<CameraFormat> native_formats);

std::vector<std::uint8_t> copyCameraBgraRows(
    const std::uint8_t* scanline_zero,
    std::ptrdiff_t stride,
    std::uint32_t width,
    std::uint32_t height);

std::vector<std::uint8_t> copyCameraBgraBuffer(
    const std::uint8_t* buffer,
    std::size_t buffer_length,
    std::ptrdiff_t stride,
    std::uint32_t width,
    std::uint32_t height);

class CameraCapture {
 public:
  virtual ~CameraCapture() = default;
  virtual bool read(CameraFrame& frame, const std::atomic_bool& running) = 0;
  virtual void stop() noexcept {}
  [[nodiscard]] virtual CameraCaptureInfo info() const = 0;
  virtual void discard(const CameraFrame&) noexcept {}
};

class CameraCaptureFactory {
 public:
  virtual ~CameraCaptureFactory() = default;
  virtual std::shared_ptr<CameraCapture> create(
      const std::string& device_id,
      std::uint32_t width,
      std::uint32_t height,
      int fps,
      bool force_cpu = false) = 0;
};

std::shared_ptr<CameraCaptureFactory>
createMediaFoundationCameraCaptureFactory();
std::vector<DeviceInfo> listCameraDevices();

}  // namespace syrnike::desktop_native::media
