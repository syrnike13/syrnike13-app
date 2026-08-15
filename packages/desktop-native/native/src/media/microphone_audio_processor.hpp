#pragma once

#include <cstdint>
#include <memory>
#include <span>
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
  // Valid until the next processFrame call on the same processor.
  std::span<const std::int16_t> pcm;
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
    std::span<const float> raw_frame,
    const RuntimeConfig& config,
    std::span<const std::int16_t> echo_reference_frame,
    int stream_delay_ms = 0,
    bool echo_reference_discontinuity = false
  );

private:
  bool ensureCleanupApm(const MicrophoneCleanupApmOptions& options);
  bool ensureAgcApm(bool enabled);
  void resetEchoPath(const MicrophoneCleanupApmOptions& options);

  VoiceGateProcessor gate_;
  MicrophoneCleanupApmOptions active_cleanup_options_{};
  bool active_agc_enabled_ = false;
  int active_stream_delay_ms_ = -1;
  std::unique_ptr<livekit::AudioProcessingModule> cleanup_apm_;
  std::unique_ptr<livekit::AudioProcessingModule> agc_apm_;
  std::vector<std::int16_t> mic_pcm_;
  std::vector<std::int16_t> reverse_pcm_;
  std::vector<float> processed_;
  std::vector<std::int16_t> agc_input_;
  std::vector<std::int16_t> output_pcm_;
};

}  // namespace syrnike::voice
