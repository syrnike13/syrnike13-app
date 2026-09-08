#include "audio/microphone_dsp.hpp"
#include "audio/rendered_echo_reference.hpp"
#include <iostream>
#include <limits>
#include <stdexcept>

using namespace syrnike::windows_media::audio;
namespace {
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
class Enhancement final : public MicrophoneEnhancement {
 public:
  std::uint64_t calls = 0, resets = 0;
  bool noise_enabled = false;
  bool reset_ok = true;
  EchoAvailability process(std::array<std::int16_t, 480>&, const EchoReferenceFrame* reference,
                           bool noise, bool echo) noexcept override {
    ++calls;
    noise_enabled = noise;
    return !echo ? EchoAvailability::disabled : reference ? EchoAvailability::active : EchoAvailability::unavailable;
  }
  bool resetEcho() noexcept override { ++resets; return reset_ok; }
};
class Reference final : public EchoReferencePort {
 public:
  std::optional<EchoReferenceFrame> frame;
  std::optional<EchoReferenceFrame> take() noexcept override { return std::exchange(frame, {}); }
};
MicrophoneFrame signal(std::int16_t amplitude) {
  MicrophoneFrame frame;
  for (std::size_t index = 0; index < frame.samples.size(); ++index)
    frame.samples[index] = index % 2 ? amplitude : static_cast<std::int16_t>(-amplitude);
  return frame;
}
void silenceAndControls() {
  auto enhancement = std::make_unique<Enhancement>();
  auto& adapter = *enhancement;
  MicrophoneDsp dsp(std::move(enhancement));
  MicrophoneDspConfig config;
  config.gate_threshold_db = -40;
  require(dsp.configure(1, config), "Initial config rejected");
  auto quiet = signal(1);
  dsp.process(quiet, 1'000'000, nullptr);
  require(quiet.samples == std::array<std::int16_t, 480>{}, "Closed-gate noise escaped AGC guard");
  require(adapter.noise_enabled && dsp.stats().echo == EchoAvailability::unavailable,
          "Missing echo reference disabled independent noise suppression");
  for (std::uint64_t cycle = 0; cycle < 200; ++cycle) {
    config.muted = true;
    require(dsp.configure(cycle * 2 + 2, config), "Mute revision rejected");
    auto frame = signal(2000);
    dsp.process(frame, 1'000'000, nullptr);
    require(frame.samples == std::array<std::int16_t, 480>{} && !dsp.stats().speaking,
            "Muted frame was not digital silence");
    config.muted = false;
    require(dsp.configure(cycle * 2 + 3, config), "Unmute revision rejected");
    frame = signal(2000);
    dsp.process(frame, 1'000'000, nullptr);
    require(frame.samples[1] > 0 && dsp.stats().speaking, "Unmute did not reopen effective output");
  }
  require(adapter.calls == 401, "Mute bypassed the warm DSP path");
  config.input_volume = (std::numeric_limits<float>::quiet_NaN)();
  require(!dsp.configure(500, config) && dsp.stats().config_revision == 401, "Invalid config committed");
  config.input_volume = 2;
  config.push_to_talk = true;
  require(dsp.configure(500, config), "PTT config failed");
  auto frame = signal(32000);
  dsp.process(frame, 1'000'000, nullptr);
  require(frame.samples == std::array<std::int16_t, 480>{}, "PTT released samples while not pressed");
  config.push_to_talk_pressed = true;
  require(dsp.configure(501, config), "PTT press failed");
  frame = signal(32000);
  dsp.process(frame, 1'000'000, nullptr);
  require(frame.samples[1] > 0 && frame.samples[1] <= 32112, "Limiter overflowed after input gain");
  for (int index = 0; index < 12; ++index) {
    frame = signal(1);
    dsp.process(frame, 1'000'000, nullptr);
  }
  require(frame.samples == std::array<std::int16_t, 480>{} && !dsp.stats().gate_open,
          "Hangover never closed gate");
}
void referenceFreshness() {
  auto enhancement = std::make_unique<Enhancement>();
  auto& adapter = *enhancement;
  MicrophoneDsp dsp(std::move(enhancement));
  Reference reference;
  MicrophoneFrame frame;
  EchoReferenceFrame echo;
  echo.renderer_epoch = 1;
  echo.sequence = 1;
  echo.rendered_timestamp_100ns = 1'000'000;
  reference.frame = echo;
  dsp.process(frame, 1'100'000, &reference);
  require(dsp.stats().echo == EchoAvailability::active, "Fresh reference rejected");
  dsp.process(frame, 1'200'000, &reference);
  require(dsp.stats().echo == EchoAvailability::unavailable, "Reference replayed without rendered progress");
  reference.frame = echo;
  dsp.process(frame, 1'300'000, &reference);
  require(dsp.stats().echo == EchoAvailability::unavailable, "Duplicate reference sequence replayed");
  echo.renderer_epoch = 2;
  reference.frame = echo;
  dsp.process(frame, 1'300'000, &reference);
  require(dsp.stats().echo == EchoAvailability::active && adapter.resets == 1, "New epoch did not reset echo timeline");
  echo.renderer_epoch = 1;
  echo.sequence = 100;
  reference.frame = echo;
  dsp.process(frame, 1'300'000, &reference);
  require(dsp.stats().echo == EchoAvailability::unavailable, "Late old renderer reference escaped fence");
  echo.renderer_epoch = 2;
  echo.rendered_timestamp_100ns = (std::numeric_limits<std::int64_t>::min)();
  reference.frame = echo;
  dsp.process(frame, 1'300'000, &reference);
  require(dsp.stats().echo == EchoAvailability::unavailable, "Invalid timestamp escaped freshness validation");
  echo.renderer_epoch = 3;
  echo.rendered_timestamp_100ns = 1'300'000;
  adapter.reset_ok = false;
  reference.frame = echo;
  dsp.process(frame, 1'300'000, &reference);
  require(dsp.stats().echo == EchoAvailability::unsupported && adapter.noise_enabled,
          "Unsupported echo reset disabled microphone/NS");
  dsp.process(frame, 1'400'000, &reference);
  require(dsp.stats().echo == EchoAvailability::unavailable && adapter.noise_enabled,
          "Output loss retained unsupported instead of unavailable echo state");
}
void renderedReferenceRetirement() {
  RenderedEchoReference port(2);
  EchoReferenceFrame frame;
  frame.renderer_epoch = 2;
  frame.rendered_timestamp_100ns = 1'000'000;
  for (std::uint64_t sequence = 1; sequence <= 100; ++sequence) {
    frame.sequence = sequence;
    require(port.publish(frame), "Valid rendered reference rejected");
  }
  const auto latest = port.take();
  require(latest && latest->sequence == 100 && !port.take(), "Echo reference accumulated/repeated backlog");
  frame.renderer_epoch = 1;
  frame.sequence = 101;
  require(!port.publish(frame), "Wrong renderer epoch published into reference port");
  frame.renderer_epoch = 2;
  require(port.publish(frame), "Current renderer reference rejected");
  port.retire();
  frame.sequence = 102;
  require(!port.take() && !port.publish(frame), "Lost output retained an available echo reference");
}
}  // namespace
int main() try {
  silenceAndControls();
  referenceFreshness();
  renderedReferenceRetirement();
  std::cout << "Microphone DSP contracts passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
