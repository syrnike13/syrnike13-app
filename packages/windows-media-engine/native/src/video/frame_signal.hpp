#pragma once

#include <functional>
#include <mutex>

namespace syrnike::windows_media::video {
// Process-wide wakeup for the frame export lane. Producers call it after a
// frame may have become available; it carries no frame ownership and never
// waits on the consumer. The listener is cleared before its owner is joined.
struct FrameSignal {
  std::mutex mutex;
  std::function<void()> listener;
};
inline FrameSignal& frameSignal() {
  static FrameSignal signal;
  return signal;
}
inline void setFrameAvailableListener(std::function<void()> listener) {
  auto& signal = frameSignal();
  std::lock_guard lock(signal.mutex);
  signal.listener = std::move(listener);
}
inline void signalFrameAvailable() noexcept {
  auto& signal = frameSignal();
  std::lock_guard lock(signal.mutex);
  if (signal.listener) signal.listener();
}
}  // namespace syrnike::windows_media::video
