#include "voice_gate.hpp"

#include <algorithm>
#include <cmath>

namespace syrnike::voice {
namespace {

constexpr float kMinDb = -60.0f;
constexpr float kMaxDb = 0.0f;
constexpr float kAutoThresholdMinDb = -50.0f;
constexpr float kAutoThresholdMaxDb = -18.0f;
constexpr std::size_t kQuietHistoryMaxFrames = 200;
constexpr std::size_t kQuietHistoryMinFrames = 20;
constexpr float kQuietFloorPercentile = 0.2f;
constexpr float kNoiseFloorUpAlpha = 0.02f;
constexpr float kNoiseFloorDownAlpha = 0.15f;
constexpr float kNoiseLearningWindowDb = 12.0f;

float clampDb(float value) {
  if (!std::isfinite(value)) return kMinDb;
  return std::max(kMinDb, std::min(kMaxDb, value));
}

float clampGain(float value) {
  if (!std::isfinite(value)) return 0.0f;
  return std::max(0.0f, std::min(1.0f, value));
}

float rmsToDbLocal(float rms) {
  if (!std::isfinite(rms) || rms <= 0.0000001f) return kMinDb;
  return clampDb(20.0f * std::log10(rms));
}

float frameDb(std::span<float> samples) {
  if (samples.empty()) return kMinDb;

  float square_sum = 0.0f;
  for (float sample : samples) {
    square_sum += sample * sample;
  }

  return rmsToDbLocal(std::sqrt(square_sum / static_cast<float>(samples.size())));
}

float percentile(std::vector<float> values, float fraction) {
  if (values.empty()) return kMinDb;
  std::sort(values.begin(), values.end());
  const auto index = static_cast<std::size_t>(
    std::floor(static_cast<float>(values.size() - 1) * fraction)
  );
  return values[std::min(index, values.size() - 1)];
}

}  // namespace

VoiceGateProcessor::VoiceGateProcessor(int sample_rate)
  : sample_rate_(std::max(1, sample_rate)) {}

void VoiceGateProcessor::updateConfig(const VoiceGateConfig& config) {
  VoiceGateConfig next = config;
  next.manual_threshold_db = clampDb(next.manual_threshold_db);
  next.auto_margin_db = std::max(3.0f, std::min(18.0f, next.auto_margin_db));
  next.hysteresis_db = std::max(2.0f, std::min(18.0f, next.hysteresis_db));
  next.attack_ms = std::max(1, next.attack_ms);
  next.hold_ms = std::max(0, next.hold_ms);
  next.release_ms = std::max(1, next.release_ms);
  next.lookahead_ms = std::max(0, next.lookahead_ms);

  const bool first_config = !config_initialized_;
  const bool enabled_changed = !first_config && config_.enabled != next.enabled;
  const bool mode_changed = !first_config &&
    config_.auto_threshold != next.auto_threshold;
  const bool lookahead_topology_changed = !first_config &&
    (config_.auto_threshold || next.auto_threshold) &&
    config_.lookahead_ms != next.lookahead_ms;

  config_ = next;
  config_initialized_ = true;
  if (first_config || enabled_changed || mode_changed) {
    resetAdaptiveState();
  }
  if (first_config || enabled_changed || mode_changed || lookahead_topology_changed) {
    resetGateState(!config_.enabled);
  }
}

void VoiceGateProcessor::reset(bool open) {
  resetAdaptiveState();
  resetGateState(open);
}

float VoiceGateProcessor::effectiveThresholdDb() const {
  if (!config_.auto_threshold) return config_.manual_threshold_db;
  return std::max(
    kAutoThresholdMinDb,
    std::min(kAutoThresholdMaxDb, noise_floor_db_ + config_.auto_margin_db)
  );
}

int VoiceGateProcessor::frameDurationMs(std::span<float> samples) const {
  if (sample_rate_ <= 0) return 0;
  return static_cast<int>(
    std::lround(static_cast<double>(samples.size()) * 1000.0 / sample_rate_)
  );
}

void VoiceGateProcessor::beginGainTransition(float target, int duration_ms) {
  target = clampGain(target);
  if (gain_ == target) {
    transition_start_gain_ = target;
    transition_target_ = target;
    transition_samples_total_ = 0;
    transition_samples_remaining_ = 0;
    return;
  }

  transition_samples_total_ = static_cast<int>(std::max(
    1.0,
    std::round(static_cast<double>(sample_rate_) * duration_ms / 1000.0)
  ));
  transition_start_gain_ = gain_;
  transition_target_ = target;
  transition_samples_remaining_ = transition_samples_total_;
}

float VoiceGateProcessor::nextGain() {
  if (transition_samples_remaining_ <= 0) return gain_;

  const int completed_samples =
    transition_samples_total_ - transition_samples_remaining_ + 1;
  const float progress = static_cast<float>(completed_samples) /
    static_cast<float>(transition_samples_total_);
  const float smooth_progress = progress * progress * (3.0f - 2.0f * progress);
  gain_ = transition_start_gain_ +
    (transition_target_ - transition_start_gain_) * smooth_progress;
  transition_samples_remaining_ -= 1;
  if (transition_samples_remaining_ == 0) {
    gain_ = transition_target_;
  }
  gain_ = clampGain(gain_);
  return gain_;
}

void VoiceGateProcessor::resetGateState(bool open) {
  open_ = open;
  below_close_ms_ = 0;
  gain_ = open ? 1.0f : 0.0f;
  transition_start_gain_ = gain_;
  transition_target_ = gain_;
  transition_samples_total_ = 0;
  transition_samples_remaining_ = 0;
  lookahead_frames_.clear();
}

int VoiceGateProcessor::lookaheadFrameCount(std::span<float> samples) const {
  if (!config_.enabled || !config_.auto_threshold || config_.lookahead_ms <= 0) {
    return 0;
  }
  const int frame_ms = std::max(1, frameDurationMs(samples));
  return std::max(0, config_.lookahead_ms / frame_ms);
}

void VoiceGateProcessor::resetAdaptiveState() {
  quiet_history_.clear();
  lookahead_frames_.clear();
  noise_floor_db_ = clampDb(config_.manual_threshold_db - config_.auto_margin_db);
}

void VoiceGateProcessor::updateNoiseFloor(float input_db, bool quiet) {
  if (!config_.auto_threshold) return;

  const bool plausible_background = !open_ &&
    input_db <= noise_floor_db_ + kNoiseLearningWindowDb;
  if (!quiet && !plausible_background) return;

  quiet_history_.push_back(clampDb(input_db));
  if (quiet_history_.size() > kQuietHistoryMaxFrames) {
    quiet_history_.erase(quiet_history_.begin());
  }

  if (quiet_history_.size() < kQuietHistoryMinFrames) return;

  const float estimated_floor = percentile(quiet_history_, kQuietFloorPercentile);
  const float alpha =
    estimated_floor > noise_floor_db_ ? kNoiseFloorUpAlpha : kNoiseFloorDownAlpha;
  noise_floor_db_ += (estimated_floor - noise_floor_db_) * alpha;
  noise_floor_db_ = clampDb(noise_floor_db_);
}

std::vector<float> VoiceGateProcessor::delayedOutputFrame(std::span<float> samples) {
  const int max_delay_frames = lookaheadFrameCount(samples);
  if (max_delay_frames <= 0) {
    lookahead_frames_.clear();
    return std::vector<float>(samples.begin(), samples.end());
  }

  lookahead_frames_.push_back(std::vector<float>(samples.begin(), samples.end()));
  if (static_cast<int>(lookahead_frames_.size()) <= max_delay_frames) {
    return std::vector<float>(samples.size(), 0.0f);
  }

  std::vector<float> output = std::move(lookahead_frames_.front());
  lookahead_frames_.pop_front();
  return output;
}

VoiceGateFrameMetrics VoiceGateProcessor::processFrame(std::span<float> samples) {
  const float input_db = frameDb(samples);

  if (!config_.enabled) {
    if (!open_ || gain_ != 1.0f || !lookahead_frames_.empty()) {
      resetGateState(true);
    }
    return VoiceGateFrameMetrics{
      .input_db = input_db,
      .noise_floor_db = noise_floor_db_,
      .threshold_db = effectiveThresholdDb(),
      .gain = gain_,
      .open = true,
      .auto_threshold = config_.auto_threshold,
    };
  }

  const float current_threshold = effectiveThresholdDb();
  const float close_threshold = std::max(kMinDb, current_threshold - config_.hysteresis_db);
  const bool quiet_for_floor = input_db < close_threshold;
  updateNoiseFloor(input_db, quiet_for_floor);

  const float threshold_db = effectiveThresholdDb();
  const float close_threshold_db = std::max(kMinDb, threshold_db - config_.hysteresis_db);

  if (open_) {
    if (input_db < close_threshold_db) {
      below_close_ms_ += frameDurationMs(samples);
      if (below_close_ms_ >= config_.hold_ms) {
        open_ = false;
        beginGainTransition(0.0f, config_.release_ms);
      }
    } else {
      below_close_ms_ = 0;
    }
  } else if (input_db >= threshold_db) {
    open_ = true;
    below_close_ms_ = 0;
    beginGainTransition(1.0f, config_.attack_ms);
  }

  std::vector<float> output = delayedOutputFrame(samples);
  const std::size_t count = std::min(samples.size(), output.size());
  for (std::size_t index = 0; index < count; ++index) {
    samples[index] = output[index] * nextGain();
  }
  for (std::size_t index = count; index < samples.size(); ++index) {
    samples[index] = 0.0f;
  }

  return VoiceGateFrameMetrics{
    .input_db = input_db,
    .noise_floor_db = noise_floor_db_,
    .threshold_db = threshold_db,
    .gain = gain_,
    .open = open_,
    .auto_threshold = config_.auto_threshold,
  };
}

}  // namespace syrnike::voice
