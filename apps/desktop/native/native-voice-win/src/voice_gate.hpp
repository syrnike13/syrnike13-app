#pragma once

#include <span>

namespace syrnike::voice {

struct VoiceGateConfig {
  bool enabled = true;
  float open_threshold_db = -28.0f;
  float close_threshold_db = -34.0f;
  int attack_ms = 10;
  int hold_ms = 120;
  int release_ms = 160;
  float floor_gain = 0.0f;
};

struct VoiceGateFrameMetrics {
  float input_db = -60.0f;
  float gain = 1.0f;
  bool open = true;
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
  bool open_ = true;
  float gain_ = 1.0f;
  int below_close_ms_ = 0;

  float smoothingStep(float target) const;
};

}  // namespace syrnike::voice
