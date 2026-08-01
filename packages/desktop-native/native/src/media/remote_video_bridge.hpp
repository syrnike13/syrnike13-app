#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>

#include <livekit/track.h>
#include <livekit/video_stream.h>

#include "../common/async_cleanup_dispatcher.hpp"
#include "../common/runtime_types.hpp"
#include "../common/bounded_release_ledger.hpp"
#include "lifetime_safe_frame_release.hpp"

namespace syrnike::desktop_native::media {

inline constexpr auto kRemoteVideoFirstFrameTimeout = std::chrono::seconds(5);

enum class FirstFrameState : std::uint8_t { Pending, Received, TimedOut };

inline bool claimFirstFrame(std::atomic<FirstFrameState>& state) noexcept {
  auto expected = FirstFrameState::Pending;
  return state.compare_exchange_strong(expected, FirstFrameState::Received) ||
    expected == FirstFrameState::Received;
}

inline bool claimFirstFrameTimeout(std::atomic<FirstFrameState>& state) noexcept {
  auto expected = FirstFrameState::Pending;
  return state.compare_exchange_strong(expected, FirstFrameState::TimedOut);
}

std::string remoteVideoSourceLabel(
  std::optional<livekit::TrackSource> publication_source,
  std::optional<livekit::TrackSource> track_source
);

struct VideoBridgeEventTypes {
  std::string frame = "__remoteVideoFrame";
  std::string track_removed = "__remoteVideoTrackRemoved";
  std::string failed = "__remoteVideoFailed";
  std::string stream_label = "Remote video";
};

class RemoteVideoBridge {
 public:
  class StreamReader {
   public:
    virtual ~StreamReader() = default;
    virtual bool read(livekit::VideoFrameEvent& event) = 0;
    virtual void close() = 0;
  };

  using Post = std::function<bool(MediaCommand)>;
  using StreamFactory = std::function<std::shared_ptr<StreamReader>(
    const std::shared_ptr<livekit::Track>&
  )>;
  using OnEnded = std::function<void(
    const std::string&,
    const std::shared_ptr<livekit::Track>&,
    const std::string&
  )>;
  using OnHealthy = std::function<void(
    const std::string&,
    const std::shared_ptr<livekit::Track>&
  )>;

  RemoteVideoBridge(
    std::uint32_t electron_main_pid,
    Post post,
    OnEnded on_ended = {},
    OnHealthy on_healthy = {},
    VideoBridgeEventTypes event_types = {},
    StreamFactory stream_factory = {},
    AsyncCleanupLauncher cleanup_launcher = {}
  );
  ~RemoteVideoBridge();

  RemoteVideoBridge(const RemoteVideoBridge&) = delete;
  RemoteVideoBridge& operator=(const RemoteVideoBridge&) = delete;

  void updateIdentity(std::string session_id, std::uint64_t generation);
  void addTrack(
    std::shared_ptr<livekit::Track> track,
    std::string participant_identity,
    std::optional<livekit::TrackSource> publication_source,
    std::string track_id = {}
  );
  void removeTrack(const std::string& track_id, bool notify = true);
  void removeTrackIfCurrent(
    const std::string& track_id,
    const std::shared_ptr<livekit::Track>& expected_track,
    bool notify = true
  );
  void release(const std::string& track_id, std::uint64_t sequence);
  void stop();
  void stop(std::shared_ptr<void> lifetime_owner);

 private:
  struct TrackWorker;
  void removeTrackLocked(
    const std::string& track_id,
    const std::shared_ptr<livekit::Track>& expected_track,
    bool notify
  );
  AsyncCleanupDispatcher* cleanup_dispatcher_;
  std::shared_ptr<AsyncCleanupNode> cleanup_node_;
  std::atomic_bool cleanup_submitted_{false};
  std::uint32_t electron_main_pid_;
  Post post_;
  OnEnded on_ended_;
  OnHealthy on_healthy_;
  VideoBridgeEventTypes event_types_;
  StreamFactory stream_factory_;
  std::shared_ptr<LifetimeSafeFrameRelease> release_router_;
  std::mutex lifecycle_mutex_;
  std::mutex mutex_;
  std::string session_id_;
  std::uint64_t generation_ = 0;
  std::uint64_t next_frame_sequence_ = 0;
  std::unordered_map<std::string, std::unique_ptr<TrackWorker>> tracks_;
#ifdef _WIN32
  struct RetiredFrame {
    std::string track_id;
    std::shared_ptr<void> resource;
    std::chrono::steady_clock::time_point retired_at;
  };
  void makeRetiredFrameRoomLocked(
    std::chrono::steady_clock::time_point now
  );
  static constexpr std::size_t max_retired_renderer_frames_ = 64;
  static constexpr auto retired_renderer_frame_ttl_ =
    std::chrono::seconds(30);
  std::unordered_map<std::uint64_t, RetiredFrame> retired_frames_;
  BoundedReleaseLedger released_frame_sequences_;
#endif
};

}  // namespace syrnike::desktop_native::media
