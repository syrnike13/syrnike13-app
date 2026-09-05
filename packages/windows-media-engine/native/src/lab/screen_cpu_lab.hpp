#pragma once

#include <chrono>
#include <functional>
#include <memory>
#include <string>
#include <atomic>
#include <mutex>
#include "screen/production_screen_pipeline.hpp"

#include <livekit/livekit.h>

namespace syrnike::windows_media {
class LiveKitRoomTransport;
}

namespace syrnike::windows_media::lab {

struct PreviewLabControl {
  std::atomic_bool stop{false};
  std::mutex mutex;
  screen::ProductionScreenPipelineStats stats;
  std::string failure;
  bool done = false;
};
void runScreenPreviewLab(const std::shared_ptr<LiveKitRoomTransport>& transport,
                         const std::shared_ptr<PreviewLabControl>& control,
                         const std::string& scenario);

bool isScreenCpuMode(const std::string& mode) noexcept;
bool isScreenGpuMode(const std::string& mode) noexcept;
void warmScreenCpuLab(const std::shared_ptr<livekit::Room>& room,
                      const std::string& mode,
                      const std::function<void()>& wait_until_ready = {},
                      const std::function<void(
                          std::chrono::steady_clock::time_point)>&
                          wait_until_unpublished = {});
std::string runScreenCpuLab(const std::shared_ptr<livekit::Room>& room,
                            const std::string& mode, int cycles,
                            const std::function<void()>& wait_until_ready = {},
                            const std::function<void(
                                std::chrono::steady_clock::time_point)>&
                                wait_until_unpublished = {},
                            const std::function<void()>& during_publication = {});

void warmScreenGpuLab(
    const std::shared_ptr<LiveKitRoomTransport>& transport,
    const std::string& mode,
    const std::function<void()>& wait_until_ready = {},
    const std::function<void(std::chrono::steady_clock::time_point)>&
        wait_until_unpublished = {});
std::string runScreenGpuLab(
    const std::shared_ptr<LiveKitRoomTransport>& transport,
    const std::string& mode, int cycles,
    const std::function<void()>& wait_until_ready = {},
    const std::function<void(std::chrono::steady_clock::time_point)>&
        wait_until_unpublished = {});

}  // namespace syrnike::windows_media::lab
