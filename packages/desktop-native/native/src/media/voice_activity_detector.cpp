#include "voice_activity_detector.hpp"

namespace syrnike::desktop_native::media {

bool VoiceActivityDetector::updateRms(
  float rms,
  bool enabled,
  std::chrono::steady_clock::time_point now
) {
  const bool previous = speaking_;
  if (!enabled) {
    speaking_ = false;
    return previous != speaking_;
  }

  if (rms >= kThresholdRms) {
    speaking_ = true;
    last_speech_ = now;
    return previous != speaking_;
  }

  if (speaking_ && now - last_speech_ >= kReleaseHold) {
    speaking_ = false;
  }
  return previous != speaking_;
}

bool VoiceActivityDetector::reset() {
  const bool previous = speaking_;
  speaking_ = false;
  last_speech_ = {};
  return previous;
}

}  // namespace syrnike::desktop_native::media
