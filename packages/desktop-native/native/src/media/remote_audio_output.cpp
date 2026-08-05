#include "remote_audio_output.hpp"

#include <audioclient.h>
#include <audiopolicy.h>
#include <avrt.h>
#include <windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <exception>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <livekit/audio_frame_sink.h>
#include <livekit/track.h>

#include "../common/diagnostic_log.hpp"
#include "audio_devices.hpp"
#include "remote_audio_ingress.hpp"
#include "voice_activity_detector.hpp"
#include "wasapi_event.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::desktop_native::media {

void startAudioOutputWithRollback(
  const std::function<void()>& start_candidate,
  const std::function<void()>& restore_previous,
  const std::function<void()>& start_previous
) {
  try {
    start_candidate();
    return;
  } catch (...) {
    const auto candidate_failure = std::current_exception();
    restore_previous();
    try {
      start_previous();
    } catch (const std::exception& rollback_error) {
      const auto failure = describeAudioFailure(rollback_error);
      throw AudioFailure(
        AudioFailureKind::RollbackFailed,
        "previous audio output rollback failed: " + failure.message,
        failure.hresult
      );
    } catch (...) {
      throw AudioFailure(
        AudioFailureKind::RollbackFailed,
        "previous audio output rollback failed",
        S_OK
      );
    }
    std::rethrow_exception(candidate_failure);
  }
}

bool remoteAudioEndpointChangeCanRearmRecovery(
  const AudioEndpointChange& change
) noexcept {
  if (change.flow != eRender) return false;
  switch (change.kind) {
    case AudioEndpointChangeKind::DefaultChanged:
      return change.role == eConsole;
    case AudioEndpointChangeKind::Added:
    case AudioEndpointChangeKind::Active:
      return true;
    case AudioEndpointChangeKind::Removed:
    case AudioEndpointChangeKind::Disabled:
      return false;
  }
  return false;
}

namespace {

constexpr std::size_t kRemoteAudioSampleRate = remoteAudioSampleRate();
constexpr std::size_t kRemoteAudioChannels = remoteAudioRenderChannels();
constexpr std::size_t kPlayoutStartPackets =
  remoteAudioPlayoutStartDuration().count() / 10;
constexpr std::size_t kFadeFrames = 48;
constexpr auto kHundredNanosecondsPerMillisecond = 10'000LL;
constexpr float kLimiterCeiling = 0.98F;
constexpr float kLimiterReleaseSeconds = 0.5F;
constexpr double kClockTargetPackets = 3.0;
constexpr double kMaximumClockCorrectionPpm = 1'000.0;
constexpr auto kClockAdjustmentInterval = std::chrono::milliseconds(100);
constexpr auto kRenderProgressDeadline = std::chrono::seconds(3);
constexpr auto kRecoveryWatchInterval = std::chrono::milliseconds(500);
constexpr std::size_t kMaximumRecoveryAttempts = 20;
using diagnostics::DiagnosticField;

struct StereoFrame {
  float left = 0.0F;
  float right = 0.0F;
};

WAVEFORMATEX desiredRemoteAudioRenderFormat() {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = static_cast<WORD>(kRemoteAudioChannels);
  format.nSamplesPerSec = static_cast<DWORD>(kRemoteAudioSampleRate);
  format.wBitsPerSample = 32;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  return format;
}

void logRemoteAudio(
  std::string_view event,
  std::initializer_list<DiagnosticField> fields = {}
) {
  auto& logger = diagnostics::DiagnosticLog::instance();
  if (logger.enabled()) logger.write(event, fields);
}

struct TrackState {
  std::shared_ptr<RemoteAudioIngress> ingress;
  std::unique_ptr<livekit::AudioFrameSinkRegistration> registration;
  std::string user_id;
  std::string track_id;
  bool stream_source = false;
  std::atomic<float> gain{1.0F};
  std::atomic_bool speaking{false};
  std::atomic<std::uint64_t> reset_epoch{0};
  std::atomic<std::uint64_t> underruns{0};

  // Renderer-thread state.
  RemoteAudioIngressFrame current_frame;
  std::size_t current_frame_offset = kRemoteAudioIngressFramesPerPacket;
  bool playout_started = false;
  std::uint64_t consumed_reset_epoch = 0;
  VoiceActivityDetector activity;
  std::array<StereoFrame, kRemoteAudioIngressFramesPerPacket> scratch{};
  float previous_left = 0.0F;
  float previous_right = 0.0F;
  std::size_t fade_in_remaining = 0;

  // Telemetry-thread state.
  RemoteAudioIngressTelemetry reported_ingress;
  std::uint64_t reported_underruns = 0;
  std::chrono::steady_clock::time_point next_dataplane_report{};
};

using RenderSnapshot = std::vector<std::shared_ptr<TrackState>>;

void resetTrackRendererState(TrackState& track) noexcept {
  track.ingress->discardQueued();
  track.current_frame_offset = kRemoteAudioIngressFramesPerPacket;
  track.playout_started = false;
  track.fade_in_remaining = 0;
  track.previous_left = 0.0F;
  track.previous_right = 0.0F;
  track.activity.reset();
  track.speaking.store(false, std::memory_order_release);
}

void fadeTrackToSilence(
  TrackState& track,
  std::size_t produced_frames,
  std::size_t requested_frames
) noexcept {
  if (produced_frames == 0) {
    const auto fade_frames = std::min(kFadeFrames, requested_frames);
    for (std::size_t index = 0; index < fade_frames; ++index) {
      const auto gain = 1.0F -
        static_cast<float>(index + 1) / static_cast<float>(fade_frames);
      track.scratch[index] = {
        track.previous_left * gain,
        track.previous_right * gain,
      };
    }
  } else {
    const auto fade_frames = std::min(kFadeFrames, produced_frames);
    const auto first = produced_frames - fade_frames;
    for (std::size_t index = 0; index < fade_frames; ++index) {
      const auto gain = 1.0F -
        static_cast<float>(index + 1) / static_cast<float>(fade_frames);
      track.scratch[first + index].left *= gain;
      track.scratch[first + index].right *= gain;
    }
  }
  track.previous_left = 0.0F;
  track.previous_right = 0.0F;
}

bool readNextTrackFrame(
  TrackState& track,
  std::uint64_t renderer_epoch
) noexcept {
  const auto result = track.ingress->tryRead(
    track.current_frame,
    renderer_epoch
  );
  if (result == RemoteAudioIngressReadResult::Frame) {
    track.current_frame_offset = 0;
    return true;
  }
  if (result == RemoteAudioIngressReadResult::Discontinuity) {
    resetTrackRendererState(track);
  }
  return false;
}

bool renderTrack(
  TrackState& track,
  StereoFrame* mixed,
  std::size_t frame_count,
  float output_volume,
  bool deafened,
  std::chrono::steady_clock::time_point now,
  std::uint64_t renderer_epoch
) noexcept {
  std::fill_n(track.scratch.begin(), frame_count, StereoFrame{});

  const auto reset_epoch = track.reset_epoch.load(std::memory_order_acquire);
  if (reset_epoch != track.consumed_reset_epoch) {
    resetTrackRendererState(track);
    track.consumed_reset_epoch = reset_epoch;
  }

  if (!track.playout_started) {
    if (track.ingress->queuedFrames() < kPlayoutStartPackets) {
      if (!track.stream_source) {
        track.activity.updateRms(0.0F, true, now);
        track.speaking.store(track.activity.speaking(), std::memory_order_release);
      }
      return false;
    }
    track.playout_started = true;
    track.fade_in_remaining = kFadeFrames;
  }

  std::size_t produced_frames = 0;
  for (; produced_frames < frame_count; ++produced_frames) {
    if (track.current_frame_offset == kRemoteAudioIngressFramesPerPacket &&
        !readNextTrackFrame(track, renderer_epoch)) {
      break;
    }
    const auto sample_index = track.current_frame_offset * kRemoteAudioChannels;
    auto left = static_cast<float>(track.current_frame.samples[sample_index]) /
      32768.0F;
    auto right = static_cast<float>(track.current_frame.samples[sample_index + 1]) /
      32768.0F;
    ++track.current_frame_offset;
    if (track.fade_in_remaining != 0) {
      const auto fade_gain = 1.0F -
        static_cast<float>(track.fade_in_remaining) /
          static_cast<float>(kFadeFrames);
      left *= fade_gain;
      right *= fade_gain;
      --track.fade_in_remaining;
    }
    track.scratch[produced_frames] = {left, right};
  }

  if (produced_frames != frame_count) {
    fadeTrackToSilence(track, produced_frames, frame_count);
    track.playout_started = false;
    track.current_frame_offset = kRemoteAudioIngressFramesPerPacket;
    track.underruns.fetch_add(1, std::memory_order_relaxed);
  } else if (frame_count != 0) {
    track.previous_left = track.scratch[frame_count - 1].left;
    track.previous_right = track.scratch[frame_count - 1].right;
  }

  const auto track_gain = track.gain.load(std::memory_order_relaxed);
  const auto effective_gain = track_gain * output_volume;
  double squared_sum = 0.0;
  for (std::size_t index = 0; index < frame_count; ++index) {
    const auto left = track.scratch[index].left * effective_gain;
    const auto right = track.scratch[index].right * effective_gain;
    if (!deafened) {
      mixed[index].left += left;
      mixed[index].right += right;
    }
    const auto mono = (left + right) * 0.5F;
    squared_sum += static_cast<double>(mono) * static_cast<double>(mono);
  }

  if (!track.stream_source) {
    const auto activity_enabled = !deafened && effective_gain > 0.0F;
    const auto rms = frame_count == 0
      ? 0.0F
      : static_cast<float>(std::sqrt(
          squared_sum / static_cast<double>(frame_count)
        ));
    track.activity.updateRms(rms, activity_enabled, now);
    track.speaking.store(track.activity.speaking(), std::memory_order_release);
  }
  return produced_frames != 0;
}

float remoteAudioLimiterTargetGainImpl(float peak) noexcept {
  if (!std::isfinite(peak) || peak <= kLimiterCeiling) return 1.0F;
  return kLimiterCeiling / peak;
}

}  // namespace

