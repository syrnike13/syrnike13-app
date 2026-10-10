#pragma once

#include "audio/microphone_dsp.hpp"

namespace syrnike::windows_media::audio {
// One committed renderer producer, one microphone DSP consumer. A candidate
// gets its own port, so switching never introduces a second producer. AEC
// needs every rendered frame in order, so this is a short FIFO, not
// latest-wins: render and capture wake independently, and a frame rendered
// between two capture frames must still reach the canceller. Overflow drops
// the oldest frame, bounding the queued delay below the DSP freshness window.
// Either side skips (never waits) when the other holds the try-lock.
// Retire on output loss/stop before releasing the renderer. The projection may
// outlive it, but can no longer provide echo after retirement.
class RenderedEchoReference final : public EchoReferencePort {
 public:
  static constexpr std::size_t kCapacity = 4;
  explicit RenderedEchoReference(std::uint64_t epoch) : epoch_(epoch) {}
  bool publish(const EchoReferenceFrame& frame) noexcept {
    if (retired_.load(std::memory_order_acquire) || !epoch_ || frame.renderer_epoch != epoch_ ||
        frame.sequence <= last_sequence_ || frame.rendered_timestamp_100ns <= 0 || frame.stream_delay_ms > 500)
      return false;
    last_sequence_ = frame.sequence;
    if (busy_.test_and_set(std::memory_order_acquire)) return false;
    if (depth_ == kCapacity) {
      head_ = (head_ + 1) % kCapacity;
      --depth_;
    }
    frames_[(head_ + depth_) % kCapacity] = frame;
    ++depth_;
    busy_.clear(std::memory_order_release);
    return true;
  }
  std::optional<EchoReferenceFrame> take() noexcept override {
    if (retired_.load(std::memory_order_acquire) || busy_.test_and_set(std::memory_order_acquire)) return {};
    std::optional<EchoReferenceFrame> frame;
    if (depth_) {
      frame = frames_[head_];
      head_ = (head_ + 1) % kCapacity;
      --depth_;
    }
    busy_.clear(std::memory_order_release);
    if (retired_.load(std::memory_order_acquire)) return {};
    return frame;
  }
  void retire() noexcept { retired_.store(true, std::memory_order_release); }
 private:
  const std::uint64_t epoch_;
  std::array<EchoReferenceFrame, kCapacity> frames_{};
  std::atomic_bool retired_{false};
  std::atomic_flag busy_ = ATOMIC_FLAG_INIT;
  std::size_t head_ = 0, depth_ = 0;
  std::uint64_t last_sequence_ = 0;  // producer only
};
}  // namespace syrnike::windows_media::audio
