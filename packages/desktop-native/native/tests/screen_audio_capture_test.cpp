#include <array>
#include <cstdint>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <vector>

#include <livekit/operation_cancellation.h>

#include "media/screen_audio_capture.hpp"

static_assert(requires(
    livekit::AudioSource& source,
    const livekit::AudioFrame& frame,
    const livekit::OperationCancellation& cancellation) {
  source.captureFrame(frame, 1, cancellation);
});

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main() try {
  using syrnike::voice::ScreenAudioPacketView;
  using syrnike::voice::drainScreenAudioWake;

  const std::array<ScreenAudioPacketView, 4> pending{{
      {.frames = 120},
      {.frames = 240, .discontinuity = true},
      {.frames = 360},
      {.frames = 480, .silent = true, .discontinuity = true},
  }};
  std::size_t next_packet = 0;
  std::size_t read_calls = 0;
  std::size_t consumed_packets = 0;
  const auto drained = drainScreenAudioWake(
      [&](const auto& consume) {
        ++read_calls;
        if (next_packet == pending.size()) return false;
        consume(pending[next_packet++]);
        return true;
      },
      [&](const ScreenAudioPacketView&) { ++consumed_packets; });

  require(read_calls == pending.size() + 1,
          "one audio wake did not read until the WASAPI queue was empty");
  require(consumed_packets == pending.size(),
          "one audio wake did not consume every pending WASAPI packet");
  require(drained.frames == 1'200 && drained.packets == 4,
          "screen audio wake counters did not include the full burst");
  require(drained.backlog_packets == 3,
          "screen audio backlog did not count packets beyond the wake head");
  require(drained.discontinuities == 2,
          "screen audio discontinuities were not counted exactly");

  using namespace syrnike::desktop_native::media;
  std::vector<WindowsAudioAttemptPhase> phases;
  auto policy = std::make_shared<WindowsAudioSessionAttemptPolicy>(
      WindowsAudioSessionAttemptOperations{
          .category = [](IAudioClient*, WindowsAudioSessionUse use,
                         AUDCLNT_STREAMOPTIONS) {
            return applyWindowsAudioCategoryPolicy(
                use, [](AUDIO_STREAM_CATEGORY) { return S_OK; });
          },
          .ducking = [](IAudioClient*, WindowsAudioSessionUse use) {
            return applyWindowsAudioDuckingPolicy(
                use, [](bool) { return S_OK; });
          },
      },
      [&](const WindowsAudioAttemptStep& step) { phases.push_back(step.phase); });
  for (int attempt = 0; attempt < 2; ++attempt) {
    const auto initialized = syrnike::voice::initializeScreenAudioCaptureAttempt(
        nullptr, [] { return S_OK; }, policy);
    require(
        initialized.category.status == WindowsAudioPolicyStatus::Applied &&
            initialized.initialize.status == WindowsAudioPolicyStatus::Applied &&
            !initialized.ducking,
        "screen loopback attempt did not apply capture policy");
  }
  require(
      phases == std::vector<WindowsAudioAttemptPhase>{
                    WindowsAudioAttemptPhase::BeforeInitialize,
                    WindowsAudioAttemptPhase::Initialize,
                    WindowsAudioAttemptPhase::BeforeInitialize,
                    WindowsAudioAttemptPhase::Initialize},
      "ScreenAudioCapture start/recreate did not reapply category before Initialize");

  std::cout << "screen audio capture tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
