#include "core/room_owner.hpp"

#include <condition_variable>
#include <exception>
#include <mutex>
#include <stdexcept>
#include <utility>

namespace syrnike::windows_media {

namespace {

EngineFailure roomFailure(
  std::string code,
  std::string message,
  std::string stage,
  bool retryable = false
) {
  return EngineFailure{
    std::move(code),
    std::move(message),
    std::move(stage),
    retryable,
  };
}

EngineResult invalidState(
  const char* operation,
  RoomConnectionState state
) {
  return EngineResult::fail(roomFailure(
    "room_invalid_state",
    std::string(operation) + " is not valid while the room is " +
      roomConnectionStateName(state),
    operation
  ));
}

}  // namespace

struct RoomOwner::SharedState final {
  mutable std::mutex mutex;
  std::condition_variable changed;
  RoomConnectionState connection_state = RoomConnectionState::Disconnected;
  std::uint64_t generation = 0;
  bool operation_complete = false;
  EngineResult operation_result = EngineResult::success();
  RoomConnectionEventCallback event_callback;
};

const char* roomConnectionStateName(RoomConnectionState state) noexcept {
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

RoomOwner::RoomOwner(
  std::shared_ptr<RoomTransport> transport,
  RoomConnectionEventCallback event_callback
) : transport_(std::move(transport)), state_(std::make_shared<SharedState>()) {
  if (!transport_) throw std::invalid_argument("RoomOwner transport is required");
  state_->event_callback = std::move(event_callback);
}

EngineResult RoomOwner::connect(
  RoomConnectRequest request,
  std::chrono::milliseconds deadline
) {
  std::uint64_t generation = 0;
  {
    std::lock_guard lock(state_->mutex);
    if (state_->connection_state != RoomConnectionState::Disconnected) {
      return invalidState("room_connect", state_->connection_state);
    }
    generation = ++state_->generation;
    state_->connection_state = RoomConnectionState::Connecting;
    state_->operation_complete = false;
    state_->operation_result = EngineResult::success();
  }

  const std::weak_ptr weak_state(state_);
  try {
    transport_->startConnect(
      generation,
      std::move(request),
      [weak_state](std::uint64_t completed_generation, EngineResult result) {
        const auto state = weak_state.lock();
        if (!state) return;
        RoomConnectionEventCallback callback;
        RoomConnectionEvent event;
        {
          std::lock_guard lock(state->mutex);
          if (
            state->generation != completed_generation ||
            state->connection_state != RoomConnectionState::Connecting
          ) return;
          state->operation_result = std::move(result);
          state->operation_complete = true;
          state->connection_state = state->operation_result.ok
            ? RoomConnectionState::Connected
            : RoomConnectionState::Disconnected;
          callback = state->event_callback;
          event = RoomConnectionEvent{
            completed_generation,
            state->connection_state,
            state->operation_result.failure,
          };
        }
        state->changed.notify_all();
        if (callback) callback(event);
      }
    );
  } catch (const std::exception& error) {
    std::lock_guard lock(state_->mutex);
    state_->connection_state = RoomConnectionState::Disconnected;
    state_->operation_complete = true;
    state_->operation_result = EngineResult::fail(roomFailure(
      "room_connect_start_failed",
      error.what(),
      "room_connect"
    ));
  } catch (...) {
    std::lock_guard lock(state_->mutex);
    state_->connection_state = RoomConnectionState::Disconnected;
    state_->operation_complete = true;
    state_->operation_result = EngineResult::fail(roomFailure(
      "room_connect_start_failed",
      "Unknown room transport failure",
      "room_connect"
    ));
  }

  const auto expires_at = std::chrono::steady_clock::now() + deadline;
  std::unique_lock lock(state_->mutex);
  if (!state_->changed.wait_until(lock, expires_at, [this, generation] {
    return state_->generation != generation || state_->operation_complete;
  })) {
    const auto timeout_result = EngineResult::fail(roomFailure(
      "room_connect_deadline_exceeded",
      "Room connect exceeded its deadline and was cancelled",
      "room_connect",
      true
    ));
    state_->connection_state = RoomConnectionState::Disconnected;
    state_->operation_complete = true;
    state_->operation_result = timeout_result;
    lock.unlock();
    transport_->cancelConnect(generation);
    return timeout_result;
  }
  return state_->operation_result;
}

EngineResult RoomOwner::cancelPendingConnect() {
  std::uint64_t generation = 0;
  EngineResult result;
  {
    std::lock_guard lock(state_->mutex);
    if (state_->connection_state != RoomConnectionState::Connecting) {
      return invalidState("room_connect_cancel", state_->connection_state);
    }
    generation = state_->generation;
    result = EngineResult::fail(roomFailure(
      "room_connect_cancelled",
      "Pending room connect was cancelled",
      "room_connect",
      true
    ));
    state_->connection_state = RoomConnectionState::Disconnected;
    state_->operation_complete = true;
    state_->operation_result = result;
  }
  transport_->cancelConnect(generation);
  state_->changed.notify_all();
  return EngineResult::success();
}

EngineResult RoomOwner::disconnect(std::chrono::milliseconds deadline) {
  std::uint64_t generation = 0;
  {
    std::lock_guard lock(state_->mutex);
    if (state_->connection_state != RoomConnectionState::Connected) {
      return invalidState("room_disconnect", state_->connection_state);
    }
    generation = state_->generation;
    state_->connection_state = RoomConnectionState::Disconnecting;
    state_->operation_complete = false;
    state_->operation_result = EngineResult::success();
  }

  const std::weak_ptr weak_state(state_);
  try {
    transport_->startDisconnect(
      generation,
      [weak_state](std::uint64_t completed_generation, EngineResult result) {
        const auto state = weak_state.lock();
        if (!state) return;
        RoomConnectionEventCallback callback;
        RoomConnectionEvent event;
        {
          std::lock_guard lock(state->mutex);
          if (
            state->generation != completed_generation ||
            state->connection_state != RoomConnectionState::Disconnecting
          ) return;
          state->operation_result = std::move(result);
          state->operation_complete = true;
          state->connection_state = RoomConnectionState::Disconnected;
          callback = state->event_callback;
          event = RoomConnectionEvent{
            completed_generation,
            state->connection_state,
            state->operation_result.failure,
          };
        }
        state->changed.notify_all();
        if (callback) callback(event);
      }
    );
  } catch (const std::exception& error) {
    std::lock_guard lock(state_->mutex);
    state_->connection_state = RoomConnectionState::Disconnected;
    state_->operation_complete = true;
    state_->operation_result = EngineResult::fail(roomFailure(
      "room_disconnect_start_failed",
      error.what(),
      "room_disconnect"
    ));
  } catch (...) {
    std::lock_guard lock(state_->mutex);
    state_->connection_state = RoomConnectionState::Disconnected;
    state_->operation_complete = true;
    state_->operation_result = EngineResult::fail(roomFailure(
      "room_disconnect_start_failed",
      "Unknown room transport failure",
      "room_disconnect"
    ));
  }

  const auto expires_at = std::chrono::steady_clock::now() + deadline;
  std::unique_lock lock(state_->mutex);
  if (!state_->changed.wait_until(lock, expires_at, [this, generation] {
    return state_->generation != generation || state_->operation_complete;
  })) {
    state_->connection_state = RoomConnectionState::Disconnected;
    state_->operation_complete = true;
    state_->operation_result = EngineResult::fail(roomFailure(
      "room_disconnect_deadline_exceeded",
      "Room disconnect exceeded its deadline",
      "room_disconnect",
      true
    ));
  }
  return state_->operation_result;
}

RoomConnectionState RoomOwner::state() const noexcept {
  std::lock_guard lock(state_->mutex);
  return state_->connection_state;
}

std::uint64_t RoomOwner::generation() const noexcept {
  std::lock_guard lock(state_->mutex);
  return state_->generation;
}

}  // namespace syrnike::windows_media
