#include "audio/microphone_capture.hpp"
#include "lab/microphone_capture_probe.hpp"
#include <iostream>
#include <stdexcept>
#include <cstdlib>
#include <cstring>
#include <string_view>

using namespace syrnike::windows_media::audio;
int main(int argc, char** argv) try {
  using Clock = std::chrono::steady_clock;
  const bool device_loss = argc == 2 && std::string_view(argv[1]) == "--device-loss";
  if (argc != 1 && !device_loss) throw std::invalid_argument("Usage: microphone_capture_allocation [--device-loss]");
  if (device_loss) syrnike::windows_media::lab::capture_device_loss_after_frames = 100;
  {
    syrnike::windows_media::lab::HeapAllocationProbe control;
    control.begin();
    auto* allocated = _strdup("capture allocation probe positive control");
    const auto counts = control.end();
    const bool observed = allocated && counts.allocations > 0;
    std::free(allocated);
    if (!observed) throw std::runtime_error("Heap allocation positive control failed");
  }
  AudioDeviceRegistry registry(makeWindowsAudioDeviceEnumerator());
  if (registry.refresh().status != AudioRegistryStatus::ready) throw std::runtime_error("Registry unavailable");
  auto endpoint = registry.resolve({AudioDirection::input, {}});
  if (!endpoint) throw std::runtime_error("Default microphone unavailable");
  MicrophoneCapture capture;
  if (capture.start(*endpoint, 1) != MicrophoneCaptureFailure::none) throw std::runtime_error("Capture startup failed");
  const auto began = Clock::now();
  while (Clock::now() - began < std::chrono::seconds{10} &&
         capture.stats().failure == MicrophoneCaptureFailure::none) {
    (void)capture.pcm()->take();
    const auto wait = WaitForSingleObject(capture.frameEvent(), 100);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) throw std::runtime_error("Capture wait failed");
  }
  const auto stopped = capture.stop(Clock::now() + std::chrono::seconds{5});
  const auto stats = capture.stats();
  const auto counts = syrnike::windows_media::lab::capture_heap_counts;
  if (device_loss) {
    const bool accepted = stopped && stats.state == MicrophoneCaptureState::failed &&
                          stats.failure == MicrophoneCaptureFailure::device_lost && stats.frames >= 100 &&
                          !stats.client_alive && !stats.thread_alive && !stats.mmcss_registered;
    std::cout << "{\"command\":\"microphone-capture-device-loss\",\"accepted\":" << (accepted ? "true" : "false")
              << ",\"injectedHresult\":true,\"physicalUnplug\":false,\"failure\":\"device_lost\",\"frames\":" << stats.frames
              << ",\"clientAlive\":" << (stats.client_alive ? "true" : "false")
              << ",\"threadAlive\":" << (stats.thread_alive ? "true" : "false")
              << ",\"mmcssRegistered\":" << (stats.mmcss_registered ? "true" : "false")
              << ",\"stopped\":" << (stopped ? "true" : "false") << "}" << std::endl;
    return accepted ? 0 : 1;
  }
  const bool accepted = stopped && stats.failure == MicrophoneCaptureFailure::none && stats.frames >= 900 &&
                        counts.allocations == 0 && counts.reallocations == 0;
  std::cout << "{\"command\":\"microphone-capture-allocation\",\"accepted\":" << (accepted ? "true" : "false")
            << ",\"positiveControl\":true,\"seconds\":10,\"frames\":" << stats.frames << ",\"callbackCount\":" << stats.callback_count
            << ",\"callbackMaxUs\":" << stats.callback_max_us << ",\"heapAllocations\":" << counts.allocations
            << ",\"heapReallocations\":" << counts.reallocations << ",\"heapBytes\":" << counts.bytes
            << ",\"interceptedImports\":" << syrnike::windows_media::lab::capture_heap_imports
            << ",\"stopped\":" << (stopped ? "true" : "false") << "}" << std::endl;
  return accepted ? 0 : 1;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
