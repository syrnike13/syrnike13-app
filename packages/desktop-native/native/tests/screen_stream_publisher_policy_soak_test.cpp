#include <chrono>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <stdexcept>

#include "media/screen_capture_slot_state.hpp"
#include "media/screen_frame_pipeline.hpp"
#include "media/screen_pipeline_stall.hpp"

int main() try {
  using namespace std::chrono_literals;
  using syrnike::desktop_native::media::ScreenFrameCadence;
  using syrnike::desktop_native::media::ScreenFrameSubmitReason;
  using syrnike::desktop_native::media::ScreenGpuSlotState;
  using syrnike::desktop_native::media::ScreenOutputStall;
  using syrnike::desktop_native::media::ScreenPipelineStall;

  constexpr std::uint64_t kFrames = 1'000'000;
  ScreenFrameCadence cadence(1s);
  ScreenGpuSlotState<5> slots;
  const auto started = ScreenFrameCadence::TimePoint{10s};

  for (std::uint64_t sequence = 1; sequence <= kFrames; ++sequence) {
    const auto now = started + std::chrono::microseconds(sequence * 16'667);
    cadence.noteSourceUpdate();
    const auto reason = cadence.decision(now);
    if (reason != ScreenFrameSubmitReason::SourceUpdate) {
      throw std::runtime_error(
          "publisher cadence accumulated stale source state");
    }
    cadence.noteSubmitted(reason, now);

    const auto slot = static_cast<std::size_t>(sequence % slots.total());
    slots.producerAcquired(slot);
    slots.publish(slot, sequence);
    if (slots.available() != slots.total() - 1) {
      throw std::runtime_error("publisher slot accounting drifted after publish");
    }
    if (!slots.discard(
            slot,
            sequence,
            [] { return true; },
            [] { return true; })) {
      throw std::runtime_error("publisher slot could not be reclaimed");
    }
    if (slots.available() != slots.total()) {
      throw std::runtime_error(
          "publisher slot capacity degraded over the long run");
    }
  }

  if (cadence.sourceRevision() != kFrames ||
      cadence.submissions() != kFrames ||
      cadence.coalescedSourceUpdates() != 0 ||
      cadence.idleRefreshes() != 0) {
    throw std::runtime_error("publisher cadence counters drifted in soak");
  }

  syrnike::desktop_native::media::EncoderBackpressureStallDetector
    backpressure;
  const auto stall_started = std::chrono::steady_clock::time_point{20s};
  if (backpressure.observe(stall_started, 2s) ||
      backpressure.observe(stall_started + 1'999ms, 2s) ||
      !backpressure.observe(stall_started + 2s, 2s) ||
      backpressure.observe(stall_started + 3s, 2s)) {
    throw std::runtime_error(
      "encoder backpressure stall threshold is not one-shot and exact"
    );
  }
  backpressure.noteProgress();
  if (backpressure.observe(stall_started + 4s, 2s)) {
    throw std::runtime_error(
      "encoder backpressure progress did not reset the detector"
    );
  }

  syrnike::desktop_native::media::ScreenOutputStallDetector encoder_output;
  if (encoder_output.observe(stall_started, true, 1, 0, 0, 5s) !=
        ScreenOutputStall::None ||
      encoder_output.observe(stall_started + 4s, true, 2, 0, 0, 5s) !=
        ScreenOutputStall::None ||
      encoder_output.observe(stall_started + 5s, true, 3, 0, 0, 5s) !=
        ScreenOutputStall::Encoder) {
    throw std::runtime_error(
      "encoder output stall was not detected after five seconds"
    );
  }

  syrnike::desktop_native::media::ScreenOutputStallDetector rtp_output;
  if (rtp_output.observe(stall_started, true, 1, 1, 0, 5s) !=
        ScreenOutputStall::None ||
      rtp_output.observe(stall_started + 4s, true, 1, 1, 0, 5s) !=
        ScreenOutputStall::None ||
      rtp_output.observe(stall_started + 5s, true, 1, 1, 0, 5s) !=
        ScreenOutputStall::Transport) {
    throw std::runtime_error(
      "RTP output stall was not detected after five seconds"
    );
  }

  syrnike::desktop_native::media::ScreenOutputStallDetector static_screen;
  if (static_screen.observe(stall_started, true, 1, 1, 1, 5s) !=
        ScreenOutputStall::None ||
      static_screen.observe(stall_started + 30s, true, 1, 1, 1, 5s) !=
        ScreenOutputStall::None) {
    throw std::runtime_error(
      "static screen was misclassified as an output stall"
    );
  }

  const syrnike::desktop_native::media::ScreenPipelineStallError
    backpressure_error(ScreenPipelineStall::EncoderBackpressure);
  const syrnike::desktop_native::media::ScreenPipelineStallError
    encoder_error(ScreenPipelineStall::EncoderOutput);
  const syrnike::desktop_native::media::ScreenPipelineStallError
    rtp_error(ScreenPipelineStall::RtpOutput);
  if (std::string_view(backpressure_error.what()) !=
        "encoder_backpressure_stalled" ||
      std::string_view(encoder_error.what()) != "encoder_output_stalled" ||
      std::string_view(rtp_error.what()) != "rtp_output_stalled") {
    throw std::runtime_error("publisher stall reasons lost their typed code");
  }
  if (!syrnike::desktop_native::media::isScreenPipelineStallReason(
        backpressure_error.what()) ||
      !syrnike::desktop_native::media::isScreenPipelineStallReason(
        encoder_error.what()) ||
      !syrnike::desktop_native::media::isScreenPipelineStallReason(
        rtp_error.what()) ||
      syrnike::desktop_native::media::isScreenPipelineStallReason(
        "runtime_error")) {
    throw std::runtime_error(
      "publisher stall reasons are not recognized by the terminal path"
    );
  }

  std::cout << "screen publisher bounded-policy and stall tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