std::string normalizeRemoteAudioIdentity(std::string_view identity) {
  constexpr std::string_view prefix = "voice:v1|";
  if (!identity.starts_with(prefix)) return std::string(identity);
  auto remainder = identity.substr(prefix.size());
  std::array<std::string_view, 5> fields;
  for (std::size_t index = 0; index < fields.size() - 1; ++index) {
    const auto separator = remainder.find('|');
    if (separator == std::string_view::npos) return std::string(identity);
    fields[index] = remainder.substr(0, separator);
    remainder.remove_prefix(separator + 1);
  }
  fields.back() = remainder;
  if (
    (fields[0] != "web" && fields[0] != "windows_native") ||
    std::any_of(fields.begin(), fields.end(), [](auto field) {
      return field.empty() || field.find('|') != std::string_view::npos;
    })
  ) {
    return std::string(identity);
  }
  return std::string(fields.back());
}

float resolveRemoteAudioGain(
  const RemoteAudioSettings& settings,
  std::string_view participant_identity,
  bool stream_source
) {
  const auto user_id = normalizeRemoteAudioIdentity(participant_identity);
  const auto& volumes = stream_source
    ? settings.stream_volumes
    : settings.user_volumes;
  const auto& mutes = stream_source
    ? settings.stream_mutes
    : settings.user_mutes;
  const auto muted = mutes.find(user_id);
  if (muted != mutes.end() && muted->second) return 0.0F;
  const auto volume = volumes.find(user_id);
  return volume == volumes.end()
    ? 1.0F
    : std::clamp(volume->second, 0.0F, 3.0F);
}

float remoteAudioLimiterTargetGain(float peak) noexcept {
  return remoteAudioLimiterTargetGainImpl(peak);
}

class RemoteAudioOutput::Implementation {
 public:
  Implementation(
    StateHandler on_state,
    TrackFailureHandler on_track_failure,
    SpeakingActivityHandler on_speaking_activity
  ) : on_state_(std::move(on_state)),
      on_track_failure_(std::move(on_track_failure)),
      on_speaking_activity_(std::move(on_speaking_activity)) {
    render_snapshot_owner_ = std::make_unique<const RenderSnapshot>();
    render_snapshot_source_.store(
      render_snapshot_owner_.get(),
      std::memory_order_seq_cst
    );
    telemetry_worker_ = std::jthread([this](std::stop_token token) {
      telemetryLoop(token);
    });
    recovery_worker_ = std::jthread([this](std::stop_token token) {
      recoveryLoop(token);
    });
    try {
      endpoint_monitor_ = std::make_unique<AudioEndpointMonitor>(
        eRender,
        [this](AudioEndpointChange change) {
          handleEndpointChange(std::move(change));
        }
      );
    } catch (const std::exception& error) {
      logRemoteAudio(
        "remote_audio_endpoint_monitor_unavailable",
        {{"message", error.what()}}
      );
    }
  }

  ~Implementation() { stop(); }

  void addTrack(
    std::string sid,
    std::string identity,
    bool stream,
    std::shared_ptr<livekit::Track> track
  ) {
    if (!track || track->kind() != livekit::TrackKind::KIND_AUDIO) return;
    removeTrack(sid);

    auto state = std::make_shared<TrackState>();
    state->ingress = std::make_shared<RemoteAudioIngress>();
    state->user_id = normalizeRemoteAudioIdentity(identity);
    state->track_id = sid;
    state->stream_source = stream;
    try {
      state->registration = livekit::AudioFrameSinkRegistration::attach(
        track,
        state->ingress,
        livekit::DirectAudioSinkOptions{
          .sample_rate = kRemoteAudioIngressSampleRate,
          .num_channels = kRemoteAudioIngressChannels,
        }
      );
    } catch (const std::exception& error) {
      notifyTrackStartFailure(error.what(), sid);
      return;
    } catch (...) {
      notifyTrackStartFailure("unknown direct audio sink attach failure", sid);
      return;
    }

    bool discard = false;
    std::size_t track_count = 0;
    {
      std::lock_guard lock(mutex_);
      if (stopping_ || tracks_.contains(sid)) {
        discard = true;
      } else {
        applyGain(*state);
        tracks_.emplace(sid, state);
        publishRenderSnapshotLocked();
        track_count = tracks_.size();
      }
    }
    if (discard) {
      state->registration->close();
      return;
    }
    activateTrackIfRunning(*state);
    telemetry_changed_.notify_all();
    logRemoteAudio(
      "remote_audio_direct_track_added",
      {
        {"trackCount", static_cast<std::uint64_t>(track_count)},
        {"streamSource", stream},
      }
    );
  }

  void removeTrack(const std::string& sid) {
    std::shared_ptr<TrackState> removed;
    {
      std::lock_guard lock(mutex_);
      const auto found = tracks_.find(sid);
      if (found == tracks_.end()) return;
      removed = std::move(found->second);
      tracks_.erase(found);
      publishRenderSnapshotLocked();
    }
    removed->registration->close();
    removed->registration.reset();
    telemetry_changed_.notify_all();
    logRemoteAudio("remote_audio_direct_track_removed");
  }

