#pragma once

#include <chrono>
#include <cstddef>
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

constexpr std::size_t remoteAudioSampleRate() noexcept { return 48'000; }

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

constexpr std::chrono::milliseconds remoteAudioTargetQueuedDuration() noexcept {
  return std::chrono::milliseconds(60);
}

constexpr std::chrono::milliseconds
remoteAudioEmergencyQueuedDuration() noexcept {
  return std::chrono::milliseconds(120);
}

// Consume slightly more source samples than WASAPI requests when independent
// producer and device clocks drift apart. The caller resamples this bounded
// input window into output_frames, preventing slow queue growth without an
// audible hard drop and without allowing latency to grow to the 200 ms cap.
constexpr std::size_t remoteAudioInputFramesForRender(
    std::size_t output_frames,
    std::size_t queued_frames) noexcept {
  if (output_frames == 0 || queued_frames <= output_frames) {
    return queued_frames;
  }
  constexpr auto target_frames =
      remoteAudioSampleRate() * remoteAudioTargetQueuedDuration().count() /
      1'000;
  if (queued_frames <= target_frames) return output_frames;
  constexpr auto emergency_frames =
      remoteAudioSampleRate() * remoteAudioEmergencyQueuedDuration().count() /
      1'000;
  const auto proportional_extra = queued_frames >= emergency_frames
      ? output_frames / 20
      : output_frames / 50;
  const auto maximum_extra = proportional_extra == 0 ? 1 : proportional_extra;
  const auto excess = queued_frames - target_frames;
  const auto extra = excess < maximum_extra ? excess : maximum_extra;
  const auto requested = output_frames + extra;
  return requested < queued_frames ? requested : queued_frames;
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
