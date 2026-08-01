#pragma once

#ifdef _WIN32

#include <cstddef>
#include <cstdint>
#include <memory>

#include <livekit/video_frame.h>

namespace syrnike::desktop_native::media {

struct RemoteVideoTextureFrame {
  std::uint64_t nt_handle = 0;
  std::uint64_t timestamp_us = 0;
  std::uint64_t gpu_completion_us = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::shared_ptr<void> lease;
};

struct RemoteVideoTexturePollResult {
  bool reset_required = false;
  bool upload_capacity_exhausted = false;
  long hresult = 0;
  std::size_t slots_quarantined = 0;
  std::size_t slots_recovered = 0;
};

// Uploads decoded BGRA frames into a bounded pool of persistent D3D11 shared
// textures. GPU completion is polled asynchronously; a delivered slot remains
// immutable until Electron's renderer fence releases its lease.
class RemoteVideoTexturePool final {
 public:
  explicit RemoteVideoTexturePool(
    std::uint32_t electron_main_pid,
    std::size_t capacity = 5
  );
  ~RemoteVideoTexturePool();

  RemoteVideoTexturePool(const RemoteVideoTexturePool&) = delete;
  RemoteVideoTexturePool& operator=(const RemoteVideoTexturePool&) = delete;

  // Returns false when every slot is busy. Invalid frames and D3D failures
  // throw.
  bool submit(
    const livekit::VideoFrame& frame,
    std::uint64_t timestamp_us
  );
  // A late live-device query quarantines only its slot. A reset is requested
  // only for an actual D3D device failure; capacity exhaustion lets the caller
  // roll to a fresh generation while retaining pending resources safely.
  RemoteVideoTexturePollResult poll();
  bool take(RemoteVideoTextureFrame& frame);

  [[nodiscard]] std::size_t available() const;
  [[nodiscard]] std::size_t ready() const;
  [[nodiscard]] std::size_t capacity() const;
  [[nodiscard]] std::size_t quarantined() const;
  [[nodiscard]] bool retirementSafe() const;
  std::uint64_t consumeSupersededReadyFrames();

 private:
  struct State;
  std::shared_ptr<State> state_;
};

}  // namespace syrnike::desktop_native::media

#endif