  void setDeafened(bool value) {
    deafened_.store(value, std::memory_order_release);
    if (value) requestTrackResets();
    telemetry_changed_.notify_all();
  }

  std::uint64_t setOutputDevice(std::string value) {
    std::lock_guard switch_lock(device_switch_mutex_);
    return configureOutputDeviceUnderSwitchLock(std::move(value));
  }

  std::string outputDeviceId() const {
    std::lock_guard lock(mutex_);
    if (!resolved_endpoint_id_.empty()) return resolved_endpoint_id_;
    return active_device_id_;
  }

  void setVolume(float value) {
    volume_.store(std::clamp(value, 0.0F, 3.0F), std::memory_order_release);
    telemetry_changed_.notify_all();
  }

  void configure(RemoteAudioSettings settings) {
    {
      std::lock_guard lock(mutex_);
      if (settings.revision <= settings_.revision) return;
      settings_ = std::move(settings);
      for (auto& [_, track] : tracks_) applyGain(*track);
    }
    telemetry_changed_.notify_all();
  }

  void stop() {
    std::vector<std::shared_ptr<TrackState>> removed;
    {
      std::lock_guard lock(mutex_);
      if (stopping_) return;
      stopping_ = true;
      removed.reserve(tracks_.size());
      for (auto& [_, track] : tracks_) removed.push_back(std::move(track));
      tracks_.clear();
      publishRenderSnapshotLocked();
    }
    recovery_worker_.request_stop();
    recovery_changed_.notify_all();
    if (recovery_worker_.joinable()) recovery_worker_.join();
    for (auto& track : removed) {
      track->ingress->suspend();
      if (track->registration) track->registration->close();
      track->registration.reset();
    }
    {
      std::lock_guard switch_lock(device_switch_mutex_);
      stopRenderer();
    }
    telemetry_worker_.request_stop();
    telemetry_changed_.notify_all();
    if (telemetry_worker_.joinable()) telemetry_worker_.join();
    RemoteAudioOutputState state;
    {
      std::lock_guard lock(mutex_);
      phase_ = RemoteAudioOutputPhase::Stopped;
      state = outputStateLocked();
    }
    publishState(std::move(state));
  }

 private:
  void publishRenderSnapshotLocked() {
    auto snapshot = std::make_unique<RenderSnapshot>();
    snapshot->reserve(tracks_.size());
    for (const auto& [_, track] : tracks_) snapshot->push_back(track);
    retired_render_snapshots_.reserve(retired_render_snapshots_.size() + 1);
    const auto* published_snapshot = snapshot.get();
    retired_render_snapshots_.push_back(std::move(render_snapshot_owner_));
    render_snapshot_owner_ = std::move(snapshot);
    render_snapshot_source_.store(
      published_snapshot,
      std::memory_order_seq_cst
    );
    reclaimRetiredRenderSnapshotsLocked();
  }

  const RenderSnapshot* acquireRenderSnapshot() noexcept {
    const RenderSnapshot* snapshot = nullptr;
    do {
      snapshot = render_snapshot_source_.load(std::memory_order_seq_cst);
      render_snapshot_hazard_.store(snapshot, std::memory_order_seq_cst);
    } while (
      snapshot != render_snapshot_source_.load(std::memory_order_seq_cst)
    );
    return snapshot;
  }

  void releaseRenderSnapshot() noexcept {
    render_snapshot_hazard_.store(nullptr, std::memory_order_seq_cst);
  }

  void reclaimRetiredRenderSnapshotsLocked() noexcept {
    const auto* hazard =
      render_snapshot_hazard_.load(std::memory_order_seq_cst);
    std::erase_if(retired_render_snapshots_, [hazard](const auto& snapshot) {
      return snapshot.get() != hazard;
    });
  }

  void requestTrackResets() {
    std::lock_guard lock(mutex_);
    for (const auto& [_, track] : tracks_) {
      track->reset_epoch.fetch_add(1, std::memory_order_release);
    }
  }

  void applyGain(TrackState& track) {
    track.gain.store(
      resolveRemoteAudioGain(
        settings_,
        track.user_id,
        track.stream_source
      ),
      std::memory_order_release
    );
  }

  void notifyTrackStartFailure(
    std::string_view message,
    std::string_view track_id
  ) noexcept {
    try {
      if (!on_track_failure_) return;
      std::uint64_t epoch = 0;
      {
        std::lock_guard lock(mutex_);
        epoch = renderer_epoch_;
      }
      on_track_failure_(AudioFailureInfo{
        AudioFailureKind::IoFailed,
        "audio_output_direct_sink_attach_failed",
        "Direct remote audio sink failed to attach: " + std::string(message),
        S_OK,
        true,
      }, std::string(track_id), epoch);
    } catch (...) {
      logRemoteAudio("remote_audio_track_failure_callback_failed");
    }
  }

  struct OutputCandidate {
    std::string selector;
    std::string resolved_endpoint_id;
    bool using_fallback = false;
  };

  struct OutputConfiguration {
    std::string desired_device_id;
    std::string active_device_id;
    std::string resolved_endpoint_id;
    RemoteAudioOutputPhase phase = RemoteAudioOutputPhase::Stopped;
    bool output_configured = false;
    bool using_fallback = false;
  };

  static std::string normalizeOutputDeviceId(std::string value) {
    return value.empty() ? std::string{"default"} : std::move(value);
  }

  OutputCandidate resolveOutputCandidate(const std::string& desired) {
    auto selector = desired;
    bool using_fallback = false;
    try {
      probeRenderDevice(
        selector,
        desiredRemoteAudioRenderFormat(),
        std::chrono::milliseconds(750)
      );
    } catch (const AudioFailure& failure) {
      if (selector == "default" ||
          !audioFailureAllowsDefaultFallback(failure.kind())) {
        throw;
      }
      selector = "default";
      using_fallback = true;
      probeRenderDevice(
        selector,
        desiredRemoteAudioRenderFormat(),
        std::chrono::milliseconds(750)
      );
    }
    auto resolved_endpoint_id = resolvedRenderDeviceId(selector);
    return {
      .selector = std::move(selector),
      .resolved_endpoint_id = std::move(resolved_endpoint_id),
      .using_fallback = using_fallback,
    };
  }

  OutputConfiguration outputConfigurationLocked() const {
    return {
      .desired_device_id = desired_device_id_,
      .active_device_id = active_device_id_,
      .resolved_endpoint_id = resolved_endpoint_id_,
      .phase = phase_,
      .output_configured = output_configured_,
      .using_fallback = using_fallback_,
    };
  }

  void restoreOutputConfigurationLocked(
    const OutputConfiguration& configuration
  ) {
    desired_device_id_ = configuration.desired_device_id;
    active_device_id_ = configuration.active_device_id;
    resolved_endpoint_id_ = configuration.resolved_endpoint_id;
    phase_ = configuration.phase;
    output_configured_ = configuration.output_configured;
    using_fallback_ = configuration.using_fallback;
  }

  RemoteAudioOutputState outputStateLocked(
    std::optional<AudioFailureInfo> failure = {},
    std::string detail = {}
  ) const {
    return {
      .phase = phase_,
      .desired_device_id = desired_device_id_,
      .active_device_id = active_device_id_,
      .resolved_endpoint_id = resolved_endpoint_id_,
      .renderer_epoch = renderer_epoch_,
      .using_fallback = using_fallback_,
      .failure = std::move(failure),
      .detail = std::move(detail),
    };
  }

