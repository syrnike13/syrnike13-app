#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <livekit/livekit.h>

#include "screen/cpu_screen_converter.hpp"

namespace syrnike::windows_media::lab {

inline constexpr std::size_t kMaximumReferenceScreenTimingSamples = 4096;

struct ReferenceScreenSenderOptions {
  std::uint32_t width = screen::kCpuReferenceWidth;
  std::uint32_t height = screen::kCpuReferenceHeight;
  std::uint32_t frames_per_second = screen::kCpuReferenceFramesPerSecond;
  std::chrono::milliseconds artificial_conversion_delay{0};
  std::function<void(std::chrono::steady_clock::time_point)>
      wait_for_unpublish;
  bool reusable_publication = false;
};

struct ReferenceScreenSenderStats {
  std::uint64_t published = 0;
  std::uint64_t publication_failures = 0;
  std::uint64_t source_generation_transitions = 0;
  std::uint64_t last_sequence = 0;
  std::uint64_t last_generation = 0;
  std::vector<std::uint64_t> capture_age_ms;
  std::vector<std::uint64_t> readback_duration_us;
  std::vector<std::uint64_t> conversion_duration_us;
  std::vector<std::uint64_t> publish_duration_us;
  screen::CpuScreenConverterStats converter;
};

struct ReferenceScreenSenderStartResult {
  bool ok = true;
  std::string failure;
};

struct ReferenceScreenSenderStopResult {
  bool ok = true;
  std::string failure;
};

// Lab-only correctness oracle. Its synchronous LiveKit calls are bounded by
// the disposable Media Lab process, not by an in-process production deadline.
// Production senders must use the screen publication seam and must not depend
// on this implementation.
class ReferenceScreenSender final {
 public:
  ReferenceScreenSender(std::shared_ptr<livekit::Room> room,
                        std::shared_ptr<screen::ScreenFramePipeline> pipeline,
                        ReferenceScreenSenderOptions options = {});
  ~ReferenceScreenSender();
  ReferenceScreenSender(const ReferenceScreenSender&) = delete;
  ReferenceScreenSender& operator=(const ReferenceScreenSender&) = delete;

  ReferenceScreenSenderStartResult start();
  bool waitForPublished(std::uint64_t count,
                        std::chrono::steady_clock::time_point deadline);
  ReferenceScreenSenderStopResult stop(
      std::chrono::steady_clock::time_point deadline) noexcept;
  ReferenceScreenSenderStats stats() const;
  std::optional<std::string> terminalFailure() const;

 private:
  struct State;
  static void runWorker(const std::shared_ptr<State>& state) noexcept;

  std::shared_ptr<State> state_;
};

}  // namespace syrnike::windows_media::lab
