#include "audio/process_loopback.hpp"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>

using namespace syrnike::windows_media::audio;
using Clock = std::chrono::steady_clock;
namespace {
std::int64_t now100ns() {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
             Clock::now().time_since_epoch())
      .count();
}
std::shared_ptr<AudioProcessIdentity> identity(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) throw std::runtime_error("Cannot open fixture process");
  FILETIME created{}, exited{}, kernel{}, user{};
  const bool valid = GetProcessTimes(process, &created, &exited, &kernel, &user) != FALSE;
  CloseHandle(process);
  if (!valid) throw std::runtime_error("Cannot resolve fixture process identity");
  return AudioProcessIdentity::fromProcess(
      pid, (static_cast<std::uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime);
}
}  // namespace
// Capture-only integration oracle. The parent harness owns all fixture
// processes; this executable never selects an arbitrary user's window.
int main(int argc, char** argv) {
  try {
    if (argc != 5) throw std::runtime_error("Expected mode, fixture PID, duration ms and cycles");
    const std::string mode = argv[1];
    if (mode != "include" && mode != "exclude") throw std::runtime_error("Unknown capture mode");
    const auto target = identity(static_cast<DWORD>(std::stoul(argv[2])));
    const auto duration = std::chrono::milliseconds(std::stoul(argv[3]));
    const auto cycles = std::stoul(argv[4]);
    if (duration.count() > 30'000 || duration.count() < 100 || cycles < 1 || cycles > 30)
      throw std::runtime_error("Capture oracle bounds exceeded");
    DWORD baseline = 0;
    GetProcessHandleCount(GetCurrentProcess(), &baseline);
    for (unsigned long cycle = 0; cycle < cycles; ++cycle) {
      std::uint64_t packets = 0, active_packets = 0, age_max_us = 0;
      double peak_rms = 0;
      std::optional<ScreenAudioFailure> failure;
      LoopbackStats capture_stats;
      {
        auto queue = std::make_shared<PcmQueue>();
        ProcessLoopback capture(queue);
        if (const auto error =
                capture.start(mode == "include" ? ScreenAudioMode::include_process_tree
                                                : ScreenAudioMode::system_exclude_client,
                              target))
          throw std::runtime_error("Loopback start failed: " +
                                   std::to_string(static_cast<int>(error->code)));
        const auto deadline = Clock::now() + duration;
        while (Clock::now() < deadline && capture.state() == ScreenAudioState::running) {
          if (const auto packet = queue->take(now100ns())) {
            double squares = 0;
            for (auto value : packet->samples) squares += static_cast<double>(value) * value;
            const double rms = std::sqrt(squares / packet->samples.size());
            peak_rms = (std::max)(peak_rms, rms);
            if (rms > 100) ++active_packets;
            ++packets;
            age_max_us = (std::max)(age_max_us,
                                    static_cast<std::uint64_t>(
                                        (std::max)(std::int64_t{0},
                                                   now100ns() - packet->capture_timestamp_100ns) /
                                        10));
          } else
            queue->wait(std::chrono::milliseconds{10});
        }
        failure = capture.failure();
        if (!capture.stop(Clock::now() + std::chrono::seconds{5}))
          throw std::runtime_error("Loopback stop did not drain");
        capture_stats = capture.stats();
        if (capture_stats.audio_clients || capture_stats.capture_threads || queue->take(now100ns()))
          throw std::runtime_error("Capture resources or PCM survived stop");
      }
      DWORD handles = 0;
      GetProcessHandleCount(GetCurrentProcess(), &handles);
      std::cout << "AUDIO_CAPTURE_SAMPLE {\"cycle\":" << cycle << ",\"packets\":" << packets
                << ",\"activePackets\":" << active_packets << ",\"peakRms\":" << peak_rms
                << ",\"maximumAgeUs\":" << age_max_us
                << ",\"failure\":" << (failure ? static_cast<int>(failure->code) : -1)
                << ",\"handlesDelta\":" << static_cast<long long>(handles) - baseline
                << ",\"clientsAfterStop\":" << capture_stats.audio_clients
                << ",\"threadsAfterStop\":" << capture_stats.capture_threads << "}" << std::endl;
      if (failure) break;
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << std::endl;
    return 1;
  }
}
