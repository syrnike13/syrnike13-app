#include "core/room_owner.hpp"

#include <exception>
#include <mutex>
#include <stdexcept>
#include <utility>

namespace syrnike::windows_media {

namespace {

EngineFailure roomFailure(std::string code, std::string message,
                          std::string stage, bool retryable = false) {
  return EngineFailure{
      std::move(code),
      std::move(message),
      std::move(stage),
      retryable,
  };
}

EngineResult invalidState(const char *operation, RoomConnectionState state) {
  return EngineResult::fail(roomFailure("room_invalid_state",
                                        std::string(operation) +
                                            " is not valid while the room is " +
                                            roomConnectionStateName(state),
                                        operation));
}

} // namespace

struct RoomOwner::SharedState final {
  mutable std::mutex mutex;
  RoomConnectionState connection_state = RoomConnectionState::Disconnected;
  std::uint64_t generation = 0;
  bool cancellation_requested = false;
  bool teardown_requested = false;
  RoomConnectionEventCallback event_callback;
};

const char *roomConnectionStateName(RoomConnectionState state) noexcept {
  switch (state) {
  case RoomConnectionState::Disconnected:
    return "disconnected";
  case RoomConnectionState::Connecting:
    return "connecting";
  case RoomConnectionState::Connected:
    return "connected";
  case RoomConnectionState::Disconnecting:
    return "disconnecting";
  }
  return "disconnected";
}

RoomOwner::RoomOwner(std::shared_ptr<RoomTransport> transport,
                     RoomConnectionEventCallback event_callback)
    : transport_(std::move(transport)),
      state_(std::make_shared<SharedState>()) {
  if (!transport_)
    throw std::invalid_argument("RoomOwner transport is required");
  state_->event_callback = std::move(event_callback);
}

EngineResult RoomOwner::beginConnect(RoomConnectRequest request) {
  std::uint64_t generation = 0;
  {
    std::lock_guard lock(state_->mutex);
    if (state_->connection_state != RoomConnectionState::Disconnected) {
      return invalidState("room_connect", state_->connection_state);
    }
    generation = ++state_->generation;
    state_->connection_state = RoomConnectionState::Connecting;
    state_->cancellation_requested = false;
  }

  const std::weak_ptr weak_state(state_);
  try {
    transport_->startConnect(
        generation, std::move(request),
        [weak_state](std::uint64_t completed_generation, EngineResult result) {
          const auto state = weak_state.lock();
          if (!state)
            return;
          RoomConnectionEventCallback callback;
          RoomConnectionEvent event;
          {
            std::lock_guard lock(state->mutex);
            if (state->generation != completed_generation ||
                (state->connection_state != RoomConnectionState::Connecting &&
                 state->connection_state != RoomConnectionState::Disconnecting))
              return;
            if (state->cancellation_requested) {
              const bool teardown_failed =
                  result.failure &&
                  result.failure->code == "room_cancel_teardown_failed";
              if (!teardown_failed) {
                result = EngineResult::fail(
                    roomFailure("room_connect_cancelled",
                                "Pending room connect was cancelled",
                                "room_connect", true));
              }
              state->connection_state = teardown_failed
                                            ? RoomConnectionState::Connected
                                            : RoomConnectionState::Disconnected;
            } else if (state->teardown_requested && !result.ok) {
              result = EngineResult::fail(roomFailure(
                  "room_connect_cancelled",
                  "Pending room connect ended while teardown was requested",
                  "room_connect", true));
              state->connection_state = RoomConnectionState::Disconnected;
            } else {
              state->connection_state = result.ok
                                            ? RoomConnectionState::Connected
                                            : RoomConnectionState::Disconnected;
            }
            state->cancellation_requested = false;
            state->teardown_requested = false;
            callback = state->event_callback;
            event = RoomConnectionEvent{
                completed_generation,
                state->connection_state,
                std::move(result.failure),
            };
          }
          if (callback)
            callback(event);
        });
  } catch (const std::exception &error) {
    std::lock_guard lock(state_->mutex);
    state_->connection_state = RoomConnectionState::Disconnected;
    return EngineResult::fail(
        roomFailure("room_connect_start_failed", error.what(), "room_connect"));
  } catch (...) {
    std::lock_guard lock(state_->mutex);
    state_->connection_state = RoomConnectionState::Disconnected;
    return EngineResult::fail(roomFailure("room_connect_start_failed",
                                          "Unknown room transport failure",
                                          "room_connect"));
  }
  return EngineResult::success();
}

EngineResult RoomOwner::cancelPendingConnect() {
  {
    std::lock_guard lock(state_->mutex);
    if (state_->connection_state != RoomConnectionState::Connecting) {
      return invalidState("room_connect_cancel", state_->connection_state);
    }
  }
  return beginTeardown();
}

EngineResult RoomOwner::beginTeardown() {
  std::uint64_t generation = 0;
  bool cancel_connect = false;
  {
    std::lock_guard lock(state_->mutex);
    if (state_->connection_state == RoomConnectionState::Disconnected ||
        state_->connection_state == RoomConnectionState::Disconnecting) {
      return EngineResult::success();
    }
    generation = state_->generation;
    state_->teardown_requested = true;
    if (state_->connection_state == RoomConnectionState::Connecting) {
      cancel_connect = true;
      if (transport_->cancelConnect(generation)) {
        state_->connection_state = RoomConnectionState::Disconnecting;
        state_->cancellation_requested = true;
      }
    } else {
      state_->connection_state = RoomConnectionState::Disconnecting;
      state_->cancellation_requested = false;
      state_->teardown_requested = false;
    }
  }
  if (cancel_connect)
    return EngineResult::success();

  const std::weak_ptr weak_state(state_);
  try {
    transport_->startDisconnect(
        generation,
        [weak_state](std::uint64_t completed_generation, EngineResult result) {
          const auto state = weak_state.lock();
          if (!state)
            return;
          RoomConnectionEventCallback callback;
          RoomConnectionEvent event;
          {
            std::lock_guard lock(state->mutex);
            if (state->generation != completed_generation ||
                state->connection_state != RoomConnectionState::Disconnecting)
              return;
            state->connection_state = result.ok
                                          ? RoomConnectionState::Disconnected
                                          : RoomConnectionState::Connected;
            callback = state->event_callback;
            event = RoomConnectionEvent{completed_generation,
                                        state->connection_state,
                                        std::move(result.failure)};
          }
          if (callback)
            callback(event);
        });
  } catch (const std::exception &error) {
    std::lock_guard lock(state_->mutex);
    state_->connection_state = RoomConnectionState::Connected;
    return EngineResult::fail(roomFailure("room_disconnect_start_failed",
                                          error.what(), "room_disconnect"));
  } catch (...) {
    std::lock_guard lock(state_->mutex);
    state_->connection_state = RoomConnectionState::Connected;
    return EngineResult::fail(roomFailure("room_disconnect_start_failed",
                                          "Unknown room transport failure",
                                          "room_disconnect"));
  }
  return EngineResult::success();
}

EngineResult RoomOwner::beginDisconnect() {
  std::uint64_t generation = 0;
  {
    std::lock_guard lock(state_->mutex);
    if (state_->connection_state != RoomConnectionState::Connected) {
      return invalidState("room_disconnect", state_->connection_state);
    }
    generation = state_->generation;
    state_->connection_state = RoomConnectionState::Disconnecting;
  }

  const std::weak_ptr weak_state(state_);
  try {
    transport_->startDisconnect(
        generation,
        [weak_state](std::uint64_t completed_generation, EngineResult result) {
          const auto state = weak_state.lock();
          if (!state)
            return;
          RoomConnectionEventCallback callback;
          RoomConnectionEvent event;
          {
            std::lock_guard lock(state->mutex);
            if (state->generation != completed_generation ||
                state->connection_state != RoomConnectionState::Disconnecting)
              return;
            state->connection_state = result.ok
                                          ? RoomConnectionState::Disconnected
                                          : RoomConnectionState::Connected;
            callback = state->event_callback;
            event = RoomConnectionEvent{
                completed_generation,
                state->connection_state,
                std::move(result.failure),
            };
          }
          if (callback)
            callback(event);
        });
  } catch (const std::exception &error) {
    std::lock_guard lock(state_->mutex);
    state_->connection_state = RoomConnectionState::Connected;
    return EngineResult::fail(roomFailure("room_disconnect_start_failed",
                                          error.what(), "room_disconnect"));
  } catch (...) {
    std::lock_guard lock(state_->mutex);
    state_->connection_state = RoomConnectionState::Connected;
    return EngineResult::fail(roomFailure("room_disconnect_start_failed",
                                          "Unknown room transport failure",
                                          "room_disconnect"));
  }
  return EngineResult::success();
}

RoomConnectionState RoomOwner::state() const noexcept {
  std::lock_guard lock(state_->mutex);
  return state_->connection_state;
}

std::uint64_t RoomOwner::generation() const noexcept {
  std::lock_guard lock(state_->mutex);
  return state_->generation;
}

} // namespace syrnike::windows_media
