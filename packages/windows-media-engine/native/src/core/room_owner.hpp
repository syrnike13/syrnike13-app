#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <thread>

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
  std::string expected_room_id;
  std::string expected_participant_identity;
};

struct RoomConnectionEvent {
  std::uint64_t generation = 0;
  RoomConnectionState state = RoomConnectionState::Disconnected;
  std::optional<EngineFailure> failure;
};

using RoomOperationCompletion =
    std::function<void(std::uint64_t, EngineResult)>;
using RoomConnectionEventCallback =
    std::function<void(const RoomConnectionEvent &)>;

class RoomTransport {
public:
  virtual ~RoomTransport() = default;

  virtual void startConnect(std::uint64_t generation,
                            RoomConnectRequest request,
                            RoomOperationCompletion completion) = 0;
  [[nodiscard]] virtual bool
  cancelConnect(std::uint64_t generation) noexcept = 0;
  virtual void startDisconnect(std::uint64_t generation,
                               RoomOperationCompletion completion) = 0;
};

class RoomOwner final {
public:
  explicit RoomOwner(std::shared_ptr<RoomTransport> transport,
                     RoomConnectionEventCallback event_callback = {},
                     RoomOperationDeadlines deadlines = {});
  ~RoomOwner();

  RoomOwner(const RoomOwner &) = delete;
  RoomOwner &operator=(const RoomOwner &) = delete;

  [[nodiscard]] EngineResult beginConnect(RoomConnectRequest request);
  [[nodiscard]] EngineResult cancelPendingConnect();
  [[nodiscard]] EngineResult beginTeardown();
  [[nodiscard]] EngineResult beginDisconnect();
  [[nodiscard]] RoomConnectionState state() const noexcept;
  [[nodiscard]] std::uint64_t generation() const noexcept;

private:
  struct SharedState;
  void runDeadlineWatchdog() noexcept;

  std::shared_ptr<RoomTransport> transport_;
  std::shared_ptr<SharedState> state_;
  RoomOperationDeadlines deadlines_;
  std::thread deadline_watchdog_;
};

[[nodiscard]] EngineResult validateRoomAuthority(
    const RoomConnectRequest &request, std::string_view actual_room_id,
    std::string_view actual_participant_identity);

[[nodiscard]] const char *
roomConnectionStateName(RoomConnectionState state) noexcept;

} // namespace syrnike::windows_media
