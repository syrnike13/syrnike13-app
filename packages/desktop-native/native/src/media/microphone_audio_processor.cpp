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
  : gate_(kSampleRate) {
  mic_pcm_.reserve(kSamplesPer10Ms);
  reverse_pcm_.reserve(kSamplesPer10Ms);
  processed_.reserve(kSamplesPer10Ms);
  agc_input_.reserve(kSamplesPer10Ms);
  output_pcm_.reserve(kSamplesPer10Ms);
}

MicrophoneAudioProcessor::~MicrophoneAudioProcessor() = default;

bool MicrophoneAudioProcessor::ensureCleanupApm(
  const MicrophoneCleanupApmOptions& options
) {
  if (!options.noise_suppression &&
      !options.echo_cancellation &&
      !options.high_pass_filter) {
    if (cleanup_apm_ && options != active_cleanup_options_) {
      try {
        cleanup_apm_->applyOptions({});
        active_cleanup_options_ = options;
      } catch (...) {
        cleanup_apm_.reset();
      }
    }
    return false;
  }

  try {
    livekit::AudioProcessingModule::Options livekit_options;
    livekit_options.noise_suppression = options.noise_suppression;
    livekit_options.echo_cancellation = options.echo_cancellation;
    livekit_options.high_pass_filter = options.high_pass_filter;
    livekit_options.auto_gain_control = false;
    if (!cleanup_apm_) {
      cleanup_apm_ =
        std::make_unique<livekit::AudioProcessingModule>(livekit_options);
    } else if (options != active_cleanup_options_) {
      cleanup_apm_->applyOptions(livekit_options);
    }
    active_cleanup_options_ = options;
  } catch (...) {
    try {
      livekit::AudioProcessingModule::Options livekit_options;
      livekit_options.noise_suppression = options.noise_suppression;
      livekit_options.echo_cancellation = options.echo_cancellation;
      livekit_options.high_pass_filter = options.high_pass_filter;
      cleanup_apm_ =
        std::make_unique<livekit::AudioProcessingModule>(livekit_options);
      active_cleanup_options_ = options;
    } catch (...) {
      cleanup_apm_.reset();
    }
  }

  return cleanup_apm_ != nullptr;
}

bool MicrophoneAudioProcessor::ensureAgcApm(bool enabled) {
  if (!enabled) {
    if (agc_apm_ && active_agc_enabled_) {
      try {
        agc_apm_->applyOptions({});
      } catch (...) {
        agc_apm_.reset();
      }
    }
    active_agc_enabled_ = false;
    return false;
  }

  try {
    livekit::AudioProcessingModule::Options livekit_options;
    livekit_options.auto_gain_control = true;
    if (!agc_apm_) {
      agc_apm_ = std::make_unique<livekit::AudioProcessingModule>(livekit_options);
    } else if (!active_agc_enabled_) {
      agc_apm_->applyOptions(livekit_options);
    }
    active_agc_enabled_ = true;
  } catch (...) {
    agc_apm_.reset();
  }

  return agc_apm_ != nullptr;
}

void MicrophoneAudioProcessor::resetEchoPath(
  const MicrophoneCleanupApmOptions& options
) {
  if (!cleanup_apm_ || !options.echo_cancellation) return;
  livekit::AudioProcessingModule::Options without_echo;
  without_echo.noise_suppression = options.noise_suppression;
  without_echo.high_pass_filter = options.high_pass_filter;
  cleanup_apm_->applyOptions(without_echo);
  livekit::AudioProcessingModule::Options restored;
  restored.noise_suppression = options.noise_suppression;
  restored.echo_cancellation = true;
  restored.high_pass_filter = options.high_pass_filter;
  cleanup_apm_->applyOptions(restored);
  active_stream_delay_ms_ = -1;
}

