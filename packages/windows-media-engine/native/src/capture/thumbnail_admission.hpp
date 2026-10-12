#pragma once

#include <atomic>

namespace syrnike::windows_media::capture {
// One-shot thumbnails may use the otherwise idle capture reservation. Camera
// and screen intent take priority and wait for the one admitted job to drain.
// No GPU reservation is enlarged to serve the optional picker.
class ThumbnailAdmission final {
 public:
  void requestPublication() noexcept { state_.fetch_or(kPublication); }
  void publicationDrained() noexcept { state_.fetch_and(~kPublication); }
  bool publicationRequested() const noexcept { return (state_.load() & kPublication) != 0; }
  bool thumbnailActive() const noexcept { return (state_.load() & kThumbnail) != 0; }
  bool acquireThumbnail() noexcept {
    unsigned expected = 0;
    return state_.compare_exchange_strong(expected, kThumbnail);
  }
  void releaseThumbnail() noexcept { state_.fetch_and(~kThumbnail); }
 private:
  static constexpr unsigned kPublication = 1, kThumbnail = 2;
  std::atomic_uint state_{0};
};
}  // namespace syrnike::windows_media::capture
