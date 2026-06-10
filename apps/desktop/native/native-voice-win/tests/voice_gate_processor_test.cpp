#include "runtime_config.hpp"
#include "voice_gate.hpp"

#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

constexpr int kSampleRate = 48000;
constexpr int kFrameSamples = 480;

float dbToLinear(float db) {
  return std::pow(10.0f, db / 20.0f);
}

std::vector<float> toneFrame(float db) {
  return std::vector<float>(kFrameSamples, dbToLinear(db));
}

std::vector<float> sineFrame(float frequency_hz, float db, int samples = kSampleRate / 5) {
  std::vector<float> frame;
  frame.reserve(static_cast<size_t>(samples));
  const float amplitude = dbToLinear(db);
  constexpr float pi = 3.14159265358979323846f;
  for (int index = 0; index < samples; ++index) {
    const float phase = 2.0f * pi * frequency_hz *
      static_cast<float>(index) / static_cast<float>(kSampleRate);
    frame.push_back(std::sin(phase) * amplitude);
  }
  return frame;
}

float rms(const std::vector<float>& samples) {
  float square_sum = 0.0f;
  for (float sample : samples) {
    square_sum += sample * sample;
  }
  return std::sqrt(square_sum / static_cast<float>(samples.size()));
}

float peak(const std::vector<float>& samples) {
  float value = 0.0f;
  for (float sample : samples) {
    value = std::max(value, std::abs(sample));
  }
  return value;
}

