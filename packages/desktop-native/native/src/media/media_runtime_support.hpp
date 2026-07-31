#pragma once

#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

#include "../common/runtime_types.hpp"

namespace syrnike::desktop_native::media {

inline constexpr auto kNativeShutdownBudget =
    std::chrono::milliseconds(1750);

class LiveKitLease final {
 public:
  LiveKitLease();
  ~LiveKitLease();

  LiveKitLease(const LiveKitLease&) = delete;
  LiveKitLease& operator=(const LiveKitLease&) = delete;

  [[nodiscard]] static bool active() noexcept;
  [[nodiscard]] static std::uint32_t activeCount() noexcept;
  [[nodiscard]] static std::uint32_t initializeTransitionCount() noexcept;
  [[nodiscard]] static std::uint32_t shutdownTransitionCount() noexcept;
};

// Shared by the runtime, publication client, Room owners, publications, and
// detached SDK tasks. initialize() runs on MediaRuntime's COM-initialized
// worker, while the inner lease remains alive until the last SDK graph owner
// releases this token.
class LiveKitRuntimeLifetime final {
 public:
  void initialize();
  [[nodiscard]] bool initialized() const noexcept {
    return initialized_.load(std::memory_order_acquire);
  }

 private:
  std::mutex mutex_;
  std::optional<LiveKitLease> lease_;
  std::atomic_bool initialized_{false};
};

RuntimeEvent reply(const MediaCommand& command);
RuntimeEvent failedReply(const MediaCommand& command, NativeError error);
RuntimeEvent lifecycle(
  const MediaCommand& command,
  const char* kind,
  const char* status,
  std::string detail = {}
);
std::string warmKey(const MediaCommand& command);

}  // namespace syrnike::desktop_native::media
