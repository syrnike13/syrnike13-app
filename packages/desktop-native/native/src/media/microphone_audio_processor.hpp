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

struct MicrophoneCleanupApmOptions {
  bool noise_suppression = false;
  bool echo_cancellation = false;
  bool high_pass_filter = false;

  bool operator==(const MicrophoneCleanupApmOptions&) const = default;
};

struct MicrophoneAudioProcessorFrame {
  std::vector<std::int16_t> pcm;
  VoiceGateFrameMetrics gate_metrics;
  std::uint32_t clipped_samples = 0;
  float output_peak = 0.0f;
  MicrophoneProcessingStatus status;
};

MicrophoneCleanupApmOptions microphoneCleanupApmOptions(
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
  bool ensureCleanupApm(const MicrophoneCleanupApmOptions& options);
  bool ensureAgcApm(bool enabled);

  VoiceGateProcessor gate_;
  MicrophoneCleanupApmOptions active_cleanup_options_{};
  bool active_agc_enabled_ = false;
  std::unique_ptr<livekit::AudioProcessingModule> cleanup_apm_;
  std::unique_ptr<livekit::AudioProcessingModule> agc_apm_;
};

}  // namespace syrnike::voice
