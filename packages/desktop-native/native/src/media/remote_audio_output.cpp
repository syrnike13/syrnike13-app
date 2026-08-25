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
#include <limits>
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
#include "realtime_snapshot.hpp"
#include "remote_audio_ingress.hpp"
#include "remote_audio_playout.hpp"
#include "voice_activity_detector.hpp"
#include "wasapi_event.hpp"
#include "windows_audio_session_policy.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::desktop_native::media {

namespace detail {

namespace {
thread_local bool remote_audio_realtime_fill = false;
std::atomic<std::uint64_t> realtime_snapshot_destructions{0};
}  // namespace

std::uint64_t remoteAudioRealtimeSnapshotDestructions() noexcept {
  return realtime_snapshot_destructions.load(std::memory_order_acquire);
}

void resetRemoteAudioRealtimeSnapshotDestructions() noexcept {
  realtime_snapshot_destructions.store(0, std::memory_order_release);
}

class RemoteAudioRealtimeFillScope final {
 public:
  RemoteAudioRealtimeFillScope() noexcept
    : previous_(remote_audio_realtime_fill) {
    remote_audio_realtime_fill = true;
  }
  ~RemoteAudioRealtimeFillScope() { remote_audio_realtime_fill = previous_; }
  static bool active() noexcept { return remote_audio_realtime_fill; }

 private:
  bool previous_ = false;
};

bool remoteAudioRealtimeFillActive() noexcept {
  return RemoteAudioRealtimeFillScope::active();
}

}  // namespace detail

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
constexpr std::uint32_t kRemoteAudioTargetPaddingFrames =
  remoteAudioRenderTargetPaddingFrames();
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

detail::RemoteAudioRenderFillPlan rendererFillPlan(
  std::uint32_t capacity_frames,
  std::uint32_t padding_frames
) noexcept {
  return detail::RemoteAudioRenderFillPlan(
    capacity_frames,
    padding_frames,
    static_cast<std::uint32_t>(kRemoteAudioIngressFramesPerPacket),
    kRemoteAudioTargetPaddingFrames
  );
}

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

AudioFailureInfo describeCurrentAudioFailure() noexcept {
  try {
    throw;
  } catch (const std::exception& error) {
    return describeAudioFailure(error);
  } catch (...) {
    return {
      AudioFailureKind::Unknown,
      "audio_unknown",
      "Unknown remote audio renderer failure",
      S_OK,
      true,
    };
  }
}

void logWindowsAudioPolicy(
  const WindowsAudioPolicyOutcome& policy,
  std::uint64_t renderer_epoch
) {
  logRemoteAudio(
    "windows_audio_session_policy",
    {
      {"use", windowsAudioSessionUseName(policy.use)},
      {"stage", windowsAudioPolicyStageName(policy.stage)},
      {"status", windowsAudioPolicyStatusName(policy.status)},
      {"reason", windowsAudioPolicyReasonCode(policy)},
      {"category", windowsAudioCategoryName(policy.category)},
      {"hresult", static_cast<std::int64_t>(policy.hresult)},
      {"rendererEpoch", renderer_epoch}
    }
  );
}

struct TrackState {
  std::shared_ptr<RemoteAudioIngress> ingress;
  std::unique_ptr<livekit::AudioFrameSinkRegistration> registration;
  std::string user_id;
  std::string track_id;
  bool stream_source = false;
  std::atomic<float> gain{1.0F};
  // Packed as renderer_epoch << 1 | speaking so a late quarantined renderer
  // cannot overwrite speaking activity published by its replacement.
  std::atomic<std::uint64_t> speaking_state{0};
  std::atomic<std::uint64_t> reset_epoch{0};
  std::atomic<std::uint64_t> underruns{0};
  std::atomic<std::uint64_t> rendered_frames{0};

  // Telemetry-thread state.
  RemoteAudioIngressTelemetry reported_ingress;
  std::uint64_t reported_underruns = 0;
  std::chrono::steady_clock::time_point next_dataplane_report{};
};

// Mutable playout state belongs to one renderer attempt. A quarantined
// attempt can finish or hang without sharing these fields with its successor.
struct TrackRendererState {
  RemoteAudioIngressFrame current_frame;
  std::size_t current_frame_offset = kRemoteAudioIngressFramesPerPacket;
  bool playout_started = false;
  std::uint64_t consumed_reset_epoch = 0;
  VoiceActivityDetector activity;
  std::array<StereoFrame, kRemoteAudioIngressFramesPerPacket> scratch{};
  float previous_left = 0.0F;
  float previous_right = 0.0F;
  std::size_t fade_in_remaining = 0;
};

struct RenderTrackState {
  std::shared_ptr<TrackState> track;
  std::shared_ptr<TrackRendererState> renderer;
};

struct RenderSnapshot final
    : public std::vector<RenderTrackState> {
  ~RenderSnapshot() {
    if (detail::RemoteAudioRealtimeFillScope::active()) {
      detail::realtime_snapshot_destructions.fetch_add(
        1,
        std::memory_order_relaxed
      );
    }
  }
};
using TrackSnapshot = std::vector<std::shared_ptr<TrackState>>;
using RenderSnapshotDomain =
  RealtimeSnapshotDomain<RenderSnapshot, 8>;

void publishTrackSpeaking(
  TrackState& track,
  std::uint64_t renderer_epoch,
  bool speaking
) noexcept {
  if (renderer_epoch == 0 ||
      renderer_epoch > (std::numeric_limits<std::uint64_t>::max() >> 1)) {
    return;
  }
  const auto next = (renderer_epoch << 1) | (speaking ? 1ULL : 0ULL);
  auto current = track.speaking_state.load(std::memory_order_relaxed);
  while ((current >> 1) <= renderer_epoch &&
         !track.speaking_state.compare_exchange_weak(
           current,
           next,
           std::memory_order_release,
           std::memory_order_relaxed
         )) {}
}

bool trackSpeakingFor(
  const TrackState& track,
  std::uint64_t renderer_epoch
) noexcept {
  const auto state = track.speaking_state.load(std::memory_order_acquire);
  return (state >> 1) == renderer_epoch && (state & 1ULL) != 0;
}

struct RendererTelemetrySnapshot {
  bool mmcss_registered = false;
  std::uint64_t capacity_frames = 0;
  std::uint64_t last_padding_frames = 0;
  std::uint64_t minimum_padding_frames =
    std::numeric_limits<std::uint64_t>::max();
  std::uint64_t maximum_writable_frames = 0;
  std::uint64_t maximum_wake_gap_ms = 0;
  std::uint64_t zero_padding_events = 0;
  std::uint64_t multi_chunk_writes = 0;
  std::uint64_t catch_up_frames = 0;
  std::uint64_t frames_written = 0;
};

class RendererThreadEnvironment final {
 public:
  RendererThreadEnvironment() {
    const auto result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(result)) {
      throwAudioFailure(result, "initialize remote audio renderer COM failed");
    }
    com_initialized_ = true;
    avrt_ = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index_);
    avrt_error_ = avrt_ ? ERROR_SUCCESS : GetLastError();
    if (avrt_) {
      if (AvSetMmThreadPriority(avrt_, AVRT_PRIORITY_HIGH)) {
        priority_boosted_ = true;
      } else {
        priority_error_ = GetLastError();
      }
    }
  }

  ~RendererThreadEnvironment() {
    if (avrt_) AvRevertMmThreadCharacteristics(avrt_);
    if (com_initialized_) CoUninitialize();
  }

  RendererThreadEnvironment(const RendererThreadEnvironment&) = delete;
  RendererThreadEnvironment& operator=(const RendererThreadEnvironment&) =
    delete;

  [[nodiscard]] bool mmcssRegistered() const noexcept {
    return avrt_ != nullptr;
  }

  [[nodiscard]] std::uint32_t mmcssError() const noexcept {
    return static_cast<std::uint32_t>(avrt_error_);
  }

  [[nodiscard]] bool mmcssPriorityBoosted() const noexcept {
    return priority_boosted_;
  }

  [[nodiscard]] std::uint32_t mmcssPriorityError() const noexcept {
    return static_cast<std::uint32_t>(priority_error_);
  }

 private:
  bool com_initialized_ = false;
  DWORD task_index_ = 0;
  HANDLE avrt_ = nullptr;
  DWORD avrt_error_ = ERROR_SUCCESS;
  bool priority_boosted_ = false;
  DWORD priority_error_ = ERROR_SUCCESS;
};

