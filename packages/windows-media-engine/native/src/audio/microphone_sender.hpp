#pragma once

#include "audio/microphone_pcm.hpp"
#include "livekit/livekit_room_transport.hpp"

namespace syrnike::windows_media::audio {
enum class MicrophonePublicationFailure { none, invalid_state, unavailable, publish_failed, timeout, send_failed };
struct MicrophoneSenderStats {
  bool published = false;
  MicrophonePublicationFailure failure = MicrophonePublicationFailure::none;
  std::uint64_t submitted = 0;
  std::uint64_t rejected_stale = 0;
  std::uint64_t latest_device_generation = 0;
  std::uint64_t publication_commits = 0;
  std::uint64_t latest_frame_age_us = 0;
  std::uint64_t maximum_frame_age_us = 0;
  std::uint32_t pending_frames = 0;
  std::uint64_t maximum_callback_wait_us = 0;
};
// One publication consumer of a warm pipeline. Serialize lifecycle calls on
// its control owner; retain the pipeline's borrowed event until stop succeeds.
// Mute, config and input changes have no publication operation here.
class MicrophoneSender final {
 public:
  MicrophoneSender(std::shared_ptr<LiveKitRoomTransport>, std::shared_ptr<MicrophonePcmPort>, void* frame_event);
  ~MicrophoneSender();
  MicrophoneSender(const MicrophoneSender&) = delete;
  MicrophoneSender& operator=(const MicrophoneSender&) = delete;
  MicrophonePublicationFailure start();
  // Any control thread may revoke a pending publication commit immediately.
  // Resource release remains serialized through stop() on the owner.
  void cancel() noexcept;
  bool stop(std::chrono::steady_clock::time_point) noexcept;
  MicrophoneSenderStats stats() const noexcept;
 private:
  struct State;
  static void run(const std::shared_ptr<State>&) noexcept;
  const std::thread::id owner_ = std::this_thread::get_id();
  std::shared_ptr<State> state_;
  std::thread worker_;
  bool started_ = false;
};
}  // namespace syrnike::windows_media::audio
