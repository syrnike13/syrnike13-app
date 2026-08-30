#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>

namespace syrnike::windows_media {

inline constexpr std::size_t kControlQueueCapacity = 16;
inline constexpr std::size_t kEventQueueCapacity = 64;
inline constexpr auto kStartDeadline = std::chrono::seconds(2);
inline constexpr auto kPingDeadline = std::chrono::seconds(1);
inline constexpr auto kShutdownDeadline = std::chrono::seconds(1);

enum class EngineState {
  Stopped,
  Starting,
  Running,
  Stopping,
  Failed,
};

struct EngineFailure {
  std::string code;
  std::string message;
  std::string stage;
  bool retryable = false;
};

struct EngineResult {
  bool ok = false;
  std::optional<EngineFailure> failure;

  [[nodiscard]] static EngineResult success();
  [[nodiscard]] static EngineResult fail(EngineFailure failure);
};

struct LifecycleEvent {
  std::uint64_t sequence = 0;
  EngineState previous = EngineState::Stopped;
  EngineState state = EngineState::Stopped;
  std::optional<EngineFailure> failure;
};

using LifecycleEventCallback = std::function<void(const LifecycleEvent&)>;

struct EngineOptions {
  bool fail_start = false;
  bool test_block_start_until_shutdown = false;
  bool test_hang_on_shutdown = false;
};

class Engine final {
 public:
  explicit Engine(EngineOptions options = {});
  ~Engine() noexcept;

  Engine(const Engine&) = delete;
  Engine& operator=(const Engine&) = delete;

  [[nodiscard]] EngineResult registerEventCallback(
    LifecycleEventCallback callback
  );
  [[nodiscard]] EngineResult start(
    std::chrono::milliseconds deadline = kStartDeadline
  );
  [[nodiscard]] EngineResult ping(
    std::chrono::milliseconds deadline = kPingDeadline
  );
  [[nodiscard]] EngineResult shutdown(
    std::chrono::milliseconds deadline = kShutdownDeadline
  );
  [[nodiscard]] EngineState state() const noexcept;

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

[[nodiscard]] const char* engineStateName(EngineState state) noexcept;

}  // namespace syrnike::windows_media

