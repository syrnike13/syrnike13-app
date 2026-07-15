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
#include <unordered_set>

#include <livekit/track.h>

#include "../common/runtime_types.hpp"

namespace syrnike::desktop_native::media {

inline constexpr auto kRemoteVideoFirstFrameTimeout = std::chrono::seconds(5);

std::string remoteVideoSourceLabel(
  std::optional<livekit::TrackSource> publication_source,
  std::optional<livekit::TrackSource> track_source
);

class RemoteVideoBridge {
 public:
  using Post = std::function<bool(MediaCommand)>;
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
    OnHealthy on_healthy = {}
  );
  ~RemoteVideoBridge();

  RemoteVideoBridge(const RemoteVideoBridge&) = delete;
  RemoteVideoBridge& operator=(const RemoteVideoBridge&) = delete;

  void updateIdentity(std::string session_id, std::uint64_t generation);
  void addTrack(
    std::shared_ptr<livekit::Track> track,
    std::string participant_identity,
    std::optional<livekit::TrackSource> publication_source
  );
  void removeTrack(const std::string& track_id, bool notify = true);
  void removeTrackIfCurrent(
    const std::string& track_id,
    const std::shared_ptr<livekit::Track>& expected_track,
    bool notify = true
  );
  void release(const std::string& track_id, std::uint64_t sequence);
  void stop();

 private:
  struct TrackWorker;
  void removeTrackLocked(
    const std::string& track_id,
    const std::shared_ptr<livekit::Track>& expected_track,
    bool notify
  );
  std::uint32_t electron_main_pid_;
  Post post_;
  OnEnded on_ended_;
  OnHealthy on_healthy_;
  std::mutex lifecycle_mutex_;
  std::mutex mutex_;
  std::string session_id_;
  std::uint64_t generation_ = 0;
  std::uint64_t next_frame_sequence_ = 0;
  std::unordered_map<std::string, std::unique_ptr<TrackWorker>> tracks_;
#ifdef _WIN32
  std::unordered_map<std::uint64_t, std::shared_ptr<void>> retired_frames_;
  std::unordered_set<std::uint64_t> released_frame_sequences_;
#endif
};

}  // namespace syrnike::desktop_native::media
