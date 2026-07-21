#pragma once

#include <cstdint>
#include <exception>
#include <functional>
#include <mutex>
#include <string>
#include <utility>

namespace syrnike::desktop_native::media {

class LifetimeSafeFrameRelease final {
 public:
  using Handler = std::function<void(const std::string&, std::uint64_t)>;

  explicit LifetimeSafeFrameRelease(Handler handler)
    : handler_(std::move(handler)) {}

  void release(const std::string& track_id, std::uint64_t sequence) noexcept {
    std::lock_guard lock(mutex_);
    if (!handler_) return;
    try {
      handler_(track_id, sequence);
    } catch (...) {
      std::terminate();
    }
  }

  void detach() noexcept {
    std::lock_guard lock(mutex_);
    handler_ = {};
  }

 private:
  std::mutex mutex_;
  Handler handler_;
};

}  // namespace syrnike::desktop_native::media
