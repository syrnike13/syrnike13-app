#pragma once

#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>
#include <variant>

#include <livekit/livekit.h>

#include "core/room_owner.hpp"

namespace syrnike::windows_media {

class LiveKitRoomTransport final : public RoomTransport {
public:
  using ActiveRoomTask =
      std::function<void(const std::shared_ptr<livekit::Room> &)>;

  LiveKitRoomTransport();
  ~LiveKitRoomTransport() override;

  LiveKitRoomTransport(const LiveKitRoomTransport &) = delete;
  LiveKitRoomTransport &operator=(const LiveKitRoomTransport &) = delete;

  void startConnect(std::uint64_t generation, RoomConnectRequest request,
                    RoomOperationCompletion completion) override;
  [[nodiscard]] bool cancelConnect(std::uint64_t generation) noexcept override;
  void startDisconnect(std::uint64_t generation,
                       RoomOperationCompletion completion) override;

  [[nodiscard]] std::shared_ptr<livekit::Room> activeRoom() const;
  // Serializes publication work with connect/disconnect on the SDK lane.
  // Returns false when the bounded single pending slot is occupied.
  [[nodiscard]] bool enqueueActiveRoomTask(ActiveRoomTask task) noexcept;
  [[nodiscard]] std::size_t pendingOperationCount() const noexcept;

private:
  struct ConnectTask {
    std::uint64_t generation;
    RoomConnectRequest request;
    RoomOperationCompletion completion;
  };
  struct DisconnectTask {
    std::uint64_t generation;
    RoomOperationCompletion completion;
  };
  struct CancellationOutcome {
    std::uint64_t generation;
    EngineResult result;
  };
  struct ActiveRoomLaneTask {
    ActiveRoomTask task;
  };
  using Task = std::variant<ConnectTask, DisconnectTask, ActiveRoomLaneTask>;

  void run() noexcept;
  void runCancellationLane() noexcept;
  void runConnect(ConnectTask task) noexcept;
  void runDisconnect(DisconnectTask task) noexcept;
  void runActiveRoomTask(ActiveRoomLaneTask task) noexcept;
  void enqueue(Task task);

  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::condition_variable cancellation_changed_;
  std::condition_variable cancellation_completed_;
  std::optional<Task> pending_task_;
  std::optional<std::uint64_t> pending_cancellation_;
  std::optional<std::uint64_t> cancellation_running_;
  std::optional<CancellationOutcome> cancellation_outcome_;
  bool operation_running_ = false;
  bool stopping_ = false;
  std::optional<std::uint64_t> cancelled_connect_generation_;
  std::optional<std::uint64_t> completion_committed_generation_;
  std::uint64_t active_generation_ = 0;
  std::shared_ptr<livekit::Room> operation_room_;
  std::shared_ptr<livekit::Room> active_room_;
  std::thread worker_;
  std::thread cancellation_worker_;
};

} // namespace syrnike::windows_media