  void publishState(RemoteAudioOutputState state) noexcept {
    try {
      if (on_state_) on_state_(std::move(state));
    } catch (...) {
      logRemoteAudio("remote_audio_output_state_callback_failed");
    }
  }

  void activateTrackIfRunning(TrackState& track) {
    std::uint64_t epoch = 0;
    {
      std::lock_guard lock(mutex_);
      if (!stopping_ && phase_ == RemoteAudioOutputPhase::Running) {
        epoch = renderer_epoch_;
      }
    }
    if (epoch != 0) track.ingress->activate(epoch);
  }

  void setIngressRendererEpoch(std::uint64_t renderer_epoch) {
    RenderSnapshot snapshot;
    {
      std::lock_guard lock(mutex_);
      snapshot.reserve(tracks_.size());
      for (const auto& [_, track] : tracks_) snapshot.push_back(track);
    }
    for (const auto& track : snapshot) {
      if (renderer_epoch == 0) {
        track->ingress->suspend();
      } else {
        track->ingress->activate(renderer_epoch);
      }
    }
  }

  void clearRecoveryRequest() {
    std::lock_guard lock(recovery_mutex_);
    ++recovery_generation_;
    recovery_request_.reset();
    recovery_attempt_ = 0;
    recovery_accelerated_ = false;
  }

  std::uint64_t configureOutputDeviceUnderSwitchLock(std::string value) {
    value = normalizeOutputDeviceId(std::move(value));
    OutputConfiguration previous;
    {
      std::lock_guard lock(mutex_);
      if (stopping_) return renderer_epoch_;
      if (desired_device_id_ == value &&
          !using_fallback_ &&
          phase_ == RemoteAudioOutputPhase::Running &&
          renderer_running_.load(std::memory_order_acquire)) {
        return renderer_epoch_;
      }
      previous = outputConfigurationLocked();
    }
    const auto candidate = resolveOutputCandidate(value);
    {
      std::lock_guard lock(mutex_);
      if (stopping_) return renderer_epoch_;
      desired_device_id_ = value;
      active_device_id_ = candidate.selector;
      resolved_endpoint_id_ = candidate.resolved_endpoint_id;
      using_fallback_ = candidate.using_fallback;
      output_configured_ = true;
      phase_ = RemoteAudioOutputPhase::Starting;
    }
    stopRenderer();
    try {
      startAudioOutputWithRollback(
        [this] { startRenderer(); },
        [this, &previous] {
          std::lock_guard lock(mutex_);
          restoreOutputConfigurationLocked(previous);
        },
        [this, &previous] {
          if (previous.output_configured &&
              previous.phase == RemoteAudioOutputPhase::Running) {
            startRenderer();
          }
        }
      );
    } catch (const AudioFailure& failure) {
      if (failure.kind() == AudioFailureKind::RollbackFailed) {
        RemoteAudioOutputState state;
        {
          std::lock_guard lock(mutex_);
          restoreOutputConfigurationLocked(previous);
          phase_ = RemoteAudioOutputPhase::Failed;
          output_configured_ = false;
          const auto info = describeAudioFailure(failure);
          state = outputStateLocked(info, info.message);
        }
        publishState(std::move(state));
      } else {
        std::lock_guard lock(mutex_);
        restoreOutputConfigurationLocked(previous);
      }
      throw;
    } catch (...) {
      {
        std::lock_guard lock(mutex_);
        restoreOutputConfigurationLocked(previous);
      }
      throw;
    }
    clearRecoveryRequest();
    AudioFailureInfo fallback{
      AudioFailureKind::EndpointInvalidated,
      "audio_output_fallback_default",
      "Selected audio output is unavailable; using system default",
      AUDCLNT_E_DEVICE_INVALIDATED,
      false,
    };
    RemoteAudioOutputState state;
    {
      std::lock_guard lock(mutex_);
      phase_ = RemoteAudioOutputPhase::Running;
      state = outputStateLocked(
        candidate.using_fallback
          ? std::optional<AudioFailureInfo>{fallback}
          : std::optional<AudioFailureInfo>{},
        candidate.using_fallback ? fallback.message : std::string{}
      );
    }
    const auto renderer_epoch = state.renderer_epoch;
    publishState(std::move(state));
    return renderer_epoch;
  }

  void startRenderer() {
    {
      std::lock_guard lock(renderer_startup_mutex_);
      renderer_ready_ = false;
      renderer_startup_failure_.reset();
    }
    renderer_running_.store(true, std::memory_order_release);
    last_render_progress_ms_.store(0, std::memory_order_release);
    std::uint64_t renderer_epoch = 0;
    {
      std::lock_guard lock(mutex_);
      renderer_epoch = ++renderer_epoch_;
    }
    logRemoteAudio("remote_audio_renderer_start_requested");
    try {
      renderer_ = std::jthread([this, renderer_epoch](std::stop_token token) {
        render(token, renderer_epoch);
      });
    } catch (...) {
      renderer_running_.store(false, std::memory_order_release);
      throw;
    }

    std::unique_lock lock(renderer_startup_mutex_);
    if (!renderer_startup_changed_.wait_for(
          lock,
          std::chrono::seconds(2),
          [this] {
            return renderer_ready_ || renderer_startup_failure_.has_value();
          }
        )) {
      lock.unlock();
      stopRenderer();
      throw AudioFailure(
        AudioFailureKind::OperationTimedOut,
        "audio output produced no render progress before deadline",
        HRESULT_FROM_WIN32(WAIT_TIMEOUT)
      );
    }
    if (renderer_startup_failure_) {
      const auto failure = *renderer_startup_failure_;
      lock.unlock();
      stopRenderer();
      throw AudioFailure(failure.kind, failure.message, failure.hresult);
    }
    lock.unlock();
    setIngressRendererEpoch(renderer_epoch);
  }

  void stopRenderer() {
    setIngressRendererEpoch(0);
    renderer_running_.store(false, std::memory_order_release);
    if (renderer_.joinable()) {
      renderer_.request_stop();
      renderer_.join();
    }
    clock_adjustment_ppm_.store(0.0, std::memory_order_relaxed);
    requestTrackResets();
  }

  void updateClockAdjustment(
    IAudioClockAdjustment& clock_adjustment,
    const RenderSnapshot& snapshot,
    std::chrono::steady_clock::time_point now,
    std::chrono::steady_clock::time_point& next_update,
    double& integral_error,
    double& applied_ppm
  ) {
    if (now < next_update) return;
    next_update = now + kClockAdjustmentInterval;

    double queued_packets = 0.0;
    std::size_t active_tracks = 0;
    for (const auto& track : snapshot) {
      if (!track->playout_started) continue;
      queued_packets += static_cast<double>(track->ingress->queuedFrames());
      if (track->current_frame_offset < kRemoteAudioIngressFramesPerPacket) {
        queued_packets += static_cast<double>(
          kRemoteAudioIngressFramesPerPacket - track->current_frame_offset
        ) / static_cast<double>(kRemoteAudioIngressFramesPerPacket);
      }
      ++active_tracks;
    }

    double requested_ppm = 0.0;
    if (active_tracks == 0) {
      integral_error = 0.0;
    } else {
      const auto average_packets =
        queued_packets / static_cast<double>(active_tracks);
      const auto error = average_packets - kClockTargetPackets;
      integral_error = std::clamp(
        integral_error + error * 0.1,
        -100.0,
        100.0
      );
      requested_ppm = std::clamp(
        error * 120.0 + integral_error * 4.0,
        -kMaximumClockCorrectionPpm,
        kMaximumClockCorrectionPpm
      );
    }
    if (std::abs(requested_ppm - applied_ppm) < 1.0) return;

    const auto adjusted_rate = static_cast<float>(
      static_cast<double>(kRemoteAudioSampleRate) *
      (1.0 + requested_ppm / 1'000'000.0)
    );
    const auto result = clock_adjustment.SetSampleRate(adjusted_rate);
    if (FAILED(result)) {
      throwAudioFailure(
        result,
        "adjust render clock failed",
        AudioFailureKind::IoFailed
      );
    }
    applied_ppm = requested_ppm;
    clock_adjustment_ppm_.store(applied_ppm, std::memory_order_relaxed);
  }

