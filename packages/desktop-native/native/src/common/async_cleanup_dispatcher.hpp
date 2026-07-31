#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>

namespace syrnike::desktop_native {

using AsyncCleanupTask = std::function<void()>;
using AsyncCleanupLauncher =
  std::function<std::thread(AsyncCleanupTask)>;
using AsyncCleanupEnqueueProbe = std::function<void()>;

class AsyncCleanupNode final
  : public std::enable_shared_from_this<AsyncCleanupNode> {
 public:
  using OwnerTask = void (*)(void*);
  using CompletionTask = void (*)(void*);

  explicit AsyncCleanupNode(AsyncCleanupLauncher launcher = {})
    : launcher_(std::move(launcher)) {}

  void prepare(
    std::shared_ptr<void> owner,
    OwnerTask task
  ) noexcept {
    auto* context = owner.get();
    prepare(std::move(owner), context, task);
  }

  void prepare(
    std::shared_ptr<void> owner,
    void* context,
    OwnerTask task,
    CompletionTask completion_task = nullptr
  ) noexcept {
    owner_ = std::move(owner);
    context_ = context;
    owner_task_ = task;
    completion_task_ = completion_task;
    claimed_.store(false);
    finished_.store(false);
  }

  void prepareRaw(void* context, OwnerTask task) noexcept {
    owner_.reset();
    context_ = context;
    owner_task_ = task;
    completion_task_ = nullptr;
    claimed_.store(false);
    finished_.store(false);
  }

  [[nodiscard]] bool finished() const noexcept {
    return finished_.load(std::memory_order_acquire);
  }

 private:
  std::thread launch() {
    auto self = shared_from_this();
    if (!launcher_) {
      return std::thread([self] { self->run(); });
    }
    return launcher_([self] { self->run(); });
  }

  void run() noexcept {
    if (claimed_.exchange(true)) return;
    try {
      if (owner_task_) owner_task_(context_);
    } catch (...) {
    }
    try {
      if (completion_task_) completion_task_(context_);
    } catch (...) {
    }
    owner_.reset();
    context_ = nullptr;
    owner_task_ = nullptr;
    completion_task_ = nullptr;
    finished_.store(true, std::memory_order_release);
  }

  std::atomic_bool claimed_{false};
  std::atomic_bool finished_{false};
  AsyncCleanupLauncher launcher_;
  std::shared_ptr<void> owner_;
  void* context_ = nullptr;
  OwnerTask owner_task_ = nullptr;
  CompletionTask completion_task_ = nullptr;
  std::shared_ptr<AsyncCleanupNode> next_;

  friend class AsyncCleanupDispatcher;
};

// Callers create AsyncCleanupNode before acquiring the resource that may need
// cleanup. Submission and ready/overflow promotion only relink shared owners,
// so cleanup ownership cannot be lost to allocation failure.
class AsyncCleanupDispatcher final {
 public:
  static AsyncCleanupDispatcher& instance() {
    static auto* dispatcher = [] {
      auto* value = new AsyncCleanupDispatcher();
      value->start();
      return value;
    }();
    return *dispatcher;
  }

  void submit(
    std::shared_ptr<AsyncCleanupNode> node,
    const AsyncCleanupEnqueueProbe& enqueue_probe = {}
  ) noexcept {
    if (!node) return;
    if (enqueue_probe) {
      try {
        enqueue_probe();
      } catch (...) {
        std::this_thread::sleep_for(kRetryBackoff);
        try {
          enqueue_probe();
        } catch (...) {
        }
      }
    }
    {
      std::lock_guard lock(mutex_);
      if (ready_.size() < kReadyCapacity) {
        ready_.push(std::move(node));
      } else {
        overflow_.push(std::move(node));
      }
    }
    changed_.notify_one();
  }

 private:
  class IntrusiveQueue final {
   public:
    [[nodiscard]] bool empty() const noexcept { return !head_; }
    [[nodiscard]] std::size_t size() const noexcept { return size_; }

    [[nodiscard]] std::shared_ptr<AsyncCleanupNode> front() const noexcept {
      return head_;
    }

    void push(std::shared_ptr<AsyncCleanupNode> node) noexcept {
      node->next_.reset();
      if (tail_) {
        tail_->next_ = node;
      } else {
        head_ = node;
      }
      tail_ = node.get();
      ++size_;
    }

    [[nodiscard]] std::shared_ptr<AsyncCleanupNode> pop() noexcept {
      auto node = std::move(head_);
      if (!node) return {};
      head_ = std::move(node->next_);
      node->next_.reset();
      --size_;
      if (!head_) tail_ = nullptr;
      return node;
    }

   private:
    std::shared_ptr<AsyncCleanupNode> head_;
    AsyncCleanupNode* tail_ = nullptr;
    std::size_t size_ = 0;
  };

  AsyncCleanupDispatcher() = default;

  void start() {
    try {
      std::thread([this] { runManagement(); }).detach();
    } catch (...) {
      throw std::runtime_error("native cleanup dispatcher could not start");
    }
  }

  void runManagement() noexcept {
    while (true) {
      std::shared_ptr<AsyncCleanupNode> node;
      {
        std::unique_lock lock(mutex_);
        changed_.wait(lock, [&] {
          return !ready_.empty() || !overflow_.empty();
        });
        while (
          ready_.size() < kReadyCapacity &&
          !overflow_.empty()
        ) {
          ready_.push(overflow_.pop());
        }
        node = ready_.front();
      }
      try {
        auto worker = node->launch();
        worker.detach();
        std::lock_guard lock(mutex_);
        if (!ready_.empty() && ready_.front() == node) {
          static_cast<void>(ready_.pop());
        }
      } catch (...) {
        std::this_thread::sleep_for(kRetryBackoff);
      }
    }
  }

  static constexpr std::size_t kReadyCapacity = 8;
  static constexpr auto kRetryBackoff = std::chrono::milliseconds(25);
  std::mutex mutex_;
  std::condition_variable changed_;
  IntrusiveQueue ready_;
  IntrusiveQueue overflow_;
};

inline AsyncCleanupLauncher failFirstAsyncCleanupLauncher(bool enabled) {
  if (!enabled) return {};
  auto failed = std::make_shared<std::atomic_bool>(false);
  return [failed](AsyncCleanupTask task) -> std::thread {
    if (!failed->exchange(true)) {
      throw std::runtime_error("injected async cleanup launch failure");
    }
    return std::thread(std::move(task));
  };
}

}  // namespace syrnike::desktop_native
