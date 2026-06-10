#include "microphone_audio_processor.hpp"

#include <stdexcept>
#include <string>

namespace {

void expect(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main() {
  syrnike::voice::RuntimeConfig config;
  config.noise_suppression_enabled = true;
  config.echo_cancellation_enabled = true;

  const auto enabled = syrnike::voice::microphoneApmOptions(config, true);
  expect(enabled.noise_suppression, "noise suppression should be enabled");
  expect(enabled.echo_cancellation, "echo cancellation should be enabled with reference");
  expect(enabled.high_pass_filter, "high-pass filter should follow enabled processing");
  expect(!enabled.auto_gain_control, "AGC must stay disabled");

  const auto no_reference = syrnike::voice::microphoneApmOptions(config, false);
  expect(no_reference.noise_suppression, "noise suppression should not require echo reference");
  expect(!no_reference.echo_cancellation, "echo cancellation should require reference");
  expect(no_reference.high_pass_filter, "high-pass filter should remain enabled for noise suppression");
  expect(!no_reference.auto_gain_control, "AGC must stay disabled without reference");

  config.noise_suppression_enabled = false;
  config.echo_cancellation_enabled = false;
  const auto disabled = syrnike::voice::microphoneApmOptions(config, true);
  expect(!disabled.noise_suppression, "noise suppression should disable explicitly");
  expect(!disabled.echo_cancellation, "echo cancellation should disable explicitly");
  expect(!disabled.high_pass_filter, "high-pass filter should disable when all processing is off");
  expect(!disabled.auto_gain_control, "AGC must stay disabled when processing is off");

  return 0;
}
