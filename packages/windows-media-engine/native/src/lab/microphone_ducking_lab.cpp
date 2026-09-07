#include "audio/microphone_pipeline.hpp"
#include "audio/livekit_microphone_dsp.hpp"
#include "audio/process_loopback.hpp"
#include "lab/audio_session_volume_probe.hpp"
#include <cmath>
#include <iostream>
#include <stdexcept>

using namespace syrnike::windows_media::audio;
namespace {
using Clock = std::chrono::steady_clock;
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
std::int64_t timestamp() {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
std::shared_ptr<AudioProcessIdentity> targetProcess(std::uint32_t pid) {
  const auto handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  require(handle != nullptr, "Foreign media process unavailable");
  FILETIME creation{}, exit{}, kernel{}, user{};
  const auto result = GetProcessTimes(handle, &creation, &exit, &kernel, &user);
  CloseHandle(handle);
  require(result != FALSE, "Foreign media process identity unavailable");
  const auto value = (static_cast<std::uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
  auto identity = AudioProcessIdentity::fromProcess(pid, value);
  require(identity != nullptr, "Foreign media process identity changed");
  return identity;
}
double sample(PcmQueue& queue, syrnike::windows_media::lab::AudioSessionVolumeProbe& volumes, const char* phase) {
  const auto began = Clock::now();
  auto next_volume = began;
  double energy = 0;
  std::uint64_t samples = 0;
  while (Clock::now() - began < std::chrono::seconds{2}) {
    if (Clock::now() >= next_volume) {
      volumes.observe();
      next_volume = Clock::now() + std::chrono::milliseconds{50};
    }
    if (auto packet = queue.take(timestamp())) {
      // Exclude transition packets and allow endpoint/session policy to settle.
      if (Clock::now() - began < std::chrono::milliseconds{400}) continue;
      for (const auto value : packet->samples) energy += static_cast<double>(value) * value;
      samples += packet->samples.size();
    } else queue.wait(std::chrono::milliseconds{5});
  }
  require(samples >= kAudioRate, "Insufficient foreign media PCM");
  const auto rms = std::sqrt(energy / static_cast<double>(samples));
  std::cout << "MICROPHONE_DUCKING {\"phase\":\"" << phase << "\",\"rms\":" << rms
            << ",\"samples\":" << samples << "}" << std::endl;
  return rms;
}
}  // namespace

int microphoneDuckingLab(std::uint32_t pid) {
  require(pid != GetCurrentProcessId(), "Ducking fixture requires a foreign media process");
  syrnike::windows_media::lab::AudioSessionVolumeProbe volumes;
  require(volumes.sessions() > 0, "No active foreign media session for ducking evidence");
  auto queue = std::make_shared<PcmQueue>();
  ProcessLoopback loopback(queue);
  require(!loopback.start(ScreenAudioMode::include_process_tree, targetProcess(pid)), "Foreign media loopback failed");
  AudioDeviceRegistry registry(makeWindowsAudioDeviceEnumerator());
  require(registry.refresh().status == AudioRegistryStatus::ready, "Microphone registry failed");
  MicrophonePipeline pipeline(makeLiveKitMicrophoneEnhancement);
  require(pipeline.selectInput(registry, {AudioDirection::input, {}}) == MicrophonePipelineFailure::none,
          "Microphone input unavailable");
  const auto baseline = sample(*queue, volumes, "baseline");
  require(baseline > 30, "Foreign media baseline too quiet");
  require(pipeline.setDemand({true, false, true}) == MicrophonePipelineFailure::none, "Warm microphone failed");
  const auto warm = sample(*queue, volumes, "warm");
  MicrophoneDspConfig config;
  config.muted = true;
  require(pipeline.configure(config) == MicrophonePipelineFailure::none, "Mute failed");
  const auto muted = sample(*queue, volumes, "muted");
  config.muted = false;
  require(pipeline.configure(config) == MicrophonePipelineFailure::none, "Unmute failed");
  const auto unmuted = sample(*queue, volumes, "unmuted");
  require(pipeline.stop(Clock::now() + std::chrono::seconds{5}), "Microphone ducking cleanup deadline");
  const auto stopped = sample(*queue, volumes, "stopped");
  require(loopback.stop(Clock::now() + std::chrono::seconds{5}), "Foreign media loopback cleanup deadline");
  for (const auto value : {warm, muted, unmuted, stopped})
    require(std::abs(value / baseline - 1.0) <= 0.03, "Foreign media PCM level changed by more than 3 percent");
  std::cout << "{\"command\":\"microphone-ducking\",\"status\":\"pass\",\"foreignSessions\":" << volumes.sessions()
            << ",\"volumeObservations\":" << volumes.observations()
            << ",\"relativeLevelTolerance\":0.03,\"systemSettingsChanged\":false,\"stopped\":true}" << std::endl;
  return 0;
}
