#include "microphone_audio_processor.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <stdexcept>
#include <utility>

#include "livekit/audio_frame.h"
#include "livekit/audio_processing_module.h"

#include "audio_constants.hpp"

namespace syrnike::voice {

MicrophoneAudioProcessingOptions microphoneApmOptions(
  const RuntimeConfig& config,
  bool echo_reference_available
) {
  MicrophoneAudioProcessingOptions options;
  options.noise_suppression = config.noise_suppression_enabled;
  options.echo_cancellation =
    config.echo_cancellation_enabled && echo_reference_available;
  options.high_pass_filter =
    options.noise_suppression || options.echo_cancellation;
  options.auto_gain_control = false;
  return options;
}

MicrophoneAudioProcessor::MicrophoneAudioProcessor()
  : gate_(kSampleRate) {}

MicrophoneAudioProcessor::~MicrophoneAudioProcessor() = default;

bool MicrophoneAudioProcessor::ensureApm(
  const MicrophoneAudioProcessingOptions& options
) {
  if (options == active_options_ && apm_ != nullptr) {
    return true;
  }

  if (options != active_options_) {
    active_options_ = options;
    apm_.reset();
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
  assert(!livekit_options.auto_gain_control);

  try {
    apm_ = std::make_unique<livekit::AudioProcessingModule>(livekit_options);
  } catch (...) {
    apm_.reset();
  }

  return apm_ != nullptr;
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
  const auto options = microphoneApmOptions(config, has_reference);
  const bool apm_ready = ensureApm(options);

  std::vector<std::int16_t> mic_pcm;
  mic_pcm.reserve(kSamplesPer10Ms);
  for (float sample : raw_frame) {
    mic_pcm.push_back(clampToPcm16(sample));
  }

  bool noise_processed = false;
  bool echo_processed = false;
  if (apm_ready && apm_) {
    try {
      if (options.echo_cancellation && echo_reference_frame) {
        livekit::AudioFrame reverse(
          std::vector<std::int16_t>(*echo_reference_frame),
          kSampleRate,
          kChannels,
          kSamplesPer10Ms
        );
        apm_->processReverseStream(reverse);
        apm_->setStreamDelayMs(50);
      }

      livekit::AudioFrame forward(
        std::move(mic_pcm),
        kSampleRate,
        kChannels,
        kSamplesPer10Ms
      );
      apm_->processStream(forward);
      mic_pcm = forward.data();
      noise_processed = options.noise_suppression;
      echo_processed = options.echo_cancellation;
    } catch (...) {
      apm_.reset();
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

  MicrophoneAudioProcessorFrame result;
  result.gate_metrics = gate_metrics;
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
    if (std::abs(sample) > 1.0f) {
      result.clipped_samples += 1;
    }
    const float limited = softLimitSample(sample);
    result.output_peak = std::max(result.output_peak, std::abs(limited));
    result.pcm.push_back(clampToPcm16(limited));
  }

  return result;
}

}  // namespace syrnike::voice
