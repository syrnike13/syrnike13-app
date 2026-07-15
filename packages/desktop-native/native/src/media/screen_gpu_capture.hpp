#pragma once

#include <windows.h>
#include <dxgiformat.h>

#include <cstdint>
#include <cstddef>
#include <memory>
#include <stdexcept>
#include <string>

#include "screen_video_capture.hpp"

namespace syrnike::desktop_native::media {

enum class ScreenGpuCaptureErrorCode {
  CaptureUnavailable,
  DeviceUnavailable,
  InteropUnavailable,
  FormatUnsupported,
  DeviceLost,
  TargetClosed,
};

class ScreenGpuCaptureError final : public std::runtime_error {
 public:
  ScreenGpuCaptureError(ScreenGpuCaptureErrorCode code, std::string message, long hresult = 0);

  [[nodiscard]] ScreenGpuCaptureErrorCode code() const noexcept { return code_; }
  [[nodiscard]] long hresult() const noexcept { return hresult_; }

 private:
  ScreenGpuCaptureErrorCode code_;
  long hresult_;
};

enum class ScreenGpuFrameStatus {
  NewFrame,
  NoFrame,
  EncoderBackpressure,
  RecoverableLost,
  TargetClosed,
  FatalError,
};

struct ScreenGpuFrame {
  std::uint64_t sequence = 0;
  std::uint64_t timestamp_us = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t slot = 0;
  HANDLE shared_texture_handle = nullptr;
  LUID adapter_luid{};
  DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN;
};

struct ScreenGpuFrameResult {
  ScreenGpuFrameStatus status = ScreenGpuFrameStatus::NoFrame;
  syrnike::voice::ScreenCaptureFrameMetrics metrics;
  const char* method = "unknown";
  ScreenGpuCaptureErrorCode error_code = ScreenGpuCaptureErrorCode::CaptureUnavailable;
};

struct ScreenPreviewDemand {
  bool demanded = false;
  std::uint32_t width = 1280;
  std::uint32_t height = 720;
  std::uint32_t fps = 30;
  std::uint32_t electron_main_pid = 0;
};

struct ScreenPreviewFrame {
  std::uint64_t sequence = 0;
  std::uint64_t timestamp_us = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint64_t nt_handle = 0;
};

struct ScreenPreviewFailure {
  ScreenGpuCaptureErrorCode code = ScreenGpuCaptureErrorCode::InteropUnavailable;
  long hresult = 0;
  std::string message;
  std::uint64_t suppressed = 0;
};

// A strict GPU-only capturer. Every NewFrame references a shared NV12 D3D11
// texture guarded by IDXGIKeyedMutex: producer key 0, consumer key 1. The
// downstream encoder must release key 0 after it has finished reading.
class ScreenGpuCapturer {
 public:
  static std::shared_ptr<ScreenGpuCapturer> create(
      const syrnike::voice::ScreenCaptureTarget& target,
      std::uint32_t width,
      std::uint32_t height);

  virtual ~ScreenGpuCapturer() = default;
  virtual ScreenGpuFrameResult capture(ScreenGpuFrame& frame) = 0;
  virtual void discard(const ScreenGpuFrame& frame) noexcept = 0;
  virtual void setPreviewDemand(ScreenPreviewDemand demand) = 0;
  virtual bool takePreviewFrame(ScreenPreviewFrame& frame) = 0;
  virtual bool takePreviewFailure(ScreenPreviewFailure& failure) = 0;
  virtual void releasePreviewFrame(std::uint64_t sequence) noexcept = 0;
  [[nodiscard]] virtual std::size_t previewFramesInFlight() const noexcept = 0;
  [[nodiscard]] virtual const char* method() const noexcept = 0;
  [[nodiscard]] virtual LUID adapterLuid() const noexcept = 0;
};

}  // namespace syrnike::desktop_native::media
