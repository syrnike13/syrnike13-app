#pragma once

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <memory>
#include <mutex>
#include <utility>
#include <vector>

#include "event_sink.hpp"

namespace syrnike::desktop_native {

// A bounded, non-lossy staging lane in front of Node's TSFN. Only one JS
// callback is scheduled at a time, so the TSFN queue cannot become the
// backpressure boundary. Producers wait for a bounded interval when the
// staging lane is full; shutdown wakes them and transfers no ownership.
class ControlEventLane final {
 public:
  static constexpr std::size_t kCapacity = 2'048;
  static constexpr auto kProducerWait = std::chrono::seconds(10);

  struct PushResult {
    bool accepted = false;
    bool schedule_callback = false;
    bool timed_out = false;
    std::unique_ptr<RuntimeEvent> rejected;
  };

  explicit ControlEventLane(
    std::size_t capacity = kCapacity,
    std::chrono::milliseconds producer_wait =
      std::chrono::duration_cast<std::chrono::milliseconds>(kProducerWait)
  ) : capacity_(capacity), producer_wait_(producer_wait) {}

  PushResult push(RuntimeEvent event) {
    RuntimeEventResourceGuard resource(event);
    resource.attach(event);
    auto payload = std::make_unique<RuntimeEvent>(std::move(event));
    std::unique_lock lock(mutex_);
    const bool ready = space_available_.wait_for(lock, producer_wait_, [&] {
      return closed_ || pending_.size() < capacity_;
    });
    if (!ready || closed_) {
      resource.transfer();
      return PushResult{false, false, !ready, std::move(payload)};
    }
    pending_.push_back(std::move(payload));
    const bool schedule = !callback_scheduled_;
    callback_scheduled_ = true;
    resource.transfer();
    return PushResult{true, schedule, false, {}};
  }

  std::vector<std::unique_ptr<RuntimeEvent>> beginCallback() noexcept {
    std::vector<std::unique_ptr<RuntimeEvent>> events;
    std::deque<std::unique_ptr<RuntimeEvent>> allocation_failure;
    {
      std::lock_guard lock(mutex_);
      if (!callback_scheduled_) return events;
      callback_scheduled_ = false;
      try {
        events.reserve(pending_.size());
      } catch (...) {
        allocation_failure.swap(pending_);
      }
      if (allocation_failure.empty()) {
        while (!pending_.empty()) {
          events.push_back(std::move(pending_.front()));
          pending_.pop_front();
        }
      }
    }
    space_available_.notify_all();
    for (auto& event : allocation_failure) {
      if (event) discardEvent(*event);
    }
    return events;
  }

  void cancelScheduledCallbackAndDiscard() noexcept {
    discardPending(false);
  }

  void rejectScheduledCallbackAndDiscard(
    std::uint64_t rejected_sequence
  ) noexcept {
    std::deque<std::unique_ptr<RuntimeEvent>> discarded;
    {
      std::lock_guard lock(mutex_);
      callback_scheduled_ = false;
      discarded.swap(pending_);
    }
    space_available_.notify_all();
    for (auto& event : discarded) {
      if (!event) continue;
      if (event->sequence == rejected_sequence) {
        // The caller returns false to SequencedEmitter, whose fallback guard
        // remains the sole owner of this event's release.
        event->on_drop = {};
      } else {
        discardEvent(*event);
      }
    }
  }

  void closeAndDiscard() noexcept {
    discardPending(true);
  }

  // Marks the lane closed and wakes bounded producers without touching
  // accepted events. This lets a sink wait for the in-flight emit to settle
  // release ownership before shutdown discards the queue.
  void requestClose() noexcept {
    {
      std::lock_guard lock(mutex_);
      closed_ = true;
    }
    space_available_.notify_all();
  }

  [[nodiscard]] std::size_t size() const {
    std::lock_guard lock(mutex_);
    return pending_.size();
  }

  [[nodiscard]] bool closed() const {
    std::lock_guard lock(mutex_);
    return closed_;
  }

 private:
  void discardPending(bool close) noexcept {
    std::deque<std::unique_ptr<RuntimeEvent>> discarded;
    {
      std::lock_guard lock(mutex_);
      if (close) closed_ = true;
      callback_scheduled_ = false;
      discarded.swap(pending_);
    }
    space_available_.notify_all();
    for (auto& event : discarded) {
      if (event) discardEvent(*event);
    }
  }

  mutable std::mutex mutex_;
  std::condition_variable space_available_;
  std::deque<std::unique_ptr<RuntimeEvent>> pending_;
  std::size_t capacity_;
  std::chrono::milliseconds producer_wait_;
  bool callback_scheduled_ = false;
  bool closed_ = false;
};

}  // namespace syrnike::desktop_native
