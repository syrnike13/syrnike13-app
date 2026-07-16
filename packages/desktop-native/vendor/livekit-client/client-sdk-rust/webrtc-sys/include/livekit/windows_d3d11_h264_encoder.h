#pragma once

#ifdef _WIN32
#include <d3d11.h>
#include <windows.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>

#include "api/scoped_refptr.h"
#include "api/video/video_frame_buffer.h"
#include "api/video_codecs/video_encoder_factory.h"

namespace livekit_ffi {

class D3D11TextureFrameBuffer : public webrtc::VideoFrameBuffer {
 public:
  D3D11TextureFrameBuffer(HANDLE shared_handle,
                          std::uint64_t adapter_luid,
                          std::uint64_t acquire_key,
                          std::uint64_t release_key,
                          int width,
                          int height,
                          std::function<void()> release_callback);
  ~D3D11TextureFrameBuffer() override;

  Type type() const override { return Type::kNative; }
  int width() const override { return width_; }
  int height() const override { return height_; }
  webrtc::scoped_refptr<webrtc::I420BufferInterface> ToI420() override {
    return nullptr;
  }
  webrtc::scoped_refptr<webrtc::VideoFrameBuffer> CropAndScale(
      int offset_x,
      int offset_y,
      int crop_width,
      int crop_height,
      int scaled_width,
      int scaled_height) override;
  HANDLE shared_handle() const { return shared_handle_; }
  bool owns_shared_handle() const { return shared_handle_ != nullptr; }
  std::uint64_t adapter_luid() const { return adapter_luid_; }
  std::uint64_t acquire_key() const { return acquire_key_; }
  std::uint64_t release_key() const { return release_key_; }
  void ReleaseLease(bool reclaim_unencoded = true);

 private:
  HANDLE shared_handle_;
  std::uint64_t adapter_luid_;
  std::uint64_t acquire_key_;
  std::uint64_t release_key_;
  int width_;
  int height_;
  std::function<void()> release_callback_;
  std::mutex lease_mutex_;
  bool released_ = false;
};

bool IsWindowsD3D11HardwareH264Supported();
std::unique_ptr<webrtc::VideoEncoderFactory>
CreateWindowsD3D11HardwareH264EncoderFactory();

}  // namespace livekit_ffi
#endif
