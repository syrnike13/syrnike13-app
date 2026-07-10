#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "media/audio_constants.hpp"
#include "media/microphone_audio_processor.hpp"
#include "media/microphone_echo_reference.hpp"
#include "media/runtime_config.hpp"
#include "media/voice_gate.hpp"

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

std::vector<float> frameAtDb(float db) {
  return std::vector<float>(
    syrnike::voice::kSamplesPer10Ms,
    std::pow(10.0f, db / 20.0f)
  );
}

}  // namespace

int main() try {
  syrnike::voice::RuntimeConfig config;
  const auto enabled = syrnike::voice::microphoneApmOptions(config, true);
  require(enabled.noise_suppression, "noise suppression was not enabled");
  require(enabled.echo_cancellation, "echo cancellation ignored a valid reference");
  require(!enabled.auto_gain_control, "unexpected AGC changes microphone gain");

  const auto without_reference = syrnike::voice::microphoneApmOptions(config, false);
  require(!without_reference.echo_cancellation, "echo cancellation ran without reference audio");

  syrnike::voice::MicrophoneEchoReferenceBuffer reference(2);
  std::vector<float> stereo(
    static_cast<std::size_t>(syrnike::voice::kSamplesPer10Ms) * 2,
    0.25f
  );
  reference.pushInterleavedFloatStereo(
    stereo.data(), syrnike::voice::kSamplesPer10Ms, false
  );
  const auto mono = reference.popFrame();
  require(mono.has_value(), "echo reference did not produce a 10ms frame");
  require(mono->size() == syrnike::voice::kSamplesPer10Ms, "echo frame size changed");
  for (int index = 0; index < 3; ++index) {
    reference.pushInterleavedFloatStereo(
      stereo.data(), syrnike::voice::kSamplesPer10Ms, false
    );
  }
  require(reference.queuedFrames() == 2, "echo reference queue is unbounded");

  syrnike::voice::VoiceGateProcessor gate(48'000);
  syrnike::voice::VoiceGateConfig gate_config;
  gate_config.enabled = true;
  gate_config.auto_threshold = false;
  gate_config.manual_threshold_db = -26.0f;
  gate_config.attack_ms = 4;
  gate_config.hold_ms = 50;
  gate_config.release_ms = 100;
  gate_config.lookahead_ms = 0;
  gate.updateConfig(gate_config);
  auto speech = frameAtDb(-18.0f);
  require(gate.processFrame(speech).open, "voice gate did not open for speech");
  for (int index = 0; index < 8; ++index) {
    auto noise = frameAtDb(-50.0f);
    gate.processFrame(noise);
  }
  auto noise = frameAtDb(-50.0f);
  require(!gate.processFrame(noise).open, "voice gate never closed after hold");
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
