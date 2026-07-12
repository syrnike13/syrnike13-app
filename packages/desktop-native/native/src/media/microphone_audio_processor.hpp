#pragma once

#include <cstdint>
#include <memory>
#include <vector>

#include "audio_processing.hpp"
#include "runtime_config.hpp"
#include "voice_gate.hpp"

namespace livekit {
class AudioProcessingModule;
}

namespace syrnike::voice {

struct MicrophoneAudioProcessingOptions {
  bool noise_suppression = false;
  bool echo_cancellation = false;
  bool high_pass_filter = false;
  bool auto_gain_control = false;

  bool operator==(const MicrophoneAudioProcessingOptions&) const = default;
};

struct MicrophoneAudioProcessorFrame {
  std::vector<std::int16_t> pcm;
  VoiceGateFrameMetrics gate_metrics;
  std::uint32_t clipped_samples = 0;
  float output_peak = 0.0f;
  MicrophoneProcessingStatus status;
};

MicrophoneAudioProcessingOptions microphoneApmOptions(
  const RuntimeConfig& config,
  bool echo_reference_available
);

class MicrophoneAudioProcessor {
public:
  MicrophoneAudioProcessor();
  ~MicrophoneAudioProcessor();

  MicrophoneAudioProcessorFrame processFrame(
    const std::vector<float>& raw_frame,
    const RuntimeConfig& config,
    const std::vector<std::int16_t>* echo_reference_frame
  );

private:
  bool ensureApm(const MicrophoneAudioProcessingOptions& options);

  VoiceGateProcessor gate_;
  MicrophoneAudioProcessingOptions active_options_{};
  std::unique_ptr<livekit::AudioProcessingModule> apm_;
};

}  // namespace syrnike::voice
