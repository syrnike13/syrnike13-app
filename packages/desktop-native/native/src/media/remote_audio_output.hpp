#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "../common/async_cleanup_dispatcher.hpp"
#include "audio_failure.hpp"

namespace livekit { class Track; }

namespace syrnike::desktop_native::media {

struct AudioEndpointChange;

constexpr std::size_t remoteAudioSampleRate() noexcept { return 48'000; }

constexpr std::chrono::milliseconds remoteAudioRenderBufferDuration() noexcept {
  return std::chrono::milliseconds(50);
}

constexpr std::uint16_t remoteAudioRenderChannels() noexcept { return 2; }

constexpr std::chrono::milliseconds remoteAudioPlayoutStartDuration() noexcept {
  return std::chrono::milliseconds(20);
}

struct RemoteAudioSettings {
  std::uint64_t revision = 0;
  std::unordered_map<std::string, float> user_volumes;
  std::unordered_map<std::string, bool> user_mutes;
  std::unordered_map<std::string, float> stream_volumes;
  std::unordered_map<std::string, bool> stream_mutes;
};

std::string normalizeRemoteAudioIdentity(std::string_view identity);
float resolveRemoteAudioGain(
  const RemoteAudioSettings& settings,
  std::string_view participant_identity,
  bool stream_source
);
float remoteAudioLimiterTargetGain(float peak) noexcept;

enum class RemoteAudioOutputPhase {
  Stopped,
  // Internal renderer transition; StateHandler publishes stable phases only.
  Starting,
  Running,
  Recovering,
  Failed,
};

struct RemoteAudioOutputState {
  RemoteAudioOutputPhase phase = RemoteAudioOutputPhase::Stopped;
  std::string desired_device_id = "default";
  std::string active_device_id;
  std::string resolved_endpoint_id;
  std::uint64_t renderer_epoch = 0;
  bool using_fallback = false;
  std::optional<AudioFailureInfo> failure;
  std::string detail;
};

void startAudioOutputWithRollback(
  const std::function<void()>& start_candidate,
  const std::function<void()>& restore_previous,
  const std::function<void()>& start_previous
);
bool remoteAudioEndpointChangeCanRearmRecovery(
  const AudioEndpointChange& change
) noexcept;

// Owns all direct decoded-audio sinks and the single WASAPI mix renderer.
class RemoteAudioOutput final {
 public:
  using StateHandler = std::function<void(RemoteAudioOutputState)>;
  using TrackFailureHandler = std::function<void(
    AudioFailureInfo,
    std::string,
    std::uint64_t
  )>;
  // Called when the aggregate set of remote microphone speakers changes.
  // The callback receives normalized participant identities and is never
  // invoked while RemoteAudioOutput's internal mutex is held.
  using SpeakingActivityHandler = std::function<void(std::vector<std::string>)>;
  explicit RemoteAudioOutput(
    StateHandler on_state = {},
    TrackFailureHandler on_track_failure = {},
    SpeakingActivityHandler on_speaking_activity = {},
    AsyncCleanupLauncher cleanup_launcher = {}
  );
  ~RemoteAudioOutput();
  RemoteAudioOutput(const RemoteAudioOutput&) = delete;
  RemoteAudioOutput& operator=(const RemoteAudioOutput&) = delete;

  void addTrack(std::string track_sid, std::string participant_identity, bool stream,
                std::shared_ptr<livekit::Track> track);
  void removeTrack(const std::string& track_sid);
  void setDeafened(bool deafened);
  std::uint64_t setOutputDevice(std::string device_id);
  std::string outputDeviceId() const;
  void setVolume(float volume);
  void configure(RemoteAudioSettings settings);
  void stop();
  void stop(std::shared_ptr<void> lifetime_owner);

 private:
  class Implementation;
  AsyncCleanupDispatcher* cleanup_dispatcher_;
  std::shared_ptr<AsyncCleanupNode> cleanup_node_;
  std::atomic_bool cleanup_submitted_{false};
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
