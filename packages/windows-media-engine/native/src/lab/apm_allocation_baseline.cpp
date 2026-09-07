#include "lab/heap_allocation_probe.hpp"
#include <livekit/livekit.h>
#include <livekit/audio_processing_module.h>
#include <chrono>
#include <iostream>

int main() try {
  livekit::initialize();
  struct Shutdown { ~Shutdown() { livekit::shutdown(); } } shutdown;
  livekit::AudioProcessingModule::Options options;
  options.noise_suppression = true;
  options.echo_cancellation = true;
  livekit::AudioProcessingModule apm(options);
  auto microphone = livekit::AudioFrame::create(48'000, 1, 480);
  auto reference = livekit::AudioFrame::create(48'000, 1, 480);
  const auto process = [&] {
    apm.setStreamDelayMs(20);
    apm.processReverseStream(reference);
    apm.processStream(microphone);
  };
  for (int frame = 0; frame < 200; ++frame) process();
  syrnike::windows_media::lab::HeapAllocationProbe heap;
  const auto began = std::chrono::steady_clock::now();
  heap.begin();
  for (int frame = 0; frame < 1000; ++frame) process();
  const auto counts = heap.end();
  const auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - began).count();
  std::cout << "{\"command\":\"microphone-apm-allocation-baseline\",\"sdk\":\"1.10.0-syrnike.12\","
               "\"frames\":1000,\"heapImports\":" << heap.imports()
            << ",\"allocations\":" << counts.allocations << ",\"reallocations\":" << counts.reallocations
            << ",\"requestedBytes\":" << counts.bytes << ",\"elapsedUs\":" << elapsed
            << ",\"realtimeAllocationFree\":" << (counts.allocations == 0 && counts.reallocations == 0 ? "true" : "false") << "}\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
