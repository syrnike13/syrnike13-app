#include "core/room_owner.hpp"

#include <chrono>
#include <condition_variable>
#include <exception>
#include <mutex>
#include <optional>
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
  std::condition_variable deadline_changed;
  RoomConnectionState connection_state = RoomConnectionState::Disconnected;
  std::uint64_t generation = 0;
  bool cancellation_requested = false;
  bool teardown_requested = false;
  bool completion_pending = false;
  bool stopping = false;
  std::optional<std::chrono::steady_clock::time_point> operation_deadline;
  std::string operation_stage;
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
                     RoomConnectionEventCallback event_callback,
                     RoomOperationDeadlines deadlines)
    : transport_(std::move(transport)),
      state_(std::make_shared<SharedState>()), deadlines_(deadlines) {
  if (!transport_)
    throw std::invalid_argument("RoomOwner transport is required");
  if (deadlines_.connect <= std::chrono::milliseconds::zero() ||
      deadlines_.disconnect <= std::chrono::milliseconds::zero() ||
      deadlines_.cancellation <= std::chrono::milliseconds::zero()) {
    throw std::invalid_argument("Room operation deadlines must be positive");
  }
  state_->event_callback = std::move(event_callback);
  transport_->setConnectionEventCallback(
      [weak = std::weak_ptr(state_)](const RoomConnectionEvent& event) {
        const auto state = weak.lock();
        if (!state) return;
        RoomConnectionEventCallback callback;
        {
          std::lock_guard lock(state->mutex);
          if (state->stopping || event.generation != state->generation ||
              state->connection_state != RoomConnectionState::Connected ||
              event.state != RoomConnectionState::Disconnected) return;
          state->connection_state = RoomConnectionState::Disconnected;
          callback = state->event_callback;
        }
        if (callback) callback(event);
      });
  deadline_watchdog_ = std::thread([this] { runDeadlineWatchdog(); });
}

RoomOwner::~RoomOwner() {
  {
    std::lock_guard lock(state_->mutex);
    state_->stopping = true;
    state_->completion_pending = false;
    state_->operation_deadline.reset();
  }
  state_->deadline_changed.notify_all();
  if (deadline_watchdog_.joinable())
    deadline_watchdog_.join();
}

EngineResult validateRoomAuthority(
    const RoomConnectRequest &request, std::string_view actual_room_id,
    std::string_view actual_participant_identity) {
  if (!request.expected_room_id.empty() &&
      !request.expected_participant_identity.empty() &&
      request.expected_room_id == actual_room_id &&
      request.expected_participant_identity == actual_participant_identity) {
    return EngineResult::success();
  }
  return EngineResult::fail(roomFailure(
      "room_authority_mismatch",
      "Connected LiveKit authority does not match the desired room intent",
      "room_authority"));
}

