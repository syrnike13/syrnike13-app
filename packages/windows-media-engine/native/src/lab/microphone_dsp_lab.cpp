#include "audio/livekit_microphone_dsp.hpp"
#include "lab/heap_allocation_probe.hpp"
#include <livekit/realtime_audio_processing.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <iostream>
#include <stdexcept>

using namespace syrnike::windows_media::audio;
namespace {
using Clock = std::chrono::steady_clock;
class Reference final : public EchoReferencePort {
 public:
  EchoReferenceFrame frame;
  std::optional<EchoReferenceFrame> take() noexcept override { return frame; }
};
std::int16_t noise(std::uint32_t& seed, int amplitude) {
  seed = seed * 1'664'525 + 1'013'904'223;
  return static_cast<std::int16_t>(static_cast<int>(seed >> 16) * amplitude / 32768 - amplitude);
}
double energy(const std::array<std::int16_t, 480>& samples) {
  double value = 0;
  for (const auto sample : samples) value += static_cast<double>(sample) * sample;
  return value;
}
}  // namespace
int microphoneSyntheticAecLab() {
  // This fixture does not join a Room or consume a microphone. A seeded remote
  // waveform is convolved with a known echo path and delayed by three frames.
  // All source/history/timing storage exists before the measured interval.
  MicrophoneDsp dsp(makeLiveKitMicrophoneEnhancement());
  MicrophoneDspConfig config;
  config.gate_enabled = false;
  config.automatic_gain = false;
  config.noise_suppression = false; // ERLE must measure AEC, not NS attenuation.
  if (!dsp.configure(1, config)) throw std::runtime_error("AEC fixture config rejected");
  Reference reference;
  reference.frame.renderer_epoch = 1;
  reference.frame.stream_delay_ms = 30;
  std::array<std::array<std::int16_t, 480>, 4> history{};
  std::uint32_t seed = 0x12345678;
  double input_energy = 0, output_energy = 0;
  std::array<std::uint64_t, 1000> durations{};
  syrnike::windows_media::lab::HeapAllocationProbe heap;
  for (std::size_t frame_index = 0; frame_index < 1500; ++frame_index) {
    auto& generated = history[frame_index % history.size()];
    for (auto& sample : generated) sample = noise(seed, 12000);
    reference.frame.samples = generated;
    reference.frame.sequence = frame_index + 1;
    reference.frame.rendered_timestamp_100ns = 1'000'000 + static_cast<std::int64_t>(frame_index) * 100'000;
    const auto& delayed = history[(frame_index + 1) % history.size()];
    MicrophoneFrame frame;
    for (std::size_t index = 0; index < frame.samples.size(); ++index) {
      const auto previous = index ? delayed[index - 1] : 0;
      frame.samples[index] = static_cast<std::int16_t>(delayed[index] * 0.55 + previous * 0.2);
    }
    if (frame_index == 500) heap.begin();
    if (frame_index >= 500) input_energy += energy(frame.samples);
    const auto began = Clock::now();
    dsp.process(frame, reference.frame.rendered_timestamp_100ns, &reference);
    if (frame_index >= 500) {
      durations[frame_index - 500] = static_cast<std::uint64_t>(
          std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - began).count());
      output_energy += energy(frame.samples);
    }
  }
  const auto allocation = heap.end();
  std::sort(durations.begin(), durations.end());
  const double erle = 10 * std::log10(input_energy / (std::max)(output_energy, 1.0));
  // Measure NS independently without a reverse stream.
  config.noise_suppression = true;
  config.echo_cancellation = false;
  if (!dsp.configure(2, config)) throw std::runtime_error("NS fixture config rejected");
  double noise_input = 0, noise_output = 0;
  for (int index = 0; index < 500; ++index) {
    MicrophoneFrame frame;
    for (auto& sample : frame.samples) sample = noise(seed, 1500);
    if (index == 250) heap.begin();
    if (index >= 250) noise_input += energy(frame.samples);
    dsp.process(frame, 200'000'000, nullptr);
    if (index >= 250) noise_output += energy(frame.samples);
  }
  const auto noise_allocations = heap.end();
  const double ns_db = 10 * std::log10(noise_input / (std::max)(noise_output, 1.0));
  // Count epoch-reset work separately instead of hiding it in steady-state.
  reference.frame.renderer_epoch = 2;
  reference.frame.rendered_timestamp_100ns = 210'000'000;
  config.echo_cancellation = true;
  if (!dsp.configure(3, config)) throw std::runtime_error("Epoch fixture config rejected");
  MicrophoneFrame epoch_frame;
  heap.begin();
  const auto reset_began = Clock::now();
  dsp.process(epoch_frame, 210'000'000, &reference);
  const auto reset_us = std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - reset_began).count();
  const auto reset_allocations = heap.end();
  const bool epoch_unsupported = dsp.stats().echo == EchoAvailability::unsupported;
  const bool passed = erle >= 10 && ns_db >= 3 && allocation.allocations == 0 && allocation.reallocations == 0 &&
                      noise_allocations.allocations == 0 && noise_allocations.reallocations == 0 &&
                      reset_allocations.allocations == 0 && reset_allocations.reallocations == 0 &&
                      epoch_unsupported && durations[949] < 10'000;
  std::cout << "{\"command\":\"microphone-synthetic-aec\",\"status\":\"" << (passed ? "pass" : "fail")
            << "\",\"measuredFrames\":1000,\"erleDb\":" << erle << ",\"noiseSuppressionDb\":" << ns_db
            << ",\"allocations\":" << allocation.allocations << ",\"reallocations\":" << allocation.reallocations
            << ",\"resetAllocations\":" << reset_allocations.allocations
            << ",\"resetReallocations\":" << reset_allocations.reallocations << ",\"resetUs\":" << reset_us
            << ",\"noiseAllocations\":" << noise_allocations.allocations
            << ",\"noiseReallocations\":" << noise_allocations.reallocations
            << ",\"epochOutcome\":\"" << (epoch_unsupported ? "unsupported" : "unexpected") << "\""
            << ",\"p50Us\":" << durations[499] << ",\"p95Us\":" << durations[949] << ",\"maxUs\":" << durations.back()
            << ",\"heapImports\":" << heap.imports() << "}\n";
  return passed ? 0 : 1;
}