class WindowsRemoteAudioEndpointSubscription final
    : public RemoteAudioEndpointSubscription {
 public:
  explicit WindowsRemoteAudioEndpointSubscription(
    std::function<void(const AudioEndpointChange&)> handler
  ) : monitor_(std::make_unique<AudioEndpointMonitor>(
        eRender,
        [handler = std::move(handler)](AudioEndpointChange change) {
          handler(change);
        }
      )) {}

 private:
  std::unique_ptr<AudioEndpointMonitor> monitor_;
};

class WindowsRemoteAudioRendererPlatformAdapter final
    : public RemoteAudioRendererPlatformAdapter {
 public:
  void runRenderer(
    RemoteAudioOperationAttempt::Context& context,
    RemoteAudioRendererRequest request
  ) override {
    context.setStage(RemoteAudioExternalStage::EndpointProbe);
    RendererThreadEnvironment thread_environment;
    if (request.mmcss_changed) {
      request.mmcss_changed(
        thread_environment.mmcssRegistered(),
        thread_environment.mmcssError()
      );
    }
    logRemoteAudio(
      "remote_audio_renderer_mmcss",
      {
        {"rendererEpoch", request.renderer_epoch},
        {"registered", thread_environment.mmcssRegistered()},
        {"win32Error", static_cast<std::uint64_t>(
          thread_environment.mmcssError()
        )},
        {"priorityBoosted", thread_environment.mmcssPriorityBoosted()},
        {"priorityWin32Error", static_cast<std::uint64_t>(
          thread_environment.mmcssPriorityError()
        )},
      }
    );

    WasapiEventPair stream_events;
    std::stop_callback stop_callback(context.stopToken(), [&stream_events] {
      stream_events.requestStop();
    });
    auto device = renderDevice(request.device_id);
    if (context.stopRequested()) return;

    context.setStage(RemoteAudioExternalStage::EndpointResolve);
    auto resolved_endpoint_id = audioEndpointId(device.Get());
    if (resolved_endpoint_id.empty()) {
      throw AudioFailure(
        AudioFailureKind::DeviceNotFound,
        "resolved audio output has no endpoint id",
        HRESULT_FROM_WIN32(ERROR_NOT_FOUND)
      );
    }
    if (request.endpoint_resolved) {
      request.endpoint_resolved(std::move(resolved_endpoint_id));
    }
    if (context.stopRequested()) return;

    context.setStage(RemoteAudioExternalStage::Activate);
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
    if (context.stopRequested()) return;

    context.setStage(RemoteAudioExternalStage::Initialize);
    auto format = desiredRemoteAudioRenderFormat();
    constexpr auto requested_buffer_duration =
      remoteAudioRenderBufferDuration();
    const auto policy_attempt = request.audio_attempt_policy->run(
      client.Get(),
      WindowsAudioSessionUse::RemotePlayback,
      AUDCLNT_STREAMOPTIONS_NONE,
      [&] {
        return client->Initialize(
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
      }
    );
    logWindowsAudioPolicy(policy_attempt.category, request.renderer_epoch);
    if (policy_attempt.ducking) {
      logWindowsAudioPolicy(*policy_attempt.ducking, request.renderer_epoch);
    }
    const auto initialize_result = policy_attempt.initialize.hresult;
    if (FAILED(initialize_result)) {
      throwAudioFailure(initialize_result, "initialize render stream failed");
    }
    const auto event_result = client->SetEventHandle(
      stream_events.audioReadyHandle()
    );
    if (FAILED(event_result)) {
      throwAudioFailure(event_result, "set render stream event failed");
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
    BYTE* initial_output = nullptr;
    const auto prime_frames = (std::min)(capacity, kRemoteAudioTargetPaddingFrames);
    const auto prime_result = render_client->GetBuffer(
      prime_frames,
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
      prime_frames,
      AUDCLNT_BUFFERFLAGS_SILENT
    );
    if (FAILED(release_prime_result)) {
      throwAudioFailure(
        release_prime_result,
        "release primed render buffer failed",
        AudioFailureKind::IoFailed
      );
    }
    if (context.stopRequested()) return;

    context.setStage(RemoteAudioExternalStage::Start);
    const auto start_result = client->Start();
    if (FAILED(start_result)) {
      throwAudioFailure(
        start_result,
        "start render failed",
        AudioFailureKind::ClientStartFailed
      );
    }

    std::exception_ptr render_failure;
    try {
      context.setStage(RemoteAudioExternalStage::Render);
      std::optional<std::chrono::steady_clock::time_point> previous_wakeup;
      while (!context.stopRequested()) {
        const auto wait_result = stream_events.wait(1'000);
        if (wait_result == WasapiEventPair::WaitResult::StopRequested) break;
        if (wait_result == WasapiEventPair::WaitResult::TimedOut) continue;
        const auto wakeup = std::chrono::steady_clock::now();
        const auto wake_gap_ms = previous_wakeup
          ? static_cast<std::uint64_t>(
              std::chrono::duration_cast<std::chrono::milliseconds>(
                wakeup - *previous_wakeup
              ).count()
            )
          : 0;
        previous_wakeup = wakeup;

        UINT32 padding = 0;
        const auto padding_result = client->GetCurrentPadding(&padding);
        if (FAILED(padding_result)) {
          throwAudioFailure(
            padding_result,
            "query render padding failed",
            AudioFailureKind::IoFailed
          );
        }
        detail::RemoteAudioRenderFillPlan fill_plan = rendererFillPlan(
          capacity,
          padding
        );
        const auto write_frames = fill_plan.totalFrames();
        if (write_frames == 0) continue;

        BYTE* output = nullptr;
        const auto buffer_result = render_client->GetBuffer(
          write_frames,
          &output
        );
        if (FAILED(buffer_result)) {
          throwAudioFailure(
            buffer_result,
            "acquire render buffer failed",
            AudioFailureKind::IoFailed
          );
        }
        if (!request.fill) {
          throw std::logic_error("remote audio renderer fill callback is missing");
        }
        const auto fill = request.fill(RemoteAudioRenderBuffer{
          .interleaved_samples = reinterpret_cast<float*>(output),
          .capacity_frames = capacity,
          .padding_frames = padding,
          .writable_frames = write_frames,
          .wake_gap_ms = wake_gap_ms,
          .wake_time = wakeup,
        });
        const auto release_result = render_client->ReleaseBuffer(
          write_frames,
          fill.silent ? AUDCLNT_BUFFERFLAGS_SILENT : 0
        );
        if (FAILED(release_result)) {
          throwAudioFailure(
            release_result,
            "release render buffer failed",
            AudioFailureKind::IoFailed
          );
        }
        if (fill.adjusted_sample_rate) {
          const auto adjustment_result = clock_adjustment->SetSampleRate(
            *fill.adjusted_sample_rate
          );
          if (FAILED(adjustment_result)) {
            throwAudioFailure(
              adjustment_result,
              "adjust render clock failed",
              AudioFailureKind::IoFailed
            );
          }
        }
        const auto accepted = !request.render_progress ||
          request.render_progress(RemoteAudioRenderProgress{
            .capacity_frames = capacity,
            .padding_frames = padding,
            .writable_frames = write_frames,
            .wake_gap_ms = wake_gap_ms,
          });
        if (accepted) static_cast<void>(context.markReady());
      }
    } catch (...) {
      render_failure = std::current_exception();
    }

    context.setStage(RemoteAudioExternalStage::Stop);
    const auto stop_result = client->Stop();
    if (FAILED(stop_result) && !render_failure) {
      throwAudioFailure(
        stop_result,
        "stop render failed",
        AudioFailureKind::IoFailed
      );
    }
    if (render_failure) std::rethrow_exception(render_failure);
  }

  std::unique_ptr<RemoteAudioEndpointSubscription> monitorEndpoints(
    std::function<void(const AudioEndpointChange&)> handler
  ) override {
    return std::make_unique<WindowsRemoteAudioEndpointSubscription>(
      std::move(handler)
    );
  }
};

void storeMaximum(
  std::atomic<std::uint64_t>& destination,
  std::uint64_t value
) noexcept {
  auto current = destination.load(std::memory_order_relaxed);
  while (
    current < value &&
    !destination.compare_exchange_weak(
      current,
      value,
      std::memory_order_relaxed
    )
  ) {}
}

void storeMinimum(
  std::atomic<std::uint64_t>& destination,
  std::uint64_t value
) noexcept {
  auto current = destination.load(std::memory_order_relaxed);
  while (
    current > value &&
    !destination.compare_exchange_weak(
      current,
      value,
      std::memory_order_relaxed
    )
  ) {}
}

void resetTrackRendererState(
  TrackState& track,
  TrackRendererState& renderer,
  std::uint64_t renderer_epoch,
  bool discard_queued = true
) noexcept {
  if (discard_queued) track.ingress->discardQueued(renderer_epoch);
  renderer.current_frame_offset = kRemoteAudioIngressFramesPerPacket;
  renderer.playout_started = false;
  renderer.fade_in_remaining = 0;
  renderer.previous_left = 0.0F;
  renderer.previous_right = 0.0F;
  renderer.activity.reset();
  if (track.ingress->activeFor(renderer_epoch)) {
    publishTrackSpeaking(track, renderer_epoch, false);
  }
}

void fadeTrackToSilence(
  TrackRendererState& renderer,
  std::size_t produced_frames,
  std::size_t requested_frames
) noexcept {
  if (produced_frames == 0) {
    const auto fade_frames = std::min(kFadeFrames, requested_frames);
    for (std::size_t index = 0; index < fade_frames; ++index) {
      const auto gain = 1.0F -
        static_cast<float>(index + 1) / static_cast<float>(fade_frames);
      renderer.scratch[index] = {
        renderer.previous_left * gain,
        renderer.previous_right * gain,
      };
    }
  } else {
    const auto fade_frames = std::min(kFadeFrames, produced_frames);
    const auto first = produced_frames - fade_frames;
    for (std::size_t index = 0; index < fade_frames; ++index) {
      const auto gain = 1.0F -
        static_cast<float>(index + 1) / static_cast<float>(fade_frames);
      renderer.scratch[first + index].left *= gain;
      renderer.scratch[first + index].right *= gain;
    }
  }
  renderer.previous_left = 0.0F;
  renderer.previous_right = 0.0F;
}

bool readNextTrackFrame(
  TrackState& track,
  TrackRendererState& renderer,
  std::uint64_t renderer_epoch
) noexcept {
  const auto result = track.ingress->tryRead(
    renderer.current_frame,
    renderer_epoch
  );
  if (result == RemoteAudioIngressReadResult::Frame) {
    renderer.current_frame_offset = 0;
    return true;
  }
  if (result == RemoteAudioIngressReadResult::Discontinuity) {
    resetTrackRendererState(track, renderer, renderer_epoch, false);
  }
  return false;
}

bool renderTrack(
  TrackState& track,
  TrackRendererState& renderer,
  StereoFrame* mixed,
  std::size_t frame_count,
  std::size_t scheduled_frames,
  float output_volume,
  bool deafened,
  std::chrono::steady_clock::time_point now,
  std::uint64_t renderer_epoch
) noexcept {
  std::fill_n(renderer.scratch.begin(), frame_count, StereoFrame{});

  const auto reset_epoch = track.reset_epoch.load(std::memory_order_acquire);
  if (reset_epoch != renderer.consumed_reset_epoch) {
    resetTrackRendererState(track, renderer, renderer_epoch);
    renderer.consumed_reset_epoch = reset_epoch;
  }

  const auto now_us = static_cast<std::uint64_t>(
    std::chrono::duration_cast<std::chrono::microseconds>(
      now.time_since_epoch()
    ).count()
  );
  const bool has_current_frame =
    renderer.current_frame_offset < kRemoteAudioIngressFramesPerPacket;
  const auto freshness = track.ingress->enforceFreshness(
    now_us,
    scheduled_frames,
    has_current_frame ? renderer.current_frame.ingress_steady_us : 0,
    has_current_frame
      ? kRemoteAudioIngressFramesPerPacket - renderer.current_frame_offset
      : 0,
    renderer_epoch
  );
  if (freshness.recovered) {
    resetTrackRendererState(track, renderer, renderer_epoch, false);
  }

  if (!renderer.playout_started) {
    if (track.ingress->queuedFrames() < kPlayoutStartPackets) {
      if (!track.stream_source && track.ingress->activeFor(renderer_epoch)) {
        renderer.activity.updateRms(0.0F, true, now);
        publishTrackSpeaking(
          track,
          renderer_epoch,
          renderer.activity.speaking()
        );
      }
      return false;
    }
    renderer.playout_started = true;
    renderer.fade_in_remaining = kFadeFrames;
  }

  std::size_t produced_frames = 0;
  for (; produced_frames < frame_count; ++produced_frames) {
    if (renderer.current_frame_offset == kRemoteAudioIngressFramesPerPacket &&
        !readNextTrackFrame(track, renderer, renderer_epoch)) {
      break;
    }
    const auto sample_index =
      renderer.current_frame_offset * kRemoteAudioChannels;
    if (sample_index + 1 >= renderer.current_frame.samples.size()) {
      resetTrackRendererState(track, renderer, renderer_epoch, false);
      break;
    }
    auto left = static_cast<float>(renderer.current_frame.samples[sample_index]) /
      32768.0F;
    auto right = static_cast<float>(
      renderer.current_frame.samples[sample_index + 1]
    ) /
      32768.0F;
    ++renderer.current_frame_offset;
    if (renderer.fade_in_remaining != 0) {
      const auto fade_gain = 1.0F -
        static_cast<float>(renderer.fade_in_remaining) /
          static_cast<float>(kFadeFrames);
      left *= fade_gain;
      right *= fade_gain;
      --renderer.fade_in_remaining;
    }
    renderer.scratch[produced_frames] = {left, right};
  }

  if (produced_frames != frame_count) {
    fadeTrackToSilence(renderer, produced_frames, frame_count);
    renderer.playout_started = false;
    renderer.current_frame_offset = kRemoteAudioIngressFramesPerPacket;
    if (track.ingress->activeFor(renderer_epoch)) {
      track.underruns.fetch_add(1, std::memory_order_relaxed);
    }
  } else if (frame_count != 0) {
    renderer.previous_left = renderer.scratch[frame_count - 1].left;
    renderer.previous_right = renderer.scratch[frame_count - 1].right;
  }

  const auto track_gain = track.gain.load(std::memory_order_relaxed);
  const auto effective_gain = track_gain * output_volume;
  double squared_sum = 0.0;
  for (std::size_t index = 0; index < frame_count; ++index) {
    const auto left = renderer.scratch[index].left * effective_gain;
    const auto right = renderer.scratch[index].right * effective_gain;
    if (!deafened) {
      mixed[index].left += left;
      mixed[index].right += right;
    }
    const auto mono = (left + right) * 0.5F;
    squared_sum += static_cast<double>(mono) * static_cast<double>(mono);
  }

  if (!track.stream_source && track.ingress->activeFor(renderer_epoch)) {
    const auto activity_enabled = !deafened && effective_gain > 0.0F;
    const auto rms = frame_count == 0
      ? 0.0F
      : static_cast<float>(std::sqrt(
          squared_sum / static_cast<double>(frame_count)
        ));
    renderer.activity.updateRms(rms, activity_enabled, now);
    publishTrackSpeaking(track, renderer_epoch, renderer.activity.speaking());
  }
  track.rendered_frames.fetch_add(produced_frames, std::memory_order_relaxed);
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

std::shared_ptr<RemoteAudioRendererPlatformAdapter>
createWindowsRemoteAudioRendererPlatformAdapter() {
  return std::make_shared<WindowsRemoteAudioRendererPlatformAdapter>();
}

class RemoteAudioOutput::Implementation final
    : public std::enable_shared_from_this<Implementation> {
 public:
  Implementation(
    StateHandler on_state,
    TrackFailureHandler on_track_failure,
    SpeakingActivityHandler on_speaking_activity,
    std::shared_ptr<RemoteAudioRendererPlatformAdapter> platform_adapter,
    RemoteAudioOperationDeadlines operation_deadlines,
    std::shared_ptr<RemoteAudioAttemptDomain> attempt_domain,
    std::shared_ptr<WindowsAudioSessionAttemptPolicy> audio_attempt_policy
  ) : render_snapshots_(std::make_unique<const RenderSnapshot>()),
      on_state_(std::move(on_state)),
      on_track_failure_(std::move(on_track_failure)),
      on_speaking_activity_(std::move(on_speaking_activity)),
      platform_adapter_(platform_adapter
        ? std::move(platform_adapter)
        : createWindowsRemoteAudioRendererPlatformAdapter()),
      operation_deadlines_(operation_deadlines),
      attempt_domain_(attempt_domain
        ? std::move(attempt_domain)
        : std::make_shared<RemoteAudioAttemptDomain>()),
      audio_attempt_policy_(audio_attempt_policy
        ? std::move(audio_attempt_policy)
        : defaultWindowsAudioSessionAttemptPolicy()) {
    if (operation_deadlines_.startup <= std::chrono::milliseconds::zero() ||
        operation_deadlines_.retirement <=
          std::chrono::milliseconds::zero()) {
      throw std::invalid_argument(
        "remote audio operation deadlines must be positive"
      );
    }
  }

  void start() {
    telemetry_worker_ = std::jthread([this](std::stop_token token) {
      telemetryLoop(token);
    });
    recovery_worker_ = std::jthread([this](std::stop_token token) {
      recoveryLoop(token);
    });
    try {
      const std::weak_ptr<Implementation> weak = shared_from_this();
      endpoint_subscription_ = platform_adapter_->monitorEndpoints(
        [weak](const AudioEndpointChange& change) {
          if (const auto owner = weak.lock()) {
            owner->handleEndpointChange(change);
          }
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

  std::optional<RemoteAudioPlayoutSnapshot> playoutSnapshot(
    std::string_view sid
  ) const {
    std::shared_ptr<TrackState> track;
    std::uint64_t renderer_epoch = 0;
    {
      std::lock_guard lock(mutex_);
      const auto found = tracks_.find(std::string(sid));
      if (found == tracks_.end()) return std::nullopt;
      track = found->second;
      renderer_epoch = renderer_epoch_;
    }
    const auto ingress = track->ingress->telemetry();
    const auto renderer = rendererTelemetry();
    return RemoteAudioPlayoutSnapshot{
      .track_id = track->track_id,
      .renderer_epoch = renderer_epoch,
      .ingress_frames = ingress.accepted_frames,
      .renderer_fill_callbacks =
        renderer_fill_callbacks_.load(std::memory_order_relaxed),
      .rendered_track_frames =
        track->rendered_frames.load(std::memory_order_relaxed),
      .renderer_frames_written = renderer.frames_written,
      .maximum_wake_gap_ms = renderer.maximum_wake_gap_ms,
      .freshness_recoveries = ingress.freshness_recoveries,
      .last_scheduled_playout_age_us =
        ingress.last_scheduled_playout_age_us,
      .maximum_scheduled_playout_age_us =
        ingress.maximum_scheduled_playout_age_us,
    };
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
    endpoint_subscription_.reset();
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
    if (renderer_track_state_epoch_ != 0) {
      for (const auto& [_, track] : tracks_) {
        if (!active_renderer_tracks_.contains(track.get())) {
          active_renderer_tracks_.emplace(
            track.get(),
            std::make_shared<TrackRendererState>()
          );
        }
      }
      std::erase_if(active_renderer_tracks_, [this](const auto& entry) {
        return std::none_of(
          tracks_.begin(),
          tracks_.end(),
          [&entry](const auto& track) {
            return track.second.get() == entry.first;
          }
        );
      });
      snapshot->reserve(tracks_.size());
      for (const auto& [_, track] : tracks_) {
        snapshot->push_back(RenderTrackState{
          track,
          active_renderer_tracks_.at(track.get()),
        });
      }
    }
    render_snapshots_.publish(std::move(snapshot));
  }

  void resetRendererTrackStatesLocked(std::uint64_t renderer_epoch) {
    renderer_track_state_epoch_ = renderer_epoch;
    active_renderer_tracks_.clear();
    publishRenderSnapshotLocked();
  }

  void clearRendererTrackStates(std::uint64_t renderer_epoch) {
    std::lock_guard lock(mutex_);
    if (renderer_track_state_epoch_ != renderer_epoch) return;
    resetRendererTrackStatesLocked(0);
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

  OutputCandidate startOutputCandidate(const std::string& desired) {
    {
      std::lock_guard lock(mutex_);
      active_device_id_ = desired;
      resolved_endpoint_id_.clear();
      using_fallback_ = false;
      phase_ = RemoteAudioOutputPhase::Starting;
    }
    try {
      startRenderer();
    } catch (const AudioFailure& failure) {
      if (desired == "default" ||
          !audioFailureAllowsDefaultFallback(failure.kind())) {
        throw;
      }
      {
        std::lock_guard lock(mutex_);
        active_device_id_ = "default";
        resolved_endpoint_id_.clear();
        using_fallback_ = true;
        phase_ = RemoteAudioOutputPhase::Starting;
      }
      startRenderer();
    }
    std::lock_guard lock(mutex_);
    return {
      .selector = active_device_id_,
      .resolved_endpoint_id = resolved_endpoint_id_,
      .using_fallback = using_fallback_,
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
    const auto attempts = attempt_domain_->snapshot();
    return {
      .phase = phase_,
      .desired_device_id = desired_device_id_,
      .active_device_id = active_device_id_,
      .resolved_endpoint_id = resolved_endpoint_id_,
      .renderer_epoch = renderer_epoch_,
      .using_fallback = using_fallback_,
      .external_stage = external_stage_,
      .startup_deadline_ms = static_cast<std::uint64_t>(
        operation_deadlines_.startup.count()
      ),
      .retirement_deadline_ms = static_cast<std::uint64_t>(
        operation_deadlines_.retirement.count()
      ),
      .quarantined_attempts = attempts.quarantined_attempts,
      .peak_owned_attempts = attempts.peak_owned_attempts,
      .rejected_attempts = attempts.rejected_starts,
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
    TrackSnapshot snapshot;
    {
      std::lock_guard lock(mutex_);
      snapshot.reserve(tracks_.size());
      for (const auto& [_, track] : tracks_) snapshot.push_back(track);
    }
    for (const auto& track : snapshot) {
      if (renderer_epoch == 0) {
        track->ingress->suspend();
        track->speaking_state.store(0, std::memory_order_release);
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
    {
      std::lock_guard lock(mutex_);
      if (stopping_) return renderer_epoch_;
      desired_device_id_ = value;
      active_device_id_ = value;
      resolved_endpoint_id_.clear();
      using_fallback_ = false;
      output_configured_ = true;
      phase_ = RemoteAudioOutputPhase::Starting;
    }
    stopRenderer();
    OutputCandidate candidate;
    try {
      startAudioOutputWithRollback(
        [this, &candidate, &value] {
          candidate = startOutputCandidate(value);
        },
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
      RemoteAudioOutputState state;
      const auto info = describeAudioFailure(failure);
      if (failure.kind() == AudioFailureKind::RollbackFailed) {
        {
          std::lock_guard lock(mutex_);
          restoreOutputConfigurationLocked(previous);
          phase_ = RemoteAudioOutputPhase::Failed;
          output_configured_ = false;
          state = outputStateLocked(info, info.message);
        }
      } else {
        std::lock_guard lock(mutex_);
        restoreOutputConfigurationLocked(previous);
        state = outputStateLocked(info, info.message);
      }
      publishState(std::move(state));
      throw;
    } catch (...) {
      const auto info = describeCurrentAudioFailure();
      RemoteAudioOutputState state;
      {
        std::lock_guard lock(mutex_);
        restoreOutputConfigurationLocked(previous);
        state = outputStateLocked(info, info.message);
      }
      publishState(std::move(state));
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

  struct RendererMixState {
    detail::RemoteAudioAttemptMixGate gate;
    RenderSnapshotDomain::ReaderToken snapshot_reader;
    std::array<StereoFrame, kRemoteAudioIngressFramesPerPacket> mixed{};
    float limiter_gain = 1.0F;
    double clock_integral_error = 0.0;
    double applied_clock_ppm = 0.0;
    std::chrono::steady_clock::time_point next_clock_update{};
  };

  void startRenderer() {
    renderer_running_.store(true, std::memory_order_release);
    last_render_progress_ms_.store(0, std::memory_order_release);
    std::uint64_t renderer_epoch = 0;
    std::string device_id;
    {
      std::lock_guard lock(mutex_);
      renderer_epoch = ++renderer_epoch_;
      device_id = active_device_id_;
      resetRendererTrackStatesLocked(renderer_epoch);
    }
    renderer_active_epoch_.store(renderer_epoch, std::memory_order_release);
    resetRendererTelemetry();
    logRemoteAudio("remote_audio_renderer_start_requested");
    const auto owner = shared_from_this();
    const auto mix_state = std::make_shared<RendererMixState>();
    {
      std::lock_guard lock(mutex_);
      mix_state->snapshot_reader = render_snapshots_.claimReader();
    }
    std::shared_ptr<RemoteAudioOperationAttempt> attempt;
    try {
      attempt = RemoteAudioOperationAttempt::start(
        attempt_domain_,
        [owner, mix_state, device_id, renderer_epoch](
          RemoteAudioOperationAttempt::Context& context
        ) {
          try {
            owner->platform_adapter_->runRenderer(
              context,
              RemoteAudioRendererRequest{
                .device_id = device_id,
                .renderer_epoch = renderer_epoch,
                .audio_attempt_policy = owner->audio_attempt_policy_,
                .endpoint_resolved = [owner, renderer_epoch](std::string id) {
                  owner->acceptResolvedEndpoint(
                    renderer_epoch,
                    std::move(id)
                  );
                },
                .mmcss_changed = [owner, renderer_epoch](
                  bool registered,
                  std::uint32_t
                ) {
                  owner->acceptMmcssState(renderer_epoch, registered);
                },
                .fill = [owner, mix_state, renderer_epoch](
                  RemoteAudioRenderBuffer buffer
                ) {
                  return owner->fillRendererBuffer(
                    renderer_epoch,
                    *mix_state,
                    buffer
                  );
                },
                .render_progress = [owner, renderer_epoch](
                  RemoteAudioRenderProgress progress
                ) {
                  return owner->acceptRenderProgress(
                    renderer_epoch,
                    progress
                  );
                },
              }
            );
            if (!context.stopRequested()) {
              throw AudioFailure(
                AudioFailureKind::IoFailed,
                "remote audio renderer exited before stop was requested",
                E_FAIL
              );
            }
          } catch (...) {
            const auto failure = describeCurrentAudioFailure();
            owner->handleRendererOperationFailure(
              failure,
              device_id,
              renderer_epoch,
              context.stopRequested()
            );
            throw;
          }
        }
      );
    } catch (...) {
      renderer_running_.store(false, std::memory_order_release);
      renderer_active_epoch_.store(0, std::memory_order_release);
      clearRendererTrackStates(renderer_epoch);
      recordAttemptDiagnostic(
        RemoteAudioExternalStage::EndpointProbe,
        renderer_epoch
      );
      throw;
    }

    {
      std::lock_guard lock(renderer_attempt_mutex_);
      renderer_attempt_ = attempt;
    }
    const auto result = attempt->waitUntilReady(
      std::chrono::steady_clock::now() + operation_deadlines_.startup
    );
    if (result.status == RemoteAudioAttemptWaitStatus::Ready &&
        rendererAttemptCurrent(renderer_epoch)) {
      {
        std::lock_guard lock(mutex_);
        external_stage_.reset();
      }
      setIngressRendererEpoch(renderer_epoch);
      return;
    }

    renderer_running_.store(false, std::memory_order_release);
    auto retired_attempt = detachRendererAttempt(renderer_epoch);
    if (retired_attempt) {
      static_cast<void>(retired_attempt->retire(
        std::chrono::steady_clock::now() + operation_deadlines_.retirement
      ));
    }
    clearRendererTrackStates(renderer_epoch);
    recordAttemptDiagnostic(result.stage, renderer_epoch);
    if (result.status == RemoteAudioAttemptWaitStatus::Failed &&
        result.failure) {
      throw AudioFailure(
        result.failure->kind,
        result.failure->message,
        result.failure->hresult
      );
    }
    throw AudioFailure(
      result.status == RemoteAudioAttemptWaitStatus::TimedOut
        ? AudioFailureKind::OperationTimedOut
        : AudioFailureKind::IoFailed,
      "remote audio renderer did not become ready during " +
        std::string(remoteAudioExternalStageName(result.stage)),
      result.status == RemoteAudioAttemptWaitStatus::TimedOut
        ? HRESULT_FROM_WIN32(WAIT_TIMEOUT)
        : E_FAIL
    );
  }

  void stopRenderer() {
    setIngressRendererEpoch(0);
    renderer_running_.store(false, std::memory_order_release);
    std::shared_ptr<RemoteAudioOperationAttempt> attempt;
    std::uint64_t renderer_epoch = 0;
    {
      std::lock_guard lock(renderer_attempt_mutex_);
      renderer_epoch = renderer_active_epoch_.exchange(
        0,
        std::memory_order_acq_rel
      );
      attempt = std::move(renderer_attempt_);
    }
    if (attempt) {
      const auto retirement = attempt->retire(
        std::chrono::steady_clock::now() + operation_deadlines_.retirement
      );
      if (retirement == RemoteAudioAttemptRetireStatus::Quarantined) {
        recordAttemptDiagnostic(attempt->stage(), renderer_epoch);
      }
    }
    clearRendererTrackStates(renderer_epoch);
    clock_adjustment_ppm_.store(0.0, std::memory_order_relaxed);
    requestTrackResets();
  }

  [[nodiscard]] bool rendererAttemptCurrent(
    std::uint64_t renderer_epoch
  ) const noexcept {
    return renderer_epoch != 0 &&
      renderer_active_epoch_.load(std::memory_order_acquire) == renderer_epoch &&
      renderer_running_.load(std::memory_order_acquire);
  }

  std::shared_ptr<RemoteAudioOperationAttempt> detachRendererAttempt(
    std::uint64_t renderer_epoch
  ) noexcept {
    std::lock_guard lock(renderer_attempt_mutex_);
    if (renderer_active_epoch_.load(std::memory_order_acquire) !=
        renderer_epoch) {
      return {};
    }
    renderer_active_epoch_.store(0, std::memory_order_release);
    return std::move(renderer_attempt_);
  }

  void recordAttemptDiagnostic(
    RemoteAudioExternalStage stage,
    std::uint64_t renderer_epoch
  ) noexcept {
    const auto snapshot = attempt_domain_->snapshot();
    {
      std::lock_guard lock(mutex_);
      external_stage_ = stage;
    }
    logRemoteAudio(
      "remote_audio_renderer_attempt_failed",
      {
        {"stage", remoteAudioExternalStageName(stage)},
        {"rendererEpoch", renderer_epoch},
        {"startupDeadlineMs", static_cast<std::uint64_t>(
          operation_deadlines_.startup.count()
        )},
        {"retirementDeadlineMs", static_cast<std::uint64_t>(
          operation_deadlines_.retirement.count()
        )},
        {"quarantinedAttempts", static_cast<std::uint64_t>(
          snapshot.quarantined_attempts
        )},
        {"peakOwnedAttempts", static_cast<std::uint64_t>(
          snapshot.peak_owned_attempts
        )},
        {"rejectedAttempts", snapshot.rejected_starts},
      }
    );
  }

  void acceptResolvedEndpoint(
    std::uint64_t renderer_epoch,
    std::string resolved_endpoint_id
  ) noexcept {
    if (!rendererAttemptCurrent(renderer_epoch) ||
        resolved_endpoint_id.empty()) {
      return;
    }
    std::lock_guard lock(mutex_);
    if (!stopping_ && renderer_epoch_ == renderer_epoch &&
        rendererAttemptCurrent(renderer_epoch)) {
      resolved_endpoint_id_ = std::move(resolved_endpoint_id);
    }
  }

  void acceptMmcssState(
    std::uint64_t renderer_epoch,
    bool registered
  ) noexcept {
    if (!rendererAttemptCurrent(renderer_epoch)) return;
    renderer_mmcss_registered_.store(registered, std::memory_order_relaxed);
  }

  std::optional<float> requestedClockSampleRate(
    const RenderSnapshot& snapshot,
    std::chrono::steady_clock::time_point now,
    RendererMixState& state,
    std::uint64_t renderer_epoch
  ) {
    if (now < state.next_clock_update) return {};
    state.next_clock_update = now + kClockAdjustmentInterval;

    double queued_packets = 0.0;
    std::size_t active_tracks = 0;
    for (const auto& entry : snapshot) {
      const auto& track = *entry.track;
      const auto& renderer = *entry.renderer;
      if (!renderer.playout_started) continue;
      queued_packets += static_cast<double>(track.ingress->queuedFrames());
      if (renderer.current_frame_offset <
          kRemoteAudioIngressFramesPerPacket) {
        queued_packets += static_cast<double>(
          kRemoteAudioIngressFramesPerPacket -
            renderer.current_frame_offset
        ) / static_cast<double>(kRemoteAudioIngressFramesPerPacket);
      }
      ++active_tracks;
    }

    double requested_ppm = 0.0;
    if (active_tracks == 0) {
      state.clock_integral_error = 0.0;
    } else {
      const auto average_packets =
        queued_packets / static_cast<double>(active_tracks);
      const auto error = average_packets - kClockTargetPackets;
      state.clock_integral_error = std::clamp(
        state.clock_integral_error + error * 0.1,
        -100.0,
        100.0
      );
      requested_ppm = std::clamp(
        error * 120.0 + state.clock_integral_error * 4.0,
        -kMaximumClockCorrectionPpm,
        kMaximumClockCorrectionPpm
      );
    }
    if (std::abs(requested_ppm - state.applied_clock_ppm) < 1.0) return {};

    state.applied_clock_ppm = requested_ppm;
    if (!rendererAttemptCurrent(renderer_epoch)) return {};
    clock_adjustment_ppm_.store(requested_ppm, std::memory_order_relaxed);
    return static_cast<float>(
      static_cast<double>(kRemoteAudioSampleRate) *
      (1.0 + requested_ppm / 1'000'000.0)
    );
  }

  RemoteAudioRenderFillResult fillRendererBuffer(
    std::uint64_t renderer_epoch,
    RendererMixState& state,
    RemoteAudioRenderBuffer buffer
  ) {
    detail::RemoteAudioRealtimeFillScope realtime_scope;
    renderer_fill_callbacks_.fetch_add(1, std::memory_order_relaxed);
    if (!buffer.interleaved_samples) {
      throw std::invalid_argument("remote audio render buffer is null");
    }
    auto mix_lease = state.gate.tryAcquire();
    if (!mix_lease || !rendererAttemptCurrent(renderer_epoch)) {
      std::fill_n(
        buffer.interleaved_samples,
        static_cast<std::size_t>(buffer.writable_frames) *
          kRemoteAudioChannels,
        0.0F
      );
      return {.silent = true};
    }

    detail::RemoteAudioRenderFillPlan fill_plan = rendererFillPlan(
      buffer.capacity_frames,
      buffer.padding_frames
    );
    if (fill_plan.totalFrames() != buffer.writable_frames) {
      throw std::logic_error("remote audio render fill plan changed in flight");
    }

    auto snapshot = render_snapshots_.acquire(state.snapshot_reader);
    const auto deafened = deafened_.load(std::memory_order_relaxed);
    const auto output_volume = volume_.load(std::memory_order_relaxed);
    std::uint32_t output_offset = 0;
    auto now = buffer.wake_time;
    while (!fill_plan.complete()) {
      const auto chunk_frames = fill_plan.nextChunk();
      std::fill_n(state.mixed.begin(), chunk_frames, StereoFrame{});
      now = std::chrono::steady_clock::now();
      for (const auto& entry : snapshot.get()) {
        renderTrack(
          *entry.track,
          *entry.renderer,
          state.mixed.data(),
          chunk_frames,
          static_cast<std::size_t>(buffer.padding_frames) + output_offset,
          output_volume,
          deafened,
          now,
          renderer_epoch
        );
      }

      float peak = 0.0F;
      for (std::uint32_t index = 0; index < chunk_frames; ++index) {
        peak = std::max(peak, std::abs(state.mixed[index].left));
        peak = std::max(peak, std::abs(state.mixed[index].right));
      }
      const auto target_limiter_gain = remoteAudioLimiterTargetGainImpl(peak);
      if (target_limiter_gain < state.limiter_gain) {
        state.limiter_gain = target_limiter_gain;
      } else {
        const auto release = static_cast<float>(chunk_frames) /
          (static_cast<float>(kRemoteAudioSampleRate) *
           kLimiterReleaseSeconds);
        state.limiter_gain = std::min(
          target_limiter_gain,
          state.limiter_gain + release
        );
      }

      for (std::uint32_t index = 0; index < chunk_frames; ++index) {
        const auto output_index = output_offset + index;
        buffer.interleaved_samples[output_index * kRemoteAudioChannels] =
          std::clamp(
            state.mixed[index].left * state.limiter_gain,
            -1.0F,
            1.0F
          );
        buffer.interleaved_samples[
          output_index * kRemoteAudioChannels + 1
        ] = std::clamp(
          state.mixed[index].right * state.limiter_gain,
          -1.0F,
          1.0F
        );
      }
      output_offset += chunk_frames;
    }
    return {
      .silent = deafened,
      .adjusted_sample_rate = requestedClockSampleRate(
        snapshot.get(),
        now,
        state,
        renderer_epoch
      ),
    };
  }

  bool acceptRenderProgress(
    std::uint64_t renderer_epoch,
    const RemoteAudioRenderProgress& progress
  ) noexcept {
    if (!rendererAttemptCurrent(renderer_epoch)) return false;
    last_render_progress_ms_.store(
      static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now().time_since_epoch()
        ).count()
      ),
      std::memory_order_release
    );
    detail::RemoteAudioRenderFillPlan fill_plan = rendererFillPlan(
      progress.capacity_frames,
      progress.padding_frames
    );
    if (fill_plan.totalFrames() == progress.writable_frames) {
      recordRendererCycle(fill_plan, progress.wake_gap_ms);
    }
    return rendererAttemptCurrent(renderer_epoch);
  }

  void handleRendererOperationFailure(
    AudioFailureInfo failure,
    const std::string& device_id,
    std::uint64_t renderer_epoch,
    bool stop_requested
  ) noexcept {
    if (!rendererAttemptCurrent(renderer_epoch)) return;
    renderer_running_.store(false, std::memory_order_release);
    const bool failed_after_readiness =
      last_render_progress_ms_.load(std::memory_order_acquire) != 0;
    if (failed_after_readiness && !stop_requested) {
      scheduleRecovery(
        std::move(failure),
        device_id,
        renderer_epoch,
        true
      );
    }
  }

  void retireFinishedRendererAttempt() noexcept {
    std::shared_ptr<RemoteAudioOperationAttempt> attempt;
    std::uint64_t renderer_epoch = 0;
    {
      std::lock_guard lock(renderer_attempt_mutex_);
      if (!renderer_attempt_ || !renderer_attempt_->finished()) return;
      renderer_epoch = renderer_active_epoch_.exchange(
        0,
        std::memory_order_acq_rel
      );
      attempt = std::move(renderer_attempt_);
    }
    renderer_running_.store(false, std::memory_order_release);
    static_cast<void>(attempt->retire(
      std::chrono::steady_clock::now() + operation_deadlines_.retirement
    ));
    clearRendererTrackStates(renderer_epoch);
  }

  void resetRendererTelemetry() noexcept {
    renderer_mmcss_registered_.store(false, std::memory_order_relaxed);
    renderer_capacity_frames_.store(0, std::memory_order_relaxed);
    renderer_last_padding_frames_.store(0, std::memory_order_relaxed);
    renderer_minimum_padding_frames_.store(
      std::numeric_limits<std::uint64_t>::max(),
      std::memory_order_relaxed
    );
    renderer_maximum_writable_frames_.store(0, std::memory_order_relaxed);
    renderer_maximum_wake_gap_ms_.store(0, std::memory_order_relaxed);
    renderer_zero_padding_events_.store(0, std::memory_order_relaxed);
    renderer_multi_chunk_writes_.store(0, std::memory_order_relaxed);
    renderer_catch_up_frames_.store(0, std::memory_order_relaxed);
    renderer_frames_written_.store(0, std::memory_order_relaxed);
  }

  void recordRendererCycle(
    const detail::RemoteAudioRenderFillPlan& plan,
    std::uint64_t wake_gap_ms
  ) noexcept {
    renderer_capacity_frames_.store(
      plan.capacityFrames(),
      std::memory_order_relaxed
    );
    renderer_last_padding_frames_.store(
      plan.paddingFrames(),
      std::memory_order_relaxed
    );
    storeMinimum(renderer_minimum_padding_frames_, plan.paddingFrames());
    storeMaximum(renderer_maximum_writable_frames_, plan.totalFrames());
    storeMaximum(renderer_maximum_wake_gap_ms_, wake_gap_ms);
    if (plan.bufferEmpty()) {
      renderer_zero_padding_events_.fetch_add(1, std::memory_order_relaxed);
    }
    if (plan.catchUpFrames() != 0) {
      renderer_multi_chunk_writes_.fetch_add(1, std::memory_order_relaxed);
      renderer_catch_up_frames_.fetch_add(
        plan.catchUpFrames(),
        std::memory_order_relaxed
      );
    }
    renderer_frames_written_.fetch_add(
      plan.totalFrames(),
      std::memory_order_relaxed
    );
  }

  [[nodiscard]] RendererTelemetrySnapshot rendererTelemetry() const noexcept {
    return {
      .mmcss_registered =
        renderer_mmcss_registered_.load(std::memory_order_relaxed),
      .capacity_frames =
        renderer_capacity_frames_.load(std::memory_order_relaxed),
      .last_padding_frames =
        renderer_last_padding_frames_.load(std::memory_order_relaxed),
      .minimum_padding_frames =
        renderer_minimum_padding_frames_.load(std::memory_order_relaxed),
      .maximum_writable_frames =
        renderer_maximum_writable_frames_.load(std::memory_order_relaxed),
      .maximum_wake_gap_ms =
        renderer_maximum_wake_gap_ms_.load(std::memory_order_relaxed),
      .zero_padding_events =
        renderer_zero_padding_events_.load(std::memory_order_relaxed),
      .multi_chunk_writes =
        renderer_multi_chunk_writes_.load(std::memory_order_relaxed),
      .catch_up_frames =
        renderer_catch_up_frames_.load(std::memory_order_relaxed),
      .frames_written =
        renderer_frames_written_.load(std::memory_order_relaxed),
    };
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
      {
        std::lock_guard lock(mutex_);
        if (stopping_) return;
      }
      const auto candidate = startOutputCandidate(desired);
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
      retireFinishedRendererAttempt();
      collectTelemetry();
    }
  }

  void collectTelemetry() {
    TrackSnapshot snapshot;
    {
      std::lock_guard lock(mutex_);
      snapshot.reserve(tracks_.size());
      for (const auto& [_, track] : tracks_) snapshot.push_back(track);
      render_snapshots_.reclaim();
    }
    std::vector<std::string> speakers;
    speakers.reserve(snapshot.size());
    const auto now = std::chrono::steady_clock::now();
    std::uint64_t renderer_epoch = 0;
    {
      std::lock_guard lock(mutex_);
      renderer_epoch = renderer_epoch_;
    }
    if (reported_renderer_epoch_ != renderer_epoch) {
      reported_renderer_epoch_ = renderer_epoch;
      reported_renderer_ = {};
      next_renderer_dataplane_report_ = {};
    }
    const auto renderer = rendererTelemetry();
    const bool renderer_dataplane_changed =
      renderer.mmcss_registered != reported_renderer_.mmcss_registered ||
      renderer.zero_padding_events != reported_renderer_.zero_padding_events ||
      renderer.multi_chunk_writes != reported_renderer_.multi_chunk_writes ||
      renderer.catch_up_frames != reported_renderer_.catch_up_frames;
    if (renderer_dataplane_changed &&
        now >= next_renderer_dataplane_report_) {
      const auto minimum_padding =
        renderer.minimum_padding_frames ==
          std::numeric_limits<std::uint64_t>::max()
        ? renderer.capacity_frames
        : renderer.minimum_padding_frames;
      logRemoteAudio(
        "remote_audio_renderer_dataplane",
        {
          {"rendererEpoch", renderer_epoch},
          {"mmcssRegistered", renderer.mmcss_registered},
          {"capacityFrames", renderer.capacity_frames},
          {"lastPaddingFrames", renderer.last_padding_frames},
          {"minimumPaddingFrames", minimum_padding},
          {"maximumWritableFrames", renderer.maximum_writable_frames},
          {"maximumWakeGapMs", renderer.maximum_wake_gap_ms},
          {"zeroPaddingEvents", renderer.zero_padding_events},
          {"multiChunkWrites", renderer.multi_chunk_writes},
          {"catchUpFrames", renderer.catch_up_frames},
          {"framesWritten", renderer.frames_written},
        }
      );
      reported_renderer_ = renderer;
      next_renderer_dataplane_report_ = now + std::chrono::seconds(5);
    }
    for (const auto& track : snapshot) {
      if (!track->stream_source && !track->user_id.empty() &&
          trackSpeakingFor(*track, renderer_epoch)) {
        speakers.push_back(track->user_id);
      }

      const auto ingress = track->ingress->telemetry();
      const auto underruns = track->underruns.load(std::memory_order_relaxed);
      const bool dataplane_changed =
        ingress.dropped_frames != track->reported_ingress.dropped_frames ||
        ingress.suspended_frames != track->reported_ingress.suspended_frames ||
        ingress.invalid_frames != track->reported_ingress.invalid_frames ||
        ingress.discontinuities != track->reported_ingress.discontinuities ||
        ingress.freshness_recoveries !=
          track->reported_ingress.freshness_recoveries ||
        ingress.last_scheduled_playout_age_us !=
          track->reported_ingress.last_scheduled_playout_age_us ||
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
            {"freshnessRecoveries", ingress.freshness_recoveries},
            {"staleFramesDiscarded", ingress.stale_frames_discarded},
            {"scheduledPlayoutAgeMs",
              static_cast<double>(ingress.last_scheduled_playout_age_us) /
                1'000.0},
            {"maximumScheduledPlayoutAgeMs",
              static_cast<double>(ingress.maximum_scheduled_playout_age_us) /
                1'000.0},
            {"oldestQueuedAgeMs",
              static_cast<double>(ingress.last_oldest_queued_age_us) /
                1'000.0},
            {"queuedPackets", ingress.last_queued_packets},
            {"endpointPaddingMs",
              static_cast<double>(renderer.last_padding_frames) * 1'000.0 /
                static_cast<double>(kRemoteAudioSampleRate)},
            {"rendererWakeGapMs", renderer.maximum_wake_gap_ms},
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
  std::unordered_map<std::string, std::shared_ptr<TrackState>> tracks_;
  std::unordered_map<TrackState*, std::shared_ptr<TrackRendererState>>
    active_renderer_tracks_;
  std::uint64_t renderer_track_state_epoch_ = 0;
  RenderSnapshotDomain render_snapshots_;
  std::string desired_device_id_ = "default";
  std::string active_device_id_;
  std::string resolved_endpoint_id_;
  RemoteAudioOutputPhase phase_ = RemoteAudioOutputPhase::Stopped;
  bool output_configured_ = false;
  bool using_fallback_ = false;
  bool stopping_ = false;
  std::optional<RemoteAudioExternalStage> external_stage_;
  std::atomic_bool deafened_{false};
  std::atomic<float> volume_{1.0F};
  std::atomic_bool renderer_running_{false};
  mutable std::mutex renderer_attempt_mutex_;
  std::shared_ptr<RemoteAudioOperationAttempt> renderer_attempt_;
  std::atomic<std::uint64_t> renderer_active_epoch_{0};
  std::uint64_t renderer_epoch_ = 0;
  std::atomic<std::uint64_t> last_render_progress_ms_{0};
  std::atomic<double> clock_adjustment_ppm_{0.0};
  std::atomic_bool renderer_mmcss_registered_{false};
  std::atomic<std::uint64_t> renderer_capacity_frames_{0};
  std::atomic<std::uint64_t> renderer_last_padding_frames_{0};
  std::atomic<std::uint64_t> renderer_minimum_padding_frames_{
    std::numeric_limits<std::uint64_t>::max()
  };
  std::atomic<std::uint64_t> renderer_maximum_writable_frames_{0};
  std::atomic<std::uint64_t> renderer_maximum_wake_gap_ms_{0};
  std::atomic<std::uint64_t> renderer_zero_padding_events_{0};
  std::atomic<std::uint64_t> renderer_multi_chunk_writes_{0};
  std::atomic<std::uint64_t> renderer_catch_up_frames_{0};
  std::atomic<std::uint64_t> renderer_frames_written_{0};
  std::atomic<std::uint64_t> renderer_fill_callbacks_{0};
  RemoteAudioSettings settings_;
  StateHandler on_state_;
  TrackFailureHandler on_track_failure_;
  SpeakingActivityHandler on_speaking_activity_;
  std::shared_ptr<RemoteAudioRendererPlatformAdapter> platform_adapter_;
  RemoteAudioOperationDeadlines operation_deadlines_;
  std::shared_ptr<RemoteAudioAttemptDomain> attempt_domain_;
  std::shared_ptr<WindowsAudioSessionAttemptPolicy> audio_attempt_policy_;
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
  std::uint64_t reported_renderer_epoch_ = 0;
  RendererTelemetrySnapshot reported_renderer_;
  std::chrono::steady_clock::time_point next_renderer_dataplane_report_{};
  std::unique_ptr<RemoteAudioEndpointSubscription> endpoint_subscription_;
};

RemoteAudioOutput::RemoteAudioOutput(
  StateHandler on_state,
  TrackFailureHandler on_track_failure,
  SpeakingActivityHandler on_speaking_activity,
  CleanupStartProbe cleanup_start_probe,
  std::shared_ptr<RemoteAudioRendererPlatformAdapter> platform_adapter,
  RemoteAudioOperationDeadlines operation_deadlines,
  std::shared_ptr<RemoteAudioAttemptDomain> attempt_domain,
  std::shared_ptr<WindowsAudioSessionAttemptPolicy> audio_attempt_policy
) : cleanup_supervisor_(&CleanupSupervisor::instance()),
    cleanup_job_(std::make_shared<CleanupJob>(
      std::move(cleanup_start_probe)
    )),
    implementation_(std::make_shared<Implementation>(
      std::move(on_state),
      std::move(on_track_failure),
      std::move(on_speaking_activity),
      std::move(platform_adapter),
      operation_deadlines,
      std::move(attempt_domain),
      std::move(audio_attempt_policy)
    )) {
  implementation_->start();
}

RemoteAudioOutput::~RemoteAudioOutput() {
  if (implementation_) implementation_->stop();
}

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

std::optional<RemoteAudioPlayoutSnapshot> RemoteAudioOutput::playoutSnapshot(
  std::string_view track_sid
) const {
  return implementation_->playoutSnapshot(track_sid);
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
  cleanup_job_->prepare(
    std::move(lifetime_owner),
    implementation_.get(),
    reinterpret_cast<CleanupResourceKey>(implementation_.get()),
    [](void* context) {
      static_cast<Implementation*>(context)->stop();
    }
  );
  cleanup_supervisor_->submitOrEscalate(cleanup_job_, "remote_audio");
}

}  // namespace syrnike::desktop_native::media
