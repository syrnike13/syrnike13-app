#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include "core/engine.hpp"

namespace syrnike::windows_media {

enum class RoomConnectionState {
  Disconnected,
  Connecting,
  Connected,
  Disconnecting,
};

struct RoomConnectRequest {
  std::string url;
  std::string token;
};

struct RoomConnectionEvent {
  std::uint64_t generation = 0;
  RoomConnectionState state = RoomConnectionState::Disconnected;
  std::optional<EngineFailure> failure;
};

using RoomOperationCompletion =
  std::function<void(std::uint64_t, EngineResult)>;
using RoomConnectionEventCallback =
  std::function<void(const RoomConnectionEvent&)>;

class RoomTransport {
 public:
  virtual ~RoomTransport() = default;

  virtual void startConnect(
    std::uint64_t generation,
    RoomConnectRequest request,
    RoomOperationCompletion completion
  ) = 0;
  virtual void cancelConnect(std::uint64_t generation) noexcept = 0;
  virtual void startDisconnect(
    std::uint64_t generation,
    RoomOperationCompletion completion
  ) = 0;
};

class RoomOwner final {
 public:
  explicit RoomOwner(
    std::shared_ptr<RoomTransport> transport,
    RoomConnectionEventCallback event_callback = {}
  );
  ~RoomOwner() = default;

  RoomOwner(const RoomOwner&) = delete;
  RoomOwner& operator=(const RoomOwner&) = delete;

  [[nodiscard]] EngineResult connect(
    RoomConnectRequest request,
    std::chrono::milliseconds deadline
  );
  [[nodiscard]] EngineResult cancelPendingConnect();
  [[nodiscard]] EngineResult disconnect(std::chrono::milliseconds deadline);
  [[nodiscard]] RoomConnectionState state() const noexcept;
  [[nodiscard]] std::uint64_t generation() const noexcept;

 private:
  struct SharedState;
  std::shared_ptr<RoomTransport> transport_;
  std::shared_ptr<SharedState> state_;
};

[[nodiscard]] const char* roomConnectionStateName(
  RoomConnectionState state
) noexcept;

}  // namespace syrnike::windows_media