void RoomOwner::runDeadlineWatchdog() noexcept {
  while (true) {
    RoomConnectionEventCallback callback;
    RoomConnectionEvent event;
    {
      std::unique_lock lock(state_->mutex);
      state_->deadline_changed.wait(lock, [this] {
        return state_->stopping ||
               (state_->completion_pending && state_->operation_deadline);
      });
      if (state_->stopping)
        return;
      const auto deadline = *state_->operation_deadline;
      const auto generation = state_->generation;
      if (state_->deadline_changed.wait_until(
              lock, deadline, [this, deadline, generation] {
                return state_->stopping || !state_->completion_pending ||
                       !state_->operation_deadline ||
                       *state_->operation_deadline != deadline ||
                       state_->generation != generation;
              })) {
        if (state_->stopping)
          return;
        continue;
      }
      state_->completion_pending = false;
      state_->operation_deadline.reset();
      callback = state_->event_callback;
      event = RoomConnectionEvent{
          generation,
          state_->connection_state,
          roomFailure("room_operation_unresponsive",
                      "Room operation exceeded its independent deadline",
                      state_->operation_stage, true),
      };
    }
    if (callback)
      callback(event);
  }
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
    state_->teardown_requested = false;
    state_->completion_pending = true;
    state_->operation_stage = "room_connect";
    state_->operation_deadline =
        std::chrono::steady_clock::now() + deadlines_.connect;
  }
  state_->deadline_changed.notify_all();

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
                !state->completion_pending ||
                (state->connection_state != RoomConnectionState::Connecting &&
                 state->connection_state != RoomConnectionState::Disconnecting))
              return;
            state->completion_pending = false;
            state->operation_deadline.reset();
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
          state->deadline_changed.notify_all();
          if (callback)
            callback(event);
        });
  } catch (const std::exception &error) {
    {
      std::lock_guard lock(state_->mutex);
      state_->connection_state = RoomConnectionState::Disconnected;
      state_->completion_pending = false;
      state_->operation_deadline.reset();
    }
    state_->deadline_changed.notify_all();
    return EngineResult::fail(
        roomFailure("room_connect_start_failed", error.what(), "room_connect"));
  } catch (...) {
    {
      std::lock_guard lock(state_->mutex);
      state_->connection_state = RoomConnectionState::Disconnected;
      state_->completion_pending = false;
      state_->operation_deadline.reset();
    }
    state_->deadline_changed.notify_all();
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
  bool deadline_changed = false;
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
        state_->operation_stage = "room_cancel_teardown";
        state_->operation_deadline =
            std::chrono::steady_clock::now() + deadlines_.cancellation;
        deadline_changed = true;
      }
    } else {
      state_->connection_state = RoomConnectionState::Disconnecting;
      state_->cancellation_requested = false;
      state_->teardown_requested = false;
      state_->completion_pending = true;
      state_->operation_stage = "room_disconnect";
      state_->operation_deadline =
          std::chrono::steady_clock::now() + deadlines_.disconnect;
      deadline_changed = true;
    }
  }
  if (deadline_changed)
    state_->deadline_changed.notify_all();
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
                !state->completion_pending ||
                state->connection_state != RoomConnectionState::Disconnecting)
              return;
            state->completion_pending = false;
            state->operation_deadline.reset();
            state->connection_state = result.ok
                                          ? RoomConnectionState::Disconnected
                                          : RoomConnectionState::Connected;
            callback = state->event_callback;
            event = RoomConnectionEvent{completed_generation,
                                        state->connection_state,
                                        std::move(result.failure)};
          }
          state->deadline_changed.notify_all();
          if (callback)
            callback(event);
        });
  } catch (const std::exception &error) {
    {
      std::lock_guard lock(state_->mutex);
      state_->connection_state = RoomConnectionState::Connected;
      state_->completion_pending = false;
      state_->operation_deadline.reset();
    }
    state_->deadline_changed.notify_all();
    return EngineResult::fail(roomFailure("room_disconnect_start_failed",
                                          error.what(), "room_disconnect"));
  } catch (...) {
    {
      std::lock_guard lock(state_->mutex);
      state_->connection_state = RoomConnectionState::Connected;
      state_->completion_pending = false;
      state_->operation_deadline.reset();
    }
    state_->deadline_changed.notify_all();
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
    state_->completion_pending = true;
    state_->operation_stage = "room_disconnect";
    state_->operation_deadline =
        std::chrono::steady_clock::now() + deadlines_.disconnect;
  }
  state_->deadline_changed.notify_all();

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
                !state->completion_pending ||
                state->connection_state != RoomConnectionState::Disconnecting)
              return;
            state->completion_pending = false;
            state->operation_deadline.reset();
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
          state->deadline_changed.notify_all();
          if (callback)
            callback(event);
        });
  } catch (const std::exception &error) {
    {
      std::lock_guard lock(state_->mutex);
      state_->connection_state = RoomConnectionState::Connected;
      state_->completion_pending = false;
      state_->operation_deadline.reset();
    }
    state_->deadline_changed.notify_all();
    return EngineResult::fail(roomFailure("room_disconnect_start_failed",
                                          error.what(), "room_disconnect"));
  } catch (...) {
    {
      std::lock_guard lock(state_->mutex);
      state_->connection_state = RoomConnectionState::Connected;
      state_->completion_pending = false;
      state_->operation_deadline.reset();
    }
    state_->deadline_changed.notify_all();
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
