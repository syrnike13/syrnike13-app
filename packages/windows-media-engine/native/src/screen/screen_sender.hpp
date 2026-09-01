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

namespace syrnike::windows_media::screen {

inline constexpr std::size_t kMaximumScreenTimingSamples = 4096;

struct ScreenSenderOptions {
  std::uint32_t width = kCpuReferenceWidth;
  std::uint32_t height = kCpuReferenceHeight;
  std::uint32_t frames_per_second = kCpuReferenceFramesPerSecond;
  std::chrono::milliseconds artificial_conversion_delay{0};
  std::function<void(std::chrono::steady_clock::time_point)>
      wait_for_unpublish;
  bool reusable_publication = false;
};

struct ScreenSenderStats {
  std::uint64_t published = 0;
  std::uint64_t publication_failures = 0;
  std::uint64_t source_generation_transitions = 0;
  std::uint64_t last_sequence = 0;
  std::uint64_t last_generation = 0;
  std::vector<std::uint64_t> capture_age_ms;
  std::vector<std::uint64_t> readback_duration_us;
  std::vector<std::uint64_t> conversion_duration_us;
  std::vector<std::uint64_t> publish_duration_us;
  CpuScreenConverterStats converter;
};

struct ScreenSenderStartResult {
  bool ok = true;
  std::string failure;
};

struct ScreenSenderStopResult {
  bool ok = true;
  std::string failure;
};

class ScreenSender final {
 public:
  ScreenSender(std::shared_ptr<livekit::Room> room,
               std::shared_ptr<ScreenFramePipeline> pipeline,
               ScreenSenderOptions options = {});
  ~ScreenSender();
  ScreenSender(const ScreenSender&) = delete;
  ScreenSender& operator=(const ScreenSender&) = delete;

  ScreenSenderStartResult start();
  bool waitForPublished(std::uint64_t count,
                        std::chrono::steady_clock::time_point deadline);
  ScreenSenderStopResult stop(
      std::chrono::steady_clock::time_point deadline) noexcept;
  ScreenSenderStats stats() const;
  std::optional<std::string> terminalFailure() const;

 private:
  struct State;
  static void runWorker(const std::shared_ptr<State>& state) noexcept;

  std::shared_ptr<State> state_;
};

}  // namespace syrnike::windows_media::screen
