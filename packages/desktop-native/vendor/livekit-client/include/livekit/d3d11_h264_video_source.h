/*
 * Copyright 2026 LiveKit
 * SPDX-License-Identifier: Apache-2.0
 */
#pragma once

#include <cstdint>
#include <memory>
#include <string>

#include "livekit/video_source.h"
#include "livekit/visibility.h"

namespace livekit {

/// Description of a cross-device D3D11 texture. `shared_handle` must refer to
/// an NV12 texture created with keyed-mutex sharing on the adapter identified
/// by `adapter_luid`. The Syrnike producer releases key 1; the encoder must
/// acquire key 1 before reading and release key 0 only after it has finished
/// using the input resource.
struct D3D11SharedTexture {
  std::uintptr_t shared_handle = 0;
  std::uint64_t adapter_luid = 0;
  std::uint64_t acquire_key = 1;
  std::uint64_t release_key = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
};

/// Keeps a shared texture alive until the encoder has finished consuming it.
/// Implementations must release the keyed mutex and producer-owned resources
/// exactly once from `release()` or their destructor.
class LIVEKIT_API D3D11TextureLease {
public:
  virtual ~D3D11TextureLease() = default;
  virtual const D3D11SharedTexture& texture() const noexcept = 0;
  /// Marks a successful handoff. After this call the producer must use keyed
  /// mutex key 0, written by the encoder after ProcessOutput, as the recycle
  /// acknowledgement; destruction must not discard or reacquire key 1.
  virtual void accepted() noexcept = 0;
  /// Rejects an unsubmitted lease and returns it to the producer immediately.
  virtual void release() noexcept = 0;
};

struct D3D11H264Capability {
  bool available = false;
  std::string reason;
};

/// Reports whether this SDK binary contains the strict D3D11 H.264 encoder.
LIVEKIT_API D3D11H264Capability queryD3D11H264Capability();

/// GPU-native screen source contract. Implementations hand leases to the
/// WebRTC VideoEncoder path, which remains responsible for rate control,
/// keyframe requests, packetization, and RTP transport.
class LIVEKIT_API D3D11H264VideoSource : public VideoSource {
public:
  virtual ~D3D11H264VideoSource() = default;
  virtual bool capture(std::unique_ptr<D3D11TextureLease> lease, std::int64_t timestamp_us) = 0;

protected:
  D3D11H264VideoSource(int width, int height) : VideoSource(width, height, true, SourceMode::D3D11Hardware) {}
};

/// Creates the source only when the compiled libwebrtc ABI exposes the native
/// encoder factory. A null result is a hard unsupported result; callers must
/// not substitute a CPU frame source for screen sharing.
LIVEKIT_API std::unique_ptr<D3D11H264VideoSource> createD3D11H264VideoSource(int width, int height);

} // namespace livekit
