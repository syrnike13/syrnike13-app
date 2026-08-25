#pragma once

#include <windows.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <exception>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <utility>

namespace syrnike::desktop_native::tests {

enum class ProtocolRecordPriority {
  Frame,
  Control,
};

enum class ProtocolRecordAdmission {
  Accepted,
  FrameDropped,
  ControlSaturated,
  Closed,
};

struct ProtocolWriterSnapshot {
  std::size_t queued = 0;
  std::size_t frame_drops = 0;
  std::size_t control_saturations = 0;
  bool write_failed = false;
};

// Isolates a potentially blocking child stdout pipe from the contention media
// loop. Frame records may use only the non-reserved portion of the queue; the
// caller must exact-release a frame when FrameDropped is returned. Control and
// anomaly records own the reserved slots and saturation is an explicit fatal
// protocol failure rather than a silent loss.
class BoundedProtocolWriter final {
 public:
  using Write = std::function<bool(std::string_view)>;
  using Cancel = std::function<void(std::thread::native_handle_type)>;

 private:
  struct State;
  static std::shared_ptr<State> makeState(
      Write write,
      std::size_t capacity,
      std::size_t control_reserve);

 public:

  BoundedProtocolWriter(
      Write write,
      std::size_t capacity = 512,
      std::size_t control_reserve = 32,
      Cancel cancel = {})
      : state_(makeState(std::move(write), capacity, control_reserve)),
        cancel_(std::move(cancel)),
        worker_([state = state_] { run(*state); }) {}

  ~BoundedProtocolWriter() {
    if (!closeUntil(std::chrono::steady_clock::now() +
                    std::chrono::milliseconds(500))) {
      std::terminate();
    }
  }

  BoundedProtocolWriter(const BoundedProtocolWriter&) = delete;
  BoundedProtocolWriter& operator=(const BoundedProtocolWriter&) = delete;

  ProtocolRecordAdmission enqueue(
      std::string line,
      ProtocolRecordPriority priority) {
    auto& state = *state_;
    std::lock_guard lock(state.mutex);
    if (state.closed) return ProtocolRecordAdmission::Closed;
    const auto frame_capacity = state.capacity - state.control_reserve;
    if (priority == ProtocolRecordPriority::Frame &&
        state.records.size() >= frame_capacity) {
      ++state.frame_drops;
      return ProtocolRecordAdmission::FrameDropped;
    }
    if (state.records.size() >= state.capacity) {
      ++state.control_saturations;
      return ProtocolRecordAdmission::ControlSaturated;
    }
    state.records.push_back(std::move(line));
    state.changed.notify_one();
    return ProtocolRecordAdmission::Accepted;
  }

  ProtocolWriterSnapshot snapshot() const {
    const auto& state = *state_;
    std::lock_guard lock(state.mutex);
    return {
        .queued = state.records.size(),
        .frame_drops = state.frame_drops,
        .control_saturations = state.control_saturations,
        .write_failed = state.write_failed,
    };
  }

  bool closeUntil(std::chrono::steady_clock::time_point deadline) noexcept {
    {
      std::lock_guard lock(state_->mutex);
      state_->closed = true;
    }
    state_->changed.notify_all();
    if (!waitFinishedUntil(*state_, deadline)) {
      try {
        if (cancel_) {
          cancel_(worker_.native_handle());
        } else {
          static_cast<void>(CancelSynchronousIo(worker_.native_handle()));
        }
      } catch (...) {
      }
      if (!waitFinishedUntil(
              *state_, deadline + std::chrono::milliseconds(250))) {
        return false;
      }
    }
    if (worker_.joinable()) worker_.join();
    return true;
  }

 private:
  struct State {
    Write write;
    std::size_t capacity = 2;
    std::size_t control_reserve = 1;
    mutable std::mutex mutex;
    std::condition_variable changed;
    mutable std::condition_variable finished_changed;
    std::deque<std::string> records;
    std::size_t frame_drops = 0;
    std::size_t control_saturations = 0;
    bool closed = false;
    bool finished = false;
    bool write_failed = false;
  };

  static bool waitFinishedUntil(
      const State& state,
      std::chrono::steady_clock::time_point deadline) {
    std::unique_lock lock(state.mutex);
    state.finished_changed.wait_until(
        lock, deadline, [&] { return state.finished; });
    return state.finished;
  }

  static void run(State& state) noexcept {
    for (;;) {
      std::string record;
      {
        std::unique_lock lock(state.mutex);
        state.changed.wait(
            lock, [&] { return state.closed || !state.records.empty(); });
        if (state.records.empty()) {
          if (state.closed) break;
          continue;
        }
        record = std::move(state.records.front());
        state.records.pop_front();
      }
      bool written = false;
      try {
        written = state.write ? state.write(record) : false;
      } catch (...) {
      }
      if (!written) {
        std::lock_guard lock(state.mutex);
        state.write_failed = true;
        state.records.clear();
        state.closed = true;
        break;
      }
    }
    {
      std::lock_guard lock(state.mutex);
      state.finished = true;
    }
    state.finished_changed.notify_all();
  }

  std::shared_ptr<State> state_;
  Cancel cancel_;
  std::thread worker_;
};

inline std::shared_ptr<BoundedProtocolWriter::State>
BoundedProtocolWriter::makeState(
    Write write,
    std::size_t capacity,
    std::size_t control_reserve) {
  auto state = std::make_shared<State>();
  state->write = std::move(write);
  state->capacity = (std::max)(std::size_t{2}, capacity);
  state->control_reserve = (std::min)(
      (std::max)(std::size_t{1}, control_reserve), state->capacity - 1);
  return state;
}

}  // namespace syrnike::desktop_native::tests
