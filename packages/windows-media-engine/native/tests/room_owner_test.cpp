#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "core/room_owner.hpp"

namespace syrnike::windows_media::tests {

namespace {

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

class ManualRoomTransport final : public RoomTransport {
 public:
  void startConnect(
    std::uint64_t generation,
    RoomConnectRequest,
    RoomOperationCompletion completion
  ) override {
    {
      std::lock_guard lock(mutex_);
      connect_completions_.emplace(generation, std::move(completion));
      ++connect_starts_;
    }
    changed_.notify_all();
  }

  void cancelConnect(std::uint64_t generation) noexcept override {
    std::lock_guard lock(mutex_);
    cancelled_.push_back(generation);
  }

  void startDisconnect(
    std::uint64_t generation,
    RoomOperationCompletion completion
  ) override {
    {
      std::lock_guard lock(mutex_);
      disconnect_completions_.emplace(generation, std::move(completion));
      ++disconnect_starts_;
    }
    changed_.notify_all();
  }

  void waitForConnectStarts(std::size_t expected) {
    std::unique_lock lock(mutex_);
    require(changed_.wait_for(lock, std::chrono::seconds(1), [&] {
      return connect_starts_ >= expected;
    }), "room connect did not start");
  }

  void waitForDisconnectStarts(std::size_t expected) {
    std::unique_lock lock(mutex_);
    require(changed_.wait_for(lock, std::chrono::seconds(1), [&] {
      return disconnect_starts_ >= expected;
    }), "room disconnect did not start");
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
      if (value == generation) return true;
    }
    return false;
  }

