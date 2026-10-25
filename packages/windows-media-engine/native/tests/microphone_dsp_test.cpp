#include "audio/microphone_dsp.hpp"
#include "audio/rendered_echo_reference.hpp"
#include <windows.h>
#include <atomic>
#include <string>
#include <thread>
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
  bool boost_gain = false;
  bool gain_ok = true;
  std::uint64_t gain_calls = 0;
  EchoAvailability process(std::array<std::int16_t, 480>&, const EchoReferenceFrame* reference,
                           bool noise, bool echo) noexcept override {
    ++calls;
    noise_enabled = noise;
    return !echo ? EchoAvailability::disabled : reference ? EchoAvailability::active : EchoAvailability::unavailable;
  }
  bool processGain(std::array<std::int16_t, 480>& samples) noexcept override {
    ++gain_calls;
    if (boost_gain) samples.fill(16000);
    return gain_ok;
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
  require(adapter.gain_calls == adapter.calls, "Closed gate or mute bypassed the warm AGC2 path");
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
  for (int index = 0; index < 29; ++index) {
    frame = signal(1);
    dsp.process(frame, 1'000'000, nullptr);
  }
  require(dsp.stats().gate_open && dsp.stats().speaking, "Hangover closed gate inside a speech pause");
  for (int index = 0; index < 3; ++index) {
    frame = signal(1);
    dsp.process(frame, 1'000'000, nullptr);
  }
  require(frame.samples == std::array<std::int16_t, 480>{} && !dsp.stats().gate_open && !dsp.stats().speaking,
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
void productControlRange() {
  MicrophoneDsp dsp(std::make_unique<Enhancement>());
  MicrophoneDspConfig config;
  config.input_volume = 4;
  config.automatic_gain = false;
  config.gate_threshold_db = -100;
  require(dsp.configure(1, config), "Product gain/gate range rejected");
  auto frame = signal(1000);
  dsp.process(frame, 1'000'000, nullptr);
  require(frame.samples[1] >= 3998 && frame.samples[1] <= 4000, "Product input gain was clamped");
  frame = signal(32000);
  dsp.process(frame, 1'000'000, nullptr);
  require(frame.samples[1] > 0 && frame.samples[1] <= 32112, "Maximum input gain overflowed limiter");
  config.input_volume = 1;
  config.gate_threshold_db = 0;
  require(dsp.configure(2, config), "Product upper gate bound rejected");
  for (int index = 0; index < 32; ++index) {
    frame = signal(1000);
    dsp.process(frame, 1'000'000, nullptr);
  }
  require(frame.samples == std::array<std::int16_t, 480>{}, "Upper gate bound leaked audio");
  config.input_volume = 4.01f;
  require(!dsp.configure(3, config), "Out-of-range gain accepted");
  config.input_volume = 1;
  config.gate_threshold_db = -100.01f;
  require(!dsp.configure(3, config) && dsp.stats().config_revision == 2,
          "Invalid gate changed committed controls");
}
void gateMeasuresBeforeGain() {
  auto enhancement = std::make_unique<Enhancement>();
  auto& adapter = *enhancement;
  adapter.boost_gain = true;
  MicrophoneDsp dsp(std::move(enhancement));
  MicrophoneDspConfig config;
  require(dsp.configure(1, config), "Gate/gain config rejected");
  auto frame = signal(50);
  dsp.process(frame, 1'000'000, nullptr);
  require(!dsp.stats().gate_open && !dsp.stats().speaking && frame.samples == std::array<std::int16_t, 480>{},
          "AGC2 boosted noise opened the gate or escaped the silence guard");
  frame = signal(1000);
  dsp.process(frame, 1'000'000, nullptr);
  require(dsp.stats().gate_open && dsp.stats().speaking && frame.samples[1] == 16000,
          "Voiced frame did not reach the separate AGC2 stage");
  require(dsp.stats().input_level < 0.031f && dsp.stats().output_level > 0.48f,
          "Input meter used the post-AGC2 level");
  for (int index = 0; index < 32; ++index) {
    frame = signal(50);
    dsp.process(frame, 1'000'000, nullptr);
  }
  require(!dsp.stats().gate_open && !dsp.stats().speaking && frame.samples == std::array<std::int16_t, 480>{},
          "AGC2 gain kept the gate's activity hangover alive");
  config.automatic_gain = false;
  config.gate_enabled = false;
  require(dsp.configure(2, config), "Gain bypass config rejected");
  const auto gain_calls = adapter.gain_calls;
  frame = signal(1000);
  dsp.process(frame, 1'000'000, nullptr);
  require(adapter.gain_calls == gain_calls && frame.samples[1] == 1000, "AGC2 bypass still applied automatic gain");
}
// Effects run before the gate: the gate and the speaking indicator measure
// the processed voice, and a missing host leaves the frame untouched.
void effectsRunBeforeTheGate() {
  using namespace syrnike::windows_media::audio_plugins;
  const auto id = "dsp-test-" + std::to_string(GetCurrentProcessId());
  auto server = EffectBusServer::create(id);
  require(server != nullptr, "Effect bus server was not created");
  auto client = EffectBusClient::open(id);
  require(client != nullptr, "Effect bus client was not opened");
  std::atomic<float> gain{0.0f};
  std::atomic<bool> stop{false};
  std::thread host([&] {
    while (!stop.load())
      server->serve(std::chrono::milliseconds{20}, [&](auto& samples) {
        for (float& value : samples) value *= gain.load();
      });
  });
  server->setActive(true, 0);
  MicrophoneDsp dsp(std::make_unique<Enhancement>());
  MicrophoneDspConfig config;
  config.automatic_gain = false;
  config.gate_threshold_db = -40;
  require(dsp.configure(1, config), "Effects config rejected");
  // A voiced frame muted by the effect closes the gate and stays silent.
  auto frame = signal(2000);
  dsp.process(frame, 1'000'000, nullptr, nullptr, client.get());
  require(!dsp.stats().gate_open && !dsp.stats().speaking && frame.samples == std::array<std::int16_t, 480>{},
          "Gate measured the voice before the effect chain");
  // A quiet frame raised by the effect opens it.
  gain = 40.0f;
  frame = signal(50);
  dsp.process(frame, 1'000'000, nullptr, nullptr, client.get());
  require(dsp.stats().gate_open && frame.samples[1] == 2000, "Effect output did not reach the gate");
  stop = true;
  host.join();
  server.reset();
  // Without a live host the voice goes through dry.
  for (int index = 0; index < 32; ++index) {
    frame = signal(50);
    dsp.process(frame, 1'000'000, nullptr, nullptr, client.get());
  }
  frame = signal(2000);
  dsp.process(frame, 1'000'000, nullptr, nullptr, client.get());
  require(dsp.stats().gate_open && frame.samples[1] == 2000, "A dead effect host altered the voice");
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
  // Every rendered frame is kept in order up to the bounded FIFO; overflow
  // drops the oldest frames and nothing is repeated.
  for (std::uint64_t sequence = 101 - RenderedEchoReference::kCapacity; sequence <= 100; ++sequence) {
    const auto queued = port.take();
    require(queued && queued->sequence == sequence, "Echo reference lost or reordered a rendered frame");
  }
  require(!port.take(), "Echo reference exceeded its bound or repeated a frame");
  frame.renderer_epoch = 1;
  frame.sequence = 101;
  require(!port.publish(frame), "Wrong renderer epoch published into reference port");
  frame.renderer_epoch = 2;
  require(port.publish(frame), "Current renderer reference rejected");
  port.retire();
  frame.sequence = 102;
  require(!port.take() && !port.publish(frame), "Lost output retained an available echo reference");
}
void gainFailurePreservesFrameAndEcho() {
  auto enhancement = std::make_unique<Enhancement>();
  enhancement->boost_gain = true;
  enhancement->gain_ok = false;
  MicrophoneDsp dsp(std::move(enhancement));
  MicrophoneDspConfig config;
  config.input_volume = 2;
  config.gate_enabled = false;
  require(dsp.configure(1, config), "Gain failure config rejected");
  auto frame = signal(1000);
  dsp.process(frame, 1'000'000, nullptr);
  require(frame.samples == signal(2000).samples, "Failed gain discarded the pre-gain frame");
  require(dsp.stats().echo == EchoAvailability::unavailable, "Gain failure mislabeled echo availability");
}
void monitorIgnoresMuteButKeepsGate() {
  MicrophoneDsp dsp(std::make_unique<Enhancement>());
  MicrophoneDspConfig config;
  config.gate_threshold_db = -40;
  config.automatic_gain = false;
  config.muted = true;
  config.push_to_talk = true;
  require(dsp.configure(1, config), "Monitor config rejected");
  std::array<std::int16_t, 480> monitor{};
  auto frame = signal(2000);
  dsp.process(frame, 1'000'000, nullptr, &monitor);
  require(frame.samples == std::array<std::int16_t, 480>{}, "Monitoring unmuted the published frame");
  require(monitor[1] > 0 && monitor[0] < 0, "Muted speech was not monitored");
  config.muted = false;
  config.push_to_talk = false;
  require(dsp.configure(2, config), "Unmuted monitor config rejected");
  frame = signal(2000);
  dsp.process(frame, 1'000'000, nullptr, &monitor);
  require(frame.samples == monitor, "Monitor differs from the published frame while unmuted");
  // The gate hangover lasts 300 ms; the monitor then fades and stays silent.
  for (int index = 0; index < 40; ++index) {
    frame = signal(1);
    dsp.process(frame, 1'000'000, nullptr, &monitor);
  }
  require(monitor == std::array<std::int16_t, 480>{}, "Closed gate leaked into the monitor");
}
}  // namespace
int main() try {
  silenceAndControls();
  monitorIgnoresMuteButKeepsGate();
  productControlRange();
  gateMeasuresBeforeGain();
  gainFailurePreservesFrameAndEcho();
  referenceFreshness();
  renderedReferenceRetirement();
  effectsRunBeforeTheGate();
  std::cout << "Microphone DSP contracts passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
