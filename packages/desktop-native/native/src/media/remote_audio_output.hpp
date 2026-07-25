#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <stop_token>
#include <thread>
#include <unordered_map>
#include <vector>

#include "../common/async_cleanup_dispatcher.hpp"
#include "audio_failure.hpp"

namespace livekit { class Track; }

namespace syrnike::desktop_native::media {

constexpr std::chrono::milliseconds remoteAudioRenderBufferDuration() noexcept {
  return std::chrono::milliseconds(50);
}

constexpr std::uint16_t remoteAudioRenderChannels() noexcept { return 2; }

constexpr std::chrono::milliseconds remoteAudioPlayoutStartDuration() noexcept {
  return std::chrono::milliseconds(20);
}

constexpr std::chrono::milliseconds remoteAudioMaxQueuedDuration() noexcept {
  return std::chrono::milliseconds(200);
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

enum class AudioOutputDeviceIntent {
  UserConfiguration,
  EndpointRecovery,
};

bool retainAudioOutputEndpointRetry(
  AudioOutputDeviceIntent intent,
  AudioFailureKind failure
) noexcept;

void startAudioOutputWithRollback(
  const std::function<void()>& start_candidate,
  const std::function<void()>& restore_previous,
  const std::function<void()>& start_previous
);

// Owns all receive-side AudioStreams and the single WASAPI mix renderer.
class RemoteAudioOutput final {
 public:
  using FailureHandler = std::function<void(
    AudioFailureInfo,
    std::string,
    std::uint64_t
  )>;
  // Called when the aggregate set of remote microphone speakers changes.
  // The callback receives normalized participant identities and is never
  // invoked while RemoteAudioOutput's internal mutex is held.
  using SpeakingActivityHandler = std::function<void(std::vector<std::string>)>;
  using WorkerTask = std::function<void(std::stop_token)>;
  using WorkerFactory = std::function<std::jthread(WorkerTask)>;

  explicit RemoteAudioOutput(
    FailureHandler on_failure = {},
    SpeakingActivityHandler on_speaking_activity = {},
    WorkerFactory worker_factory = {},
    AsyncCleanupLauncher cleanup_launcher = {}
  );
  ~RemoteAudioOutput();
  RemoteAudioOutput(const RemoteAudioOutput&) = delete;
  RemoteAudioOutput& operator=(const RemoteAudioOutput&) = delete;

  void addTrack(std::string track_sid, std::string participant_identity, bool stream,
                std::shared_ptr<livekit::Track> track);
  void removeTrack(const std::string& track_sid);
  void setDeafened(bool deafened);
  std::uint64_t setOutputDevice(
    std::string device_id,
    AudioOutputDeviceIntent intent
  );
  std::string outputDeviceId() const;
  bool isRendererEpochCurrent(std::uint64_t epoch) const;
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