 private:
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::map<std::uint64_t, RoomOperationCompletion> connect_completions_;
  std::map<std::uint64_t, RoomOperationCompletion> disconnect_completions_;
  std::vector<std::uint64_t> cancelled_;
  std::size_t connect_starts_ = 0;
  std::size_t disconnect_starts_ = 0;
};

void connectAndDisconnectEmitFiniteEvents() {
  auto transport = std::make_shared<ManualRoomTransport>();
  std::vector<RoomConnectionEvent> events;
  RoomOwner owner(transport, [&](const RoomConnectionEvent& event) {
    events.push_back(event);
  });
  EngineResult connect_result;
  std::thread connecting([&] {
    connect_result = owner.connect(
      RoomConnectRequest{"ws://localhost", "token"},
      std::chrono::seconds(1)
    );
  });
  transport->waitForConnectStarts(1);
  transport->completeConnect(1, EngineResult::success());
  connecting.join();
  require(connect_result.ok, "room connect failed");
  require(owner.state() == RoomConnectionState::Connected, "room did not connect");

  EngineResult disconnect_result;
  std::thread disconnecting([&] {
    disconnect_result = owner.disconnect(std::chrono::seconds(1));
  });
  transport->waitForDisconnectStarts(1);
  transport->completeDisconnect(1, EngineResult::success());
  disconnecting.join();
  require(disconnect_result.ok, "room disconnect failed");
  require(owner.state() == RoomConnectionState::Disconnected, "room did not disconnect");
  require(events.size() == 2, "room event count changed");
  require(events[0].state == RoomConnectionState::Connected, "connected event missing");
  require(events[1].state == RoomConnectionState::Disconnected, "disconnected event missing");
}

void pendingConnectCancellationIsTyped() {
  auto transport = std::make_shared<ManualRoomTransport>();
  RoomOwner owner(transport);
  EngineResult connect_result;
  std::thread connecting([&] {
    connect_result = owner.connect(
      RoomConnectRequest{"ws://localhost", "token"},
      std::chrono::seconds(1)
    );
  });
  transport->waitForConnectStarts(1);
  require(owner.cancelPendingConnect().ok, "pending connect cancellation failed");
  connecting.join();
  require(
    !connect_result.ok && connect_result.failure &&
      connect_result.failure->code == "room_connect_cancelled",
    "pending connect cancellation was not typed"
  );
  require(transport->wasCancelled(1), "transport cancellation was not requested");
  transport->completeConnect(1, EngineResult::success());
  require(owner.state() == RoomConnectionState::Disconnected, "late callback reconnected room");
}

void lateCompletionCannotMutateNewGeneration() {
  auto transport = std::make_shared<ManualRoomTransport>();
  RoomOwner owner(transport);
  const auto expired = owner.connect(
    RoomConnectRequest{"ws://localhost", "old"},
    std::chrono::milliseconds(0)
  );
  require(
    !expired.ok && expired.failure &&
      expired.failure->code == "room_connect_deadline_exceeded",
    "connect deadline was not typed"
  );

  EngineResult new_result;
  std::thread connecting([&] {
    new_result = owner.connect(
      RoomConnectRequest{"ws://localhost", "new"},
      std::chrono::seconds(1)
    );
  });
  transport->waitForConnectStarts(2);
  transport->completeConnect(1, EngineResult::success());
  require(owner.state() == RoomConnectionState::Connecting, "old completion mutated new attempt");
  transport->completeConnect(2, EngineResult::success());
  connecting.join();
  require(new_result.ok, "new generation did not connect");
  require(owner.generation() == 2, "room generation changed unexpectedly");
}

void disconnectDeadlineFencesLateCompletion() {
  auto transport = std::make_shared<ManualRoomTransport>();
  RoomOwner owner(transport);
  EngineResult connect_result;
  std::thread connecting([&] {
    connect_result = owner.connect(
      RoomConnectRequest{"ws://localhost", "token"},
      std::chrono::seconds(1)
    );
  });
  transport->waitForConnectStarts(1);
  transport->completeConnect(1, EngineResult::success());
  connecting.join();
  require(connect_result.ok, "disconnect-deadline setup failed");

  const auto expired = owner.disconnect(std::chrono::milliseconds(0));
  require(
    !expired.ok && expired.failure &&
      expired.failure->code == "room_disconnect_deadline_exceeded",
    "disconnect deadline was not typed"
  );
  EngineResult reconnect_result;
  std::thread reconnecting([&] {
    reconnect_result = owner.connect(
      RoomConnectRequest{"ws://localhost", "new-token"},
      std::chrono::seconds(1)
    );
  });
  transport->waitForConnectStarts(2);
  transport->completeDisconnect(1, EngineResult::success());
  require(owner.state() == RoomConnectionState::Connecting,
    "late disconnect mutated a new connect");
  transport->completeConnect(2, EngineResult::success());
  reconnecting.join();
  require(reconnect_result.ok, "connect after expired disconnect failed");
}

void fiftyLifecycleCyclesReturnToBaseline() {
  auto transport = std::make_shared<ManualRoomTransport>();
  RoomOwner owner(transport);
  for (std::size_t cycle = 0; cycle < 50; ++cycle) {
    EngineResult connect_result;
    std::thread connecting([&] {
      connect_result = owner.connect(
        RoomConnectRequest{"ws://localhost", "token"},
        std::chrono::seconds(1)
      );
    });
    transport->waitForConnectStarts(cycle + 1);
    transport->completeConnect(cycle + 1, EngineResult::success());
    connecting.join();
    require(connect_result.ok, "lifecycle connect failed");

    EngineResult disconnect_result;
    std::thread disconnecting([&] {
      disconnect_result = owner.disconnect(std::chrono::seconds(1));
    });
    transport->waitForDisconnectStarts(cycle + 1);
    transport->completeDisconnect(cycle + 1, EngineResult::success());
    disconnecting.join();
    require(disconnect_result.ok, "lifecycle disconnect failed");
    require(owner.state() == RoomConnectionState::Disconnected, "cycle did not disconnect");
  }
  require(transport->pendingCallbacks() == 0, "callbacks did not return to baseline");
}

}  // namespace

void runRoomOwnerTests() {
  connectAndDisconnectEmitFiniteEvents();
  pendingConnectCancellationIsTyped();
  lateCompletionCannotMutateNewGeneration();
  disconnectDeadlineFencesLateCompletion();
  fiftyLifecycleCyclesReturnToBaseline();
}

}  // namespace syrnike::windows_media::tests