  void render(std::stop_token token, std::uint64_t renderer_epoch) {
    const auto com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_initialized = SUCCEEDED(com_result);
    DWORD task_index = 0;
    HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);
    std::string device_id;
    try {
      WasapiEventPair stream_events;
      std::stop_callback stop_callback(token, [&stream_events] {
        stream_events.requestStop();
      });
      {
        std::lock_guard lock(mutex_);
        device_id = active_device_id_;
      }
      auto device = renderDevice(device_id);
      const auto resolved_endpoint_id = audioEndpointId(device.Get());
      {
        std::lock_guard lock(mutex_);
        if (renderer_epoch_ == renderer_epoch &&
            !resolved_endpoint_id.empty()) {
          resolved_endpoint_id_ = resolved_endpoint_id;
        }
      }
      ComPtr<IAudioClient> client;
      const auto activate_result = device->Activate(
        __uuidof(IAudioClient),
        CLSCTX_ALL,
        nullptr,
        reinterpret_cast<void**>(client.GetAddressOf())
      );
      if (FAILED(activate_result)) {
        throwAudioFailure(activate_result, "activate render device failed");
      }

      ComPtr<IAudioClient2> client2;
      if (SUCCEEDED(client.As(&client2))) {
        AudioClientProperties properties{};
        properties.cbSize = sizeof(properties);
        properties.bIsOffload = FALSE;
        properties.eCategory = AudioCategory_Media;
        properties.Options = AUDCLNT_STREAMOPTIONS_NONE;
        (void)client2->SetClientProperties(&properties);
      }

      auto format = desiredRemoteAudioRenderFormat();
      constexpr auto requested_buffer_duration =
        remoteAudioRenderBufferDuration();
      const auto initialize_result = client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
          AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
          AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY |
          AUDCLNT_STREAMFLAGS_RATEADJUST,
        requested_buffer_duration.count() *
          kHundredNanosecondsPerMillisecond,
        0,
        &format,
        nullptr
      );
      if (FAILED(initialize_result)) {
        throwAudioFailure(initialize_result, "initialize render stream failed");
      }
      const auto event_result = client->SetEventHandle(
        stream_events.audioReadyHandle()
      );
      if (FAILED(event_result)) {
        throwAudioFailure(event_result, "set render stream event failed");
      }

      ComPtr<IAudioSessionControl> session_control;
      if (SUCCEEDED(client->GetService(IID_PPV_ARGS(&session_control)))) {
        ComPtr<IAudioSessionControl2> session_control2;
        if (SUCCEEDED(session_control.As(&session_control2))) {
          (void)session_control2->SetDuckingPreference(TRUE);
        }
      }

      ComPtr<IAudioRenderClient> render_client;
      const auto render_service_result = client->GetService(
        IID_PPV_ARGS(&render_client)
      );
      if (FAILED(render_service_result)) {
        throwAudioFailure(render_service_result, "open render client failed");
      }
      ComPtr<IAudioClockAdjustment> clock_adjustment;
      const auto clock_service_result = client->GetService(
        IID_PPV_ARGS(&clock_adjustment)
      );
      if (FAILED(clock_service_result)) {
        throwAudioFailure(
          clock_service_result,
          "open render clock adjustment failed"
        );
      }

      UINT32 capacity = 0;
      const auto capacity_result = client->GetBufferSize(&capacity);
      if (FAILED(capacity_result) || capacity == 0) {
        throwAudioFailure(
          FAILED(capacity_result) ? capacity_result : S_OK,
          "query render capacity failed",
          AudioFailureKind::IoFailed
        );
      }
      std::vector<StereoFrame> mixed(capacity);

      BYTE* initial_output = nullptr;
      const auto prime_result = render_client->GetBuffer(
        capacity,
        &initial_output
      );
      if (FAILED(prime_result)) {
        throwAudioFailure(
          prime_result,
          "prime render buffer failed",
          AudioFailureKind::IoFailed
        );
      }
      const auto release_prime_result = render_client->ReleaseBuffer(
        capacity,
        AUDCLNT_BUFFERFLAGS_SILENT
      );
      if (FAILED(release_prime_result)) {
        throwAudioFailure(
          release_prime_result,
          "release primed render buffer failed",
          AudioFailureKind::IoFailed
        );
      }
      const auto start_result = client->Start();
      if (FAILED(start_result)) {
        throwAudioFailure(
          start_result,
          "start render failed",
          AudioFailureKind::ClientStartFailed
        );
      }

      float limiter_gain = 1.0F;
      double clock_integral_error = 0.0;
      double applied_clock_ppm = 0.0;
      auto next_clock_update = std::chrono::steady_clock::now();
      while (!token.stop_requested() &&
             renderer_running_.load(std::memory_order_acquire)) {
        const auto wait_result = stream_events.wait(1'000);
        if (wait_result == WasapiEventPair::WaitResult::StopRequested) break;
        if (wait_result == WasapiEventPair::WaitResult::TimedOut) continue;

        UINT32 padding = 0;
        const auto padding_result = client->GetCurrentPadding(&padding);
        if (FAILED(padding_result)) {
          throwAudioFailure(
            padding_result,
            "query render padding failed",
            AudioFailureKind::IoFailed
          );
        }
        const auto writable = capacity - std::min(capacity, padding);
        const UINT32 count = std::min<UINT32>(
          writable,
          static_cast<UINT32>(kRemoteAudioIngressFramesPerPacket)
        );
        if (count == 0) continue;

        BYTE* output = nullptr;
        const auto buffer_result = render_client->GetBuffer(count, &output);
        if (FAILED(buffer_result)) {
          throwAudioFailure(
            buffer_result,
            "acquire render buffer failed",
            AudioFailureKind::IoFailed
          );
        }

        std::fill_n(mixed.begin(), count, StereoFrame{});
        const auto* snapshot = acquireRenderSnapshot();
        const auto deafened = deafened_.load(std::memory_order_relaxed);
        const auto output_volume = volume_.load(std::memory_order_relaxed);
        const auto now = std::chrono::steady_clock::now();
        for (const auto& track : *snapshot) {
          renderTrack(
            *track,
            mixed.data(),
            count,
            output_volume,
            deafened,
            now,
            renderer_epoch
          );
        }
        updateClockAdjustment(
          *clock_adjustment.Get(),
          *snapshot,
          now,
          next_clock_update,
          clock_integral_error,
          applied_clock_ppm
        );
        releaseRenderSnapshot();

        float peak = 0.0F;
        for (UINT32 index = 0; index < count; ++index) {
          peak = std::max(peak, std::abs(mixed[index].left));
          peak = std::max(peak, std::abs(mixed[index].right));
        }
        const auto target_limiter_gain =
          remoteAudioLimiterTargetGainImpl(peak);
        if (target_limiter_gain < limiter_gain) {
          limiter_gain = target_limiter_gain;
        } else {
          const auto release = static_cast<float>(count) /
            (static_cast<float>(kRemoteAudioSampleRate) *
             kLimiterReleaseSeconds);
          limiter_gain = std::min(
            target_limiter_gain,
            limiter_gain + release
          );
        }

        auto* samples = reinterpret_cast<float*>(output);
        for (UINT32 index = 0; index < count; ++index) {
          samples[index * kRemoteAudioChannels] = std::clamp(
            mixed[index].left * limiter_gain,
            -1.0F,
            1.0F
          );
          samples[index * kRemoteAudioChannels + 1] = std::clamp(
            mixed[index].right * limiter_gain,
            -1.0F,
            1.0F
          );
        }
        const auto release_result = render_client->ReleaseBuffer(
          count,
          deafened ? AUDCLNT_BUFFERFLAGS_SILENT : 0
        );
        if (FAILED(release_result)) {
          throwAudioFailure(
            release_result,
            "release render buffer failed",
            AudioFailureKind::IoFailed
          );
        }
        last_render_progress_ms_.store(
          static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now().time_since_epoch()
            ).count()
          ),
          std::memory_order_release
        );

