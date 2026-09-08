#pragma once

#include "screen/screen_owner.hpp"

namespace syrnike::windows_media::sources {
inline constexpr std::uint32_t kThumbnailWidth = 320, kThumbnailHeight = 180;
inline constexpr std::size_t kThumbnailBytes = kThumbnailWidth * kThumbnailHeight * 4;
inline constexpr auto kThumbnailDeadline = std::chrono::seconds(2);

enum class ThumbnailState { cancelled, pending, ready, failed };
struct ThumbnailSnapshot {
  std::uint64_t revision = 0;
  ThumbnailState state = ThumbnailState::cancelled;
  std::string code;
  std::shared_ptr<const std::vector<std::uint8_t>> pixels;
};
struct ThumbnailStats {
  std::uint64_t admitted = 0, ready = 0, cancelled = 0, failed = 0;
  std::uint32_t active = 0, peak_active = 0;
};

// One worker, one replaceable request and one bounded result. N-API only copies
// this cache; capture, conversion, readback and teardown stay on the worker.
class ThumbnailOwner final {
 public:
  ThumbnailOwner(screen::ScreenOwner&, capture::ThumbnailAdmission&);
  ~ThumbnailOwner();
  ThumbnailSnapshot query(std::uint64_t revision, std::optional<std::string> source_id);
  ThumbnailStats stats() const;
  void beginStop();
  void stop();
 private:
  struct Request {
    std::uint64_t revision = 0;
    std::optional<std::string> source_id;
    std::chrono::steady_clock::time_point deadline;
  };
  bool current(const Request&) const;
  ThumbnailSnapshot capture(const Request&);
  void run() noexcept;
  screen::ScreenOwner& sources_;
  capture::ThumbnailAdmission& admission_;
  mutable std::mutex mutex_;
  std::mutex join_mutex_;
  std::condition_variable changed_;
  Request request_;
  ThumbnailSnapshot snapshot_;
  ThumbnailStats stats_;
  bool stopping_ = false, done_ = false;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::sources
