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
  bool resetEcho() noexcept override {
    // WebRTC Initialize reallocates its echo history (1369 allocations in the
    // epoch fixture). Never invoke it from the frame owner. A changed renderer
    // epoch disables AEC with typed unsupported until a fresh DSP is prepared;
    // independent NS, capture and publication continue with the existing owner.
    return false;
  }
 private:
  livekit::RealtimeAudioProcessing processor_;
};
}  // namespace
std::unique_ptr<MicrophoneEnhancement> makeLiveKitMicrophoneEnhancement() {
  return std::make_unique<LiveKitMicrophoneEnhancement>();
}
}  // namespace syrnike::windows_media::audio
