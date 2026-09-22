#pragma once

#include <chrono>

namespace syrnike::windows_media::audio {

// Keep the 10 ms PCM rate when a timer wake arrives late. Recover at most one
// missed period; a long scheduling pause must not replay an old audio backlog.
class RemoteAudioMixerCadence final {
 public:
  using Clock = std::chrono::steady_clock;

  explicit RemoteAudioMixerCadence(Clock::time_point started)
      : next_due_(started + std::chrono::milliseconds{10}) {}

  unsigned framesForWake(Clock::time_point now) noexcept {
    const unsigned frames = now >= next_due_ + std::chrono::milliseconds{10} ? 2 : 1;
    next_due_ += std::chrono::milliseconds{10 * frames};
    if (next_due_ <= now) next_due_ = now + std::chrono::milliseconds{10};
    return frames;
  }

 private:
  Clock::time_point next_due_;
};

}  // namespace syrnike::windows_media::audio
