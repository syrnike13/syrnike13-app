#pragma once

#include "camera/camera_frame.hpp"
#include "livekit/livekit_room_transport.hpp"

namespace syrnike::windows_media::camera {
enum class CameraPublicationFailure { none, invalid_state, publish_failed, send_failed, timeout };
struct CameraPublicationStats {
  CameraPublicationFailure failure = CameraPublicationFailure::none;
  bool published = false;
  std::uint64_t commits = 0, submitted = 0, generation = 0, stale = 0, maximum_age_us = 0;
  std::uint32_t width = 0, height = 0;
};
// Separate camera publication owner. SDK lifecycle calls share the Room lane;
// one sender worker copies fresh owned frames and never retains an MF sample.
// Device/preview changes do not publish, unpublish or reconnect the Room.
class CameraPublication final {
 public:
  CameraPublication(std::shared_ptr<LiveKitRoomTransport>, std::shared_ptr<CameraFramePort>, CameraProfile initial_profile);
  ~CameraPublication();
  CameraPublicationFailure start();
  // Thread-safe revocation only; stop() on the owner proves SDK retirement.
  void cancel() noexcept;
  bool stop(std::chrono::steady_clock::time_point deadline) noexcept;
  CameraPublicationStats stats() const noexcept;
 private:
  struct State;
  static void run(const std::shared_ptr<State>&) noexcept;
  const std::thread::id owner_ = std::this_thread::get_id();
  std::shared_ptr<State> state_;
  std::thread worker_;
  bool started_ = false;
};
}  // namespace syrnike::windows_media::camera
