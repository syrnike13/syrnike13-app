#pragma once

#include <chrono>
#include <condition_variable>
#include <mutex>

namespace syrnike::desktop_native::media {

// A worker may start before its owning actor has published the corresponding
// state. This one-shot gate blocks without spinning and has both cancellation
// and a deadline so teardown cannot strand a pre-commit worker.
class VoiceAttemptCommit final {
 public:
  void commit() noexcept {
    {
      std::lock_guard lock(mutex_);
      committed_ = true;
    }
    changed_.notify_all();
  }

  void cancel() noexcept {
    {
      std::lock_guard lock(mutex_);
      cancelled_ = true;
    }
    changed_.notify_all();
  }

  bool waitFor(std::chrono::milliseconds timeout) noexcept {
    std::unique_lock lock(mutex_);
    static_cast<void>(changed_.wait_for(lock, timeout, [&] {
      return committed_ || cancelled_;
    }));
    return committed_ && !cancelled_;
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  bool committed_ = false;
  bool cancelled_ = false;
};

}  // namespace syrnike::desktop_native::media