        bool became_ready = false;
        {
          std::lock_guard lock(renderer_startup_mutex_);
          if (!renderer_ready_) {
            renderer_ready_ = true;
            became_ready = true;
          }
        }
        if (became_ready) renderer_startup_changed_.notify_all();
      }
      (void)client->Stop();
    } catch (const std::exception& error) {
      renderer_running_.store(false, std::memory_order_release);
      handleRendererFailure(
        describeAudioFailure(error),
        device_id,
        renderer_epoch,
        token.stop_requested()
      );
    } catch (...) {
      renderer_running_.store(false, std::memory_order_release);
      handleRendererFailure(AudioFailureInfo{
        AudioFailureKind::Unknown,
        "audio_unknown",
        "Remote audio renderer failed",
        S_OK,
        true,
      }, device_id, renderer_epoch, token.stop_requested());
    }
    releaseRenderSnapshot();
    if (avrt) AvRevertMmThreadCharacteristics(avrt);
    if (com_initialized) CoUninitialize();
    renderer_running_.store(false, std::memory_order_release);
  }

  void handleRendererFailure(
    AudioFailureInfo failure,
    const std::string& device_id,
    std::uint64_t renderer_epoch,
    bool stop_requested
  ) noexcept {
    bool failed_after_readiness = false;
    {
      std::lock_guard lock(renderer_startup_mutex_);
      failed_after_readiness = renderer_ready_;
      if (!failed_after_readiness) renderer_startup_failure_ = failure;
    }
    renderer_startup_changed_.notify_all();
    if (failed_after_readiness && !stop_requested) {
      scheduleRecovery(
        std::move(failure),
        device_id,
        renderer_epoch,
        true
      );
    }
  }

  struct RecoveryRequest {
    AudioFailureInfo failure;
    std::string failed_device_id;
    std::uint64_t failed_renderer_epoch = 0;
    std::uint64_t generation = 0;
  };

  static std::chrono::milliseconds recoveryDelay(std::size_t attempt) {
    if (attempt == 0) return std::chrono::milliseconds::zero();
    if (attempt == 1) return std::chrono::milliseconds(250);
    if (attempt == 2) return std::chrono::seconds(1);
    return std::chrono::seconds(5);
  }

  void scheduleRecovery(
    AudioFailureInfo failure,
    std::string failed_device_id,
    std::uint64_t failed_renderer_epoch,
    bool report_failure
  ) noexcept {
    RemoteAudioOutputState state;
    bool terminal = false;
    {
      std::lock_guard lock(mutex_);
      if (stopping_ || !output_configured_ ||
          renderer_epoch_ != failed_renderer_epoch ||
          phase_ == RemoteAudioOutputPhase::Failed) {
        return;
      }
      terminal = !failure.retryable;
      phase_ = terminal
        ? RemoteAudioOutputPhase::Failed
        : RemoteAudioOutputPhase::Recovering;
      state = outputStateLocked(
        report_failure
          ? std::optional<AudioFailureInfo>{failure}
          : std::optional<AudioFailureInfo>{},
        report_failure ? failure.message : std::string{}
      );
    }
    setIngressRendererEpoch(0);
    logRemoteAudio(
      terminal
        ? "remote_audio_renderer_failed"
        : "remote_audio_renderer_recovery_started",
      {
        {"rendererEpoch", failed_renderer_epoch},
        {"failureCode", failure.code},
        {"hresult", static_cast<std::int64_t>(failure.hresult)},
      }
    );
    publishState(std::move(state));
    if (terminal) return;

    {
      std::lock_guard lock(recovery_mutex_);
      const auto generation = ++recovery_generation_;
      recovery_request_ = RecoveryRequest{
        .failure = std::move(failure),
        .failed_device_id = std::move(failed_device_id),
        .failed_renderer_epoch = failed_renderer_epoch,
        .generation = generation,
      };
      recovery_attempt_ = 0;
      recovery_next_attempt_ = std::chrono::steady_clock::now();
      recovery_accelerated_ = true;
    }
    recovery_changed_.notify_all();
  }

  bool recoveryRequestCurrent(const RecoveryRequest& request) {
    std::lock_guard lock(recovery_mutex_);
    return recovery_request_.has_value() &&
      recovery_request_->generation == request.generation &&
      recovery_generation_ == request.generation;
  }

  void finishRecoveryAttempt(
    const RecoveryRequest& request,
    const AudioFailureInfo& failure
  ) {
    bool exhausted = false;
    std::size_t attempt = 0;
    {
      std::lock_guard lock(recovery_mutex_);
      if (!recovery_request_ ||
          recovery_request_->generation != request.generation) {
        return;
      }
      recovery_request_->failure = failure;
      ++recovery_attempt_;
      attempt = recovery_attempt_;
      exhausted = !failure.retryable ||
        recovery_attempt_ >= kMaximumRecoveryAttempts;
      if (exhausted) {
        recovery_request_.reset();
      } else {
        recovery_next_attempt_ =
          std::chrono::steady_clock::now() + recoveryDelay(recovery_attempt_);
      }
      recovery_accelerated_ = false;
    }
    if (!exhausted) {
      logRemoteAudio(
        "remote_audio_renderer_recovery_retry",
        {
          {"attempt", static_cast<std::uint64_t>(attempt)},
          {"failureCode", failure.code},
          {"hresult", static_cast<std::int64_t>(failure.hresult)},
        }
      );
      return;
    }

    RemoteAudioOutputState state;
    {
      std::lock_guard lock(mutex_);
      if (stopping_) return;
      phase_ = RemoteAudioOutputPhase::Failed;
      state = outputStateLocked(failure, failure.message);
    }
    logRemoteAudio(
      "remote_audio_renderer_recovery_exhausted",
      {
        {"attempts", static_cast<std::uint64_t>(attempt)},
        {"failureCode", failure.code},
        {"hresult", static_cast<std::int64_t>(failure.hresult)},
      }
    );
    publishState(std::move(state));
  }

  void recoverOutput(const RecoveryRequest& request) {
    std::lock_guard switch_lock(device_switch_mutex_);
    if (!recoveryRequestCurrent(request)) return;
    {
      std::lock_guard lock(mutex_);
      if (stopping_ || phase_ != RemoteAudioOutputPhase::Recovering) return;
    }

    stopRenderer();
    try {
      std::string desired;
      {
        std::lock_guard lock(mutex_);
        desired = desired_device_id_;
      }
      const auto candidate = resolveOutputCandidate(desired);
      {
        std::lock_guard lock(mutex_);
        if (stopping_) return;
        active_device_id_ = candidate.selector;
        resolved_endpoint_id_ = candidate.resolved_endpoint_id;
        using_fallback_ = candidate.using_fallback;
        phase_ = RemoteAudioOutputPhase::Starting;
      }
      startRenderer();
      if (!recoveryRequestCurrent(request)) {
        stopRenderer();
        return;
      }

      RemoteAudioOutputState state;
      AudioFailureInfo fallback{
        AudioFailureKind::EndpointInvalidated,
        "audio_output_fallback_default",
        "Selected audio output is unavailable; using system default",
        AUDCLNT_E_DEVICE_INVALIDATED,
        false,
      };
      {
        std::lock_guard lock(mutex_);
        phase_ = RemoteAudioOutputPhase::Running;
        state = outputStateLocked(
          candidate.using_fallback
            ? std::optional<AudioFailureInfo>{fallback}
            : std::optional<AudioFailureInfo>{},
          candidate.using_fallback
            ? fallback.message
            : (desired == "default"
                ? "audio_output_default_recovered"
                : "audio_output_recovered")
        );
      }
      clearRecoveryRequest();
      const auto recovered_epoch = state.renderer_epoch;
      publishState(std::move(state));
      logRemoteAudio(
        "remote_audio_renderer_recovered",
        {
          {"rendererEpoch", recovered_epoch},
          {"usingFallback", candidate.using_fallback},
        }
      );
    } catch (const std::exception& error) {
      const auto failure = describeAudioFailure(error);
      {
        std::lock_guard lock(mutex_);
        if (!stopping_) phase_ = RemoteAudioOutputPhase::Recovering;
      }
      finishRecoveryAttempt(request, failure);
    } catch (...) {
      const AudioFailureInfo failure{
        AudioFailureKind::Unknown,
        "audio_unknown",
        "Remote audio renderer recovery failed",
        S_OK,
        true,
      };
      {
        std::lock_guard lock(mutex_);
        if (!stopping_) phase_ = RemoteAudioOutputPhase::Recovering;
      }
      finishRecoveryAttempt(request, failure);
    }
  }

  void checkRenderProgress() {
    std::uint64_t renderer_epoch = 0;
    std::string active_device_id;
    {
      std::lock_guard lock(mutex_);
      if (stopping_ || phase_ != RemoteAudioOutputPhase::Running ||
          !output_configured_ ||
          !renderer_running_.load(std::memory_order_acquire)) {
        return;
      }
      renderer_epoch = renderer_epoch_;
      active_device_id = active_device_id_;
    }
    const auto last_progress = last_render_progress_ms_.load(
      std::memory_order_acquire
    );
    if (last_progress == 0) return;
    const auto now = static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()
      ).count()
    );
    if (now - last_progress < static_cast<std::uint64_t>(
          std::chrono::duration_cast<std::chrono::milliseconds>(
            kRenderProgressDeadline
          ).count()
        )) {
      return;
    }
    scheduleRecovery(
      AudioFailureInfo{
        AudioFailureKind::OperationTimedOut,
        "audio_output_progress_timeout",
        "Audio output stopped making render progress",
        HRESULT_FROM_WIN32(WAIT_TIMEOUT),
        true,
      },
      std::move(active_device_id),
      renderer_epoch,
      true
    );
  }

  void recoveryLoop(std::stop_token token) {
    std::stop_callback stop_callback(token, [this] {
      recovery_changed_.notify_all();
    });
    while (!token.stop_requested()) {
      std::optional<RecoveryRequest> request;
      {
        std::unique_lock lock(recovery_mutex_);
        recovery_changed_.wait_for(lock, kRecoveryWatchInterval, [this, &token] {
          return token.stop_requested() || recovery_request_.has_value();
        });
        if (token.stop_requested()) break;
        if (recovery_request_) {
          const auto now = std::chrono::steady_clock::now();
          if (!recovery_accelerated_ && now < recovery_next_attempt_) {
            recovery_changed_.wait_until(lock, recovery_next_attempt_);
            if (token.stop_requested()) break;
            continue;
          }
          recovery_accelerated_ = false;
          request = recovery_request_;
        }
      }
      if (request) {
        recoverOutput(*request);
      } else {
        checkRenderProgress();
      }
    }
  }

  void telemetryLoop(std::stop_token token) {
    std::stop_callback stop_callback(token, [this] {
      telemetry_changed_.notify_all();
    });
    while (!token.stop_requested()) {
      std::unique_lock lock(telemetry_mutex_);
      telemetry_changed_.wait_for(lock, std::chrono::milliseconds(100));
      lock.unlock();
      if (token.stop_requested()) break;
      collectTelemetry();
    }
  }

  void collectTelemetry() {
    RenderSnapshot snapshot;
    {
      std::lock_guard lock(mutex_);
      snapshot.reserve(tracks_.size());
      for (const auto& [_, track] : tracks_) snapshot.push_back(track);
      reclaimRetiredRenderSnapshotsLocked();
    }
    std::vector<std::string> speakers;
    speakers.reserve(snapshot.size());
    const auto now = std::chrono::steady_clock::now();
    for (const auto& track : snapshot) {
      if (!track->stream_source && !track->user_id.empty() &&
          track->speaking.load(std::memory_order_acquire)) {
        speakers.push_back(track->user_id);
      }

      const auto ingress = track->ingress->telemetry();
      const auto underruns = track->underruns.load(std::memory_order_relaxed);
      const bool dataplane_changed =
        ingress.dropped_frames != track->reported_ingress.dropped_frames ||
        ingress.suspended_frames != track->reported_ingress.suspended_frames ||
        ingress.invalid_frames != track->reported_ingress.invalid_frames ||
        ingress.discontinuities != track->reported_ingress.discontinuities ||
        underruns != track->reported_underruns;
      if (dataplane_changed && now >= track->next_dataplane_report) {
        logRemoteAudio(
          "remote_audio_direct_dataplane",
          {
            {"trackId", track->track_id},
            {"queuedFrames", static_cast<std::uint64_t>(
              track->ingress->queuedFrames()
            )},
            {"acceptedFrames", ingress.accepted_frames},
            {"droppedFrames", ingress.dropped_frames},
            {"suspendedFrames", ingress.suspended_frames},
            {"invalidFrames", ingress.invalid_frames},
            {"discontinuities", ingress.discontinuities},
            {"underruns", underruns},
            {"clockAdjustmentPpm", clock_adjustment_ppm_.load(
              std::memory_order_relaxed
            )},
          }
        );
        track->reported_ingress = ingress;
        track->reported_underruns = underruns;
        track->next_dataplane_report = now + std::chrono::seconds(5);
      }
    }

    std::sort(speakers.begin(), speakers.end());
    speakers.erase(
      std::unique(speakers.begin(), speakers.end()),
      speakers.end()
    );
    if (speakers == reported_speakers_) return;
    reported_speakers_ = speakers;
    if (!on_speaking_activity_) return;
    try {
      on_speaking_activity_(std::move(speakers));
    } catch (...) {
      logRemoteAudio("remote_audio_speaking_callback_failed");
    }
  }

  void accelerateRecovery() {
    {
      std::lock_guard lock(recovery_mutex_);
      if (!recovery_request_) return;
      recovery_accelerated_ = true;
      recovery_next_attempt_ = std::chrono::steady_clock::now();
    }
    recovery_changed_.notify_all();
  }

  void rearmRecoveryFromFailed(
    std::string failed_device_id,
    std::uint64_t failed_renderer_epoch
  ) {
    std::lock_guard switch_lock(device_switch_mutex_);
    {
      std::lock_guard lock(mutex_);
      if (stopping_ || !output_configured_ ||
          phase_ != RemoteAudioOutputPhase::Failed ||
          renderer_epoch_ != failed_renderer_epoch) {
        return;
      }
      phase_ = RemoteAudioOutputPhase::Recovering;
    }
    scheduleRecovery(
      AudioFailureInfo{
        AudioFailureKind::EndpointInvalidated,
        "audio_endpoint_available",
        "Audio output endpoint became available",
        AUDCLNT_E_DEVICE_INVALIDATED,
        true,
      },
      std::move(failed_device_id),
      failed_renderer_epoch,
      false
    );
  }

  void handleEndpointChange(AudioEndpointChange change) {
    std::string desired;
    std::string active;
    std::string resolved;
    RemoteAudioOutputPhase phase = RemoteAudioOutputPhase::Stopped;
    bool using_fallback = false;
    std::uint64_t renderer_epoch = 0;
    {
      std::lock_guard lock(mutex_);
      if (stopping_) return;
      if (!output_configured_) return;
      desired = desired_device_id_;
      active = active_device_id_;
      resolved = resolved_endpoint_id_;
      phase = phase_;
      using_fallback = using_fallback_;
      renderer_epoch = renderer_epoch_;
    }

    const bool can_rearm = remoteAudioEndpointChangeCanRearmRecovery(change);
    if (phase == RemoteAudioOutputPhase::Recovering ||
        phase == RemoteAudioOutputPhase::Starting) {
      if (can_rearm) accelerateRecovery();
      return;
    }
    if (phase == RemoteAudioOutputPhase::Failed) {
      if (can_rearm) {
        rearmRecoveryFromFailed(std::move(active), renderer_epoch);
      }
      return;
    }
    if (phase != RemoteAudioOutputPhase::Running) return;

    const bool active_lost =
      (change.kind == AudioEndpointChangeKind::Removed ||
       change.kind == AudioEndpointChangeKind::Disabled) &&
      (change.device_id == resolved || change.device_id == active);
    const bool default_changed =
      change.kind == AudioEndpointChangeKind::DefaultChanged &&
      change.role == eConsole && active == "default";
    const bool desired_returned =
      using_fallback && desired != "default" &&
      (change.kind == AudioEndpointChangeKind::Added ||
       change.kind == AudioEndpointChangeKind::Active) &&
      change.device_id == desired;
    if (!active_lost && !default_changed && !desired_returned) return;

    const bool report_failure = active_lost;
    scheduleRecovery(
      AudioFailureInfo{
        AudioFailureKind::EndpointInvalidated,
        "audio_endpoint_invalidated",
        active_lost
          ? "Audio output endpoint became unavailable"
          : "Audio output endpoint changed",
        AUDCLNT_E_DEVICE_INVALIDATED,
        true,
      },
      std::move(active),
      renderer_epoch,
      report_failure
    );
  }

  mutable std::mutex mutex_;
  std::mutex device_switch_mutex_;
  std::mutex renderer_startup_mutex_;
  std::condition_variable renderer_startup_changed_;
  std::unordered_map<std::string, std::shared_ptr<TrackState>> tracks_;
  std::unique_ptr<const RenderSnapshot> render_snapshot_owner_;
  std::vector<std::unique_ptr<const RenderSnapshot>> retired_render_snapshots_;
  std::atomic<const RenderSnapshot*> render_snapshot_source_{nullptr};
  std::atomic<const RenderSnapshot*> render_snapshot_hazard_{nullptr};
  std::string desired_device_id_ = "default";
  std::string active_device_id_;
  std::string resolved_endpoint_id_;
  RemoteAudioOutputPhase phase_ = RemoteAudioOutputPhase::Stopped;
  bool output_configured_ = false;
  bool using_fallback_ = false;
  bool stopping_ = false;
  std::atomic_bool deafened_{false};
  std::atomic<float> volume_{1.0F};
  std::atomic_bool renderer_running_{false};
  std::jthread renderer_;
  std::uint64_t renderer_epoch_ = 0;
  bool renderer_ready_ = false;
  std::optional<AudioFailureInfo> renderer_startup_failure_;
  std::atomic<std::uint64_t> last_render_progress_ms_{0};
  std::atomic<double> clock_adjustment_ppm_{0.0};
  RemoteAudioSettings settings_;
  StateHandler on_state_;
  TrackFailureHandler on_track_failure_;
  SpeakingActivityHandler on_speaking_activity_;
  std::mutex recovery_mutex_;
  std::condition_variable recovery_changed_;
  std::optional<RecoveryRequest> recovery_request_;
  std::uint64_t recovery_generation_ = 0;
  std::size_t recovery_attempt_ = 0;
  std::chrono::steady_clock::time_point recovery_next_attempt_{};
  bool recovery_accelerated_ = false;
  std::jthread recovery_worker_;
  std::mutex telemetry_mutex_;
  std::condition_variable telemetry_changed_;
  std::jthread telemetry_worker_;
  std::vector<std::string> reported_speakers_;
  std::unique_ptr<AudioEndpointMonitor> endpoint_monitor_;
};

