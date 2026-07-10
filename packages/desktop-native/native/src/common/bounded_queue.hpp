#pragma once

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

  std::optional<Item> waitPop() {
    std::unique_lock lock(mutex_);
    ready_.wait(lock, [&] { return closed_ || !items_.empty(); });
    if (items_.empty()) return std::nullopt;
    Item item = std::move(items_.front());
    items_.pop_front();
    return item;
  }

  void close() {
    {
      std::lock_guard lock(mutex_);
      closed_ = true;
    }
    ready_.notify_all();
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
  std::deque<Item> items_;
  bool closed_ = false;
};

}  // namespace syrnike::desktop_native
