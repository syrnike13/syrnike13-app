#include "livekit/livekit_room_transport.hpp"

#include <chrono>
#include <exception>
#include <stdexcept>
#include <utility>

namespace syrnike::windows_media {
namespace {

EngineResult liveKitFailure(std::string code, std::string message,
                            std::string stage, bool retryable = false) {
  return EngineResult::fail(EngineFailure{
      std::move(code),
      std::move(message),
      std::move(stage),
      retryable,
  });
}

EngineResult cancelLiveKitRoom(const std::shared_ptr<livekit::Room> &room) {
  try {
    if (!room->disconnect()) {
      return liveKitFailure("room_cancel_teardown_failed",
                            "LiveKit Room cancellation teardown returned false",
                            "room_disconnect", true);
    }
    return EngineResult::success();
  } catch (const std::exception &) {
    return liveKitFailure(
        "room_cancel_teardown_failed",
        "LiveKit Room cancellation teardown raised an exception",
        "room_disconnect", true);
  } catch (...) {
    return liveKitFailure("room_cancel_teardown_failed",
                          "Unknown LiveKit Room cancellation teardown failure",
                          "room_disconnect", true);
  }
}

} // namespace

LiveKitRoomTransport::LiveKitRoomTransport(std::shared_ptr<LiveKitRoomObserver> delegate)
    : delegate_(std::move(delegate)) {
  livekit::initialize(livekit::LogLevel::Info);
  worker_ = std::thread([this] { run(); });
  cancellation_worker_ = std::thread([this] { runCancellationLane(); });
}

void LiveKitRoomTransport::setConnectionEventCallback(RoomConnectionEventCallback callback) {
  std::lock_guard lock(mutex_);
  connection_event_callback_ = std::move(callback);
}

LiveKitRoomTransport::~LiveKitRoomTransport() {
  {
    std::lock_guard lock(mutex_);
    stopping_ = true;
  }
  changed_.notify_one();
  cancellation_changed_.notify_one();
  if (cancellation_worker_.joinable())
    cancellation_worker_.join();
  if (worker_.joinable())
    worker_.join();
  if (delegate_) delegate_->stop();
  {
    std::lock_guard lock(mutex_);
    operation_room_.reset();
    active_room_.reset();
  }
  livekit::shutdown();
}

void LiveKitRoomTransport::startConnect(std::uint64_t generation,
                                        RoomConnectRequest request,
                                        RoomOperationCompletion completion) {
  enqueue(ConnectTask{generation, std::move(request), std::move(completion)});
}

bool LiveKitRoomTransport::cancelConnect(std::uint64_t generation) noexcept {
  {
    std::lock_guard lock(mutex_);
    if (completion_committed_generation_ == generation)
      return false;
    const auto *queued =
        pending_task_ ? std::get_if<ConnectTask>(&*pending_task_) : nullptr;
    const bool queued_connect = queued && queued->generation == generation;
    const bool running_connect =
        operation_running_ && active_generation_ == generation;
    if (!queued_connect && !running_connect)
      return false;
    cancelled_connect_generation_ = generation;
    if (running_connect)
      pending_cancellation_ = generation;
  }
  cancellation_changed_.notify_one();
  return true;
}

void LiveKitRoomTransport::startDisconnect(std::uint64_t generation,
                                           RoomOperationCompletion completion) {
  enqueue(DisconnectTask{generation, std::move(completion)});
}

std::shared_ptr<livekit::Room> LiveKitRoomTransport::activeRoom() const {
  std::lock_guard lock(mutex_);
  return active_room_;
}

bool LiveKitRoomTransport::enqueueActiveRoomTask(ActiveRoomTask task) noexcept {
  if (!task)
    return false;
  try {
    enqueue(ActiveRoomLaneTask{std::move(task)});
    return true;
  } catch (...) {
    return false;
  }
}

std::size_t LiveKitRoomTransport::pendingOperationCount() const noexcept {
  std::lock_guard lock(mutex_);
  return static_cast<std::size_t>(pending_task_.has_value()) +
         static_cast<std::size_t>(operation_running_) +
         static_cast<std::size_t>(pending_cancellation_.has_value()) +
         static_cast<std::size_t>(cancellation_running_.has_value()) +
         static_cast<std::size_t>(cancellation_outcome_.has_value()) +
         static_cast<std::size_t>(
             completion_committed_generation_.has_value());
}

void LiveKitRoomTransport::enqueue(Task task) {
  {
    std::lock_guard lock(mutex_);
    // A completion may wake the Engine control thread just before the worker
    // clears operation_running_. Permit exactly one follow-up operation so a
    // disconnect cannot be rejected by that bookkeeping race.
    if (stopping_ || pending_task_) {
      throw std::runtime_error("LiveKit transport operation lane is occupied");
    }
    pending_task_ = std::move(task);
  }
  changed_.notify_one();
}

void LiveKitRoomTransport::run() noexcept {
  while (true) {
    std::optional<Task> task;
    {
      std::unique_lock lock(mutex_);
      // Read the SDK's synchronized state on its owner lane; this also works
      // when the laboratory installs a RoomDelegate for track observations.
      changed_.wait_for(lock, std::chrono::milliseconds(100),
                    [this] { return stopping_ || pending_task_.has_value(); });
      if (stopping_) {
        pending_task_.reset();
        return;
      }
      if (active_room_ && !disconnect_reported_ &&
          active_room_->connectionState() == livekit::ConnectionState::Disconnected) {
        disconnect_reported_ = true;
        const auto callback = connection_event_callback_;
        const auto generation = active_generation_;
        lock.unlock();
        if (callback) callback(RoomConnectionEvent{
            generation, RoomConnectionState::Disconnected,
            EngineFailure{"room_connection_lost", "LiveKit Room disconnected unexpectedly",
                          "room_connection", true}});
        continue;
      }
      if (!pending_task_) continue;
      task = std::move(pending_task_);
      pending_task_.reset();
      operation_running_ = true;
      if (const auto *connect = std::get_if<ConnectTask>(&*task)) {
        active_generation_ = connect->generation;
        disconnect_reported_ = false;
      }
    }
    if (auto *connect = std::get_if<ConnectTask>(&*task)) {
      runConnect(std::move(*connect));
    } else if (auto *disconnect = std::get_if<DisconnectTask>(&*task)) {
      runDisconnect(std::move(*disconnect));
    } else {
      runActiveRoomTask(std::move(std::get<ActiveRoomLaneTask>(*task)));
    }
    {
      std::lock_guard lock(mutex_);
      operation_running_ = false;
      operation_room_.reset();
    }
  }
}

void LiveKitRoomTransport::runActiveRoomTask(ActiveRoomLaneTask task) noexcept {
  std::shared_ptr<livekit::Room> room;
  {
    std::lock_guard lock(mutex_);
    room = active_room_;
  }
  try {
    task.task(room);
  } catch (...) {
    // ActiveRoomTask owns its typed completion contract. Never let a client
    // callback terminate the shared SDK lane.
  }
}

void LiveKitRoomTransport::runCancellationLane() noexcept {
  while (true) {
    std::shared_ptr<livekit::Room> room;
    std::uint64_t generation = 0;
    {
      std::unique_lock lock(mutex_);
      cancellation_changed_.wait(lock, [this] {
        return stopping_ || pending_cancellation_.has_value();
      });
      if (stopping_ && !pending_cancellation_)
        return;
      generation = *pending_cancellation_;
      pending_cancellation_.reset();
      cancellation_running_ = generation;
      if (active_generation_ == generation)
        room = operation_room_;
    }
    auto result = EngineResult::success();
    if (room)
      result = cancelLiveKitRoom(room);
    {
      std::lock_guard lock(mutex_);
      cancellation_running_.reset();
      cancellation_outcome_ =
          CancellationOutcome{generation, std::move(result)};
    }
    cancellation_completed_.notify_all();
  }
}

void LiveKitRoomTransport::runConnect(ConnectTask task) noexcept {
  std::shared_ptr<livekit::Room> room;
  {
    std::lock_guard lock(mutex_);
    if (cancelled_connect_generation_ == task.generation) {
      cancelled_connect_generation_.reset();
      if (pending_cancellation_ == task.generation)
        pending_cancellation_.reset();
      active_generation_ = 0;
    } else {
      room = std::make_shared<livekit::Room>();
      room->setDelegate(delegate_.get());
      operation_room_ = room;
    }
  }
  if (!room) {
    task.completion(
        task.generation,
        liveKitFailure("room_connect_cancelled",
                       "LiveKit connect was cancelled before it started",
                       "room_connect", true));
    return;
  }
  livekit::RoomOptions options;
  options.auto_subscribe = false;
  options.dynacast = false;
  options.connect_timeout = std::chrono::seconds(10);
  EngineResult result;
  try {
    result = room->connect(task.request.url, task.request.token, options)
                 ? EngineResult::success()
                 : liveKitFailure("livekit_connect_failed",
                                  "LiveKit Room connect returned false",
                                  "room_connect", true);
  } catch (const std::exception &) {
    result = liveKitFailure("livekit_connect_failed",
                            "LiveKit Room connect raised an exception",
                            "room_connect", true);
  } catch (...) {
    result =
        liveKitFailure("livekit_connect_failed",
                       "Unknown LiveKit connect failure", "room_connect", true);
  }
  if (result.ok) {
    const auto local_participant = room->localParticipant().lock();
    const auto authority = validateRoomAuthority(
        task.request, room->roomInfo().name,
        local_participant ? local_participant->identity() : std::string_view{});
    if (!authority.ok) {
      // The credential lease is already consumed. Tear down the unexpected
      // authority before reporting the typed mismatch to the Engine.
      static_cast<void>(cancelLiveKitRoom(room));
      result = authority;
    }
  }
  bool cancelled = false;
  std::optional<EngineResult> cancellation_result;
  {
    std::unique_lock lock(mutex_);
    cancelled = cancelled_connect_generation_ == task.generation;
    if (cancelled) {
      cancellation_completed_.wait(lock, [this, generation = task.generation] {
        return stopping_ || (pending_cancellation_ != generation &&
                             cancellation_running_ != generation);
      });
      if (cancellation_outcome_ &&
          cancellation_outcome_->generation == task.generation) {
        cancellation_result = std::move(cancellation_outcome_->result);
        cancellation_outcome_.reset();
      }
      cancelled_connect_generation_.reset();
    }
    if (result.ok && !cancelled)
      active_room_ = room;
    completion_committed_generation_ = task.generation;
  }
  if (cancelled) {
    // Cancellation can reach the dedicated lane after operation_room_ is
    // published but before Room::connect() has left its initial Disconnected
    // state. In that window disconnect() is a no-op. Once connect() returns,
    // retry teardown if the Room is now live instead of retaining a connection
    // that the accepted off/shutdown intent was meant to destroy.
    if (room->connectionState() != livekit::ConnectionState::Disconnected) {
      cancellation_result = cancelLiveKitRoom(room);
    }
    if (room->connectionState() == livekit::ConnectionState::Disconnected ||
        !cancellation_result || cancellation_result->ok) {
      std::lock_guard lock(mutex_);
      if (active_generation_ == task.generation) {
        active_generation_ = 0;
        active_room_.reset();
      }
      result =
          liveKitFailure("room_connect_cancelled",
                         "LiveKit connect was cancelled", "room_connect", true);
    } else {
      std::lock_guard lock(mutex_);
      active_room_ = room;
      result = std::move(*cancellation_result);
    }
  }
  if (!result.ok) {
    room.reset();
  }
  task.completion(task.generation, std::move(result));
  {
    std::lock_guard lock(mutex_);
    if (completion_committed_generation_ == task.generation)
      completion_committed_generation_.reset();
  }
}

void LiveKitRoomTransport::runDisconnect(DisconnectTask task) noexcept {
  std::shared_ptr<livekit::Room> room;
  {
    std::lock_guard lock(mutex_);
    if (active_generation_ == task.generation)
      room = active_room_;
    operation_room_ = room;
  }
  EngineResult result;
  if (!room) {
    result = liveKitFailure("livekit_room_missing",
                            "The active LiveKit Room is unavailable",
                            "room_disconnect");
  } else {
    try {
      result = room->disconnect()
                   ? EngineResult::success()
                   : liveKitFailure("livekit_disconnect_failed",
                                    "LiveKit Room disconnect returned false",
                                    "room_disconnect", true);
    } catch (const std::exception &) {
      result = liveKitFailure("livekit_disconnect_failed",
                              "LiveKit Room disconnect raised an exception",
                              "room_disconnect", true);
    } catch (...) {
      result = liveKitFailure("livekit_disconnect_failed",
                              "Unknown LiveKit disconnect failure",
                              "room_disconnect", true);
    }
  }
  {
    std::lock_guard lock(mutex_);
    if (result.ok && active_generation_ == task.generation) {
      active_generation_ = 0;
      active_room_.reset();
      operation_room_.reset();
    }
  }
  room.reset();
  task.completion(task.generation, std::move(result));
}

} // namespace syrnike::windows_media
