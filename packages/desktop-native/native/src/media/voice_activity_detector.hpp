#pragma once

#include <chrono>

namespace syrnike::desktop_native::media {

// Stateful voice-activity policy. Audio capture and routing stay outside this
// module; callers provide one normalized post-processing RMS value per frame.
class VoiceActivityDetector final {
 public:
  static constexpr float kThresholdRms = 0.0012589F; // -58 dBFS
  static constexpr auto kReleaseHold = std::chrono::milliseconds(180);

  bool updateRms(
    float rms,
    bool enabled,
    std::chrono::steady_clock::time_point now
  );
  bool reset();
  bool speaking() const { return speaking_; }

 private:
  bool speaking_ = false;
  std::chrono::steady_clock::time_point last_speech_{};
};

}  // namespace syrnike::desktop_native::media
