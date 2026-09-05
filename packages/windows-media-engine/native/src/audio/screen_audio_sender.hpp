#pragma once
#include "audio/process_loopback.hpp"
#include "livekit/livekit_room_transport.hpp"

namespace syrnike::windows_media::audio {
struct ScreenAudioSenderStats {
  std::uint64_t generation = 0, submitted = 0, discontinuities = 0;
  std::int64_t last_capture_timestamp_100ns = 0;
  std::uint64_t maximum_submit_age_us = 0;
  bool published = false;
};
// Publish/unpublish use the Room control lane. PCM has a separate worker and
// a fixed 10 ms clocked SDK source, so capture never waits for networking or video.
class ScreenAudioSender final {
 public:
  // Optional bounded observer runs on the sender worker, never capture or SDK
  // callback threads. The fixture uses it for monotonic capture-age evidence.
  using PacketObserver = std::function<void(const PcmPacket&)>;
  ScreenAudioSender(std::shared_ptr<LiveKitRoomTransport>, std::shared_ptr<PcmQueue>,
                    PacketObserver = {});
  ~ScreenAudioSender();
  std::optional<ScreenAudioFailure> start(std::uint64_t generation);
  bool stop(std::chrono::steady_clock::time_point deadline) noexcept;
  ScreenAudioSenderStats stats() const noexcept;
  std::optional<ScreenAudioFailure> failure() const noexcept;

 private:
  struct State;
  void run(const std::shared_ptr<State>&) noexcept;
  bool enqueue(const std::shared_ptr<State>&, LiveKitRoomTransport::ActiveRoomTask,
               std::chrono::steady_clock::time_point deadline);
  std::shared_ptr<LiveKitRoomTransport> transport_;
  std::shared_ptr<PcmQueue> queue_;
  PacketObserver packet_observer_;
  mutable std::mutex mutex_;
  std::shared_ptr<State> state_;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::audio
