#pragma once

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "event_sink.hpp"

namespace syrnike::desktop_native {

// Keeps at most one pending media event per track identity. The Node adapter
// schedules a single JS callback and drains the newest event for every key;
// replaced events are returned to the caller so native resources can be
// released immediately.
class CoalescingEventLane final {
 public:
  static constexpr std::size_t kCapacity = 64;

  explicit CoalescingEventLane(std::function<void()> before_store = {})
    : CoalescingEventLane(kCapacity, std::move(before_store)) {}

  explicit CoalescingEventLane(
    std::size_t capacity,
    std::function<void()> before_store = {}
  ) : capacity_(std::max<std::size_t>(1, capacity)),
      before_store_(std::move(before_store)) {}

  struct PushResult {
    bool accepted = false;
    bool schedule_callback = false;
    std::unique_ptr<RuntimeEvent> discarded;
    std::uint64_t dropped_count = 0;
  };

  class CallbackBatch final {
   public:
    CallbackBatch() = default;
    CallbackBatch(const CallbackBatch&) = delete;
    CallbackBatch& operator=(const CallbackBatch&) = delete;

    CallbackBatch(CallbackBatch&& other) noexcept
      : owner_(std::exchange(other.owner_, nullptr)),
        events_(std::move(other.events_)),
        deliver_(other.deliver_) {}

    CallbackBatch& operator=(CallbackBatch&& other) noexcept {
      if (this == &other) return *this;
      finish();
      owner_ = std::exchange(other.owner_, nullptr);
      events_ = std::move(other.events_);
      deliver_ = other.deliver_;
      return *this;
    }

    ~CallbackBatch() { finish(); }

    [[nodiscard]] bool active() const noexcept { return owner_ != nullptr; }
    [[nodiscard]] bool deliver() const noexcept { return deliver_; }
    std::vector<std::unique_ptr<RuntimeEvent>>& events() noexcept { return events_; }

   private:
    friend class CoalescingEventLane;

    CallbackBatch(
      CoalescingEventLane* owner,
      std::vector<std::unique_ptr<RuntimeEvent>> events,
      bool deliver
    ) : owner_(owner), events_(std::move(events)), deliver_(deliver) {}

    void finish() noexcept {
      auto* owner = std::exchange(owner_, nullptr);
      if (owner) owner->finishCallback();
    }

    CoalescingEventLane* owner_ = nullptr;
    std::vector<std::unique_ptr<RuntimeEvent>> events_;
    bool deliver_ = false;
  };

  PushResult push(RuntimeEvent event) {
    RuntimeEventResourceGuard resource(event);
    resource.attach(event);
    auto payload = std::make_unique<RuntimeEvent>(std::move(event));
    std::lock_guard lock(mutex_);
    if (closed_) {
      resource.transfer();
      return PushResult{
        false,
        false,
        std::move(payload),
        ++dropped_count_,
      };
    }
    PushResult result;
    result.accepted = true;
    const auto key = eventKey(*payload);
    if (before_store_) before_store_();
    if (auto found = pending_.find(key); found != pending_.end()) {
      result.discarded = std::move(found->second);
      found->second = std::move(payload);
      result.dropped_count = ++dropped_count_;
    } else {
      pending_.emplace(key, std::move(payload));
      if (pending_.size() > capacity_) {
        const auto oldest = std::min_element(
          pending_.begin(),
          pending_.end(),
          [](const auto& left, const auto& right) {
            return left.second->sequence < right.second->sequence;
          }
        );
        result.discarded = std::move(oldest->second);
        pending_.erase(oldest);
        result.dropped_count = ++dropped_count_;
      }
    }
    if (!callback_scheduled_) {
      callback_scheduled_ = true;
      result.schedule_callback = true;
    }
    resource.transfer();
    return result;
  }

  CallbackBatch beginCallback() noexcept {
    std::vector<std::unique_ptr<RuntimeEvent>> events;
    decltype(pending_) allocation_failure;
    bool allocation_failed = false;
    bool deliver = false;
    {
      std::lock_guard lock(mutex_);
      if (!callback_scheduled_) return {};
      try {
        events.reserve(pending_.size());
      } catch (...) {
        allocation_failed = true;
        callback_scheduled_ = false;
        allocation_failure.swap(pending_);
      }
      if (!allocation_failed) {
        callback_scheduled_ = false;
        ++callbacks_in_flight_;
        for (auto& [_, event] : pending_) events.push_back(std::move(event));
        pending_.clear();
        deliver = !closed_;
      }
    }
    if (allocation_failed) {
      for (auto& [_, event] : allocation_failure) {
        if (event) discardEvent(*event);
      }
      return {};
    }
    std::sort(events.begin(), events.end(), [](const auto& left, const auto& right) {
      return left->sequence < right->sequence;
    });
    return CallbackBatch(this, std::move(events), deliver);
  }

  void cancelScheduledCallbackAndDiscard() noexcept {
    discardPending(false);
  }

  void closeAndDiscard() noexcept {
    discardPending(true);
  }

  bool waitForInFlightCallbacks(std::chrono::milliseconds timeout) {
    std::unique_lock lock(mutex_);
    return callbacks_finished_.wait_for(
      lock,
      timeout,
      [&] { return callbacks_in_flight_ == 0; }
    );
  }

  std::uint64_t noteDropped() {
    std::lock_guard lock(mutex_);
    return ++dropped_count_;
  }

 private:
  void discardPending(bool close) noexcept {
    decltype(pending_) discarded;
    {
      std::lock_guard lock(mutex_);
      if (close) closed_ = true;
      callback_scheduled_ = false;
      discarded.swap(pending_);
    }
    for (auto& [_, event] : discarded) {
      if (event) discardEvent(*event);
    }
  }

  void finishCallback() noexcept {
    {
      std::lock_guard lock(mutex_);
      if (callbacks_in_flight_ == 0) return;
      --callbacks_in_flight_;
    }
    callbacks_finished_.notify_all();
  }

  static std::string eventKey(const RuntimeEvent& event) {
    return std::string(nativeEventName(event.type)) + '\n' + event.session_id + '\n' +
      std::to_string(event.generation) + '\n' + event.track_id;
  }

  std::mutex mutex_;
  std::condition_variable callbacks_finished_;
  std::unordered_map<std::string, std::unique_ptr<RuntimeEvent>> pending_;
  bool callback_scheduled_ = false;
  bool closed_ = false;
  std::size_t callbacks_in_flight_ = 0;
  std::uint64_t dropped_count_ = 0;
  std::size_t capacity_;
  std::function<void()> before_store_;
};

}  // namespace syrnike::desktop_native
