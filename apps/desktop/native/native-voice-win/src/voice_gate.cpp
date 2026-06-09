#include "voice_gate.hpp"

#include <algorithm>
#include <cmath>

namespace syrnike::voice {
namespace {

float clampGain(float value) {
  if (!std::isfinite(value)) return 0.0f;
  return std::max(0.0f, std::min(1.0f, value));
}

float rmsToDbLocal(float rms) {
  if (!std::isfinite(rms) || rms <= 0.0000001f) return -60.0f;
  return std::max(-60.0f, std::min(0.0f, 20.0f * std::log10(rms)));
}

float frameDb(std::span<float> samples) {
  if (samples.empty()) return -60.0f;

  float square_sum = 0.0f;
  for (float sample : samples) {
    square_sum += sample * sample;
  }

  return rmsToDbLocal(std::sqrt(square_sum / static_cast<float>(samples.size())));
}

int frameDurationMs(std::span<float> samples, int sample_rate) {
  if (sample_rate <= 0) return 0;
  return static_cast<int>(
    std::lround(static_cast<double>(samples.size()) * 1000.0 / sample_rate)
  );
}

}  // namespace

VoiceGateProcessor::VoiceGateProcessor(int sample_rate)
  : sample_rate_(std::max(1, sample_rate)) {}

void VoiceGateProcessor::updateConfig(const VoiceGateConfig& config) {
  config_ = config;
  config_.open_threshold_db = std::max(-60.0f, std::min(0.0f, config_.open_threshold_db));
  config_.close_threshold_db = std::max(-60.0f, std::min(config_.open_threshold_db, config_.close_threshold_db));
  config_.attack_ms = std::max(1, config_.attack_ms);
  config_.hold_ms = std::max(0, config_.hold_ms);
  config_.release_ms = std::max(1, config_.release_ms);
  config_.floor_gain = clampGain(config_.floor_gain);
}

void VoiceGateProcessor::reset(bool open) {
  open_ = open;
  below_close_ms_ = 0;
  gain_ = open ? 1.0f : config_.floor_gain;
}

float VoiceGateProcessor::smoothingStep(float target) const {
  const int duration_ms = target > gain_ ? config_.attack_ms : config_.release_ms;
  const float samples = static_cast<float>(sample_rate_) *
    static_cast<float>(duration_ms) / 1000.0f;
  if (samples <= 1.0f) return 1.0f;
  return (1.0f - config_.floor_gain) / samples;
}

VoiceGateFrameMetrics VoiceGateProcessor::processFrame(std::span<float> samples) {
  const float input_db = frameDb(samples);

  if (!config_.enabled) {
    open_ = true;
    below_close_ms_ = 0;
    for (float& sample : samples) {
      if (gain_ < 1.0f) {
        gain_ = std::min(1.0f, gain_ + smoothingStep(1.0f));
      } else if (gain_ > 1.0f) {
        gain_ = 1.0f;
      }
      sample *= gain_;
    }
    return VoiceGateFrameMetrics{
      .input_db = input_db,
      .gain = gain_,
      .open = true,
    };
  }

  if (open_) {
    if (input_db < config_.close_threshold_db) {
      below_close_ms_ += frameDurationMs(samples, sample_rate_);
      if (below_close_ms_ > config_.hold_ms) {
        open_ = false;
      }
    } else {
      below_close_ms_ = 0;
    }
  } else if (input_db >= config_.open_threshold_db) {
    open_ = true;
    below_close_ms_ = 0;
  }

  const float target = open_ ? 1.0f : config_.floor_gain;
  for (float& sample : samples) {
    if (gain_ < target) {
      gain_ = std::min(target, gain_ + smoothingStep(target));
    } else if (gain_ > target) {
      gain_ = std::max(target, gain_ - smoothingStep(target));
    }
    sample *= gain_;
  }

  return VoiceGateFrameMetrics{
    .input_db = input_db,
    .gain = gain_,
    .open = open_,
  };
}

}  // namespace syrnike::voice
