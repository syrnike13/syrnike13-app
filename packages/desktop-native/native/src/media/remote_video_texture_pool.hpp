#pragma once

#ifdef _WIN32

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

#include <livekit/video_frame.h>

#include "remote_video_texture_pool_policy.hpp"

namespace syrnike::desktop_native::media {

class VideoResourceAdmissionBudget;
class RemoteVideoTexturePool;

class RemoteVideoTexturePoolError final : public std::runtime_error {
 public:
  RemoteVideoTexturePoolError(std::string message, long hresult)
      : std::runtime_error(std::move(message)), hresult_(hresult) {}

  [[nodiscard]] long hresult() const noexcept { return hresult_; }

 private:
  long hresult_ = 0;
};

struct RemoteVideoTextureFrame {
  std::uint64_t nt_handle = 0;
  std::uint64_t timestamp_us = 0;
  std::uint64_t source_timestamp_us = 0;
  std::uint32_t source_frame_id = 0;
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

struct RemoteVideoTextureCompletionPoll {
  // Admission identity is the exact pool generation; diagnostic owner IDs are
  // grouping keys and must never fence an injected completion decision.
  std::uint64_t pool_reservation_id = 0;
  std::uint64_t submission_sequence = 0;
  std::uint64_t elapsed_us = 0;
  std::uint64_t timeout_us = 0;
  bool quarantined = false;
};

// Optional deterministic fault control for contention tests. An empty
// function is the production default and performs no allocation or override.
// Returning true withholds the real D3D query observation while the pool still
// runs its normal timeout, quarantine, and late-recovery policy.
using RemoteVideoTextureCompletionPollControl =
    std::function<bool(const RemoteVideoTextureCompletionPoll&)>;

enum class RemoteVideoD3dDeviceOperation {
  Submit,
  Poll,
};

using RemoteVideoD3dDeviceOperationProbe =
    std::function<void(RemoteVideoD3dDeviceOperation)>;

// One owner represents one admitted D3D device/context and Electron process
// handle. Texture-pool generations share it until an actual device failure.
class RemoteVideoD3dDeviceOwner final {
 public:
  static std::shared_ptr<RemoteVideoD3dDeviceOwner> create(
    VideoResourceAdmissionBudget& resource_budget,
    std::string owner_id,
    std::uint32_t electron_main_pid,
    RemoteVideoD3dDeviceOperationProbe operation_probe = {}
  );
  ~RemoteVideoD3dDeviceOwner();

  RemoteVideoD3dDeviceOwner(const RemoteVideoD3dDeviceOwner&) = delete;
  RemoteVideoD3dDeviceOwner& operator=(const RemoteVideoD3dDeviceOwner&) = delete;

  [[nodiscard]] std::uint64_t identity() const noexcept;
  [[nodiscard]] std::uint64_t deviceReservationId() const noexcept;
  [[nodiscard]] bool multithreadProtected() const noexcept;

 private:
  struct State;
  explicit RemoteVideoD3dDeviceOwner(std::shared_ptr<State> state);
  std::shared_ptr<State> state_;

  friend class RemoteVideoTexturePool;
};

[[nodiscard]] std::shared_ptr<RemoteVideoD3dDeviceOwner>
selectRemoteVideoD3dDeviceOwnerForRollover(
  const std::shared_ptr<RemoteVideoD3dDeviceOwner>& current,
  RemoteVideoGpuRolloverCause cause,
  VideoResourceAdmissionBudget& resource_budget,
  std::string owner_id,
  std::uint32_t electron_main_pid
);

// Uploads decoded BGRA frames into a bounded pool of persistent D3D11 shared
// textures. GPU completion is polled asynchronously; a delivered slot remains
// immutable until Electron's renderer fence releases its lease.
class RemoteVideoTexturePool final {
 public:
  explicit RemoteVideoTexturePool(
    VideoResourceAdmissionBudget& resource_budget,
    std::string owner_id,
    std::uint32_t electron_main_pid,
    std::uint32_t width,
    std::uint32_t height,
    std::size_t capacity = 5,
    RemoteVideoTextureCompletionPollControl completion_poll_control = {}
  );
  RemoteVideoTexturePool(
    std::shared_ptr<RemoteVideoD3dDeviceOwner> device_owner,
    VideoResourceAdmissionBudget& resource_budget,
    std::string owner_id,
    std::uint32_t width,
    std::uint32_t height,
    std::size_t capacity = 5,
    RemoteVideoTextureCompletionPollControl completion_poll_control = {}
  );
  ~RemoteVideoTexturePool();

  RemoteVideoTexturePool(const RemoteVideoTexturePool&) = delete;
  RemoteVideoTexturePool& operator=(const RemoteVideoTexturePool&) = delete;

  // Returns false when every slot is busy. Invalid frames and D3D failures
  // throw.
  bool submit(
    const livekit::VideoFrame& frame,
    std::uint64_t timestamp_us,
    std::uint64_t source_timestamp_us = 0,
    std::uint32_t source_frame_id = 0
  );
  // A late live-device query quarantines only its slot. A reset is requested
  // only for an actual D3D device failure; capacity exhaustion lets the caller
  // roll to a fresh generation while retaining pending resources safely.
  RemoteVideoTexturePollResult poll();
  bool take(RemoteVideoTextureFrame& frame);
  // A renderer-fence stall cannot publish another texture. Completed uploads
  // are made reusable without duplicating a process handle; delivered slots
  // remain immutable until their authoritative renderer fences arrive.
  std::uint64_t discardReady();

  [[nodiscard]] std::size_t available() const;
  [[nodiscard]] std::size_t ready() const;
  [[nodiscard]] std::size_t capacity() const;
  [[nodiscard]] std::size_t quarantined() const;
  [[nodiscard]] std::uint32_t width() const noexcept;
  [[nodiscard]] std::uint32_t height() const noexcept;
  [[nodiscard]] bool retirementSafe() const;
  std::uint64_t consumeSupersededReadyFrames();
  [[nodiscard]] std::uint64_t deviceOwnerIdentity() const noexcept;
  [[nodiscard]] std::uint64_t deviceReservationId() const noexcept;
  [[nodiscard]] std::uint64_t generationReservationId() const noexcept;
  [[nodiscard]] std::shared_ptr<RemoteVideoD3dDeviceOwner> deviceOwner() const;

 private:
  struct State;
  std::shared_ptr<State> state_;
};

}  // namespace syrnike::desktop_native::media

#endif
