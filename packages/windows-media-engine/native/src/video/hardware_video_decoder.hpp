#pragma once

#include <d3d11.h>
#include <wrl/client.h>

#include <cstdint>
#include <memory>
#include <span>

namespace syrnike::windows_media::video {

// One decoded picture as BGRA on the process D3D11 device. Its texture returns
// to the decoder for reuse when the last reference drops.
struct DecodedVideoFrame {
  Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
};

// H.264 through the Media Foundation decoder with a D3D11 device manager, so
// DXVA decodes on any vendor's GPU. Decoded NV12 is converted to BGRA by the
// D3D11 video processor; nothing touches system memory. One instance is used
// by one thread at a time.
class HardwareVideoDecoder {
 public:
  enum class Result { Frame, NoFrame, Error, Fallback };

  // Null when Media Foundation has no DXVA-capable decoder on this device.
  static std::unique_ptr<HardwareVideoDecoder> createH264();

  virtual ~HardwareVideoDecoder() = default;
  // One complete Annex B access unit. `frame` is set for Result::Frame.
  virtual Result decode(std::span<const std::uint8_t> access_unit, bool keyframe,
                        std::shared_ptr<DecodedVideoFrame>& frame) = 0;
};

// CPU copy of a decoded frame for consumers without GPU access.
bool readDecodedFrameI420(const DecodedVideoFrame& frame, std::uint8_t* y, int stride_y,
                          std::uint8_t* u, int stride_u, std::uint8_t* v, int stride_v);

// Registers the decoder with the LiveKit SDK. Call before the first Room.
void installHardwareVideoDecoder();

}  // namespace syrnike::windows_media::video
