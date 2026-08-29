#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include "../common/cleanup_supervisor.hpp"
#include "audio_failure.hpp"
#include "remote_audio_operation_supervisor.hpp"
#include "windows_audio_session_policy.hpp"

namespace livekit { class Track; }

namespace syrnike::desktop_native::media {

namespace detail {

// A renderer attempt owns its own gate and mixer state. Quarantining one
// attempt therefore cannot make a replacement wait on the old attempt's lock.
class RemoteAudioAttemptMixGate final {
 public:
  class Lease final {
   public:
    Lease() noexcept = default;
    Lease(Lease&&) noexcept = default;
    Lease& operator=(Lease&&) noexcept = default;
    Lease(const Lease&) = delete;
    Lease& operator=(const Lease&) = delete;

    explicit operator bool() const noexcept { return lock_.owns_lock(); }

   private:
    friend class RemoteAudioAttemptMixGate;
    explicit Lease(std::unique_lock<std::mutex> lock) noexcept
      : lock_(std::move(lock)) {}
    std::unique_lock<std::mutex> lock_;
  };

  [[nodiscard]] Lease tryAcquire() noexcept {
    std::unique_lock lock(mutex_, std::try_to_lock);
    if (!lock.owns_lock()) return {};
    return Lease(std::move(lock));
  }

 private:
  std::mutex mutex_;
};

std::uint64_t remoteAudioRealtimeSnapshotDestructions() noexcept;
void resetRemoteAudioRealtimeSnapshotDestructions() noexcept;
bool remoteAudioRealtimeFillActive() noexcept;

}  // namespace detail

struct AudioEndpointChange;

constexpr std::size_t remoteAudioSampleRate() noexcept { return 48'000; }

constexpr std::chrono::milliseconds remoteAudioPlayoutStartDuration() noexcept {
  return std::chrono::milliseconds(20);
}

constexpr std::chrono::milliseconds remoteAudioRenderBufferDuration() noexcept {
  return std::chrono::milliseconds(50);
}

// Keep the 50 ms WASAPI buffer as jitter absorption, but only maintain 30 ms
// of endpoint padding in steady state. Filling to capacity made scheduled
// playout age ~67 ms and left almost no room inside the 80 ms freshness budget.
constexpr std::chrono::milliseconds remoteAudioRenderTargetPadding() noexcept {
  return std::chrono::milliseconds(30);
}

constexpr std::uint32_t remoteAudioRenderTargetPaddingFrames() noexcept {
  return static_cast<std::uint32_t>(
    remoteAudioSampleRate() * remoteAudioRenderTargetPadding().count() / 1'000
  );
}

constexpr std::uint16_t remoteAudioRenderChannels() noexcept { return 2; }

constexpr std::chrono::milliseconds remoteAudioRendererStartupDeadline()
    noexcept {
  return std::chrono::seconds(2);
}

constexpr std::chrono::milliseconds remoteAudioRendererRetirementDeadline()
    noexcept {
  return std::chrono::milliseconds(250);
}

struct RemoteAudioOperationDeadlines {
  std::chrono::milliseconds startup = remoteAudioRendererStartupDeadline();
  std::chrono::milliseconds retirement =
    remoteAudioRendererRetirementDeadline();
};

struct RemoteAudioRenderBuffer {
  float* interleaved_samples = nullptr;
  std::uint32_t capacity_frames = 0;
  std::uint32_t padding_frames = 0;
  std::uint32_t writable_frames = 0;
  std::uint64_t wake_gap_ms = 0;
  std::chrono::steady_clock::time_point wake_time{};
};

struct RemoteAudioRenderFillResult {
  bool silent = false;
  std::optional<float> adjusted_sample_rate;
};

struct RemoteAudioRenderProgress {
  std::uint32_t capacity_frames = 0;
  std::uint32_t padding_frames = 0;
  std::uint32_t writable_frames = 0;
  std::uint64_t wake_gap_ms = 0;
};

struct RemoteAudioRendererRequest {
  std::string device_id;
  std::uint64_t renderer_epoch = 0;
  std::shared_ptr<WindowsAudioSessionAttemptPolicy> audio_attempt_policy;
  std::function<void(std::string)> endpoint_resolved;
  std::function<void(bool, std::uint32_t)> mmcss_changed;
  std::function<RemoteAudioRenderFillResult(RemoteAudioRenderBuffer)> fill;
  std::function<bool(RemoteAudioRenderProgress)> render_progress;
};

class RemoteAudioEndpointSubscription {
 public:
  virtual ~RemoteAudioEndpointSubscription() = default;
};

class RemoteAudioRendererPlatformAdapter {
 public:
  virtual ~RemoteAudioRendererPlatformAdapter() = default;
  virtual void runRenderer(
    RemoteAudioOperationAttempt::Context& context,
    RemoteAudioRendererRequest request
  ) = 0;
  virtual std::unique_ptr<RemoteAudioEndpointSubscription> monitorEndpoints(
    std::function<void(const AudioEndpointChange&)> handler
  ) = 0;
};

std::shared_ptr<RemoteAudioRendererPlatformAdapter>
createWindowsRemoteAudioRendererPlatformAdapter();

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
  std::optional<RemoteAudioExternalStage> external_stage;
  std::uint64_t startup_deadline_ms = 0;
  std::uint64_t retirement_deadline_ms = 0;
  std::size_t quarantined_attempts = 0;
  std::size_t peak_owned_attempts = 0;
  std::uint64_t rejected_attempts = 0;
  std::optional<AudioFailureInfo> failure;
  std::string detail;
};

// Read-only dataplane evidence used by diagnostics and contention harnesses.
// Track ingress and renderer counters come from the same production graph, so
// a caller cannot mistake a separately drained test queue for WASAPI playout.
struct RemoteAudioPlayoutSnapshot {
  std::string track_id;
  std::uint64_t renderer_epoch = 0;
  std::uint64_t ingress_frames = 0;
  std::uint64_t renderer_fill_callbacks = 0;
  std::uint64_t rendered_track_frames = 0;
  std::uint64_t renderer_frames_written = 0;
  std::uint64_t maximum_wake_gap_ms = 0;
  std::uint64_t freshness_recoveries = 0;
  std::uint64_t scheduled_playout_age_samples = 0;
  std::uint64_t last_scheduled_playout_age_us = 0;
  std::uint64_t maximum_scheduled_playout_age_us = 0;
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
    CleanupStartProbe cleanup_start_probe = {},
    std::shared_ptr<RemoteAudioRendererPlatformAdapter> platform_adapter = {},
    RemoteAudioOperationDeadlines operation_deadlines = {},
    std::shared_ptr<RemoteAudioAttemptDomain> attempt_domain = {},
    std::shared_ptr<WindowsAudioSessionAttemptPolicy> audio_attempt_policy = {}
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
  std::optional<RemoteAudioPlayoutSnapshot> playoutSnapshot(
    std::string_view track_sid
  ) const;
  void setVolume(float volume);
  void configure(RemoteAudioSettings settings);
  void stop();
  void stop(std::shared_ptr<void> lifetime_owner);

 private:
  class Implementation;
  CleanupSupervisor* cleanup_supervisor_;
  std::shared_ptr<CleanupJob> cleanup_job_;
  std::atomic_bool cleanup_submitted_{false};
  std::shared_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
