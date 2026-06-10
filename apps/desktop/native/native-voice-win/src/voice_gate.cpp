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
constexpr std::size_t kQuietHistoryMinFrames = 16;
constexpr float kQuietFloorPercentile = 0.2f;
constexpr float kNoiseFloorUpAlpha = 0.02f;
constexpr float kNoiseFloorDownAlpha = 0.25f;

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
  const bool auto_mode_changed = config_.auto_threshold != config.auto_threshold;

  config_ = config;
  config_.manual_threshold_db = clampDb(config_.manual_threshold_db);
  config_.auto_margin_db = std::max(3.0f, std::min(18.0f, config_.auto_margin_db));
  config_.hysteresis_db = std::max(2.0f, std::min(18.0f, config_.hysteresis_db));
  config_.attack_ms = std::max(1, config_.attack_ms);
  config_.hold_ms = std::max(0, config_.hold_ms);
  config_.release_ms = std::max(1, config_.release_ms);
  config_.lookahead_ms = std::max(0, config_.lookahead_ms);
  config_.floor_gain = clampGain(config_.floor_gain);

  if (auto_mode_changed) {
    resetAdaptiveState();
    open_ = true;
    below_close_ms_ = 0;
    gain_ = 1.0f;
  }
}

void VoiceGateProcessor::reset(bool open) {
  open_ = open;
  below_close_ms_ = 0;
  gain_ = open ? 1.0f : config_.floor_gain;
  resetAdaptiveState();
}

float VoiceGateProcessor::effectiveThresholdDb() const {
  if (!config_.auto_threshold) return config_.manual_threshold_db;
  return std::max(
    kAutoThresholdMinDb,
    std::min(kAutoThresholdMaxDb, noise_floor_db_ + config_.auto_margin_db)
  );
}

float VoiceGateProcessor::gainSmoothingCoefficient(float target) const {
  const int duration_ms = target > gain_ ? config_.attack_ms : config_.release_ms;
  if (duration_ms <= 1) return 1.0f;
  const float frame_ms = 10.0f;
  return std::max(0.0f, std::min(1.0f, 1.0f - std::exp(-frame_ms / static_cast<float>(duration_ms))));
}

int VoiceGateProcessor::frameDurationMs(std::span<float> samples) const {
  if (sample_rate_ <= 0) return 0;
  return static_cast<int>(
    std::lround(static_cast<double>(samples.size()) * 1000.0 / sample_rate_)
  );
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
  if (!config_.auto_threshold || !quiet) return;

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
    open_ = true;
    below_close_ms_ = 0;
    gain_ = 1.0f;
    lookahead_frames_.clear();
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
      }
    } else {
      below_close_ms_ = 0;
    }
  } else if (input_db >= threshold_db) {
    open_ = true;
    below_close_ms_ = 0;
  }

  const float target = open_ ? 1.0f : config_.floor_gain;
  const float coefficient = gainSmoothingCoefficient(target);
  gain_ += (target - gain_) * coefficient;
  gain_ = clampGain(gain_);

  std::vector<float> output = delayedOutputFrame(samples);
  const std::size_t count = std::min(samples.size(), output.size());
  for (std::size_t index = 0; index < count; ++index) {
    samples[index] = output[index] * gain_;
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
