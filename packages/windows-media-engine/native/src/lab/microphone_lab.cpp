#include "audio/microphone_capture.hpp"
#include <windows.h>
#include <tlhelp32.h>
#include <algorithm>
#include <charconv>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string_view>

using namespace syrnike::windows_media::audio;
int microphoneMuteCycleLab();
int microphoneCandidateFaultLab();
int microphoneCancellationFaultLab();
int microphonePublicationLab(unsigned seconds, std::optional<AudioDeviceId> input = {}, bool device_loss = false);
int microphoneDeviceSwitchLab();
int microphonePublicationFailureLab();
int microphoneDuckingLab(std::uint32_t pid);
int microphoneDefaultChangeLab();
int microphoneSyntheticAecLab();
namespace {
using Clock = std::chrono::steady_clock;
std::uint32_t number(std::string_view text, std::uint32_t maximum) {
  std::uint32_t result = 0;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), result);
  if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() || !result || result > maximum)
    throw std::invalid_argument("Invalid numeric microphone lab argument");
  return result;
}
DWORD handles() {
  DWORD count = 0;
  if (!GetProcessHandleCount(GetCurrentProcess(), &count)) throw std::runtime_error("Handle count failed");
  return count;
}
DWORD threads() {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snapshot == INVALID_HANDLE_VALUE) throw std::runtime_error("Thread count failed");
  THREADENTRY32 entry{};
  entry.dwSize = sizeof(entry);
  DWORD count = 0;
  if (Thread32First(snapshot, &entry)) do {
    if (entry.th32OwnerProcessID == GetCurrentProcessId()) ++count;
  } while (Thread32Next(snapshot, &entry));
  CloseHandle(snapshot);
  return count;
}
const char* failureName(MicrophoneCaptureFailure failure) {
  switch (failure) {
    case MicrophoneCaptureFailure::none: return "none";
    case MicrophoneCaptureFailure::invalid_state: return "invalid_state";
    case MicrophoneCaptureFailure::cancelled: return "cancelled";
    case MicrophoneCaptureFailure::activation_failed: return "activation_failed";
    case MicrophoneCaptureFailure::format_unavailable: return "format_unavailable";
    case MicrophoneCaptureFailure::policy_unavailable: return "policy_unavailable";
    case MicrophoneCaptureFailure::device_lost: return "device_lost";
    case MicrophoneCaptureFailure::capture_failed: return "capture_failed";
    case MicrophoneCaptureFailure::no_progress: return "no_progress";
    case MicrophoneCaptureFailure::start_timeout: return "start_timeout";
    case MicrophoneCaptureFailure::stop_timeout: return "stop_timeout";
  }
  return "unknown";
}
}  // namespace
int main(int argc, char** argv) try {
  if (argc == 2 && std::string_view(argv[1]) == "microphone-synthetic-aec") return microphoneSyntheticAecLab();
  if (argc == 2 && std::string_view(argv[1]) == "microphone-mute-cycle") return microphoneMuteCycleLab();
  if (argc == 2 && std::string_view(argv[1]) == "microphone-candidate-fault") return microphoneCandidateFaultLab();
  if (argc == 2 && std::string_view(argv[1]) == "microphone-cancellation") return microphoneCancellationFaultLab();
  if (argc == 2 && std::string_view(argv[1]) == "microphone-device-switch") return microphoneDeviceSwitchLab();
  if (argc == 2 && std::string_view(argv[1]) == "microphone-publication-failure") return microphonePublicationFailureLab();
  if (argc == 2 && std::string_view(argv[1]) == "microphone-default-change") return microphoneDefaultChangeLab();
  if (argc == 3 && std::string_view(argv[1]) == "microphone-ducking")
    return microphoneDuckingLab(number(argv[2], 0xffffffffu));
  if (argc == 3 && std::string_view(argv[1]) == "microphone-publication")
    return microphonePublicationLab(number(argv[2], 1800));
  if (argc == 5 && std::string_view(argv[1]) == "microphone-publication" && std::string_view(argv[3]) == "--input")
    return microphonePublicationLab(number(argv[2], 1800), number(argv[4], 512));
  if (argc == 5 && std::string_view(argv[1]) == "microphone-device-loss" && std::string_view(argv[3]) == "--input")
    return microphonePublicationLab(number(argv[2], 1800), number(argv[4], 512), true);
  if (argc == 4 && std::string_view(argv[1]) == "microphone-soak" && std::string_view(argv[2]) == "--minutes")
    return microphonePublicationLab(number(argv[3], 30) * 60);
  if (argc < 2 || std::string_view(argv[1]) != "microphone-capture")
    throw std::invalid_argument("usage: media_lab microphone-capture [--seconds 1..1800] [--input 1..512]");
  std::uint32_t seconds = 5;
  std::optional<AudioDeviceId> input;
  for (int index = 2; index < argc; ++index) {
    const std::string_view argument(argv[index]);
    if (++index == argc) throw std::invalid_argument("Missing microphone lab argument value");
    if (argument == "--seconds") seconds = number(argv[index], 1800);
    else if (argument == "--input") input = number(argv[index], 512);
    else throw std::invalid_argument("Unknown microphone lab argument");
  }
  AudioDeviceRegistry registry(makeWindowsAudioDeviceEnumerator());
  const auto devices = registry.refresh();
  if (devices.status != AudioRegistryStatus::ready) throw std::runtime_error("Audio registry failed");
  auto endpoint = registry.resolve({AudioDirection::input, input});
  if (!endpoint) {
    std::cout << "{\"command\":\"microphone-capture\",\"status\":\"unavailable\",\"failure\":\"input_unavailable\"}\n";
    return 2;
  }
  const auto baseline_handles = handles();
  const auto baseline_threads = threads();
  MicrophoneCaptureStats final_stats;
  std::uint64_t observed = 0, superseded = 0, last_sequence = 0;
  std::uint64_t max_age_us = 0;
  double energy = 0;
  std::uint64_t sample_count = 0;
  DWORD peak_handles = baseline_handles, peak_threads = baseline_threads;
  bool stopped = false;
  {
    MicrophoneCapture capture;
    const auto failure = capture.start(std::move(*endpoint), 1);
    if (failure == MicrophoneCaptureFailure::none) {
      const auto port = capture.pcm();
      const auto deadline = Clock::now() + std::chrono::seconds{seconds};
      auto next_resource_sample = Clock::now();
      while (Clock::now() < deadline && capture.stats().failure == MicrophoneCaptureFailure::none) {
        if (const auto frame = port->take()) {
          ++observed;
          if (last_sequence && frame->sequence > last_sequence + 1) superseded += frame->sequence - last_sequence - 1;
          last_sequence = frame->sequence;
          const auto now = std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
              Clock::now().time_since_epoch()).count();
          max_age_us = (std::max)(max_age_us, static_cast<std::uint64_t>((std::max)(std::int64_t{0}, now - frame->timestamp_100ns) / 10));
          for (const auto sample : frame->samples) energy += static_cast<double>(sample) * sample;
          sample_count += frame->samples.size();
        }
        if (Clock::now() >= next_resource_sample) {
          peak_handles = (std::max)(peak_handles, handles());
          peak_threads = (std::max)(peak_threads, threads());
          next_resource_sample = Clock::now() + std::chrono::seconds{1};
        }
        const auto wait = WaitForSingleObject(capture.frameEvent(), 100);
        if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT)
          throw std::runtime_error("Microphone frame wait failed");
      }
    }
    stopped = capture.stop(Clock::now() + std::chrono::seconds{5});
    final_stats = capture.stats();
  }
  const bool passed = stopped && final_stats.failure == MicrophoneCaptureFailure::none && observed >= seconds * 80ULL &&
                      !final_stats.client_alive && !final_stats.thread_alive && !final_stats.mmcss_registered;
  std::cout << "{\"command\":\"microphone-capture\",\"status\":\"" << (passed ? "pass" : "fail")
            << "\",\"failure\":\"" << failureName(final_stats.failure)
            << "\",\"platformResult\":" << final_stats.platform_result
            << ",\"seconds\":" << seconds << ",\"rate\":48000,\"channels\":1,\"samplesPerFrame\":480"
            << ",\"captured\":" << final_stats.frames << ",\"observed\":" << observed
            << ",\"superseded\":" << superseded << ",\"maxAgeUs\":" << max_age_us
            << ",\"rms\":" << (sample_count ? std::sqrt(energy / static_cast<double>(sample_count)) / 32768.0 : 0.0)
            << ",\"callbackCount\":" << final_stats.callback_count
            << ",\"callbackMaxUs\":" << final_stats.callback_max_us
            << ",\"callbackHistogram\":[";
  for (std::size_t index = 0; index < final_stats.callback_histogram.size(); ++index) {
    if (index) std::cout << ',';
    std::cout << final_stats.callback_histogram[index];
  }
  std::cout << "],\"discontinuities\":" << final_stats.discontinuities
            << ",\"platformDiscontinuities\":" << final_stats.platform_discontinuities
            << ",\"firstPositionStep\":" << final_stats.first_position_step
            << ",\"firstPacketFrames\":" << final_stats.first_packet_frames
            << ",\"invalidTimestamps\":" << final_stats.invalid_timestamps
            << ",\"baselineHandles\":" << baseline_handles << ",\"peakHandles\":" << peak_handles
            << ",\"finalHandles\":" << handles() << ",\"baselineThreads\":" << baseline_threads
            << ",\"peakThreads\":" << peak_threads << ",\"finalThreads\":" << threads()
            << ",\"stopped\":" << (stopped ? "true" : "false") << "}\n";
  return passed ? 0 : 1;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
