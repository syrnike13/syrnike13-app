#include "microphone_audio_processor.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

#include "livekit/audio_frame.h"
#include "livekit/audio_processing_module.h"

#include "audio_constants.hpp"

namespace syrnike::voice {

MicrophoneCleanupApmOptions microphoneCleanupApmOptions(
  const RuntimeConfig& config,
  bool echo_reference_available
) {
  MicrophoneCleanupApmOptions options;
  options.noise_suppression = config.noise_suppression_enabled;
  options.echo_cancellation =
    config.echo_cancellation_enabled && echo_reference_available;
  options.high_pass_filter =
    options.noise_suppression || options.echo_cancellation;
  return options;
}

MicrophoneAudioProcessor::MicrophoneAudioProcessor()
  : gate_(kSampleRate) {}

MicrophoneAudioProcessor::~MicrophoneAudioProcessor() = default;

bool MicrophoneAudioProcessor::ensureCleanupApm(
  const MicrophoneCleanupApmOptions& options
) {
  if (options == active_cleanup_options_ && cleanup_apm_ != nullptr) {
    return true;
  }

  if (options != active_cleanup_options_) {
    active_cleanup_options_ = options;
    cleanup_apm_.reset();
  }

  if (!options.noise_suppression &&
      !options.echo_cancellation &&
      !options.high_pass_filter) {
    return false;
  }

  livekit::AudioProcessingModule::Options livekit_options;
  livekit_options.noise_suppression = options.noise_suppression;
  livekit_options.echo_cancellation = options.echo_cancellation;
  livekit_options.high_pass_filter = options.high_pass_filter;
  livekit_options.auto_gain_control = false;

  try {
    cleanup_apm_ =
      std::make_unique<livekit::AudioProcessingModule>(livekit_options);
  } catch (...) {
    cleanup_apm_.reset();
  }

  return cleanup_apm_ != nullptr;
}

bool MicrophoneAudioProcessor::ensureAgcApm(bool enabled) {
  if (enabled == active_agc_enabled_ && agc_apm_ != nullptr) {
    return true;
  }

  if (enabled != active_agc_enabled_) {
    active_agc_enabled_ = enabled;
    agc_apm_.reset();
  }

  if (!enabled) {
    return false;
  }

  livekit::AudioProcessingModule::Options livekit_options;
  livekit_options.noise_suppression = false;
  livekit_options.echo_cancellation = false;
  livekit_options.high_pass_filter = false;
  livekit_options.auto_gain_control = true;

  try {
    agc_apm_ = std::make_unique<livekit::AudioProcessingModule>(livekit_options);
  } catch (...) {
    agc_apm_.reset();
  }

  return agc_apm_ != nullptr;
}

MicrophoneAudioProcessorFrame MicrophoneAudioProcessor::processFrame(
  const std::vector<float>& raw_frame,
  const RuntimeConfig& config,
  const std::vector<std::int16_t>* echo_reference_frame
) {
  if (raw_frame.size() != kSamplesPer10Ms) {
    throw std::invalid_argument("microphone processor requires exactly 10ms frames");
  }

  const bool has_reference =
    echo_reference_frame != nullptr && echo_reference_frame->size() == kSamplesPer10Ms;
  const auto cleanup_options = microphoneCleanupApmOptions(config, has_reference);
  const bool cleanup_apm_ready = ensureCleanupApm(cleanup_options);

  std::vector<std::int16_t> mic_pcm;
  mic_pcm.reserve(kSamplesPer10Ms);
  for (float sample : raw_frame) {
    mic_pcm.push_back(clampToPcm16(sample));
  }

  bool noise_processed = false;
  bool echo_processed = false;
  if (cleanup_apm_ready && cleanup_apm_) {
    try {
      if (cleanup_options.echo_cancellation && echo_reference_frame) {
        livekit::AudioFrame reverse(
          std::vector<std::int16_t>(*echo_reference_frame),
          kSampleRate,
          kChannels,
          kSamplesPer10Ms
        );
        cleanup_apm_->processReverseStream(reverse);
        cleanup_apm_->setStreamDelayMs(50);
      }

      livekit::AudioFrame forward(
        std::move(mic_pcm),
        kSampleRate,
        kChannels,
        kSamplesPer10Ms
      );
      cleanup_apm_->processStream(forward);
      mic_pcm = forward.data();
      noise_processed = cleanup_options.noise_suppression;
      echo_processed = cleanup_options.echo_cancellation;
    } catch (...) {
      cleanup_apm_.reset();
      mic_pcm.clear();
      mic_pcm.reserve(kSamplesPer10Ms);
      for (float sample : raw_frame) {
        mic_pcm.push_back(clampToPcm16(sample));
      }
    }
  }

  std::vector<float> processed;
  processed.reserve(kSamplesPer10Ms);
  for (std::int16_t sample : mic_pcm) {
    processed.push_back(
      (static_cast<float>(sample) / 32768.0f) * config.input_volume
    );
  }

  gate_.updateConfig(voiceGateConfigFromRuntimeConfig(config));
  const VoiceGateFrameMetrics gate_metrics = gate_.processFrame(processed);

  std::uint32_t clipped_samples = 0;
  if (config.automatic_gain_control_enabled) {
    std::vector<std::int16_t> agc_input;
    agc_input.reserve(kSamplesPer10Ms);
    for (float sample : processed) {
      // WebRTC's APM accepts PCM16. Count this unavoidable boundary clamp as
      // clipping, while keeping the safety soft limiter after the AGC stage.
      if (std::abs(sample) > 1.0f) {
        clipped_samples += 1;
      }
      agc_input.push_back(clampToPcm16(sample));
    }

    if (ensureAgcApm(true) && agc_apm_) {
      try {
        livekit::AudioFrame agc_frame(
          std::move(agc_input),
          kSampleRate,
          kChannels,
          kSamplesPer10Ms
        );
        agc_apm_->processStream(agc_frame);

        processed.clear();
        processed.reserve(kSamplesPer10Ms);
        for (std::int16_t sample : agc_frame.data()) {
          processed.push_back(static_cast<float>(sample) / 32768.0f);
        }
      } catch (...) {
        agc_apm_.reset();
        // Keep the post-volume, post-gate float frame as the safe AGC bypass.
      }
    }
  } else {
    ensureAgcApm(false);
  }

  // The gate envelope reaches literal zero before AGC. Enforce that state on
  // the final frame as well, so adaptive gain cannot resurrect a closed gate
  // through internal state or rounding at the PCM16 boundary.
  if (config.voice_gate_enabled && !gate_metrics.open && gate_metrics.gain == 0.0f) {
    std::fill(processed.begin(), processed.end(), 0.0f);
  }

  MicrophoneAudioProcessorFrame result;
  result.gate_metrics = gate_metrics;
  result.clipped_samples = clipped_samples;
  result.status.noise_suppression =
    config.noise_suppression_enabled
      ? (noise_processed ? "software" : "unavailable")
      : "disabled";
  result.status.echo_cancellation =
    config.echo_cancellation_enabled
      ? (echo_processed ? "software" : "unavailable")
      : "disabled";

  result.pcm.reserve(kSamplesPer10Ms);
  for (float sample : processed) {
    if (!config.automatic_gain_control_enabled && std::abs(sample) > 1.0f) {
      result.clipped_samples += 1;
    }
    const float limited = softLimitSample(sample);
    result.output_peak = std::max(result.output_peak, std::abs(limited));
    result.pcm.push_back(clampToPcm16(limited));
  }

  return result;
}

}  // namespace syrnike::voice
