#pragma once

#include <cstddef>
#include <optional>
#include <span>
#include <vector>

namespace syrnike::voice {

class MicrophoneCaptureFrameAccumulator final {
 public:
  explicit MicrophoneCaptureFrameAccumulator(std::size_t frame_samples)
    : samples_(frame_samples) {}

  void beginPacket(bool discontinuity) {
    if (discontinuity) pending_samples_ = 0;
  }

  std::optional<std::span<const float>> push(float sample) noexcept {
    if (samples_.empty()) return std::nullopt;
    samples_[pending_samples_++] = sample;
    if (pending_samples_ != samples_.size()) return std::nullopt;
    pending_samples_ = 0;
    return std::span<const float>(samples_);
  }

  [[nodiscard]] std::size_t pendingSamples() const noexcept {
    return pending_samples_;
  }

 private:
  std::vector<float> samples_;
  std::size_t pending_samples_ = 0;
};

}  // namespace syrnike::voice
