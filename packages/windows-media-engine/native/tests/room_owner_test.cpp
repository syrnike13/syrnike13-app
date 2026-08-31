#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "core/room_owner.hpp"

namespace syrnike::windows_media::tests {

namespace {

void require(bool condition, const std::string &message) {
  if (!condition)
    throw std::runtime_error(message);
}

class ManualRoomTransport final : public RoomTransport {
public:
  void startConnect(std::uint64_t generation, RoomConnectRequest,
                    RoomOperationCompletion completion) override {
    {
      std::lock_guard lock(mutex_);
      connect_completions_.emplace(generation, std::move(completion));
      ++connect_starts_;
    }
    changed_.notify_all();
  }

  bool cancelConnect(std::uint64_t generation) noexcept override {
    std::lock_guard lock(mutex_);
    cancelled_.push_back(generation);
    return cancel_accepted_;
  }

  void startDisconnect(std::uint64_t generation,
                       RoomOperationCompletion completion) override {
    {
      std::lock_guard lock(mutex_);
      disconnect_completions_.emplace(generation, std::move(completion));
      ++disconnect_starts_;
    }
    changed_.notify_all();
  }

  void waitForConnectStarts(std::size_t expected) {
    std::unique_lock lock(mutex_);
    require(changed_.wait_for(lock, std::chrono::seconds(1),
                              [&] { return connect_starts_ >= expected; }),
            "room connect did not start");
  }

  void waitForDisconnectStarts(std::size_t expected) {
    std::unique_lock lock(mutex_);
    require(changed_.wait_for(lock, std::chrono::seconds(1),
                              [&] { return disconnect_starts_ >= expected; }),
            "room disconnect did not start");
  }

  void completeConnect(std::uint64_t generation, EngineResult result) {
    RoomOperationCompletion completion;
    {
      std::lock_guard lock(mutex_);
      completion = connect_completions_.at(generation);
      connect_completions_.erase(generation);
    }
    completion(generation, std::move(result));
  }

  void completeDisconnect(std::uint64_t generation, EngineResult result) {
    RoomOperationCompletion completion;
    {
      std::lock_guard lock(mutex_);
      completion = disconnect_completions_.at(generation);
      disconnect_completions_.erase(generation);
    }
    completion(generation, std::move(result));
  }

  [[nodiscard]] std::size_t pendingCallbacks() const {
    std::lock_guard lock(mutex_);
    return connect_completions_.size() + disconnect_completions_.size();
  }

  [[nodiscard]] bool wasCancelled(std::uint64_t generation) const {
    std::lock_guard lock(mutex_);
    for (const auto value : cancelled_) {
      if (value == generation)
        return true;
    }
    return false;
  }

