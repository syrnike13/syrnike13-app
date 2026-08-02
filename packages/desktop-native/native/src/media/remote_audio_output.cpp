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

bool retainAudioOutputEndpointRetry(
  AudioOutputDeviceIntent intent,
  AudioFailureKind failure
) noexcept {
  return intent == AudioOutputDeviceIntent::EndpointRecovery &&
    audioFailureAllowsDefaultFallback(failure);
}

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

bool readNextTrackFrame(TrackState& track) noexcept {
  const auto result = track.ingress->tryRead(track.current_frame);
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
  std::chrono::steady_clock::time_point now
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
        !readNextTrackFrame(track)) {
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
    FailureHandler on_failure,
    SpeakingActivityHandler on_speaking_activity
  ) : on_failure_(std::move(on_failure)),
      on_speaking_activity_(std::move(on_speaking_activity)) {
    render_snapshot_owner_ = std::make_unique<const RenderSnapshot>();
    render_snapshot_source_.store(
      render_snapshot_owner_.get(),
      std::memory_order_seq_cst
    );
    telemetry_worker_ = std::jthread([this](std::stop_token token) {
      telemetryLoop(token);
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

  std::uint64_t setOutputDevice(
    std::string value,
    AudioOutputDeviceIntent intent
  ) {
    std::lock_guard switch_lock(device_switch_mutex_);
    bool previous_configured = false;
    bool previous_fallback_pending = false;
    {
      std::lock_guard lock(mutex_);
      previous_configured = output_configured_;
      previous_fallback_pending = output_fallback_pending_;
      output_configured_ = true;
      output_fallback_pending_ = false;
    }
    try {
      return applyOutputDeviceLocked(std::move(value), false);
    } catch (const AudioFailure& failure) {
      std::lock_guard lock(mutex_);
      if (!stopping_) {
        const bool rollback_failed =
          failure.kind() == AudioFailureKind::RollbackFailed;
        const bool retain_recovery = retainAudioOutputEndpointRetry(
          intent,
          failure.kind()
        );
        if (rollback_failed ||
            intent == AudioOutputDeviceIntent::EndpointRecovery) {
          output_fallback_pending_ = retain_recovery;
          output_configured_ = retain_recovery;
        } else {
          output_fallback_pending_ = previous_fallback_pending;
          output_configured_ = previous_configured;
        }
      }
      throw;
    } catch (...) {
      std::lock_guard lock(mutex_);
      if (!stopping_) {
        if (intent == AudioOutputDeviceIntent::EndpointRecovery) {
          output_fallback_pending_ = false;
          output_configured_ = false;
        } else {
          output_fallback_pending_ = previous_fallback_pending;
          output_configured_ = previous_configured;
        }
      }
      throw;
    }
  }

  bool isRendererEpochCurrent(std::uint64_t epoch) const {
    std::lock_guard lock(mutex_);
    return epoch != 0 && renderer_epoch_ == epoch;
  }

  std::string outputDeviceId() const {
    std::lock_guard lock(mutex_);
    return output_device_id_;
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
    std::lock_guard switch_lock(device_switch_mutex_);
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
    for (auto& track : removed) {
      if (track->registration) track->registration->close();
      track->registration.reset();
    }
    stopRenderer();
    telemetry_worker_.request_stop();
    telemetry_changed_.notify_all();
    if (telemetry_worker_.joinable()) telemetry_worker_.join();
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
      if (!on_failure_) return;
      std::uint64_t epoch = 0;
      {
        std::lock_guard lock(mutex_);
        epoch = renderer_epoch_;
      }
      on_failure_(AudioFailureInfo{
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

  std::uint64_t applyOutputDeviceLocked(std::string value, bool force) {
    {
      std::lock_guard lock(mutex_);
      if (stopping_ ||
          (!force && output_device_id_ == value && renderer_running_.load())) {
        return renderer_epoch_;
      }
    }
    const auto requested = value;
    try {
      probeRenderDevice(
        value,
        desiredRemoteAudioRenderFormat(),
        std::chrono::milliseconds(750)
      );
    } catch (const AudioFailure& failure) {
      if (value.empty() || value == "default" ||
          !audioFailureAllowsDefaultFallback(failure.kind())) {
        throw;
      }
      value = "default";
      probeRenderDevice(
        value,
        desiredRemoteAudioRenderFormat(),
        std::chrono::milliseconds(750)
      );
    }

    std::string previous;
    {
      std::lock_guard lock(mutex_);
      previous = output_device_id_;
    }
    stopRenderer();
    {
      std::lock_guard lock(mutex_);
      if (stopping_) return renderer_epoch_;
      output_device_id_ = std::move(value);
    }
    startAudioOutputWithRollback(
      [this] { startRenderer(); },
      [this, &previous] {
        std::lock_guard lock(mutex_);
        output_device_id_ = previous;
      },
      [this] { startRenderer(); }
    );

    std::string active;
    std::uint64_t active_epoch = 0;
    {
      std::lock_guard lock(mutex_);
      active = output_device_id_;
      active_epoch = renderer_epoch_;
    }
    if (requested != active && on_failure_) {
      on_failure_(AudioFailureInfo{
        AudioFailureKind::EndpointInvalidated,
        "audio_output_fallback_default",
        "Selected audio output is unavailable; using system default",
        AUDCLNT_E_DEVICE_INVALIDATED,
        false,
      }, requested, active_epoch);
    }
    return active_epoch;
  }

  void startRenderer() {
    {
      std::lock_guard lock(renderer_startup_mutex_);
      renderer_ready_ = false;
      renderer_startup_failure_.reset();
    }
    renderer_running_.store(true, std::memory_order_release);
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
  }

  void stopRenderer() {
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
        device_id = output_device_id_;
      }
      auto device = renderDevice(device_id);
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
            now
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
      handleRendererFailure(
        describeAudioFailure(error),
        device_id,
        renderer_epoch,
        token.stop_requested()
      );
    } catch (...) {
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
    if (failed_after_readiness && !stop_requested &&
        renderer_running_.load(std::memory_order_acquire) && on_failure_) {
      try {
        on_failure_(std::move(failure), device_id, renderer_epoch);
      } catch (...) {
        logRemoteAudio("remote_audio_renderer_failure_callback_failed");
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
    for (const auto& track : snapshot) {
      if (!track->stream_source && !track->user_id.empty() &&
          track->speaking.load(std::memory_order_acquire)) {
        speakers.push_back(track->user_id);
      }

      const auto ingress = track->ingress->telemetry();
      const auto underruns = track->underruns.load(std::memory_order_relaxed);
      if (ingress.dropped_frames != track->reported_ingress.dropped_frames ||
          ingress.invalid_frames != track->reported_ingress.invalid_frames ||
          ingress.discontinuities !=
            track->reported_ingress.discontinuities ||
          underruns != track->reported_underruns) {
        logRemoteAudio(
          "remote_audio_direct_dataplane",
          {
            {"trackId", track->track_id},
            {"queuedFrames", static_cast<std::uint64_t>(
              track->ingress->queuedFrames()
            )},
            {"acceptedFrames", ingress.accepted_frames},
            {"droppedFrames", ingress.dropped_frames},
            {"invalidFrames", ingress.invalid_frames},
            {"discontinuities", ingress.discontinuities},
            {"underruns", underruns},
            {"clockAdjustmentPpm", clock_adjustment_ppm_.load(
              std::memory_order_relaxed
            )},
          }
        );
      }
      track->reported_ingress = ingress;
      track->reported_underruns = underruns;
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

  void handleEndpointChange(AudioEndpointChange change) {
    std::lock_guard switch_lock(device_switch_mutex_);
    std::string selected;
    bool fallback_pending = false;
    {
      std::lock_guard lock(mutex_);
      if (stopping_) return;
      selected = output_device_id_;
      fallback_pending = output_fallback_pending_;
      if (!configuredAudioOutputEndpointChangeRequiresDefaultRetry(
            output_configured_,
            selected,
            fallback_pending,
            change
          )) {
        return;
      }
    }

    const bool follows_default = selected.empty() || selected == "default";
    const bool selected_lost =
      !follows_default && selected == change.device_id;
    try {
      applyOutputDeviceLocked("default", true);
      {
        std::lock_guard lock(mutex_);
        output_fallback_pending_ = false;
      }
      if ((selected_lost || fallback_pending) && on_failure_) {
        std::uint64_t active_epoch = 0;
        {
          std::lock_guard lock(mutex_);
          active_epoch = renderer_epoch_;
        }
        const bool explicit_fallback = !follows_default;
        on_failure_(AudioFailureInfo{
          AudioFailureKind::EndpointInvalidated,
          explicit_fallback
            ? "audio_output_fallback_default"
            : "audio_output_default_recovered",
          explicit_fallback
            ? "Selected audio output disappeared; using system default"
            : "Default audio output recovered",
          AUDCLNT_E_DEVICE_INVALIDATED,
          false,
        }, selected, active_epoch);
      }
    } catch (const std::exception& error) {
      const auto failure = describeAudioFailure(error);
      std::uint64_t active_epoch = 0;
      {
        std::lock_guard lock(mutex_);
        if (!stopping_) {
          output_fallback_pending_ =
            audioFailureAllowsDefaultFallback(failure.kind);
        }
        active_epoch = renderer_epoch_;
      }
      if (on_failure_) on_failure_(failure, "default", active_epoch);
    }
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
  std::string output_device_id_ = "default";
  bool output_fallback_pending_ = false;
  bool output_configured_ = false;
  bool stopping_ = false;
  std::atomic_bool deafened_{false};
  std::atomic<float> volume_{1.0F};
  std::atomic_bool renderer_running_{false};
  std::jthread renderer_;
  std::uint64_t renderer_epoch_ = 0;
  bool renderer_ready_ = false;
  std::optional<AudioFailureInfo> renderer_startup_failure_;
  std::atomic<double> clock_adjustment_ppm_{0.0};
  RemoteAudioSettings settings_;
  FailureHandler on_failure_;
  SpeakingActivityHandler on_speaking_activity_;
  std::mutex telemetry_mutex_;
  std::condition_variable telemetry_changed_;
  std::jthread telemetry_worker_;
  std::vector<std::string> reported_speakers_;
  std::unique_ptr<AudioEndpointMonitor> endpoint_monitor_;
};

RemoteAudioOutput::RemoteAudioOutput(
  FailureHandler on_failure,
  SpeakingActivityHandler on_speaking_activity,
  AsyncCleanupLauncher cleanup_launcher
) : cleanup_dispatcher_(&AsyncCleanupDispatcher::instance()),
    cleanup_node_(std::make_shared<AsyncCleanupNode>(
      std::move(cleanup_launcher)
    )),
    implementation_(std::make_unique<Implementation>(
      std::move(on_failure),
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

std::uint64_t RemoteAudioOutput::setOutputDevice(
  std::string id,
  AudioOutputDeviceIntent intent
) {
  return implementation_->setOutputDevice(std::move(id), intent);
}

bool RemoteAudioOutput::isRendererEpochCurrent(std::uint64_t epoch) const {
  return implementation_->isRendererEpochCurrent(epoch);
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
