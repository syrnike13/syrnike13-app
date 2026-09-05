#pragma once
#include "audio/process_loopback.hpp"
#include <functional>

namespace syrnike::windows_media::audio {
struct ScreenAudioIntent {
  ScreenAudioMode mode;
  std::shared_ptr<AudioProcessIdentity> target;
};
struct ScreenAudioSessionStats {
  std::uint64_t generation = 0, captured = 0, submitted = 0, maximum_submit_age_us = 0;
  std::uint32_t clients = 0, threads = 0;
  std::size_t queue_depth = 0;
  std::size_t maximum_queue_depth = 0;
  std::uint64_t superseded_packets = 0, stale_packets = 0;
};
struct ScreenAudioOwnerStats {
  ScreenAudioState state = ScreenAudioState::idle;
  std::uint64_t desired_revision = 0, active_revision = 0;
  std::optional<ScreenAudioFailure> failure;
  ScreenAudioSessionStats session;
};
// The session port has no video or Room teardown operation. A failed session
// can only release its own capture/source/publication resources.
class ScreenAudioSession {
 public:
  virtual ~ScreenAudioSession() = default;
  virtual std::optional<ScreenAudioFailure> start(const ScreenAudioIntent&) = 0;
  virtual bool stop(std::chrono::steady_clock::time_point deadline) noexcept = 0;
  virtual std::optional<ScreenAudioFailure> failure() const noexcept = 0;
  virtual ScreenAudioSessionStats stats() const noexcept = 0;
};
class ScreenAudioOwner final {
 public:
  using Factory = std::function<std::unique_ptr<ScreenAudioSession>()>;
  explicit ScreenAudioOwner(Factory);
  ~ScreenAudioOwner();
  // Null intent is audio=off. Retrying a failure requires a newer explicit
  // revision; there is no autonomous audio recovery loop.
  bool applyDesired(std::uint64_t revision, std::optional<ScreenAudioIntent>);
  ScreenAudioOwnerStats stats() const noexcept;
  bool stop(std::chrono::steady_clock::time_point deadline) noexcept;

 private:
  void run() noexcept;
  Factory factory_;
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::optional<ScreenAudioIntent> desired_;
  ScreenAudioOwnerStats stats_;
  bool stopping_ = false, done_ = false;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::audio