void expect(bool condition, const std::string& message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

void expectNear(float actual, float expected, float epsilon, const std::string& message) {
  if (std::abs(actual - expected) > epsilon) {
    throw std::runtime_error(
      message + ": expected " + std::to_string(expected) + ", got " + std::to_string(actual)
    );
  }
}

syrnike::voice::VoiceGateConfig manualConfig() {
  syrnike::voice::VoiceGateConfig config;
  config.enabled = true;
  config.auto_threshold = false;
  config.manual_threshold_db = -26.0f;
  config.auto_margin_db = 8.0f;
  config.hysteresis_db = 6.0f;
  config.attack_ms = 4;
  config.hold_ms = 50;
  config.release_ms = 100;
  config.lookahead_ms = 0;
  config.floor_gain = 0.125f;
  return config;
}

syrnike::voice::VoiceGateConfig autoConfig() {
  auto config = manualConfig();
  config.auto_threshold = true;
  config.manual_threshold_db = -28.0f;
  config.hold_ms = 180;
  config.lookahead_ms = 20;
  return config;
}

void protocol_reads_voice_gate_auto_threshold() {
  const auto command = syrnike::voice::parseStartCommand(
    "{\"cmd\":\"connect_microphone\",\"voiceGateAutoThreshold\":true}"
  );

  expect(command.voice_gate_auto_threshold, "protocol should parse enabled auto voice gate");

  const auto default_command = syrnike::voice::parseStartCommand(
    "{\"cmd\":\"connect_microphone\"}"
  );

  expect(default_command.voice_gate_auto_threshold, "auto voice gate should default to enabled");
}

void runtime_config_stores_voice_gate_auto_threshold() {
  syrnike::voice::StartCommand command;
  command.voice_gate_auto_threshold = false;
  syrnike::voice::updateRuntimeConfig(command);
  expect(
    !syrnike::voice::readRuntimeConfig().voice_gate_auto_threshold,
    "runtime config should store disabled auto voice gate"
  );

  command.voice_gate_auto_threshold = true;
  syrnike::voice::updateRuntimeConfig(command);
  expect(
    syrnike::voice::readRuntimeConfig().voice_gate_auto_threshold,
    "runtime config should store enabled auto voice gate"
  );
}

void disabled_gate_leaves_audio_and_reports_open() {
  syrnike::voice::VoiceGateProcessor gate(kSampleRate);
  auto config = manualConfig();
  config.enabled = false;
  gate.updateConfig(config);

  auto frame = toneFrame(-45.0f);
  const auto before = peak(frame);
  const auto metrics = gate.processFrame(frame);

  expect(metrics.open, "disabled gate should report open");
  expectNear(metrics.gain, 1.0f, 0.001f, "disabled gate should keep unity gain");
  expectNear(metrics.threshold_db, -26.0f, 0.001f, "disabled manual gate should report manual threshold");
  expectNear(peak(frame), before, 0.0001f, "disabled gate should not change samples");
}

void manual_gate_uses_manual_threshold_and_hysteresis() {
  syrnike::voice::VoiceGateProcessor gate(kSampleRate);
  gate.updateConfig(manualConfig());

  auto loud = toneFrame(-20.0f);
  const auto loud_metrics = gate.processFrame(loud);
  expect(loud_metrics.open, "manual gate should open above manual threshold");
  expect(!loud_metrics.auto_threshold, "manual gate metrics should identify manual mode");
  expectNear(loud_metrics.threshold_db, -26.0f, 0.001f, "manual gate should report manual threshold");

  for (int frame_index = 0; frame_index < 5; ++frame_index) {
    auto quiet = toneFrame(-40.0f);
    gate.processFrame(quiet);
  }

  auto between = toneFrame(-29.0f);
  const auto between_metrics = gate.processFrame(between);
  expect(!between_metrics.open, "closed manual gate should not reopen below manual threshold");

  auto reopen = toneFrame(-20.0f);
  const auto reopen_metrics = gate.processFrame(reopen);
  expect(reopen_metrics.open, "manual gate should reopen at manual threshold");
}

void auto_gate_raises_threshold_above_steady_room_noise() {
  syrnike::voice::VoiceGateProcessor gate(kSampleRate);
  gate.updateConfig(autoConfig());

  syrnike::voice::VoiceGateFrameMetrics metrics;
  for (int frame_index = 0; frame_index < 80; ++frame_index) {
    auto noise = toneFrame(-48.0f);
    metrics = gate.processFrame(noise);
  }

  expect(metrics.auto_threshold, "auto gate should report auto threshold mode");
  expect(metrics.threshold_db > -43.0f, "auto gate should raise threshold above the measured noise floor");
  expect(metrics.threshold_db < -34.0f, "auto gate should keep a conservative speech threshold");
  expect(metrics.noise_floor_db < metrics.threshold_db, "auto gate should report noise floor below threshold");
}

void auto_gate_does_not_learn_short_loud_transient_as_noise_floor() {
  syrnike::voice::VoiceGateProcessor gate(kSampleRate);
  gate.updateConfig(autoConfig());

  syrnike::voice::VoiceGateFrameMetrics metrics;
  for (int frame_index = 0; frame_index < 80; ++frame_index) {
    auto noise = toneFrame(-50.0f);
    metrics = gate.processFrame(noise);
  }
  const float before_threshold = metrics.threshold_db;

  auto transient = toneFrame(-8.0f);
  gate.processFrame(transient);

  for (int frame_index = 0; frame_index < 10; ++frame_index) {
    auto noise = toneFrame(-50.0f);
    metrics = gate.processFrame(noise);
  }

  expect(
    metrics.threshold_db <= before_threshold + 1.0f,
    "auto gate should not raise threshold after a short loud transient"
  );
}

void auto_gate_uses_lookahead_only_in_auto_mode() {
  syrnike::voice::VoiceGateProcessor auto_gate(kSampleRate);
  auto_gate.updateConfig(autoConfig());

  for (int frame_index = 0; frame_index < 80; ++frame_index) {
    auto noise = toneFrame(-50.0f);
    auto_gate.processFrame(noise);
  }

  auto auto_speech = toneFrame(-18.0f);
  const float auto_input_peak = peak(auto_speech);
  const auto auto_metrics = auto_gate.processFrame(auto_speech);
  expect(auto_metrics.open, "auto gate should open quickly on speech");
  expect(
    peak(auto_speech) < auto_input_peak * 0.5f,
    "auto gate should output delayed pre-roll on the opening frame"
  );

  syrnike::voice::VoiceGateProcessor manual_gate(kSampleRate);
  manual_gate.updateConfig(manualConfig());
  auto manual_speech = toneFrame(-18.0f);
  const float manual_input_peak = peak(manual_speech);
  const auto manual_metrics = manual_gate.processFrame(manual_speech);

  expect(manual_metrics.open, "manual gate should open immediately");
  expect(
    peak(manual_speech) > manual_input_peak * 0.9f,
    "manual gate should not add lookahead delay"
  );
}

void open_gate_is_frequency_neutral() {
  syrnike::voice::VoiceGateProcessor gate(kSampleRate);
  gate.updateConfig(manualConfig());

  auto low = sineFrame(120.0f, -20.0f);
  const float low_before = rms(low);
  const auto low_metrics = gate.processFrame(low);
  const float low_gain = rms(low) / low_before;

  auto high = sineFrame(2000.0f, -20.0f);
  const float high_before = rms(high);
  const auto high_metrics = gate.processFrame(high);
  const float high_gain = rms(high) / high_before;

  expect(low_metrics.open, "low frequency tone should keep gate open");
  expect(high_metrics.open, "high frequency tone should keep gate open");
  expectNear(low_gain, 1.0f, 0.001f, "open gate should not attenuate low frequency content");
  expectNear(high_gain, 1.0f, 0.001f, "open gate should not attenuate high frequency content");
  expectNear(low_gain, high_gain, 0.001f, "open gate should be frequency neutral");
}

void gate_uses_hold_before_release() {
  syrnike::voice::VoiceGateProcessor gate(kSampleRate);
  gate.updateConfig(manualConfig());

  auto loud = toneFrame(-20.0f);
  gate.processFrame(loud);

  for (int frame_index = 0; frame_index < 4; ++frame_index) {
    auto quiet = toneFrame(-50.0f);
    const auto metrics = gate.processFrame(quiet);
    expect(metrics.open, "gate should stay open during hold window");
    expectNear(metrics.gain, 1.0f, 0.001f, "gate should keep unity gain during hold");
  }
}

void gate_releases_smoothly_instead_of_zeroing_a_frame() {
  syrnike::voice::VoiceGateProcessor gate(kSampleRate);
  gate.updateConfig(manualConfig());

  auto loud = toneFrame(-20.0f);
  gate.processFrame(loud);

  for (int frame_index = 0; frame_index < 5; ++frame_index) {
    auto hold = toneFrame(-50.0f);
    gate.processFrame(hold);
  }

  auto first_release = toneFrame(-50.0f);
  const auto input_peak = peak(first_release);
  const auto metrics = gate.processFrame(first_release);
  const auto output_peak = peak(first_release);

  expect(!metrics.open, "gate should start closing after hold");
  expect(output_peak > 0.0f, "release should not hard-zero the first closing frame");
  expect(output_peak < input_peak, "release should reduce the first closing frame");
}

void toggling_auto_mode_does_not_leave_gate_stuck_closed() {
  syrnike::voice::VoiceGateProcessor gate(kSampleRate);
  auto config = autoConfig();
  gate.updateConfig(config);

  for (int frame_index = 0; frame_index < 80; ++frame_index) {
    auto quiet = toneFrame(-50.0f);
    gate.processFrame(quiet);
  }

  config.auto_threshold = false;
  config.manual_threshold_db = -30.0f;
  config.lookahead_ms = 0;
  gate.updateConfig(config);

  auto speech = toneFrame(-20.0f);
  const auto metrics = gate.processFrame(speech);
  expect(metrics.open, "manual gate should open after auto mode is disabled");
  expectNear(metrics.threshold_db, -30.0f, 0.001f, "manual threshold should apply after auto mode toggle");
}

}  // namespace

int main() {
  using TestFn = void (*)();
  TestFn tests[] = {
    protocol_reads_voice_gate_auto_threshold,
    runtime_config_stores_voice_gate_auto_threshold,
    disabled_gate_leaves_audio_and_reports_open,
    manual_gate_uses_manual_threshold_and_hysteresis,
    auto_gate_raises_threshold_above_steady_room_noise,
    auto_gate_does_not_learn_short_loud_transient_as_noise_floor,
    auto_gate_uses_lookahead_only_in_auto_mode,
    open_gate_is_frequency_neutral,
    gate_uses_hold_before_release,
    gate_releases_smoothly_instead_of_zeroing_a_frame,
    toggling_auto_mode_does_not_leave_gate_stuck_closed,
  };

  for (const auto test : tests) {
    try {
      test();
    } catch (const std::exception& error) {
      std::cerr << error.what() << '\n';
      return 1;
    }
  }

  return 0;
}
