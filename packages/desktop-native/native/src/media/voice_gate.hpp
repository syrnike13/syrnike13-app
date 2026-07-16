#pragma once

#include <deque>
#include <span>
#include <vector>

namespace syrnike::voice {

struct VoiceGateConfig {
  bool enabled = true;
  bool auto_threshold = true;
  float manual_threshold_db = -28.0f;
  float auto_margin_db = 8.0f;
  float hysteresis_db = 6.0f;
  int attack_ms = 4;
  int hold_ms = 240;
  int release_ms = 120;
  int lookahead_ms = 20;
};

struct VoiceGateFrameMetrics {
  float input_db = -60.0f;
  float noise_floor_db = -60.0f;
  float threshold_db = -28.0f;
  float gain = 1.0f;
  bool open = true;
  bool auto_threshold = false;
};

class VoiceGateProcessor {
public:
  explicit VoiceGateProcessor(int sample_rate);

  void updateConfig(const VoiceGateConfig& config);
  void reset(bool open = true);
  VoiceGateFrameMetrics processFrame(std::span<float> samples);

private:
  int sample_rate_;
  VoiceGateConfig config_;
  bool config_initialized_ = false;
  bool open_ = false;
  float gain_ = 0.0f;
  float transition_start_gain_ = 0.0f;
  float transition_target_ = 0.0f;
  int transition_samples_total_ = 0;
  int transition_samples_remaining_ = 0;
  int below_close_ms_ = 0;
  float noise_floor_db_ = -36.0f;
  std::vector<float> quiet_history_;
  std::deque<std::vector<float>> lookahead_frames_;

  float effectiveThresholdDb() const;
  int frameDurationMs(std::span<float> samples) const;
  int lookaheadFrameCount(std::span<float> samples) const;
  void beginGainTransition(float target, int duration_ms);
  float nextGain();
  void resetGateState(bool open);
  void resetAdaptiveState();
  void updateNoiseFloor(float input_db, bool quiet);
  std::vector<float> delayedOutputFrame(std::span<float> samples);
};

}  // namespace syrnike::voice
