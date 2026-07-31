#pragma once

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <mutex>
#include <optional>
#include <utility>

namespace syrnike::desktop_native {

template <typename Item, std::size_t Capacity>
class BoundedQueue {
 public:
  bool tryPush(Item item) {
    {
      std::lock_guard lock(mutex_);
      if (closed_ || items_.size() >= Capacity) return false;
      items_.push_back(std::move(item));
    }
    ready_.notify_one();
    return true;
  }

  template <typename Rep, typename Period>
  bool tryPushFor(
    Item item,
    const std::chrono::duration<Rep, Period>& timeout
  ) {
    {
      std::unique_lock lock(mutex_);
      if (!space_available_.wait_for(lock, timeout, [&] {
            return closed_ || items_.size() < Capacity;
          })) {
        return false;
      }
      if (closed_) return false;
      items_.push_back(std::move(item));
    }
    ready_.notify_one();
    return true;
  }

  std::optional<Item> waitPop() {
    std::unique_lock lock(mutex_);
    ready_.wait(lock, [&] { return closed_ || !items_.empty(); });
    if (items_.empty()) return std::nullopt;
    Item item = std::move(items_.front());
    items_.pop_front();
    space_available_.notify_one();
    return item;
  }

  void close() {
    {
      std::lock_guard lock(mutex_);
      closed_ = true;
    }
    ready_.notify_all();
    space_available_.notify_all();
  }

  std::size_t closeAndDiscard() {
    std::size_t discarded = 0;
    {
      std::lock_guard lock(mutex_);
      closed_ = true;
      discarded = items_.size();
      items_.clear();
    }
    ready_.notify_all();
    space_available_.notify_all();
    return discarded;
  }

  bool closed() const {
    std::lock_guard lock(mutex_);
    return closed_;
  }

  std::size_t size() const {
    std::lock_guard lock(mutex_);
    return items_.size();
  }

 private:
  mutable std::mutex mutex_;
  std::condition_variable ready_;
  std::condition_variable space_available_;
  std::deque<Item> items_;
  bool closed_ = false;
};

}  // namespace syrnike::desktop_native
