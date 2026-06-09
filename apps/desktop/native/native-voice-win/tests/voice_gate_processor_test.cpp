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

syrnike::voice::VoiceGateConfig testConfig() {
  syrnike::voice::VoiceGateConfig config;
  config.enabled = true;
  config.open_threshold_db = -26.0f;
  config.close_threshold_db = -32.0f;
  config.attack_ms = 10;
  config.hold_ms = 50;
  config.release_ms = 100;
  config.floor_gain = 0.0f;
  return config;
}

void disabled_gate_leaves_audio_and_reports_open() {
  syrnike::voice::VoiceGateProcessor gate(kSampleRate);
  auto config = testConfig();
  config.enabled = false;
  gate.updateConfig(config);

  auto frame = toneFrame(-45.0f);
  const auto before = peak(frame);
  const auto metrics = gate.processFrame(frame);

  expect(metrics.open, "disabled gate should report open");
  expectNear(metrics.gain, 1.0f, 0.001f, "disabled gate should keep unity gain");
  expectNear(peak(frame), before, 0.0001f, "disabled gate should not change samples");
}

void disabling_gate_recovers_smoothly_from_closed_state() {
  syrnike::voice::VoiceGateProcessor gate(kSampleRate);
  auto config = testConfig();
  gate.updateConfig(config);

  auto loud = toneFrame(-20.0f);
  gate.processFrame(loud);

  for (int frame_index = 0; frame_index < 20; ++frame_index) {
    auto quiet = toneFrame(-50.0f);
    gate.processFrame(quiet);
  }

  config.enabled = false;
  gate.updateConfig(config);

  auto disabled = toneFrame(-20.0f);
  const auto input_peak = peak(disabled);
  const auto metrics = gate.processFrame(disabled);

  expect(metrics.open, "disabled gate should report open while recovering");
  expect(std::abs(disabled.front()) > 0.0f, "disabled gate should start recovering immediately");
  expect(std::abs(disabled.front()) < input_peak, "disabled gate should not jump from closed to unity in one sample");

  for (int frame_index = 0; frame_index < 2; ++frame_index) {
    auto recover = toneFrame(-20.0f);
    gate.processFrame(recover);
  }

  auto recovered = toneFrame(-20.0f);
  gate.processFrame(recovered);
  expectNear(peak(recovered), input_peak, 0.001f, "disabled gate should return to unity after attack");
}

void gate_uses_hold_before_release() {
  syrnike::voice::VoiceGateProcessor gate(kSampleRate);
  gate.updateConfig(testConfig());

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
  gate.updateConfig(testConfig());

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

void closed_gate_requires_open_threshold_to_reopen() {
  syrnike::voice::VoiceGateProcessor gate(kSampleRate);
  gate.updateConfig(testConfig());

  auto loud = toneFrame(-20.0f);
  gate.processFrame(loud);

  for (int frame_index = 0; frame_index < 20; ++frame_index) {
    auto quiet = toneFrame(-50.0f);
    gate.processFrame(quiet);
  }

  auto between_thresholds = toneFrame(-29.0f);
  const auto between_metrics = gate.processFrame(between_thresholds);
  expect(!between_metrics.open, "closed gate should ignore levels below open threshold");
  expect(peak(between_thresholds) < dbToLinear(-29.0f) * 0.5f, "closed gate should keep attenuating below open threshold");

  auto above_open = toneFrame(-20.0f);
  const auto open_metrics = gate.processFrame(above_open);
  expect(open_metrics.open, "gate should reopen when input crosses open threshold");
  expect(peak(above_open) > 0.0f, "attack should allow audio through while reopening");
}

void threshold_updates_do_not_reset_gate_state() {
  syrnike::voice::VoiceGateProcessor gate(kSampleRate);
  auto config = testConfig();
  gate.updateConfig(config);

  auto loud = toneFrame(-20.0f);
  gate.processFrame(loud);

  config.open_threshold_db = -18.0f;
  config.close_threshold_db = -24.0f;
  gate.updateConfig(config);

  auto quiet = toneFrame(-40.0f);
  const auto metrics = gate.processFrame(quiet);
  expect(metrics.open, "config update should not reset an open gate before hold expires");
}

}  // namespace

int main() {
  using TestFn = void (*)();
  TestFn tests[] = {
    disabled_gate_leaves_audio_and_reports_open,
    disabling_gate_recovers_smoothly_from_closed_state,
    gate_uses_hold_before_release,
    gate_releases_smoothly_instead_of_zeroing_a_frame,
    closed_gate_requires_open_threshold_to_reopen,
    threshold_updates_do_not_reset_gate_state,
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
