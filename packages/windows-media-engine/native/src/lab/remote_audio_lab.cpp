#include "audio/remote_audio_output.hpp"

#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>

using namespace syrnike::windows_media::audio;
int remoteAudioPublish(unsigned seconds, unsigned frequency);
int remoteAudioReceive(unsigned seconds, bool inject_reader_delay);
int remoteAudioRouting();
int remoteAudioOutputStress();
int remoteAudioAecFixture();
int remoteAudioDucking(std::uint32_t pid);
int remoteAudioEchoPublication();
int remoteAudioDefaultRemoval();
namespace {
using Clock = std::chrono::steady_clock;
std::int64_t timestamp() {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
int outputProbe(unsigned seconds) {
  AudioDeviceRegistry registry(makeWindowsAudioDeviceEnumerator());
  if (registry.refresh().status != AudioRegistryStatus::ready) throw std::runtime_error("Audio registry unavailable");
  RemoteAudioMixerWorker mixer;
  auto input = std::make_shared<RemoteAudioPcmPort>(1);
  const std::array graph{RemoteAudioInput{input, 1, false}};
  if (!mixer.configure(graph, false)) throw std::runtime_error("Mixer graph rejected");
  RemoteAudioOutput output(mixer);
  const auto failure = output.selectOutput(registry, {AudioDirection::output, {}});
  if (failure != RemoteOutputFailure::none) {
    const auto stats = output.stats();
    std::cerr << "Output start failed: " << static_cast<int>(failure) << " platform=" << stats.active.platform_error << '\n';
    return 1;
  }
  auto reference = output.echoReference();
  std::uint64_t audible = 0, silent = 0, unexpected_audible = 0, references = 0;
  const auto began = Clock::now();
  auto next = began;
  bool deafened = false;
  for (std::uint64_t sequence = 1; sequence <= seconds * 100; ++sequence) {
    const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - began).count();
    const bool requested_deafen = elapsed_ms >= 1000 && elapsed_ms < 2000;
    if (requested_deafen != deafened) {
      if (!output.setDeafened(requested_deafen)) throw std::runtime_error("Output deafen command failed");
      deafened = requested_deafen;
    }
    RemoteAudioFrame frame;
    frame.generation = 1;
    frame.sequence = sequence;
    frame.decoded_timestamp_100ns = timestamp();
    for (std::size_t sample = 0; sample < kRemoteAudioFrames; ++sample) {
      const auto position = (sequence - 1) * kRemoteAudioFrames + sample;
      const auto value = static_cast<std::int16_t>(400 * std::sin(
          2 * 3.14159265358979323846 * 700 * static_cast<double>(position) / kRemoteAudioRate));
      frame.samples[sample * 2] = value;
      frame.samples[sample * 2 + 1] = value;
    }
    (void)input->publish(frame);
    if (const auto echo = reference->take()) {
      ++references;
      int peak = 0;
      for (const auto value : echo->samples) peak = (std::max)(peak, std::abs(static_cast<int>(value)));
      if (elapsed_ms > 1100 && elapsed_ms < 1900) {
        if (peak) ++unexpected_audible;
        else ++silent;
      } else if (!deafened && peak > 100) ++audible;
    }
    next += std::chrono::milliseconds(10);
    if (Clock::now() > next + std::chrono::milliseconds(10)) next = Clock::now();
    std::this_thread::sleep_until(next);
  }
  const auto running = output.stats().active;
  const bool stopped = output.stop(Clock::now() + std::chrono::seconds(5));
  const auto final = output.stats().active;
  const bool mixer_stopped = mixer.stop(Clock::now() + std::chrono::seconds(5));
  const bool passed = running.failure == WasapiOutputFailure::none && running.consumed_frames > 48000 &&
      audible > 50 && silent > 30 && unexpected_audible == 0 && references > 100 && stopped &&
      !final.client_alive && !final.thread_alive && !reference->take() && mixer_stopped;
  std::cout << "{\"command\":\"output-probe\",\"scope\":\"mixer-renderer-reference-smoke\",\"status\":\""
            << (passed ? "pass" : "fail") << "\",\"seconds\":" << seconds
            << ",\"bufferFrames\":" << running.buffer_frames << ",\"paddingFrames\":" << running.padding_frames
            << ",\"consumedFrames\":" << running.consumed_frames << ",\"submittedFrames\":" << running.submitted_frames
            << ",\"referenceFrames\":" << references << ",\"audibleReferenceFrames\":" << audible
            << ",\"deafenedSilentReferences\":" << silent << ",\"unexpectedAudibleReferences\":" << unexpected_audible
            << ",\"maximumScheduledAgeUs\":" << running.maximum_scheduled_age_100ns / 10
            << ",\"maximumWakeGapUs\":" << running.maximum_wake_gap_100ns / 10
            << ",\"underruns\":" << running.underruns << ",\"stopped\":" << (stopped ? "true" : "false") << "}\n";
  return passed ? 0 : 1;
}
}  // namespace
int main(int argc, char** argv) try {
  if (argc == 2 && std::string(argv[1]) == "routing") return remoteAudioRouting();
  if (argc == 2 && std::string(argv[1]) == "output-stress") return remoteAudioOutputStress();
  if (argc == 2 && std::string(argv[1]) == "default-removal") return remoteAudioDefaultRemoval();
  if (argc == 2 && std::string(argv[1]) == "aec") return remoteAudioAecFixture();
  if (argc == 2 && std::string(argv[1]) == "echo-publication") return remoteAudioEchoPublication();
  if (argc == 3 && std::string(argv[1]) == "ducking") return remoteAudioDucking(static_cast<std::uint32_t>(std::stoul(argv[2])));
  if (argc >= 3 && (std::string(argv[1]) == "publish" || std::string(argv[1]) == "receive" || std::string(argv[1]) == "receive-delay")) {
    const auto seconds = std::stoul(argv[2]);
    if (seconds < 23 || seconds > 1840) throw std::runtime_error("Invalid remote lab duration");
    if ((std::string(argv[1]) == "receive" || std::string(argv[1]) == "receive-delay") && argc == 3)
      return remoteAudioReceive(static_cast<unsigned>(seconds), std::string(argv[1]) == "receive-delay");
    if (std::string(argv[1]) == "publish" && argc == 4) {
      const auto frequency = std::stoul(argv[3]);
      if (frequency != 700 && frequency != 1300) throw std::runtime_error("Invalid lab frequency");
      return remoteAudioPublish(static_cast<unsigned>(seconds), static_cast<unsigned>(frequency));
    }
    throw std::runtime_error("Invalid remote lab arguments");
  }
  if (argc != 3 || std::string(argv[1]) != "output-probe")
    throw std::runtime_error(
        "Usage: remote_audio_lab output-probe <seconds:3..60> | output-stress | "
        "default-removal | aec | echo-publication | ducking <pid> | routing | "
        "publish <seconds:23..1840> <700|1300> | receive <seconds:23..1840> | "
        "receive-delay <seconds:23..1840>");
  const auto seconds = std::stoul(argv[2]);
  if (seconds < 3 || seconds > 60) throw std::runtime_error("Invalid output probe duration");
  return outputProbe(static_cast<unsigned>(seconds));
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