  void rejectCancellationAsTooLate() {
    std::lock_guard lock(mutex_);
    cancel_accepted_ = false;
  }

private:
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::map<std::uint64_t, RoomOperationCompletion> connect_completions_;
  std::map<std::uint64_t, RoomOperationCompletion> disconnect_completions_;
  std::vector<std::uint64_t> cancelled_;
  std::size_t connect_starts_ = 0;
  std::size_t disconnect_starts_ = 0;
  bool cancel_accepted_ = true;
};

void connectAndDisconnectEmitFiniteEvents() {
  auto transport = std::make_shared<ManualRoomTransport>();
  std::vector<RoomConnectionEvent> events;
  RoomOwner owner(transport, [&](const RoomConnectionEvent &event) {
    events.push_back(event);
  });
  const auto connect_result =
      owner.beginConnect(RoomConnectRequest{"ws://localhost", "token"});
  transport->waitForConnectStarts(1);
  require(connect_result.ok, "room connect did not start");
  require(owner.state() == RoomConnectionState::Connecting,
          "room connect blocked instead of returning connecting state");
  transport->completeConnect(1, EngineResult::success());
  require(owner.state() == RoomConnectionState::Connected,
          "room did not connect");

  const auto disconnect_result = owner.beginDisconnect();
  transport->waitForDisconnectStarts(1);
  require(disconnect_result.ok, "room disconnect did not start");
  require(owner.state() == RoomConnectionState::Disconnecting,
          "room disconnect blocked instead of returning disconnecting state");
  transport->completeDisconnect(1, EngineResult::success());
  require(owner.state() == RoomConnectionState::Disconnected,
          "room did not disconnect");
  require(events.size() == 2, "room event count changed");
  require(events[0].state == RoomConnectionState::Connected,
          "connected event missing");
  require(events[1].state == RoomConnectionState::Disconnected,
          "disconnected event missing");
}

void pendingConnectCancellationIsTyped() {
  auto transport = std::make_shared<ManualRoomTransport>();
  std::vector<RoomConnectionEvent> events;
  RoomOwner owner(transport, [&](const RoomConnectionEvent &event) {
    events.push_back(event);
  });
  require(owner.beginConnect(RoomConnectRequest{"ws://localhost", "token"}).ok,
          "pending connect did not start");
  transport->waitForConnectStarts(1);
  require(owner.cancelPendingConnect().ok,
          "pending connect cancellation failed");
  require(owner.state() == RoomConnectionState::Disconnecting,
          "cancelled connect completed before transport termination");
  transport->completeConnect(1, EngineResult::success());
  require(events.size() == 1 && events[0].failure &&
              events[0].failure->code == "room_connect_cancelled",
          "pending connect cancellation was not typed");
  require(transport->wasCancelled(1),
          "transport cancellation was not requested");
  require(owner.state() == RoomConnectionState::Disconnected,
          "late callback reconnected room");
}

void failedDisconnectRetainsRoomOwnership() {
  auto transport = std::make_shared<ManualRoomTransport>();
  std::vector<RoomConnectionEvent> events;
  RoomOwner owner(transport, [&](const RoomConnectionEvent &event) {
    events.push_back(event);
  });
  require(owner.beginConnect(RoomConnectRequest{"ws://localhost", "token"}).ok,
          "disconnect failure connect did not start");
  transport->completeConnect(1, EngineResult::success());
  require(owner.beginDisconnect().ok,
          "disconnect failure attempt did not start");
  transport->completeDisconnect(
      1, EngineResult::fail(EngineFailure{"livekit_disconnect_failed",
                                          "disconnect failed",
                                          "room_disconnect", true}));
  require(owner.state() == RoomConnectionState::Connected,
          "failed disconnect released Room ownership");
  require(events.size() == 2 && events.back().failure &&
              events.back().state == RoomConnectionState::Connected,
          "failed disconnect did not emit a retained-room failure");
  require(owner.beginDisconnect().ok,
          "retained Room could not retry disconnect");
  transport->completeDisconnect(1, EngineResult::success());
  require(owner.state() == RoomConnectionState::Disconnected,
          "retried disconnect did not release Room ownership");
}

void failedCancellationTeardownRetainsRoomOwnership() {
  auto transport = std::make_shared<ManualRoomTransport>();
  std::vector<RoomConnectionEvent> events;
  RoomOwner owner(transport, [&](const RoomConnectionEvent &event) {
    events.push_back(event);
  });
  require(owner.beginConnect(RoomConnectRequest{"ws://localhost", "token"}).ok,
          "cancellation teardown connect did not start");
  require(owner.cancelPendingConnect().ok,
          "cancellation teardown was not requested");
  transport->completeConnect(
      1, EngineResult::fail(EngineFailure{"room_cancel_teardown_failed",
                                          "teardown failed", "room_disconnect",
                                          true}));
  require(owner.state() == RoomConnectionState::Connected,
          "failed cancellation teardown released Room ownership");
  require(events.size() == 1 && events.back().failure &&
              events.back().failure->code == "room_cancel_teardown_failed" &&
              events.back().state == RoomConnectionState::Connected,
          "failed cancellation teardown was not surfaced as retained Room");
  require(owner.beginDisconnect().ok,
          "retained Room could not retry teardown after cancellation failure");
  transport->completeDisconnect(1, EngineResult::success());
  require(owner.state() == RoomConnectionState::Disconnected,
          "retried cancellation teardown did not release Room ownership");
}

void lateCancellationFallsThroughToDisconnect() {
  auto transport = std::make_shared<ManualRoomTransport>();
  RoomOwner owner(transport);
  require(owner.beginConnect(RoomConnectRequest{"ws://localhost", "token"}).ok,
          "late cancellation connect did not start");
  transport->rejectCancellationAsTooLate();
  require(owner.beginTeardown().ok, "late cancellation teardown failed");
  require(owner.state() == RoomConnectionState::Connecting,
          "too-late cancellation forged a disconnected state");
  transport->completeConnect(1, EngineResult::success());
  require(owner.state() == RoomConnectionState::Connected,
          "committed connect ownership was lost");
  require(owner.beginTeardown().ok,
          "committed connect could not continue into disconnect");
  transport->completeDisconnect(1, EngineResult::success());
  require(owner.state() == RoomConnectionState::Disconnected,
          "late cancellation fallback did not disconnect");
}

void lateCompletionCannotMutateNewGeneration() {
  auto transport = std::make_shared<ManualRoomTransport>();
  RoomOwner owner(transport);
  require(owner.beginConnect(RoomConnectRequest{"ws://localhost", "old"}).ok,
          "old generation did not start");
  require(owner.cancelPendingConnect().ok, "old generation did not cancel");
  transport->completeConnect(1, EngineResult::success());
  const auto new_result =
      owner.beginConnect(RoomConnectRequest{"ws://localhost", "new"});
  transport->waitForConnectStarts(2);
  require(owner.state() == RoomConnectionState::Connecting,
          "old completion mutated new attempt");
  transport->completeConnect(2, EngineResult::success());
  require(new_result.ok, "new generation did not connect");
  require(owner.generation() == 2, "room generation changed unexpectedly");
}

void fiftyLifecycleCyclesReturnToBaseline() {
  auto transport = std::make_shared<ManualRoomTransport>();
  RoomOwner owner(transport);
  for (std::size_t cycle = 0; cycle < 50; ++cycle) {
    const auto connect_result =
        owner.beginConnect(RoomConnectRequest{"ws://localhost", "token"});
    transport->waitForConnectStarts(cycle + 1);
    transport->completeConnect(cycle + 1, EngineResult::success());
    require(connect_result.ok, "lifecycle connect failed");

    const auto disconnect_result = owner.beginDisconnect();
    transport->waitForDisconnectStarts(cycle + 1);
    transport->completeDisconnect(cycle + 1, EngineResult::success());
    require(disconnect_result.ok, "lifecycle disconnect failed");
    require(owner.state() == RoomConnectionState::Disconnected,
            "cycle did not disconnect");
  }
  require(transport->pendingCallbacks() == 0,
          "callbacks did not return to baseline");
}

} // namespace

void runRoomOwnerTests() {
  connectAndDisconnectEmitFiniteEvents();
  pendingConnectCancellationIsTyped();
  failedDisconnectRetainsRoomOwnership();
  failedCancellationTeardownRetainsRoomOwnership();
  lateCancellationFallsThroughToDisconnect();
  lateCompletionCannotMutateNewGeneration();
  fiftyLifecycleCyclesReturnToBaseline();
}

} // namespace syrnike::windows_media::tests
