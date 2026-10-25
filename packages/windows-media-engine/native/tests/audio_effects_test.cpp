#include "audio_plugins/builtin_effects.hpp"
#include "audio_plugins/effect_bus.hpp"
#include "audio_plugins/effect_chain.hpp"

#include <windows.h>
#include <atomic>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

using namespace syrnike::windows_media::audio_plugins;
namespace {
using Frame = std::array<float, kEffectBusFrameSamples>;
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }

class Gain final : public AudioEffect {
 public:
  explicit Gain(float gain, std::uint32_t latency = 0) : gain_(gain), latency_(latency) {}
  void process(float* samples, std::size_t count) noexcept override {
    for (std::size_t index = 0; index < count; ++index) samples[index] *= gain_;
  }
  std::uint32_t latencySamples() const noexcept override { return latency_; }
 private:
  float gain_;
  std::uint32_t latency_;
};
// Delays by its reported latency, like a lookahead plugin.
class Delay final : public AudioEffect {
 public:
  explicit Delay(std::uint32_t samples) : line_(samples, 0.0f) {}
  void process(float* samples, std::size_t count) noexcept override {
    for (std::size_t index = 0; index < count; ++index) {
      const float out = line_[position_];
      line_[position_] = samples[index];
      position_ = (position_ + 1) % line_.size();
      samples[index] = out;
    }
  }
  std::uint32_t latencySamples() const noexcept override { return static_cast<std::uint32_t>(line_.size()); }
 private:
  std::vector<float> line_;
  std::size_t position_ = 0;
};
Frame constant(float value) {
  Frame frame;
  frame.fill(value);
  return frame;
}
Frame sine(std::size_t offset, float frequency = 440) {
  Frame frame;
  for (std::size_t index = 0; index < frame.size(); ++index)
    frame[index] = 0.5f * std::sin(2.0f * 3.14159265f * frequency * static_cast<float>(offset + index) / 48'000.0f);
  return frame;
}
float rms(const Frame& frame) {
  float energy = 0;
  for (float value : frame) energy += value * value;
  return std::sqrt(energy / static_cast<float>(frame.size()));
}

void slotMixRampsAndBypasses() {
  EffectSlot slot(std::make_unique<Gain>(0.0f), 1.0f, true);
  // A fresh slot fades in from dry over 20 ms (two frames).
  auto frame = constant(1.0f);
  slot.process(frame.data(), frame.size());
  require(frame.front() > 0.99f && frame.back() < 1.0f, "Slot did not fade in from dry");
  for (int block = 0; block < 3; ++block) {
    frame = constant(1.0f);
    slot.process(frame.data(), frame.size());
  }
  require(std::abs(frame.back()) < 1e-6f, "Full mix kept dry signal");
  slot.setMix(0.5f);
  for (int block = 0; block < 4; ++block) {
    frame = constant(1.0f);
    slot.process(frame.data(), frame.size());
  }
  require(std::abs(frame.back() - std::cos(3.14159265f / 4)) < 1e-4f, "Half mix is not equal power");
  slot.setEnabled(false);
  for (int block = 0; block < 4; ++block) {
    frame = constant(1.0f);
    slot.process(frame.data(), frame.size());
  }
  require(frame.back() == 1.0f, "Disabled slot did not fade back to dry");
  frame = constant(1.0f);
  slot.process(frame.data(), frame.size());
  require(frame == constant(1.0f), "Faded-out slot still touched audio");
}

void dryPathFollowsLatency() {
  constexpr std::uint32_t latency = 96;
  EffectSlot slot(std::make_unique<Delay>(latency), 0.5f, true);
  // A delayed wet path and a compensated dry path stay coherent: the blend of
  // identical signals has the equal-power sum of both gains, not comb nulls.
  Frame frame;
  for (std::size_t block = 0; block < 8; ++block) {
    frame = sine(block * kEffectBusFrameSamples, 2000);
    slot.process(frame.data(), frame.size());
  }
  const float expected = 0.5f / std::sqrt(2.0f) * (std::sin(0.785398f) + std::cos(0.785398f));
  require(std::abs(rms(frame) - expected) < 0.01f, "Dry path is not latency compensated");
  require(slot.latencySamples() == latency, "Slot lost effect latency");
}

void pitchMixStaysAligned() {
  // The pitch shifter always hands the wet copy over from half a window ago.
  // The slot must delay the dry path by the same amount, otherwise a partial
  // mix comb filters: 1024 samples is antiphase at 70.3125 Hz.
  EffectSlot slot(makeBuiltinEffect("pitch"), 0.5f, true);
  require(slot.latencySamples() == 1024, "Pitch did not declare its delay");
  Frame frame;
  for (int block = 0; block < 12; ++block) {
    frame = sine(block * kEffectBusFrameSamples, 70.3125f);
    slot.process(frame.data(), frame.size());
  }
  const float ratio = rms(frame) / rms(sine(11 * kEffectBusFrameSamples, 70.3125f));
  require(ratio > 1.3f && ratio < 1.5f, "Pitch mix combed the voice");
}

void chainExchangeHandsOver() {
  EffectChainExchange exchange;
  require(exchange.acquire() == nullptr && exchange.latest() == nullptr, "Empty exchange returned a chain");
  auto first = std::make_unique<EffectChain>();
  first->add(std::make_shared<EffectSlot>(std::make_unique<Gain>(2.0f), 1.0f, true));
  auto* first_ptr = first.get();
  exchange.publish(std::move(first));
  require(exchange.latest() == first_ptr, "Pending chain is not visible to control");
  require(exchange.acquire() == first_ptr, "Realtime thread did not take the chain");
  auto second = std::make_unique<EffectChain>();
  auto* second_ptr = second.get();
  exchange.publish(std::move(second));
  require(exchange.acquire() == second_ptr, "Second chain was not taken");
  // The first chain is retired; a third publish must wait for its collection.
  auto third = std::make_unique<EffectChain>();
  auto* third_ptr = third.get();
  exchange.publish(std::move(third));
  require(exchange.acquire() == third_ptr, "Collected retired slot blocked the swap");
}

void builtinsStayFiniteAndBounded() {
  for (const auto kind : builtinEffectKinds()) {
    auto effect = makeBuiltinEffect(kind);
    require(effect != nullptr, "Builtin effect kind missing");
    for (const auto& parameter : effect->parameters()) {
      require(effect->setParameter(parameter.id, parameter.maximum), "Builtin rejected its own parameter");
      require(effect->parameter(parameter.id) == parameter.maximum, "Builtin parameter not stored");
    }
    require(!effect->setParameter("missing", 1), "Builtin accepted an unknown parameter");
    for (std::size_t block = 0; block < 200; ++block) {
      auto frame = sine(block * kEffectBusFrameSamples);
      effect->process(frame.data(), frame.size());
      for (float value : frame) require(std::isfinite(value) && std::abs(value) < 8.0f, "Builtin output diverged");
    }
  }
  require(makeBuiltinEffect("vst") == nullptr, "Unknown builtin kind was created");
}

void neutralBuiltinsPassVoice() {
  auto eq = makeBuiltinEffect("eq");
  auto pitch = makeBuiltinEffect("pitch");
  Frame eq_frame, pitch_frame;
  for (std::size_t block = 0; block < 20; ++block) {
    eq_frame = sine(block * kEffectBusFrameSamples);
    pitch_frame = eq_frame;
    eq->process(eq_frame.data(), eq_frame.size());
    pitch->process(pitch_frame.data(), pitch_frame.size());
  }
  const float reference = rms(sine(19 * kEffectBusFrameSamples));
  require(std::abs(rms(eq_frame) - reference) < 0.01f, "Flat EQ changed the level");
  require(std::abs(rms(pitch_frame) - reference) < 0.05f, "Unity pitch shift changed the level");
  auto compressor = makeBuiltinEffect("compressor");
  compressor->setParameter("makeupDb", 0);
  auto loud = constant(0.9f);
  for (int block = 0; block < 20; ++block) {
    loud = constant(0.9f);
    compressor->process(loud.data(), loud.size());
  }
  require(loud.back() < 0.5f, "Compressor did not reduce a loud signal");
}

std::string busId() { return "test-" + std::to_string(GetCurrentProcessId()) + "-" + std::to_string(GetTickCount64()); }

void busRoundTripAndFallback() {
  const auto id = busId();
  require(!validEffectBusId("bad id") && !validEffectBusId("") && validEffectBusId(id), "Bus id validation");
  require(EffectBusClient::open(id) == nullptr, "Client opened a missing bus");
  auto server = EffectBusServer::create(id);
  require(server != nullptr, "Bus server was not created");
  require(EffectBusServer::create(id) == nullptr, "A second server took over an existing bus");
  auto client = EffectBusClient::open(id);
  require(client != nullptr, "Client did not open the bus");
  std::array<std::int16_t, kEffectBusFrameSamples> samples{};
  samples.fill(1000);
  require(!client->process(samples), "Inactive bus processed a frame");

  std::atomic<bool> stop{false}, stall{false};
  std::thread audio([&] {
    while (!stop.load()) {
      server->serve(std::chrono::milliseconds{20}, [&](Frame& frame) {
        if (stall.load()) std::this_thread::sleep_for(std::chrono::milliseconds{30});
        for (float& value : frame) value *= 2.0f;
      });
    }
  });
  server->setActive(true, 0);
  for (int round = 0; round < 50; ++round) {
    samples.fill(1000);
    require(client->process(samples) && samples.front() == 2000, "Bus round trip failed");
  }
  stall = true;
  samples.fill(1000);
  require(!client->process(samples) && samples.front() == 1000, "Stalled host did not fall back to dry");
  stall = false;
  // While the host is still busy with the late frame, frames stay dry at once.
  samples.fill(1000);
  require(!client->process(samples) && samples.front() == 1000, "Busy host blocked the next frame");
  std::this_thread::sleep_for(std::chrono::milliseconds{60});
  samples.fill(1000);
  require(client->process(samples) && samples.front() == 2000, "Bus did not recover after a stall");
  const auto stats = client->stats();
  require(stats.timeouts == 1 && stats.busy >= 1 && stats.processed == 51, "Bus statistics are wrong");
  stop = true;
  audio.join();
  server.reset();
  samples.fill(1000);
  require(!client->process(samples) && samples.front() == 1000, "Closed host still processed audio");
}
}  // namespace

int main() {
  try {
    slotMixRampsAndBypasses();
    dryPathFollowsLatency();
    pitchMixStaysAligned();
    chainExchangeHandsOver();
    builtinsStayFiniteAndBounded();
    neutralBuiltinsPassVoice();
    busRoundTripAndFallback();
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
  std::cout << "audio effects ok\n";
  return 0;
}
