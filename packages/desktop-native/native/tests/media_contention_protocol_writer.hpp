#pragma once

#include <windows.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <exception>
#include <functional>
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

  BoundedProtocolWriter(
      Write write,
      std::size_t capacity = 512,
      std::size_t control_reserve = 32,
      Cancel cancel = {})
      : write_(std::move(write)),
        cancel_(std::move(cancel)),
        capacity_((std::max)(std::size_t{2}, capacity)),
        control_reserve_((std::min)(
            (std::max)(std::size_t{1}, control_reserve), capacity_ - 1)),
        worker_([this] { run(); }) {}

  ~BoundedProtocolWriter() {
    if (closeUntil(std::chrono::steady_clock::now() +
                   std::chrono::milliseconds(500))) {
      return;
    }
    std::terminate();
  }

  BoundedProtocolWriter(const BoundedProtocolWriter&) = delete;
  BoundedProtocolWriter& operator=(const BoundedProtocolWriter&) = delete;

  ProtocolRecordAdmission enqueue(
      std::string line,
      ProtocolRecordPriority priority) {
    std::lock_guard lock(mutex_);
    if (closed_) return ProtocolRecordAdmission::Closed;
    const auto frame_capacity = capacity_ - control_reserve_;
    if (priority == ProtocolRecordPriority::Frame &&
        records_.size() >= frame_capacity) {
      ++frame_drops_;
      return ProtocolRecordAdmission::FrameDropped;
    }
    if (records_.size() >= capacity_) {
      ++control_saturations_;
      return ProtocolRecordAdmission::ControlSaturated;
    }
    records_.push_back(std::move(line));
    changed_.notify_one();
    return ProtocolRecordAdmission::Accepted;
  }

  ProtocolWriterSnapshot snapshot() const {
    std::lock_guard lock(mutex_);
    return {
        .queued = records_.size(),
        .frame_drops = frame_drops_,
        .control_saturations = control_saturations_,
        .write_failed = write_failed_,
    };
  }

  bool closeUntil(std::chrono::steady_clock::time_point deadline) noexcept {
    {
      std::lock_guard lock(mutex_);
      closed_ = true;
    }
    changed_.notify_all();
    if (!waitFinishedUntil(deadline)) {
      try {
        if (cancel_) {
          cancel_(worker_.native_handle());
        } else {
          static_cast<void>(CancelSynchronousIo(worker_.native_handle()));
        }
      } catch (...) {
      }
      if (!waitFinishedUntil(deadline + std::chrono::milliseconds(250))) {
        return false;
      }
    }
    if (worker_.joinable()) worker_.join();
    return true;
  }

 private:
  bool waitFinishedUntil(std::chrono::steady_clock::time_point deadline) const {
    std::unique_lock lock(mutex_);
    finished_changed_.wait_until(lock, deadline, [&] { return finished_; });
    return finished_;
  }

  void run() noexcept {
    for (;;) {
      std::string record;
      {
        std::unique_lock lock(mutex_);
        changed_.wait(lock, [&] { return closed_ || !records_.empty(); });
        if (records_.empty()) {
          if (closed_) break;
          continue;
        }
        record = std::move(records_.front());
        records_.pop_front();
      }
      bool written = false;
      try {
        written = write_(record);
      } catch (...) {
      }
      if (!written) {
        std::lock_guard lock(mutex_);
        write_failed_ = true;
        records_.clear();
        closed_ = true;
        break;
      }
    }
    {
      std::lock_guard lock(mutex_);
      finished_ = true;
    }
    finished_changed_.notify_all();
  }

  Write write_;
  Cancel cancel_;
  const std::size_t capacity_;
  const std::size_t control_reserve_;
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  mutable std::condition_variable finished_changed_;
  std::deque<std::string> records_;
  std::size_t frame_drops_ = 0;
  std::size_t control_saturations_ = 0;
  bool closed_ = false;
  bool finished_ = false;
  bool write_failed_ = false;
  std::thread worker_;
};

}  // namespace syrnike::desktop_native::tests
