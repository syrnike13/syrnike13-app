#include "audio/livekit_microphone_dsp.hpp"
#include "audio/remote_audio_output.hpp"

#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>

using namespace syrnike::windows_media::audio;
namespace {
using Clock = std::chrono::steady_clock;
std::int64_t timestamp() {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
double energy(const std::array<std::int16_t, 480>& samples) {
  double value = 0;
  for (const auto sample : samples) value += static_cast<double>(sample) * sample;
  return value;
}
class FixtureReference final : public EchoReferencePort {
 public:
  std::optional<EchoReferenceFrame> frame;
  std::optional<EchoReferenceFrame> take() noexcept override { return std::exchange(frame, {}); }
};
}
int remoteAudioAecFixture() {
  // The echo path is synthetic, but its input is exclusively successful WASAPI
  // ReleaseBuffer PCM, with the renderer's original sequence, epoch and delay.
  AudioDeviceRegistry registry(makeWindowsAudioDeviceEnumerator());
  if (registry.refresh().status != AudioRegistryStatus::ready) throw std::runtime_error("AEC registry unavailable");
  RemoteAudioMixerWorker mixer;
  auto input = std::make_shared<RemoteAudioPcmPort>(1, 2);
  if (!mixer.configure(std::array{RemoteAudioInput{input, 1, false}}, false)) throw std::runtime_error("AEC graph rejected");
  std::jthread producer([input](std::stop_token stop) {
    std::uint64_t sequence = 0;
    std::uint32_t seed = 0x12345678;
    auto next = Clock::now();
    while (!stop.stop_requested()) {
      RemoteAudioFrame frame;
      frame.generation = 1;
      frame.sequence = ++sequence;
      frame.decoded_timestamp_100ns = timestamp();
      for (std::size_t index = 0; index < 480; ++index) {
        seed = seed * 1'664'525 + 1'013'904'223;
        const auto value = static_cast<std::int16_t>(static_cast<int>(seed >> 16) * 4000 / 32768 - 4000);
        frame.samples[index * 2] = frame.samples[index * 2 + 1] = value;
      }
      (void)input->publish(frame);
      next = (std::max)(next + std::chrono::milliseconds{10}, Clock::now());
      std::this_thread::sleep_until(next);
    }
  });
  RemoteAudioOutput output(mixer);
  if (output.selectOutput(registry, {AudioDirection::output, {}}) != RemoteOutputFailure::none)
    throw std::runtime_error("AEC output unavailable");
  auto rendered = output.echoReference();
  MicrophoneDsp dsp(makeLiveKitMicrophoneEnhancement());
  MicrophoneDspConfig config;
  config.gate_enabled = false;
  config.automatic_gain = false;
  config.noise_suppression = false;
  if (!dsp.configure(1, config)) throw std::runtime_error("AEC configuration failed");
  FixtureReference reference;
  std::array<std::array<std::int16_t, 480>, 4> history{};
  double input_energy = 0, output_energy = 0;
  std::uint64_t frames = 0, active = 0, missing_sequences = 0, prior_sequence = 0;
  std::uint32_t minimum_delay = UINT32_MAX, maximum_delay = 0;
  const auto deadline = Clock::now() + std::chrono::seconds{18};
  while (frames < 1500 && Clock::now() < deadline) {
    auto frame = rendered->take();
    if (!frame) { std::this_thread::sleep_for(std::chrono::milliseconds{1}); continue; }
    if (prior_sequence && frame->sequence != prior_sequence + 1) ++missing_sequences;
    prior_sequence = frame->sequence;
    minimum_delay = (std::min)(minimum_delay, frame->stream_delay_ms);
    maximum_delay = (std::max)(maximum_delay, frame->stream_delay_ms);
    history[frames % history.size()] = frame->samples;
    const auto& delayed = history[(frames + 1) % history.size()];
    MicrophoneFrame microphone;
    for (std::size_t index = 0; index < 480; ++index)
      microphone.samples[index] = static_cast<std::int16_t>(delayed[index] * 0.55 + (index ? delayed[index - 1] : 0) * 0.2);
    if (frames >= 500) input_energy += energy(microphone.samples);
    reference.frame = frame;
    dsp.process(microphone, timestamp(), &reference);
    if (dsp.stats().echo == EchoAvailability::active) ++active;
    if (frames >= 500) output_energy += energy(microphone.samples);
    ++frames;
  }
  producer.request_stop();
  producer.join();
  const auto render_stats = output.stats().active;
  if (!output.stop(Clock::now() + std::chrono::seconds{5}) || !mixer.stop(Clock::now() + std::chrono::seconds{5}))
    throw std::runtime_error("AEC fixture cleanup deadline");
  MicrophoneFrame after_loss;
  dsp.process(after_loss, timestamp(), rendered.get());
  const bool unavailable = dsp.stats().echo == EchoAvailability::unavailable;
  const auto erle = 10 * std::log10(input_energy / (std::max)(output_energy, 1.0));
  const bool passed = frames == 1500 && active == frames && erle >= 10 && unavailable &&
      render_stats.maximum_scheduled_age_100ns <= kRemoteAudioMaximumAge100ns;
  std::cout << "{\"scope\":\"wasapi-rendered-reference-synthetic-echo\",\"status\":\"" << (passed ? "pass" : "fail")
            << "\",\"renderedFrames\":" << frames << ",\"activeAecFrames\":" << active
            << ",\"erleDb\":" << erle << ",\"sequenceGaps\":" << missing_sequences
            << ",\"minimumStreamDelayMs\":" << minimum_delay << ",\"maximumStreamDelayMs\":" << maximum_delay
            << ",\"outputLossUnavailable\":" << (unavailable ? "true" : "false") << "}" << std::endl;
  return passed ? 0 : 1;
}
