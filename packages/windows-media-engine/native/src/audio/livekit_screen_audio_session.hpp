#pragma once
#include "audio/screen_audio_owner.hpp"
#include "audio/screen_audio_sender.hpp"

namespace syrnike::windows_media::audio {
class LiveKitScreenAudioSession final : public ScreenAudioSession {
 public:
  LiveKitScreenAudioSession(std::shared_ptr<LiveKitRoomTransport> transport,
                            ScreenAudioSender::PacketObserver observer = {})
      : pcm_(std::make_shared<PcmQueue>()),
        capture_(pcm_),
        sender_(std::move(transport), pcm_, std::move(observer)) {}
  std::optional<ScreenAudioFailure> start(const ScreenAudioIntent& intent) override {
    if (cancelled_) return ScreenAudioFailure{ScreenAudioFailureCode::cancelled};
    if (const auto failure = capture_.start(intent.mode, intent.target)) return failure;
    if (cancelled_) return ScreenAudioFailure{ScreenAudioFailureCode::cancelled};
    return sender_.start(capture_.stats().generation, intent.bitrate);
  }
  void cancel() noexcept override {
    cancelled_ = true;
    sender_.cancel();
  }
  bool stop(std::chrono::steady_clock::time_point deadline) noexcept override {
    const bool captured = capture_.stop(deadline);
    const bool published = sender_.stop(deadline);
    return captured && published;
  }
  std::optional<ScreenAudioFailure> failure() const noexcept override {
    if (cancelled_) return ScreenAudioFailure{ScreenAudioFailureCode::cancelled};
    if (const auto failure = capture_.failure()) return failure;
    return sender_.failure();
  }
  ScreenAudioSessionStats stats() const noexcept override {
    const auto capture = capture_.stats();
    const auto sender = sender_.stats();
    const auto queue = pcm_->stats();
    return {capture.generation,    capture.capture_packets,
            sender.submitted,      sender.maximum_submit_age_us,
            capture.audio_clients, capture.capture_threads,
            queue.depth,           queue.maximum_depth,
            queue.superseded,      queue.stale,
            capture.silent_packets, capture.invalid_timestamps, capture.peak_sample,
            sender.maximum_callback_wait_us};
  }

 private:
  std::shared_ptr<PcmQueue> pcm_;
  ProcessLoopback capture_;
  ScreenAudioSender sender_;
  std::atomic_bool cancelled_{false};
};
}  // namespace syrnike::windows_media::audio
