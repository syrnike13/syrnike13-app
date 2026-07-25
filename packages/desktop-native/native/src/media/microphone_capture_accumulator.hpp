#pragma once

#include <cstddef>
#include <optional>
#include <utility>
#include <vector>

namespace syrnike::voice {

class MicrophoneCaptureFrameAccumulator final {
 public:
  explicit MicrophoneCaptureFrameAccumulator(std::size_t frame_samples)
    : frame_samples_(frame_samples) {
    samples_.reserve(frame_samples_);
  }

  void beginPacket(bool discontinuity) {
    if (discontinuity) samples_.clear();
  }

  std::optional<std::vector<float>> push(float sample) {
    samples_.push_back(sample);
    if (samples_.size() != frame_samples_) return std::nullopt;
    auto frame = std::move(samples_);
    samples_.clear();
    samples_.reserve(frame_samples_);
    return frame;
  }

  [[nodiscard]] std::size_t pendingSamples() const noexcept {
    return samples_.size();
  }

 private:
  std::size_t frame_samples_;
  std::vector<float> samples_;
};

}  // namespace syrnike::voice
