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

#include "../common/cleanup_supervisor.hpp"
#include "../common/runtime_types.hpp"
#include "lifetime_safe_frame_release.hpp"
#include "remote_video_texture_pool.hpp"

namespace syrnike::desktop_native::media {

class VideoResourceAdmissionBudget;

inline constexpr auto kRemoteVideoFirstFrameTimeout = std::chrono::seconds(5);

enum class FirstFrameState : std::uint8_t { Pending, Received, TimedOut };

enum class RemoteVideoRendererFlowState : std::uint8_t {
  Flowing,
  FenceBlocked,
  Retiring,
};

struct RemoteVideoTrackSnapshot {
  RemoteVideoRendererFlowState renderer_flow =
      RemoteVideoRendererFlowState::Flowing;
  bool gpu_pump_quiescent = false;
  std::uint64_t frames_read = 0;
  std::uint64_t frames_submitted = 0;
  std::uint64_t frames_published = 0;
  std::uint64_t gpu_pool_rollovers = 0;
  std::uint64_t gpu_pump_wakeups = 0;
  std::uint64_t stream_generations = 0;
};

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
  NativeCommandType frame = NativeCommandType::RemoteVideoFrame;
  NativeCommandType track_removed = NativeCommandType::RemoteVideoTrackRemoved;
  NativeCommandType failed = NativeCommandType::RemoteVideoFailed;
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
    CleanupStartProbe cleanup_start_probe = {},
    VideoResourceAdmissionBudget* resource_budget = nullptr,
    RemoteVideoTextureCompletionPollControl completion_poll_control = {}
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
  [[nodiscard]] std::optional<RemoteVideoTrackSnapshot> trackSnapshot(
    const std::string& track_id
  ) const;
  void stop();
  void stop(std::shared_ptr<void> lifetime_owner);

 private:
  struct TrackRetirementState;
  struct TrackWorker;
  void removeTrackLocked(
    const std::string& track_id,
    const std::shared_ptr<livekit::Track>& expected_track,
    bool notify
  );
  void submitTrackRetirement(
    const std::shared_ptr<TrackWorker>& worker
  ) noexcept;
  void finishTrackRetirement(TrackWorker& worker) noexcept;
  static void completeTrackRetirement(TrackWorker& worker) noexcept;
  void waitForTrackRetirements();
  void stageTracksForCleanup() noexcept;
  void finishStagedCleanup() noexcept;
  CleanupSupervisor* cleanup_supervisor_;
  CleanupStartProbe cleanup_start_probe_;
  std::shared_ptr<CleanupJob> cleanup_job_;
  std::atomic_bool cleanup_submitted_{false};
  std::uint32_t electron_main_pid_;
  Post post_;
  OnEnded on_ended_;
  OnHealthy on_healthy_;
  VideoBridgeEventTypes event_types_;
  StreamFactory stream_factory_;
  VideoResourceAdmissionBudget* resource_budget_ = nullptr;
  RemoteVideoTextureCompletionPollControl completion_poll_control_;
  std::shared_ptr<LifetimeSafeFrameRelease> release_router_;
  std::mutex lifecycle_mutex_;
  std::shared_ptr<TrackRetirementState> retirement_state_;
  mutable std::mutex mutex_;
  std::string session_id_;
  std::uint64_t generation_ = 0;
  std::unordered_map<std::string, std::shared_ptr<TrackWorker>> tracks_;
  std::unordered_map<std::string, std::shared_ptr<TrackWorker>>
    staged_cleanup_tracks_;
};

}  // namespace syrnike::desktop_native::media
