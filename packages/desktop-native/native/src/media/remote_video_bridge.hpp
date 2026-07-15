#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>

#include <livekit/track.h>

#include "../common/runtime_types.hpp"

namespace syrnike::desktop_native::media {

std::string remoteVideoSourceLabel(
  std::optional<livekit::TrackSource> publication_source,
  std::optional<livekit::TrackSource> track_source
);

class RemoteVideoBridge {
 public:
  using Post = std::function<bool(MediaCommand)>;

  RemoteVideoBridge(std::uint32_t electron_main_pid, Post post);
  ~RemoteVideoBridge();

  RemoteVideoBridge(const RemoteVideoBridge&) = delete;
  RemoteVideoBridge& operator=(const RemoteVideoBridge&) = delete;

  void updateIdentity(std::string session_id, std::uint64_t generation);
  void addTrack(
    std::shared_ptr<livekit::Track> track,
    std::string participant_identity,
    std::optional<livekit::TrackSource> publication_source
  );
  void removeTrack(const std::string& track_id);
  void release(const std::string& track_id, std::uint64_t sequence);
  void stop();

 private:
  struct TrackWorker;
  std::uint32_t electron_main_pid_;
  Post post_;
  std::mutex mutex_;
  std::string session_id_;
  std::uint64_t generation_ = 0;
  std::unordered_map<std::string, std::unique_ptr<TrackWorker>> tracks_;
};

}  // namespace syrnike::desktop_native::media