MicrophoneAudioProcessorFrame MicrophoneAudioProcessor::processFrame(
  std::span<const float> raw_frame,
  const RuntimeConfig& config,
  std::span<const std::int16_t> echo_reference_frame,
  int stream_delay_ms,
  bool echo_reference_discontinuity
) {
  if (raw_frame.size() != kSamplesPer10Ms) {
    throw std::invalid_argument("microphone processor requires exactly 10ms frames");
  }

  const bool has_reference =
    echo_reference_frame.size() == kSamplesPer10Ms;
  const auto cleanup_options = microphoneCleanupApmOptions(config, has_reference);
  const bool cleanup_apm_ready = ensureCleanupApm(cleanup_options);

  mic_pcm_.resize(kSamplesPer10Ms);
  for (std::size_t index = 0; index < raw_frame.size(); ++index) {
    mic_pcm_[index] = clampToPcm16(raw_frame[index]);
  }

  bool noise_processed = false;
  bool echo_processed = false;
  if (cleanup_apm_ready && cleanup_apm_) {
    try {
      if (cleanup_options.echo_cancellation && !echo_reference_frame.empty()) {
        if (echo_reference_discontinuity) {
          resetEchoPath(cleanup_options);
        }
        reverse_pcm_.assign(
          echo_reference_frame.begin(),
          echo_reference_frame.end()
        );
        livekit::AudioFrame reverse(
          std::move(reverse_pcm_),
          kSampleRate,
          kChannels,
          kSamplesPer10Ms
        );
        cleanup_apm_->processReverseStream(reverse);
        reverse_pcm_ = std::move(reverse.data());
        const int bounded_delay = std::clamp(stream_delay_ms, 0, 500);
        if (active_stream_delay_ms_ != bounded_delay) {
          cleanup_apm_->setStreamDelayMs(bounded_delay);
          active_stream_delay_ms_ = bounded_delay;
        }
      }

      livekit::AudioFrame forward(
        std::move(mic_pcm_),
        kSampleRate,
        kChannels,
        kSamplesPer10Ms
      );
      try {
        cleanup_apm_->processStream(forward);
        mic_pcm_ = std::move(forward.data());
      } catch (...) {
        mic_pcm_ = std::move(forward.data());
        throw;
      }
      noise_processed = cleanup_options.noise_suppression;
      echo_processed = cleanup_options.echo_cancellation;
    } catch (...) {
      cleanup_apm_.reset();
      mic_pcm_.resize(kSamplesPer10Ms);
      for (std::size_t index = 0; index < raw_frame.size(); ++index) {
        mic_pcm_[index] = clampToPcm16(raw_frame[index]);
      }
    }
  }

  processed_.resize(kSamplesPer10Ms);
  for (std::size_t index = 0; index < mic_pcm_.size(); ++index) {
    processed_[index] =
      (static_cast<float>(mic_pcm_[index]) / 32768.0f) * config.input_volume;
  }

  gate_.updateConfig(voiceGateConfigFromRuntimeConfig(config));
  const VoiceGateFrameMetrics gate_metrics = gate_.processFrame(processed_);

  std::uint32_t clipped_samples = 0;
  if (config.automatic_gain_control_enabled) {
    agc_input_.resize(kSamplesPer10Ms);
    for (std::size_t index = 0; index < processed_.size(); ++index) {
      const float sample = processed_[index];
      // WebRTC's APM accepts PCM16. Count this unavoidable boundary clamp as
      // clipping, while keeping the safety soft limiter after the AGC stage.
      if (std::abs(sample) > 1.0f) {
        clipped_samples += 1;
      }
      agc_input_[index] = clampToPcm16(sample);
    }

    if (ensureAgcApm(true) && agc_apm_) {
      try {
        livekit::AudioFrame agc_frame(
          std::move(agc_input_),
          kSampleRate,
          kChannels,
          kSamplesPer10Ms
        );
        try {
          agc_apm_->processStream(agc_frame);
          agc_input_ = std::move(agc_frame.data());
        } catch (...) {
          agc_input_ = std::move(agc_frame.data());
          throw;
        }
        processed_.resize(kSamplesPer10Ms);
        for (std::size_t index = 0; index < agc_input_.size(); ++index) {
          processed_[index] =
            static_cast<float>(agc_input_[index]) / 32768.0f;
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
    std::fill(processed_.begin(), processed_.end(), 0.0f);
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

  output_pcm_.resize(kSamplesPer10Ms);
  for (std::size_t index = 0; index < processed_.size(); ++index) {
    const float sample = processed_[index];
    if (!config.automatic_gain_control_enabled && std::abs(sample) > 1.0f) {
      result.clipped_samples += 1;
    }
    const float limited = softLimitSample(sample);
    result.output_peak = std::max(result.output_peak, std::abs(limited));
    output_pcm_[index] = clampToPcm16(limited);
  }
  result.pcm = std::span<const std::int16_t>(output_pcm_);

  return result;
}

}  // namespace syrnike::voice
