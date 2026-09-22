#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <span>

namespace syrnike::windows_media::audio {

// Activity is measured from fresh decoded microphone PCM on this client.
// A short hold keeps the indicator visible between syllables and inventory polls.
class RemoteSpeakerActivity final {
 public:
  using Clock = std::chrono::steady_clock;

  void observe(std::span<const std::int16_t> samples, Clock::time_point now) noexcept {
    if (samples.empty()) return;

    double energy = 0;
    for (const auto sample : samples) {
      const double normalized = static_cast<double>(sample) / 32768.0;
      energy += normalized * normalized;
    }
    const float rms = static_cast<float>(std::sqrt(energy / static_cast<double>(samples.size())));
    const float floor_coefficient = rms < noise_floor_ ? 0.05f : 0.0005f;
    noise_floor_ = (std::clamp)(noise_floor_ + floor_coefficient * (rms - noise_floor_), 0.0001f, 0.03f);
    const float threshold = (std::clamp)(noise_floor_ * 2.5f, 0.003f, 0.08f);
    if (rms >= threshold * (speaking(now) ? 0.75f : 1.0f))
      speaking_until_ = now + std::chrono::milliseconds{300};
  }

  bool speaking(Clock::time_point now) const noexcept { return now < speaking_until_; }
  Clock::time_point speakingUntil() const noexcept { return speaking_until_; }

 private:
  float noise_floor_ = 0.0001f;
  Clock::time_point speaking_until_{};
};

}  // namespace syrnike::windows_media::audio