RemoteAudioOutput::RemoteAudioOutput(
  StateHandler on_state,
  TrackFailureHandler on_track_failure,
  SpeakingActivityHandler on_speaking_activity,
  AsyncCleanupLauncher cleanup_launcher
) : cleanup_dispatcher_(&AsyncCleanupDispatcher::instance()),
    cleanup_node_(std::make_shared<AsyncCleanupNode>(
      std::move(cleanup_launcher)
    )),
    implementation_(std::make_unique<Implementation>(
      std::move(on_state),
      std::move(on_track_failure),
      std::move(on_speaking_activity)
    )) {}

RemoteAudioOutput::~RemoteAudioOutput() = default;

void RemoteAudioOutput::addTrack(
  std::string sid,
  std::string identity,
  bool stream,
  std::shared_ptr<livekit::Track> track
) {
  implementation_->addTrack(
    std::move(sid),
    std::move(identity),
    stream,
    std::move(track)
  );
}

void RemoteAudioOutput::removeTrack(const std::string& sid) {
  implementation_->removeTrack(sid);
}

void RemoteAudioOutput::setDeafened(bool value) {
  implementation_->setDeafened(value);
}

std::uint64_t RemoteAudioOutput::setOutputDevice(std::string id) {
  return implementation_->setOutputDevice(std::move(id));
}

std::string RemoteAudioOutput::outputDeviceId() const {
  return implementation_->outputDeviceId();
}

void RemoteAudioOutput::setVolume(float volume) {
  implementation_->setVolume(volume);
}

void RemoteAudioOutput::configure(RemoteAudioSettings settings) {
  implementation_->configure(std::move(settings));
}

void RemoteAudioOutput::stop() {
  implementation_->stop();
}

void RemoteAudioOutput::stop(std::shared_ptr<void> lifetime_owner) {
  if (!implementation_ || cleanup_submitted_.exchange(true)) return;
  cleanup_node_->prepare(
    std::move(lifetime_owner),
    implementation_.get(),
    [](void* context) {
      static_cast<Implementation*>(context)->stop();
    }
  );
  cleanup_dispatcher_->submit(cleanup_node_);
}

}  // namespace syrnike::desktop_native::media
