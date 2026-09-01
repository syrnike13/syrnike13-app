#pragma once

#include <chrono>
#include <functional>
#include <memory>
#include <string>

#include <livekit/livekit.h>

namespace syrnike::windows_media::lab {

bool isScreenCpuMode(const std::string& mode) noexcept;
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

}  // namespace syrnike::windows_media::lab
