#include <windows.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <thread>

#include <livekit/video_frame.h>

#include "media/remote_video_texture_pool.hpp"
#include "media/video_resource_admission.hpp"

namespace {
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
using syrnike::desktop_native::media::RemoteVideoTextureCompletionPoll;
using syrnike::desktop_native::media::RemoteVideoTextureFrame;
using syrnike::desktop_native::media::RemoteVideoTexturePool;
using syrnike::desktop_native::media::VideoResourceAdmissionBudget;
using syrnike::desktop_native::media::productionVideoResourceLimits;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
}  // namespace

int main() try {
  auto source = livekit::VideoFrame::create(
      64, 64, livekit::VideoBufferType::BGRA);
  std::fill(source.data(), source.data() + 64 * 64 * 4, 0x5a);

  bool hold_first_completion = true;
  std::uint64_t maximum_control_elapsed_us = 0;
  VideoResourceAdmissionBudget resource_budget(
      productionVideoResourceLimits());
  RemoteVideoTexturePool pool(
      resource_budget,
      "remote:completion-control",
      GetCurrentProcessId(),
      64,
      64,
      2,
      [&](const RemoteVideoTextureCompletionPoll& observation) noexcept {
        maximum_control_elapsed_us = std::max(
            maximum_control_elapsed_us, observation.elapsed_us);
        return hold_first_completion && observation.submission_sequence == 1;
      });
  require(pool.submit(source, 11), "controlled upload was rejected");

  bool quarantined = false;
  const auto quarantine_deadline = Clock::now() + 750ms;
  while (!quarantined && Clock::now() < quarantine_deadline) {
    const auto result = pool.poll();
    require(!result.reset_required, "timeout requested a device reset");
    quarantined = result.slots_quarantined == 1;
    std::this_thread::sleep_for(1ms);
  }
  require(quarantined, "completion control did not reach the 500 ms timeout");
  require(pool.quarantined() == 1, "timed-out slot was not quarantined");
  require(
      maximum_control_elapsed_us >= 500'000,
      "completion control did not observe the real timeout budget");
  RemoteVideoTextureFrame frame;
  require(!pool.take(frame), "timed-out texture escaped before recovery");

  hold_first_completion = false;
  bool recovered = false;
  const auto recovery_deadline = Clock::now() + 1s;
  while (!recovered && Clock::now() < recovery_deadline) {
    const auto result = pool.poll();
    require(!result.reset_required, "late completion requested a reset");
    recovered = result.slots_recovered == 1;
    std::this_thread::sleep_for(1ms);
  }
  require(recovered, "late completion did not recover its quarantined slot");
  require(pool.take(frame), "late completion was not made available safely");
  require(
      frame.gpu_completion_us >= 500'000,
      "late completion lost its measured timeout duration");
  frame.lease.reset();
  require(pool.available() == 2, "recovered texture lease was not recycled");

  require(pool.submit(source, 22), "post-recovery upload was rejected");
  const auto publish_deadline = Clock::now() + 1s;
  while (!pool.take(frame) && Clock::now() < publish_deadline) {
    pool.poll();
    std::this_thread::sleep_for(1ms);
  }
  require(frame.timestamp_us == 22, "post-recovery frame was not published");
  frame.lease.reset();

  require(pool.submit(source, 33), "discard-ready upload was rejected");
  const auto ready_deadline = Clock::now() + 1s;
  while (pool.ready() == 0 && Clock::now() < ready_deadline) {
    pool.poll();
    std::this_thread::sleep_for(1ms);
  }
  require(pool.ready() == 1, "discard-ready upload did not complete");
  require(
      pool.discardReady() == 1 && pool.available() == 2 && !pool.take(frame),
      "discardReady did not reclaim only the undelivered completed texture");

  std::cout << "Remote video completion control tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << "Remote video completion control tests failed: "
            << error.what() << '\n';
  return 1;
}
