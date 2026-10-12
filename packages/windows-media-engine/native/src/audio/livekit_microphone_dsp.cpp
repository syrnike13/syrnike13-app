#include "audio/livekit_microphone_dsp.hpp"
#include <livekit/realtime_audio_processing.h>

namespace syrnike::windows_media::audio {
namespace {
class LiveKitMicrophoneEnhancement final : public MicrophoneEnhancement {
 public:
  EchoAvailability process(std::array<std::int16_t, kMicrophoneFrameSamples>& samples,
                           const EchoReferenceFrame* reference, bool noise, bool echo) noexcept override {
    const auto result = processor_.process(samples, reference ? &reference->samples : nullptr,
                                           reference ? reference->stream_delay_ms : 0, noise, echo);
    if (result != livekit::RealtimeAudioProcessingResult::ok) return EchoAvailability::failed;
    return !echo ? EchoAvailability::disabled : reference ? EchoAvailability::active : EchoAvailability::unavailable;
  }
  bool processGain(std::array<std::int16_t, kMicrophoneFrameSamples>& samples) noexcept override {
    return processor_.processGain(samples) == livekit::RealtimeAudioProcessingResult::ok;
  }
  bool resetEcho() noexcept override {
    // WebRTC Initialize reallocates its echo history, so it never runs on the
    // frame owner. AEC3 re-estimates delay and re-converges its filter on a new
    // render timeline by itself, as it does when a WebRTC playout device
    // changes. Keep cancelling instead of disabling AEC for the warm DSP's
    // remaining lifetime (every later call and output device switch).
    return true;
  }
 private:
  livekit::RealtimeAudioProcessing processor_;
};
}  // namespace
std::unique_ptr<MicrophoneEnhancement> makeLiveKitMicrophoneEnhancement() {
  return std::make_unique<LiveKitMicrophoneEnhancement>();
}
}  // namespace syrnike::windows_media::audio
