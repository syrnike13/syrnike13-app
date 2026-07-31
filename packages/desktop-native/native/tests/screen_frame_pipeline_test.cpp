#include <chrono>
#include <cstdint>
#include <iostream>
#include <stdexcept>

#include "media/screen_frame_pipeline.hpp"

int main() try {
  using namespace std::chrono_literals;
  using syrnike::desktop_native::media::ScreenFrameCadence;
  using syrnike::desktop_native::media::ScreenFrameSubmitReason;
  using syrnike::desktop_native::media::ScreenLatencyWindow;

  const auto started = ScreenFrameCadence::TimePoint{10s};
  ScreenFrameCadence cadence(1s);
  if (cadence.decision(started) != ScreenFrameSubmitReason::None) {
    throw std::runtime_error("cadence submitted without captured state");
  }
  cadence.noteSourceUpdate();
  if (cadence.decision(started) != ScreenFrameSubmitReason::SourceUpdate) {
    throw std::runtime_error("new source state was not selected immediately");
  }
  cadence.noteSourceUpdate();
  if (cadence.coalescedSourceUpdates() != 1) {
    throw std::runtime_error("unsubmitted source state was not coalesced");
  }
  cadence.noteSubmitted(ScreenFrameSubmitReason::SourceUpdate, started);
  if (cadence.decision(started + 999ms) != ScreenFrameSubmitReason::None ||
      cadence.decision(started + 1s) != ScreenFrameSubmitReason::IdleRefresh) {
    throw std::runtime_error("static refresh cadence was not bounded");
  }
  cadence.noteSubmitted(ScreenFrameSubmitReason::IdleRefresh, started + 1s);
  if (cadence.submissions() != 2 || cadence.idleRefreshes() != 1) {
    throw std::runtime_error("cadence submission counters diverged");
  }

  ScreenLatencyWindow<8> latency;
  for (const std::uint64_t sample : {8U, 1U, 4U, 2U, 16U}) {
    latency.record(sample);
  }
  const auto quantiles = latency.snapshot();
  if (quantiles.p50_us != 4 || quantiles.p95_us != 16 ||
      quantiles.max_us != 16) {
    throw std::runtime_error("latency quantiles were calculated incorrectly");
  }

  std::cout << "screen frame cadence and latency tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
