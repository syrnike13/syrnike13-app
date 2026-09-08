#include "audio/remote_audio_output.hpp"
#include "audio/process_loopback.hpp"
#include "lab/audio_session_volume_probe.hpp"

#include <cmath>
#include <iostream>
#include <stdexcept>

using namespace syrnike::windows_media::audio;
namespace {
using Clock = std::chrono::steady_clock;
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
std::int64_t timestamp() {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
std::shared_ptr<AudioProcessIdentity> targetProcess(std::uint32_t pid) {
  const auto handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  require(handle != nullptr, "Ducking fixture process unavailable");
  FILETIME creation{}, exit{}, kernel{}, user{};
  const auto valid = GetProcessTimes(handle, &creation, &exit, &kernel, &user);
  CloseHandle(handle);
  require(valid != FALSE, "Ducking fixture process identity unavailable");
  auto identity = AudioProcessIdentity::fromProcess(pid,
      (static_cast<std::uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime);
  require(identity != nullptr, "Ducking fixture process changed");
  return identity;
}
}
int remoteAudioDucking(std::uint32_t pid) {
  require(pid != GetCurrentProcessId(), "Ducking requires a foreign media process");
  syrnike::windows_media::lab::AudioSessionVolumeProbe volumes;
  require(volumes.sessions() > 0, "Ducking requires active foreign sessions");
  auto queue = std::make_shared<PcmQueue>();
  ProcessLoopback loopback(queue);
  require(!loopback.start(ScreenAudioMode::include_process_tree, targetProcess(pid)), "Ducking loopback failed");
  AudioDeviceRegistry registry(makeWindowsAudioDeviceEnumerator());
  const auto devices = registry.refresh();
  require(devices.status == AudioRegistryStatus::ready, "Ducking output registry failed");
  RemoteAudioMixerWorker mixer;
  RemoteAudioOutput output(mixer);
  struct Measurement { const char* name; double rms; std::uint64_t samples; };
  std::vector<Measurement> measurements;
  const auto sample = [&](const char* name) {
    const auto began = Clock::now();
    auto next_volume = began;
    double energy = 0;
    std::uint64_t samples = 0;
    while (Clock::now() - began < std::chrono::seconds{2}) {
      if (Clock::now() >= next_volume) {
        volumes.observe();
        next_volume = Clock::now() + std::chrono::milliseconds{50};
      }
      if (auto packet = queue->take(timestamp())) {
        if (Clock::now() - began < std::chrono::milliseconds{400}) continue;
        for (const auto value : packet->samples) energy += static_cast<double>(value) * value;
        samples += packet->samples.size();
      } else queue->wait(std::chrono::milliseconds{5});
    }
    require(samples >= kAudioRate, "Ducking foreign PCM insufficient");
    measurements.push_back({name, std::sqrt(energy / samples), samples});
  };
  sample("baseline");
  require(measurements[0].rms > 30, "Ducking baseline too quiet");
  require(output.selectOutput(registry, {AudioDirection::output, {}}) == RemoteOutputFailure::none,
          "Ducking default output failed");
  sample("default");
  std::uint32_t explicit_count = 0;
  for (const auto& device : devices.devices) if (device.direction == AudioDirection::output) {
    require(output.selectOutput(registry, {AudioDirection::output, device.id}) == RemoteOutputFailure::none,
            "Ducking explicit output failed");
    sample("explicit");
    ++explicit_count;
  }
  require(output.setDeafened(true), "Ducking deafen failed");
  sample("deafened");
  require(output.setDeafened(false), "Ducking undeafen failed");
  sample("undeafened");
  require(output.stop(Clock::now() + std::chrono::seconds{5}), "Ducking output stop failed");
  sample("stopped");
  require(loopback.stop(Clock::now() + std::chrono::seconds{5}) && mixer.stop(Clock::now() + std::chrono::seconds{5}),
          "Ducking cleanup deadline");
  bool passed = explicit_count > 0;
  for (const auto& value : measurements) passed = passed && std::abs(value.rms / measurements[0].rms - 1) <= 0.03;
  std::cout << "{\"scope\":\"wasapi-output-foreign-session-ducking\",\"status\":\"" << (passed ? "pass" : "fail")
            << "\",\"foreignSessions\":" << volumes.sessions() << ",\"volumeObservations\":" << volumes.observations()
            << ",\"explicitOutputs\":" << explicit_count << ",\"relativeTolerance\":0.03,\"systemSettingsChanged\":false,\"measurements\":[";
  for (std::size_t index = 0; index < measurements.size(); ++index) {
    if (index) std::cout << ',';
    const auto& value = measurements[index];
    std::cout << "{\"phase\":\"" << value.name << "\",\"rms\":" << value.rms << ",\"samples\":" << value.samples << '}';
  }
  std::cout << "]}" << std::endl;
  return passed ? 0 : 1;
}
