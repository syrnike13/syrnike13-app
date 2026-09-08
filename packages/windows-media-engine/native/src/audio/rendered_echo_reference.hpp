#pragma once

#include "audio/microphone_dsp.hpp"

namespace syrnike::windows_media::audio {
// One committed renderer producer, one microphone DSP consumer. A candidate
// gets its own port, so switching never introduces a second producer. Three
// owned values implement latest-wins publication without waiting or allocation.
// Retire on output loss/stop before releasing the renderer. The projection may
// outlive it, but can no longer provide echo after retirement.
class RenderedEchoReference final : public EchoReferencePort {
 public:
  explicit RenderedEchoReference(std::uint64_t epoch) : epoch_(epoch) {}
  bool publish(const EchoReferenceFrame& frame) noexcept {
    if (retired_.load(std::memory_order_acquire) || !epoch_ || frame.renderer_epoch != epoch_ ||
        frame.sequence <= last_sequence_ || frame.rendered_timestamp_100ns <= 0 || frame.stream_delay_ms > 500)
      return false;
    last_sequence_ = frame.sequence;
    frames_[write_] = frame;
    write_ = middle_.exchange(write_ | 4, std::memory_order_acq_rel) & 3;
    return true;
  }
  std::optional<EchoReferenceFrame> take() noexcept override {
    if (retired_.load(std::memory_order_acquire) || !(middle_.load(std::memory_order_acquire) & 4)) return {};
    read_ = middle_.exchange(read_, std::memory_order_acq_rel) & 3;
    const auto frame = frames_[read_];
    if (retired_.load(std::memory_order_acquire)) return {};
    return frame;
  }
  void retire() noexcept { retired_.store(true, std::memory_order_release); }
 private:
  const std::uint64_t epoch_;
  std::array<EchoReferenceFrame, 3> frames_{};
  std::atomic_bool retired_{false};
  std::atomic<unsigned> middle_{1};
  unsigned write_ = 2, read_ = 0;
  std::uint64_t last_sequence_ = 0;
};
}  // namespace syrnike::windows_media::audio
