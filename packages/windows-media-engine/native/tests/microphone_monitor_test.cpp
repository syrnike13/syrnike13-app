#include "audio/microphone_monitor.hpp"

#include <windows.h>
#include <objbase.h>

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <thread>

using namespace syrnike::windows_media::audio;
using namespace std::chrono_literals;
namespace {
using Clock = std::chrono::steady_clock;
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
struct Apartment {
  HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
};
MicrophoneFrame speech(std::uint64_t sequence) {
  MicrophoneFrame frame;
  frame.sequence = sequence;
  for (std::size_t index = 0; index < frame.samples.size(); ++index)
    frame.samples[index] = index % 2 ? 2000 : -2000;
  return frame;
}
void rejectsInvalidConstruction() {
  auto source = std::make_shared<MicrophonePcmPort>();
  bool rejected = false;
  try {
    MicrophoneMonitor monitor({L"input", AudioDirection::input, "Microphone"}, source, 1.0f);
  } catch (const std::invalid_argument&) { rejected = true; }
  require(rejected, "An input endpoint was accepted as monitor output");
  rejected = false;
  try {
    MicrophoneMonitor monitor({L"output", AudioDirection::output, "Speakers"}, nullptr, 1.0f);
  } catch (const std::invalid_argument&) { rejected = true; }
  require(rejected, "A monitor without a source was accepted");
}
void missingOutputDropsFramesAndStopsPromptly() {
  auto source = std::make_shared<MicrophonePcmPort>();
  const auto started = Clock::now();
  {
    MicrophoneMonitor monitor({L"{missing-output-endpoint}", AudioDirection::output, "Missing"}, source, 1.0f);
    for (std::uint64_t sequence = 0; sequence < 20; ++sequence) {
      source->publish(speech(sequence));
      std::this_thread::sleep_for(10ms);
    }
    std::this_thread::sleep_for(50ms);
    const auto stats = monitor.stats();
    require(!stats.device_open && stats.device_opens == 0, "A missing output was reported open");
    require(stats.device_platform_result != 0, "The open failure was not recorded");
    require(stats.rendered_frames == 0 && stats.dropped_frames >= 18,
            "Frames without a device were kept for later playback");
    require(source->pendingFrames() <= 1, "Frames without a device built a backlog");
  }
  require(Clock::now() - started < 2s, "Monitor shutdown waited for the device retry");
}
// Renders on the real default output at zero volume: the device clock pulls
// frames, but nothing is audible on the machine running the test.
void rendersOnDefaultOutputSilently() {
  AudioDeviceRegistry registry(makeWindowsAudioDeviceEnumerator());
  (void)registry.refresh();
  const auto endpoint = registry.resolve({AudioDirection::output, {}});
  if (!endpoint) {
    std::cout << "No output device; default output render skipped\n";
    return;
  }
  auto source = std::make_shared<MicrophonePcmPort>();
  MicrophoneMonitor monitor(*endpoint, source, 0.0f);
  for (std::uint64_t sequence = 0; sequence < 50; ++sequence) {
    source->publish(speech(sequence));
    std::this_thread::sleep_for(10ms);
  }
  const auto stats = monitor.stats();
  require(stats.device_open && stats.device_opens == 1, "Default output did not open");
  require(stats.rendered_frames >= 20, "The device clock did not pull monitor frames");
  require(source->pendingFrames() <= 3, "Monitor latency grew beyond the queue bound");
}
}  // namespace
int main() try {
  Apartment apartment;
  rejectsInvalidConstruction();
  missingOutputDropsFramesAndStopsPromptly();
  rendersOnDefaultOutputSilently();
  std::cout << "Microphone monitor contracts passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
