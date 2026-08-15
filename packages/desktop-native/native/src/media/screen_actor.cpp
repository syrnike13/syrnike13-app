#include "screen_actor.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <exception>
#include <future>
#include <latch>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <livekit/d3d11_h264_video_source.h>

#include <objbase.h>

#include "../common/diagnostic_log.hpp"
#include "livekit_disconnect_reason.hpp"
#include "media_runtime_support.hpp"
#include "capture_backend_supervisor.hpp"
#include "screen_audio_capture.hpp"
#include "screen_capture_priority.hpp"
#include "screen_frame_pipeline.hpp"
#include "screen_gpu_capture.hpp"
#include "screen_gpu_retirement.hpp"

namespace syrnike::desktop_native::media {
namespace {

using diagnostics::DiagnosticField;

std::string sanitizeDiagnosticMessage(std::string_view message) {
  return diagnostics::redactForDiagnostics(message);
}

void logScreen(
  std::string_view event,
  std::initializer_list<DiagnosticField> fields = {}
) {
  auto& logger = diagnostics::DiagnosticLog::instance();
  if (!logger.enabled()) return;
  logger.write(event, fields);
}

std::string_view gpuCaptureReason(ScreenGpuCaptureErrorCode code) noexcept {
  switch (code) {
    case ScreenGpuCaptureErrorCode::AccessLost:
      return "gpu_access_lost";
    case ScreenGpuCaptureErrorCode::DeviceLost:
      return "gpu_device_lost";
    case ScreenGpuCaptureErrorCode::GpuTimeout:
      return "gpu_pipeline_timeout";
    case ScreenGpuCaptureErrorCode::ResourceSaturated:
      return "gpu_resource_saturated";
    case ScreenGpuCaptureErrorCode::PermissionDenied:
      return "gpu_permission_denied";
    case ScreenGpuCaptureErrorCode::InteropUnavailable:
    case ScreenGpuCaptureErrorCode::FormatUnsupported:
      return "gpu_interop_unavailable";
    case ScreenGpuCaptureErrorCode::TargetClosed:
      return "target_closed";
    case ScreenGpuCaptureErrorCode::CaptureUnavailable:
    case ScreenGpuCaptureErrorCode::DeviceUnavailable:
      return "gpu_capture_unavailable";
  }
  return "gpu_capture_unavailable";
}

std::string_view gpuCaptureFailureCategory(
    ScreenGpuCaptureErrorCode code) noexcept {
  switch (code) {
    case ScreenGpuCaptureErrorCode::DeviceLost:
      return "gpu_device_lost";
    case ScreenGpuCaptureErrorCode::PermissionDenied:
      return "gpu_permission_denied";
    case ScreenGpuCaptureErrorCode::InteropUnavailable:
    case ScreenGpuCaptureErrorCode::FormatUnsupported:
      return "gpu_interop_unavailable";
    case ScreenGpuCaptureErrorCode::ResourceSaturated:
      return "gpu_resource_saturated";
    case ScreenGpuCaptureErrorCode::TargetClosed:
      return "target_closed";
    case ScreenGpuCaptureErrorCode::CaptureUnavailable:
    case ScreenGpuCaptureErrorCode::AccessLost:
    case ScreenGpuCaptureErrorCode::DeviceUnavailable:
    case ScreenGpuCaptureErrorCode::GpuTimeout:
      return "gpu_capture_unavailable";
  }
  return "gpu_capture_unavailable";
}

std::uint64_t packLuid(const LUID luid) noexcept {
  return static_cast<std::uint64_t>(luid.LowPart) |
    (static_cast<std::uint64_t>(static_cast<std::uint32_t>(luid.HighPart)) << 32U);
}

class ScreenTextureLease final : public livekit::D3D11TextureLease {
 public:
  ScreenTextureLease(
    std::shared_ptr<ScreenGpuCapturer> capturer,
    ScreenGpuFrame frame
  ) : capturer_(std::move(capturer)), frame_(frame) {
    texture_.shared_handle = reinterpret_cast<std::uintptr_t>(frame_.shared_texture_handle);
    texture_.adapter_luid = packLuid(frame_.adapter_luid);
    texture_.acquire_key = 1;
    texture_.release_key = 0;
    texture_.width = frame_.width;
    texture_.height = frame_.height;
  }

  ~ScreenTextureLease() override {
    if (!accepted_) release();
  }

  const livekit::D3D11SharedTexture& texture() const noexcept override {
    return texture_;
  }

  void accepted() noexcept override { accepted_ = true; }

  void release() noexcept override {
    if (released_) return;
    released_ = true;
    auto capturer = std::move(capturer_);
    if (capturer) capturer->discard(frame_);
  }

 private:
  std::shared_ptr<ScreenGpuCapturer> capturer_;
  ScreenGpuFrame frame_;
  livekit::D3D11SharedTexture texture_;
  bool accepted_ = false;
  bool released_ = false;
};

}  // namespace

bool emitScreenBackendRestart(
  SequencedEmitter& emitter,
  const std::string& session_id,
  std::uint64_t generation,
  const ScreenGpuRecoveryTransition& transition
) {
  RuntimeEvent event;
  event.type = NativeEventType::ScreenBackendRestart;
  event.session_id = session_id;
  event.generation = generation;
  event.capture_method = transition.backend;
  event.reason = transition.action;
  event.video_recoverable_lost_count = transition.count;
  event.error_code = std::string(gpuCaptureReason(transition.error_code));
  if (transition.hresult != 0) {
    event.hresult = static_cast<std::int64_t>(transition.hresult);
  }
  return emitter.emit(std::move(event));
}

std::thread launchOptionalScreenStatsWorker(
    const LaunchScreenWorker& launcher,
    std::function<void()> work) noexcept {
  try {
    auto guarded_work = [work = std::move(work)]() noexcept {
      try {
        if (work) work();
      } catch (const std::exception& error) {
        try {
          logScreen(
            "screen_stats_worker_failed",
            {{"message", sanitizeDiagnosticMessage(error.what())}}
          );
        } catch (...) {
        }
      } catch (...) {
        try {
          logScreen(
            "screen_stats_worker_failed",
            {{"message", "unknown stats worker failure"}}
          );
        } catch (...) {
        }
      }
    };
    if (launcher) return launcher(std::move(guarded_work));
    return std::thread(std::move(guarded_work));
  } catch (...) {
    logScreen(
      "screen_stats_worker_launch_failed",
      {{"reason", "worker_launch_failed"}}
    );
    return {};
  }
}

std::thread launchScreenCaptureWorker(
    const LaunchScreenWorker& launcher,
    std::shared_ptr<void> owner,
    std::function<void()> work,
    std::function<void()> rollback,
    PrepareOwnedScreenWork prepare_owned_work) {
  try {
    std::function<void()> owned_work;
    if (prepare_owned_work) {
      owned_work = prepare_owned_work(
          std::move(owner),
          std::move(work));
    } else {
      owned_work = [
          owner = std::move(owner),
          work = std::move(work)]() mutable {
        work();
      };
    }
    if (launcher) return launcher(std::move(owned_work));
    return std::thread(std::move(owned_work));
  } catch (...) {
    const auto launch_error = std::current_exception();
    try {
      if (rollback) rollback();
    } catch (...) {
    }
    std::rethrow_exception(launch_error);
  }
}

class ScreenActor::Implementation final
    : public std::enable_shared_from_this<ScreenActor::Implementation> {
 public:
  Implementation(
    SequencedEmitter& emitter,
    InternalPost post,
    CleanupStartProbe cleanup_start_probe,
    LaunchScreenWorker launch_stats_worker,
    LaunchScreenWorker launch_capture_worker,
    ScreenFrameHandoffObserver frame_handoff_observer,
    AfterScreenVideoPublished after_video_published,
    ScreenVideoPublicationObserver video_publication_observer
  ) : emitter_(emitter),
      post_(std::move(post)),
      launch_stats_worker_(std::move(launch_stats_worker)),
      launch_capture_worker_(std::move(launch_capture_worker)),
      frame_handoff_observer_(std::move(frame_handoff_observer)),
      after_video_published_(std::move(after_video_published)),
      video_publication_observer_(std::move(video_publication_observer)),
      cleanup_supervisor_(&CleanupSupervisor::instance()),
      cleanup_start_probe_(std::move(cleanup_start_probe)) {
    const auto preview_work_signal = preview_work_signal_;
    preview_reaper_thread_ = std::thread([this, preview_work_signal] {
      // Capacity is retained across wakes. A wake copies only shared owners;
      // delivery identity strings stay in immutable control-path storage.
      std::vector<PreviewCapturerState> candidates;
      std::vector<std::shared_ptr<ScreenGpuCapturer>> completed;
      std::vector<std::shared_ptr<ScreenGpuCapturer>> retired;
      candidates.reserve(8);
      completed.reserve(8);
      retired.reserve(8);
      // Start from zero so work queued before the thread reaches its first
      // wait is observed instead of being adopted as the idle baseline.
      std::uint64_t observed_epoch = 0;
      bool timed_poll_required = false;
      while (preview_work_signal->waitForChange(
          observed_epoch,
          timed_poll_required
              ? std::optional{std::chrono::milliseconds(4)}
              : std::nullopt)) {
        observed_epoch = preview_work_signal->epoch();
        {
          std::lock_guard lock(preview_mutex_);
          for (const auto& [key, state] : preview_capturers_) {
            if (state.capturer) candidates.push_back(state);
          }
        }
        timed_poll_required = false;
        for (auto& candidate : candidates) {
          auto& state = candidate;
          if (state.active) {
            const bool requested = state.preview_lane &&
                state.preview_lane->takeLatest().has_value();
            if (requested || state.capturer->optionalWorkPending()) {
              state.capturer->pollOptionalWork();
            }
            deliverPreview(state);
            timed_poll_required = timed_poll_required ||
                state.capturer->optionalWorkPending();
            continue;
          }
          state.capturer->pollRetirement();
          if (state.capturer->previewFramesInFlight() == 0) {
            completed.push_back(std::move(state.capturer));
          } else {
            // Renderer fence release notifies this lane explicitly. Do not
            // spin while Chromium owns the last preview reference.
            timed_poll_required = timed_poll_required ||
                state.capturer->optionalWorkPending();
          }
        }
        {
          std::lock_guard lock(preview_mutex_);
          for (const auto& capturer : completed) {
            for (auto found = preview_capturers_.begin();
                 found != preview_capturers_.end(); ++found) {
              if (found->second.active ||
                  found->second.capturer != capturer) {
                continue;
              }
              retired.push_back(std::move(found->second.capturer));
              preview_capturers_.erase(found);
              break;
            }
          }
        }
        if (!retired.empty()) {
          submitCapturerRetirement(
              std::move(retired), "screen_preview_reaper");
        }
        // Release every local capturer owner before an indefinite idle wait.
        // Vector capacity remains allocated for the next real notification.
        candidates.clear();
        completed.clear();
        retired.clear();
      }
    });
  }

  void initializePublication(
    IsCurrent is_current,
    std::shared_ptr<LiveKitVoiceSession> voice_session,
    CommitIfCurrent commit_if_current,
    Now now
  ) {
    const auto owner = weak_from_this();
    publication_ = std::make_unique<ScreenPublicationController>(
        emitter_,
        post_,
        std::move(is_current),
        std::move(voice_session),
        std::move(commit_if_current),
        std::move(now),
        [owner](const MediaCommand& command) {
          const auto implementation = owner.lock();
          if (!implementation) {
            throw std::runtime_error("screen actor is shutting down");
          }
          return implementation->describePublication(command);
        },
        [owner](
          const MediaCommand& command,
          const ScreenPublicationDescription& description
        ) {
          const auto implementation = owner.lock();
          if (!implementation) {
            throw std::runtime_error("screen actor is shutting down");
          }
          return implementation->prepareCapture(command, description);
        },
        [owner](
          const MediaCommand& command,
          const ScreenPublicationDescription& description,
          const std::shared_ptr<livekit::D3D11H264VideoSource>& video_source,
          const std::shared_ptr<livekit::LocalVideoTrack>& video_track,
          const std::shared_ptr<ScreenGpuCapturer>& capturer,
          const std::shared_ptr<std::atomic_bool>& running,
          const std::function<bool()>& is_current,
          std::thread& capture_thread
        ) {
          const auto implementation = owner.lock();
          if (!implementation) {
            throw std::runtime_error("screen actor is shutting down");
          }
          implementation->startVideoCapture(
            command,
            description,
            video_source,
            video_track,
            capturer,
            running,
            is_current,
            capture_thread
          );
        },
        [owner](
          const MediaCommand& command,
          const ScreenPublicationDescription& description,
          const std::shared_ptr<livekit::AudioSource>& audio_source,
          const std::shared_ptr<std::atomic_bool>& running,
          const std::shared_ptr<syrnike::voice::ScreenAudioStopSignal>& audio_stop,
          std::thread& audio_thread
        ) {
          const auto implementation = owner.lock();
          if (!implementation) {
            throw std::runtime_error("screen actor is shutting down");
          }
          implementation->startAudioCapture(
            command,
            description.target,
            audio_source,
            running,
            audio_stop,
            audio_thread
          );
        },
        [owner](const std::string& session_id, std::uint64_t generation) {
          if (const auto implementation = owner.lock()) {
            implementation->resetStats(session_id, generation);
          }
        },
        ScreenPublicationController::QueryEncoderCapability{},
        ScreenPublicationController::CreateVideoSource{},
        cleanup_start_probe_,
        CleanupEnqueueProbe{},
        ScreenPublicationController::BeforeResourceCleanup{},
        nullptr,
        after_video_published_,
        video_publication_observer_
      );
  }

  ~Implementation() { shutdown(); }

  void connect(const MediaCommand& command) { publication_->connect(command); }

  void startCapture(const MediaCommand& command) {
    publication_->startCapture(command);
  }

  void stopCapture(const MediaCommand& command, bool emit_stopped) {
    publication_->stopCapture(command, emit_stopped);
  }

  void disconnect(const MediaCommand& command, bool emit_stopped) {
    publication_->disconnect(command, emit_stopped);
  }

  void handleTerminal(const MediaCommand& command) {
    logScreen(
      "screen_handle_terminal",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"message", sanitizeDiagnosticMessage(command.internal_message)}
      }
    );
    const bool livekit_terminal = isLiveKitDisconnectTerminalMessage(command.internal_message);
    if (!publication_->handleTerminal(command, livekit_terminal)) return;
    const auto reason = command.internal_message.empty()
      ? std::string("runtime_error")
      : command.internal_message;
    logScreen(
      "screen_terminal_state",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"message", reason}
      }
    );
    emitCaptureEnded(command.session_id, command.generation, reason);
  }

  void emitCaptureEnded(
    const std::string& session_id,
    std::uint64_t generation,
    const std::string& reason
  ) {
    RuntimeEvent ended;
    ended.type = NativeEventType::ScreenCaptureEnded;
    ended.session_id = session_id;
    ended.generation = generation;
    constexpr std::string_view allowed_reasons[] = {
      "target_closed",
      "gpu_capture_unavailable",
      "gpu_encoder_unavailable",
      "gpu_interop_unavailable",
      "gpu_device_lost",
      "gpu_permission_denied",
    };
    ended.reason = "runtime_error";
    for (const auto allowed : allowed_reasons) {
      if (reason == allowed) {
        ended.reason = reason;
        break;
      }
    }
    if (isScreenPipelineStallReason(reason)) ended.reason = reason;
    ended.detail = reason;
    emitter_.emit(std::move(ended));
    RuntimeEvent stopped;
    stopped.type = NativeEventType::SessionStopped;
    stopped.session_id = session_id;
    stopped.generation = generation;
    stopped.reason = reason;
    emitter_.emit(std::move(stopped));
  }

  void handleWorkerCommand(const MediaCommand& command) {
    if (command.type == NativeCommandType::SetLocalScreenPreviewDemand) {
      setPreviewDemand(command);
      return;
    }
    if (command.type == NativeCommandType::ReleaseLocalScreenPreviewFrame) {
      releasePreviewFrame(command);
      return;
    }
    publication_->handleWorkerCommand(command);
  }

  RuntimeEvent probe(const MediaCommand& command) {
    return publication_->probe(command);
  }

  void shutdown(
      std::optional<std::chrono::steady_clock::time_point> stop_by =
          std::nullopt) {
    const auto deadline = stop_by.value_or(
        std::chrono::steady_clock::now() + kNativeShutdownBudget);
    if (publication_) publication_->shutdown(deadline);
    preview_work_signal_->stop();
    if (preview_reaper_thread_.joinable() &&
        preview_reaper_thread_.get_id() != std::this_thread::get_id()) {
      preview_reaper_thread_.join();
    }
    std::vector<std::shared_ptr<ScreenGpuCapturer>> retired;
    {
      std::lock_guard lock(preview_mutex_);
      for (auto& [key, state] : preview_capturers_) {
        if (state.capturer) retired.push_back(std::move(state.capturer));
      }
      preview_capturers_.clear();
    }
    std::shared_ptr<CleanupJob> shutdown_cleanup;
    if (!retired.empty()) {
      shutdown_cleanup = submitCapturerRetirement(
          std::move(retired), "screen_preview_shutdown");
    }
    if (shutdown_cleanup && !shutdown_cleanup->waitUntil(deadline)) {
      const auto cleanup = cleanup_supervisor_->snapshot();
      logScreen(
          "screen_preview_cleanup_unfinished",
          {
              {"activeJobs", static_cast<std::uint64_t>(cleanup.active_jobs)},
              {"backlogJobs", static_cast<std::uint64_t>(cleanup.backlog_jobs)},
              {"ownedJobs", static_cast<std::uint64_t>(cleanup.owned_jobs)},
          });
    }
  }

 private:
  struct PreviewDeliveryIdentity {
    std::string session_id;
    std::string participant_identity;
    std::uint64_t generation = 0;
  };

  struct PreviewCapturerState {
    std::shared_ptr<ScreenGpuCapturer> capturer;
    std::shared_ptr<ScreenPreviewWorkLane> preview_lane;
    std::shared_ptr<const PreviewDeliveryIdentity> identity;
    bool active = false;
  };

  void deliverPreview(const PreviewCapturerState& state) noexcept {
    auto capturer = state.capturer;
    const auto identity = state.identity;
    if (!capturer || !identity) return;
    ScreenPreviewFrame preview;
    if (capturer->takePreviewFrame(preview)) {
      try {
        MediaCommand preview_command;
        try {
          preview_command = makeNativeResourceCommand(
              NativeCommandType::LocalScreenPreviewFrame,
              [capturer, sequence = preview.sequence] {
                capturer->releasePreviewFrame(sequence);
              });
        } catch (...) {
          capturer->releasePreviewFrame(preview.sequence);
          throw;
        }
        preview_command.session_id = identity->session_id;
        preview_command.generation = identity->generation;
        preview_command.track_id = localPreviewTrackId(identity->session_id);
        preview_command.participant_identity = identity->participant_identity;
        preview_command.video_source = "screen";
        preview_command.frame_sequence = preview.sequence;
        preview_command.timestamp_us = preview.timestamp_us;
        preview_command.width = static_cast<int>(preview.width);
        preview_command.height = static_cast<int>(preview.height);
        preview_command.nt_handle = preview.nt_handle;
        auto rejected_release = preview_command.on_drop;
        bool posted = false;
        try {
          posted = post_(std::move(preview_command));
        } catch (...) {
          rejected_release();
          throw;
        }
        if (!posted) rejected_release();
      } catch (const std::exception& error) {
        logScreen(
            "screen_preview_delivery_failed",
            {{"message", sanitizeDiagnosticMessage(error.what())}});
      } catch (...) {
        logScreen(
            "screen_preview_delivery_failed",
            {{"message", "unknown preview delivery failure"}});
      }
    }

    ScreenPreviewFailure preview_failure;
    if (!capturer->takePreviewFailure(preview_failure)) return;
    try {
      MediaCommand failure;
      failure.type = NativeCommandType::LocalScreenPreviewFailed;
      failure.session_id = identity->session_id;
      failure.generation = identity->generation;
      failure.track_id = localPreviewTrackId(identity->session_id);
      failure.video_source = std::string(gpuCaptureReason(preview_failure.code));
      failure.internal_message = std::move(preview_failure.message);
      failure.diagnostic_hresult = preview_failure.hresult;
      failure.diagnostic_suppressed = preview_failure.suppressed;
      static_cast<void>(post_(std::move(failure)));
    } catch (const std::exception& error) {
      logScreen(
          "screen_preview_failure_delivery_failed",
          {{"message", sanitizeDiagnosticMessage(error.what())}});
    } catch (...) {
      logScreen(
          "screen_preview_failure_delivery_failed",
          {{"message", "unknown preview failure delivery failure"}});
    }
  }

  struct CapturerRetirementState {
    std::vector<std::shared_ptr<ScreenGpuCapturer>> capturers;
  };

  std::shared_ptr<CleanupJob> submitCapturerRetirement(
      std::vector<std::shared_ptr<ScreenGpuCapturer>> capturers,
      std::string_view owner) noexcept {
    if (capturers.empty()) return {};
    try {
      auto state = std::make_shared<CapturerRetirementState>();
      auto job = std::make_shared<CleanupJob>(cleanup_start_probe_);
      state->capturers = std::move(capturers);
      job->prepare(
          state,
          reinterpret_cast<CleanupResourceKey>(this),
          [](void* context) {
            static_cast<CapturerRetirementState*>(context)->capturers.clear();
          });
      cleanup_supervisor_->submitOrEscalate(job, owner);
      return job;
    } catch (...) {
      logScreen(
          "screen_capturer_cleanup_allocation_failed",
          {{"reason", "runtime_loss"}});
      std::terminate();
    }
  }

  std::shared_ptr<CleanupJob> submitCapturerRetirement(
      std::shared_ptr<ScreenGpuCapturer> capturer,
      std::string_view owner) noexcept {
    if (!capturer) return {};
    try {
      auto state = std::make_shared<CapturerRetirementState>();
      auto job = std::make_shared<CleanupJob>(cleanup_start_probe_);
      state->capturers.reserve(1);
      state->capturers.push_back(std::move(capturer));
      job->prepare(
          state,
          reinterpret_cast<CleanupResourceKey>(this),
          [](void* context) {
            static_cast<CapturerRetirementState*>(context)->capturers.clear();
          });
      cleanup_supervisor_->submitOrEscalate(job, owner);
      return job;
    } catch (...) {
      logScreen(
          "screen_capturer_cleanup_allocation_failed",
          {{"reason", "runtime_loss"}});
      std::terminate();
    }
  }

  ScreenPublicationDescription describePublication(const MediaCommand& command) const {
    ScreenPublicationDescription description;
    description.target = syrnike::voice::resolveScreenCaptureTarget(command.source_id);
    syrnike::voice::resolveScreenCaptureSize(
      description.target,
      static_cast<std::uint32_t>(command.width),
      static_cast<std::uint32_t>(command.height),
      description.width,
      description.height
    );
    description.publish_audio =
      command.audio_requested &&
      (!description.target.window || description.target.process_id != 0);
    if (description.publish_audio) {
      syrnike::voice::validateScreenLoopbackAudio(
        description.target,
        command.exclude_process_id
      );
      description.audio_mode = description.target.window ? "process" : "system_exclude";
      description.loopback_mode = description.target.window
        ? "include_target_process_tree"
        : "exclude_target_process_tree";
      description.audio_target_process_id = description.target.window
        ? description.target.process_id
        : command.exclude_process_id;
    }
    return description;
  }

  void startVideoCapture(
    const MediaCommand& command,
    const ScreenPublicationDescription& description,
    const std::shared_ptr<livekit::D3D11H264VideoSource>& video_source,
    const std::shared_ptr<livekit::LocalVideoTrack>& video_track,
    const std::shared_ptr<ScreenGpuCapturer>& capturer,
    const std::shared_ptr<std::atomic_bool>& running,
    const std::function<bool()>& is_current,
    std::thread& capture_thread
  ) {
    const auto owner = shared_from_this();
    if (!capturer) {
      throw std::runtime_error("gpu_capture_unavailable: missing prepared capturer");
    }
    if (!is_current()) throw std::runtime_error("stale screen capture generation");
    const auto preview_key =
      previewKey(command.session_id, command.generation);
    const auto terminal_incarnation = nextTerminalIncarnation();
    NativeTerminalIncarnationCandidate terminal_candidate(
      terminalIncarnationFence(),
      NativeTerminalProducer::ScreenCapture, terminal_incarnation
    );
    auto capture_committed = std::make_shared<std::latch>(1);
    auto preview_lane = std::make_shared<ScreenPreviewWorkLane>(
        preview_work_signal_);
    std::function<void()> rollback = [this, preview_key] {
      rollbackPreviewCapturer(preview_key);
    };
    std::function<void()> capture_work = [this,
       session_id = command.session_id,
       generation = command.generation,
       width = description.width,
       height = description.height,
       fps = description.fps,
       source = video_source,
       track = video_track,
       running,
       capturer,
       preview_lane,
       capture_committed,
       terminal_incarnation]() mutable {
        capture_committed->wait();
        captureLoop(
          std::move(session_id),
          generation,
          width,
          height,
          fps,
          std::move(source),
          std::move(track),
          std::move(running),
          std::move(capturer),
          std::move(preview_lane),
          terminal_incarnation
        );
    };
    registerPreviewCapturer(
      command, preview_key, capturer, std::move(preview_lane));
    capture_thread = launchScreenCaptureWorker(
      launch_capture_worker_,
      owner,
      std::move(capture_work),
      std::move(rollback)
    );
    static_cast<void>(terminal_candidate.publish());
    capture_committed->count_down();
  }

  std::shared_ptr<ScreenGpuCapturer> prepareCapture(
    const MediaCommand&,
    const ScreenPublicationDescription& description
  ) {
    std::shared_ptr<ScreenGpuCapturer> capturer;
    try {
      capturer = ScreenGpuCapturer::create(
        description.target,
        description.width,
        description.height,
        capture_supervisor_
      );
    } catch (const ScreenGpuCaptureError& error) {
      auto message = std::string(gpuCaptureFailureCategory(error.code())) +
        ": " + std::string(gpuCaptureReason(error.code())) +
        ": " + error.what();
      if (error.hresult() != 0) {
        message += " (HRESULT " + std::to_string(error.hresult()) + ")";
      }
      throw std::runtime_error(std::move(message));
    }
    const auto adapter_capability =
      livekit::queryD3D11H264CapabilityForAdapter(
        packLuid(capturer->adapterLuid()));
    if (!adapter_capability.available) {
      throw std::runtime_error(
        "gpu_encoder_unavailable: " + adapter_capability.reason);
    }
    return capturer;
  }

  void startAudioCapture(
    const MediaCommand& command,
    const syrnike::voice::ScreenCaptureTarget& target,
    const std::shared_ptr<livekit::AudioSource>& audio_source,
    const std::shared_ptr<std::atomic_bool>& running,
    const std::shared_ptr<syrnike::voice::ScreenAudioStopSignal>& stop_signal,
    std::thread& audio_thread
  ) {
    const auto owner = weak_from_this();
    const auto session_id = command.session_id;
    const auto generation = command.generation;
    const auto audio_epoch = command.internal_epoch;
    const auto terminal_incarnation = nextTerminalIncarnation();
    NativeTerminalIncarnationCandidate terminal_candidate(
      terminalIncarnationFence(),
      NativeTerminalProducer::ScreenAudio, terminal_incarnation
    );
    auto audio_committed = std::make_shared<std::latch>(1);
    auto on_failure = [
      owner,
      session_id,
      generation,
      audio_epoch,
      terminal_incarnation
    ](std::string message) {
      const auto implementation = owner.lock();
      if (!implementation) return;
      MediaCommand terminal;
      terminal.type = NativeCommandType::ScreenAudioTerminal;
      terminal.terminal_producer = NativeTerminalProducer::ScreenAudio;
      terminal.session_id = session_id;
      terminal.generation = generation;
      terminal.internal_epoch = audio_epoch;
      terminal.terminal_incarnation = terminal_incarnation;
      terminal.internal_message = std::move(message);
      implementation->post_(std::move(terminal));
    };
    auto on_stats = [owner, session_id, generation, audio_epoch](
      std::uint64_t frames,
      std::uint64_t packets,
      std::uint64_t backlog_packets,
      std::uint64_t discontinuities,
      double peak_db,
      double rms_db
    ) {
      if (const auto implementation = owner.lock()) {
        implementation->recordAudioStats(
          session_id,
          generation,
          audio_epoch,
          frames,
          packets,
          backlog_packets,
          discontinuities,
          peak_db,
          rms_db
        );
      }
    };
    {
      std::lock_guard lock(stats_mutex_);
      if (stats_session_id_ == session_id && stats_generation_ == generation) {
        stats_audio_epoch_ = audio_epoch;
        stats_audio_frames_ = 0;
        stats_audio_packets_ = 0;
        stats_audio_backlog_packets_ = 0;
        stats_audio_discontinuities_ = 0;
        stats_audio_peak_db_ = -120.0;
        stats_audio_rms_db_ = -120.0;
      }
    }
    const bool capture_window = target.window;
    const auto target_process_id = target.process_id;
    const auto exclude_process_id = command.exclude_process_id;
    audio_thread = std::thread([
      capture_window,
      target_process_id,
      exclude_process_id,
      session_id,
      audio_source,
      running,
      stop_signal,
      audio_committed,
      on_failure = std::move(on_failure),
      on_stats = std::move(on_stats)
    ]() mutable {
      audio_committed->wait();
      if (capture_window) {
        syrnike::voice::captureProcessLoopbackAudio(
          target_process_id,
          session_id,
          audio_source,
          running,
          stop_signal,
          std::move(on_failure),
          std::move(on_stats)
        );
      } else {
        syrnike::voice::captureSystemLoopbackAudio(
          exclude_process_id,
          session_id,
          audio_source,
          running,
          stop_signal,
          std::move(on_failure),
          std::move(on_stats)
        );
      }
    });
    static_cast<void>(terminal_candidate.publish());
    audio_committed->count_down();
  }

  void resetStats(const std::string& session_id, std::uint64_t generation) {
    std::lock_guard lock(stats_mutex_);
    stats_session_id_ = session_id;
    stats_generation_ = generation;
    stats_video_frames_ = 0;
    stats_audio_epoch_ = 0;
    stats_audio_frames_ = 0;
    stats_audio_packets_ = 0;
    stats_audio_backlog_packets_ = 0;
    stats_audio_discontinuities_ = 0;
    stats_method_wgc_gpu_ = 0;
    stats_method_dxgi_gpu_ = 0;
    stats_video_recoverable_lost_count_ = 0;
    stats_video_gpu_pool_slots_available_ = 0;
    stats_video_gpu_pool_slots_total_ = 0;
    stats_video_dxgi_duplication_hold_us_max_ = 0;
    stats_video_frame_flow_ = {};
    stats_audio_peak_db_ = -120.0;
    stats_audio_rms_db_ = -120.0;
    stats_capture_method_.clear();
    stats_rtp_available_ = false;
    stats_rtp_packets_sent_ = 0;
    stats_rtp_bytes_sent_ = 0;
    stats_rtp_frames_sent_ = 0;
    stats_rtp_frames_encoded_ = 0;
    stats_encoder_implementation_.clear();
    next_stats_at_ = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  }

  void emitStatsIfDue(const std::string& session_id, std::uint64_t generation) {
    std::optional<RuntimeEvent> snapshot;
    {
      std::lock_guard lock(stats_mutex_);
      if (stats_session_id_ != session_id || stats_generation_ != generation) return;
      const auto now = std::chrono::steady_clock::now();
      if (now < next_stats_at_) return;
      RuntimeEvent event;
      event.type = NativeEventType::Stats;
      event.session_id = stats_session_id_;
      event.generation = stats_generation_;
      event.frames = stats_video_frames_;
      event.audio_frames = stats_audio_frames_;
      event.audio_packets = stats_audio_packets_;
      event.audio_backlog_packets = stats_audio_backlog_packets_;
      event.audio_discontinuities = stats_audio_discontinuities_;
      event.audio_peak_db = stats_audio_peak_db_;
      event.audio_rms_db = stats_audio_rms_db_;
      event.capture_method = stats_capture_method_;
      event.method_wgc_gpu = stats_method_wgc_gpu_;
      event.method_dxgi_gpu = stats_method_dxgi_gpu_;
      event.video_recoverable_lost_count =
        stats_video_recoverable_lost_count_;
      event.video_gpu_pool_slots_available =
        stats_video_gpu_pool_slots_available_;
      event.video_gpu_pool_slots_total = stats_video_gpu_pool_slots_total_;
      event.video_dxgi_duplication_hold_us_max =
        stats_video_dxgi_duplication_hold_us_max_;
      event.video_source_updates = stats_video_frame_flow_.source_updates;
      event.video_gpu_submissions = stats_video_frame_flow_.gpu_submissions;
      event.video_idle_refreshes = stats_video_frame_flow_.idle_refreshes;
      event.video_coalesced_source_updates =
        stats_video_frame_flow_.coalesced_source_updates;
      event.video_encoder_backpressure_ticks =
        stats_video_frame_flow_.encoder_backpressure_ticks;
      event.video_superseded_ready_frames =
        stats_video_frame_flow_.superseded_ready_frames;
      event.video_gpu_slot_timeouts =
        stats_video_frame_flow_.gpu_slot_timeouts;
      event.video_gpu_slots_recovered =
        stats_video_frame_flow_.gpu_slots_recovered;
      event.video_gpu_frames_dropped_stale =
        stats_video_frame_flow_.gpu_frames_dropped_stale;
      event.video_gpu_pool_rollovers =
        stats_video_frame_flow_.gpu_pool_rollovers;
      event.video_gpu_rollovers_blocked =
        stats_video_frame_flow_.gpu_rollovers_blocked;
      event.video_gpu_retired_generations =
        stats_video_frame_flow_.gpu_retired_generations;
      event.video_gpu_slots_quarantined =
        stats_video_frame_flow_.gpu_slots_quarantined;
      event.video_preview_bridge_submissions =
        stats_video_frame_flow_.preview_bridge_submissions;
      event.video_preview_bridge_acquires =
        stats_video_frame_flow_.preview_bridge_acquires;
      event.video_preview_bridge_timeouts =
        stats_video_frame_flow_.preview_bridge_timeouts;
      event.video_preview_bridge_slots_recovered =
        stats_video_frame_flow_.preview_bridge_slots_recovered;
      event.video_preview_gpu_submissions =
        stats_video_frame_flow_.preview_gpu_submissions;
      event.video_preview_frames_completed =
        stats_video_frame_flow_.preview_frames_completed;
      event.video_preview_slot_timeouts =
        stats_video_frame_flow_.preview_slot_timeouts;
      event.video_preview_frames_dropped_stale =
        stats_video_frame_flow_.preview_frames_dropped_stale;
      event.video_preview_device_resets =
        stats_video_frame_flow_.preview_device_resets;
      event.video_gpu_completion_p50_us =
        stats_video_frame_flow_.gpu_completion_p50_us;
      event.video_gpu_completion_p95_us =
        stats_video_frame_flow_.gpu_completion_p95_us;
      event.video_gpu_completion_max_us =
        stats_video_frame_flow_.gpu_completion_max_us;
      event.rtp_stats_available = stats_rtp_available_;
      event.rtp_packets_sent = stats_rtp_packets_sent_;
      event.rtp_bytes_sent = stats_rtp_bytes_sent_;
      event.rtp_frames_sent = stats_rtp_frames_sent_;
      event.rtp_frames_encoded = stats_rtp_frames_encoded_;
      event.encoder_implementation = stats_encoder_implementation_;
      snapshot = std::move(event);
      stats_video_dxgi_duplication_hold_us_max_ = 0;
      next_stats_at_ = now + std::chrono::seconds(1);
    }
    emitter_.emit(std::move(*snapshot));
  }

  void recordAudioStats(
    const std::string& session_id,
    std::uint64_t generation,
    std::uint64_t audio_epoch,
    std::uint64_t frames,
    std::uint64_t packets,
    std::uint64_t backlog_packets,
    std::uint64_t discontinuities,
    double peak_db,
    double rms_db
  ) {
    {
      std::lock_guard lock(stats_mutex_);
      if (stats_session_id_ != session_id ||
          stats_generation_ != generation ||
          stats_audio_epoch_ != audio_epoch) {
        return;
      }
      stats_audio_frames_ = frames;
      stats_audio_packets_ = packets;
      stats_audio_backlog_packets_ = backlog_packets;
      stats_audio_discontinuities_ = discontinuities;
      stats_audio_peak_db_ = peak_db;
      stats_audio_rms_db_ = rms_db;
    }
    emitStatsIfDue(session_id, generation);
  }

  void recordVideoStats(
    const std::string& session_id,
    std::uint64_t generation,
    std::uint64_t frames,
    const std::string& method,
    std::uint64_t method_wgc_gpu,
    std::uint64_t method_dxgi_gpu,
    std::uint64_t recoverable_lost_count,
    std::size_t gpu_pool_slots_available,
    std::size_t gpu_pool_slots_total,
    const ScreenFrameFlowStats& frame_flow,
    int dxgi_duplication_hold_us
  ) {
    {
      std::lock_guard lock(stats_mutex_);
      if (stats_session_id_ != session_id || stats_generation_ != generation) return;
      stats_video_frames_ = frames;
      stats_capture_method_ = method;
      stats_method_wgc_gpu_ = method_wgc_gpu;
      stats_method_dxgi_gpu_ = method_dxgi_gpu;
      stats_video_recoverable_lost_count_ = recoverable_lost_count;
      stats_video_gpu_pool_slots_available_ = gpu_pool_slots_available;
      stats_video_gpu_pool_slots_total_ = gpu_pool_slots_total;
      stats_video_frame_flow_ = frame_flow;
      if (dxgi_duplication_hold_us > 0) {
        stats_video_dxgi_duplication_hold_us_max_ = std::max<std::uint64_t>(
          stats_video_dxgi_duplication_hold_us_max_,
          static_cast<std::uint64_t>(dxgi_duplication_hold_us));
      }
    }
    emitStatsIfDue(session_id, generation);
  }

  struct OutboundStatsSample {
    bool available = false;
    bool active = false;
    std::uint64_t frames_encoded = 0;
    std::uint64_t frames_sent = 0;
  };

  std::optional<OutboundStatsSample> sampleOutboundStats(
    const std::string& session_id,
    std::uint64_t generation,
    const std::shared_ptr<livekit::LocalVideoTrack>& track
  ) {
    if (!track) return std::nullopt;
    try {
      auto stats_future = track->getStats();
      if (stats_future.wait_for(std::chrono::milliseconds(250)) !=
          std::future_status::ready) {
        logScreen(
          "screen_rtp_stats_timeout",
          {
            {"sessionId", session_id},
            {"generation", generation}
          }
        );
        return std::nullopt;
      }
      const auto records = stats_future.get();
      std::uint64_t packets_sent = 0;
      std::uint64_t bytes_sent = 0;
      std::uint64_t frames_sent = 0;
      std::uint64_t frames_encoded = 0;
      double target_bitrate = 0;
      double frames_per_second = 0;
      std::uint64_t frame_width = 0;
      std::uint64_t frame_height = 0;
      std::uint64_t quality_limitation_reason = 0;
      bool active = false;
      std::string encoder_implementation;
      bool available = false;
      for (const auto& record : records) {
        const auto* outbound = std::get_if<livekit::RtcOutboundRtpStats>(&record.stats);
        if (!outbound) continue;
        available = true;
        packets_sent += outbound->sent.packets_sent;
        bytes_sent += outbound->sent.bytes_sent;
        frames_sent += outbound->outbound.frames_sent;
        frames_encoded += outbound->outbound.frames_encoded;
        target_bitrate += outbound->outbound.target_bitrate;
        frames_per_second += outbound->outbound.frames_per_second;
        frame_width = std::max<std::uint64_t>(
          frame_width, outbound->outbound.frame_width);
        frame_height = std::max<std::uint64_t>(
          frame_height, outbound->outbound.frame_height);
        quality_limitation_reason = std::max<std::uint64_t>(
          quality_limitation_reason,
          static_cast<std::uint64_t>(outbound->outbound.quality_limitation_reason));
        active = active || outbound->outbound.active;
        if (encoder_implementation.empty()) {
          encoder_implementation = outbound->outbound.encoder_implementation;
        }
      }
      {
        std::lock_guard lock(stats_mutex_);
        if (stats_session_id_ != session_id || stats_generation_ != generation) {
          return std::nullopt;
        }
        stats_rtp_available_ = available;
        stats_rtp_packets_sent_ = packets_sent;
        stats_rtp_bytes_sent_ = bytes_sent;
        stats_rtp_frames_sent_ = frames_sent;
        stats_rtp_frames_encoded_ = frames_encoded;
        stats_encoder_implementation_ = std::move(encoder_implementation);
      }
      logScreen(
        "screen_rtp_stats",
        {
          {"sessionId", session_id},
          {"generation", generation},
          {"available", available},
          {"packetsSent", packets_sent},
          {"bytesSent", bytes_sent},
          {"framesSent", frames_sent},
          {"framesEncoded", frames_encoded},
          {"targetBitrate", target_bitrate},
          {"framesPerSecond", frames_per_second},
          {"frameWidth", frame_width},
          {"frameHeight", frame_height},
          {"qualityLimitationReason", quality_limitation_reason},
          {"active", active}
        }
      );
      return OutboundStatsSample{
        available,
        active,
        frames_encoded,
        frames_sent,
      };
    } catch (const std::exception& error) {
      logScreen(
        "screen_rtp_stats_error",
        {
          {"sessionId", session_id},
          {"generation", generation},
          {"message", sanitizeDiagnosticMessage(error.what())}
        }
      );
      return std::nullopt;
    }
  }

  void captureLoop(
    std::string session_id,
    std::uint64_t generation,
    std::uint32_t width,
    std::uint32_t height,
    int fps,
    std::shared_ptr<livekit::D3D11H264VideoSource> source,
    std::shared_ptr<livekit::LocalVideoTrack> track,
    std::shared_ptr<std::atomic_bool> running,
    std::shared_ptr<ScreenGpuCapturer> capturer,
    std::shared_ptr<ScreenPreviewWorkLane> preview_lane,
    std::uint64_t terminal_incarnation
  ) {
    logScreen(
      "screen_capture_loop_start",
      {
        {"sessionId", session_id},
        {"generation", generation},
        {"width", static_cast<std::uint64_t>(width)},
        {"height", static_cast<std::uint64_t>(height)},
        {"fps", static_cast<std::uint64_t>(fps)}
      }
    );
    syrnike::voice::ScreenCapturePriorityScope priority;
    const auto interval = std::chrono::microseconds(1'000'000 / fps);
    auto next_frame = std::chrono::steady_clock::now();
    const auto started = next_frame;
    EncoderBackpressureStallDetector encoder_backpressure_stall;
    ScreenOutputStallDetector output_stall;
    ScreenOutputStall reported_output_stall = ScreenOutputStall::None;
    bool capture_loss_reported = false;
    std::uint64_t frames = 0;
    std::uint64_t method_wgc_gpu = 0;
    std::uint64_t method_dxgi_gpu = 0;
    std::string method = capturer->method();
    const auto observe_encoder_backpressure =
      [&](std::chrono::steady_clock::time_point now) {
        if (!encoder_backpressure_stall.observe(
              now, std::chrono::seconds(2))) return;
        logScreen(
          "screen_encoder_backpressure_stall",
          {
            {"sessionId", session_id},
            {"generation", generation},
            {"frames", frames},
            {"method", method}
          }
        );
        throw ScreenPipelineStallError(
          ScreenPipelineStall::EncoderBackpressure
        );
      };
    ScreenGpuFrame captured;
    const HRESULT com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool uninitialize_com = SUCCEEDED(com_result);
    std::atomic_bool stats_running{true};
    std::mutex sampled_stats_mutex;
    std::optional<OutboundStatsSample> sampled_stats;
    std::uint64_t sampled_stats_revision = 0;
    std::uint64_t consumed_stats_revision = 0;
    std::atomic<std::uint64_t> telemetry_frames{0};
    std::atomic<std::uint64_t> telemetry_method_wgc_gpu{0};
    std::atomic<std::uint64_t> telemetry_method_dxgi_gpu{0};
    std::atomic<int> telemetry_duplication_hold_us_max{0};
    std::thread stats_thread = launchOptionalScreenStatsWorker(
      launch_stats_worker_,
      [&] {
      auto next_sample = std::chrono::steady_clock::now();
      while (stats_running.load(std::memory_order_acquire)) {
        const auto now = std::chrono::steady_clock::now();
        if (now < next_sample) {
          std::this_thread::sleep_for(std::min(
              std::chrono::milliseconds(50),
              std::chrono::duration_cast<std::chrono::milliseconds>(
                  next_sample - now)));
          continue;
        }
        auto sample = sampleOutboundStats(session_id, generation, track);
        const auto gpu_pool_slots_available = capturer->frameSlotsAvailable();
        const auto gpu_pool_slots_total = capturer->frameSlotsTotal();
        const auto frame_flow = capturer->frameFlowStats();
        const auto recoverable_loss_count = capturer->recoverableLossCount();
        recordVideoStats(
          session_id,
          generation,
          telemetry_frames.load(std::memory_order_relaxed),
          capturer->method(),
          telemetry_method_wgc_gpu.load(std::memory_order_relaxed),
          telemetry_method_dxgi_gpu.load(std::memory_order_relaxed),
          recoverable_loss_count,
          gpu_pool_slots_available,
          gpu_pool_slots_total,
          frame_flow,
          telemetry_duplication_hold_us_max.exchange(
            0, std::memory_order_relaxed)
        );
        {
          std::lock_guard lock(sampled_stats_mutex);
          sampled_stats = std::move(sample);
          ++sampled_stats_revision;
        }
        next_sample = std::chrono::steady_clock::now() +
            std::chrono::seconds(1);
      }
      }
    );

    try {
      if (FAILED(com_result) && com_result != RPC_E_CHANGED_MODE) {
        throw ScreenGpuCaptureError(
          ScreenGpuCaptureErrorCode::CaptureUnavailable,
          "screen capture COM initialization failed",
          static_cast<long>(com_result)
        );
      }
      while (running->load()) {
        const auto capture = capturer->capture(captured);
        if (capture.recovery_transition) {
          emitScreenBackendRestart(
            emitter_,
            session_id,
            generation,
            *capture.recovery_transition
          );
        }
        if (capture.method && capture.method[0] != '\0') method = capture.method;
        if (capture.status == ScreenGpuFrameStatus::NewFrame) {
          capture_loss_reported = false;
          auto lease = std::make_unique<ScreenTextureLease>(capturer, captured);
          const auto timestamp = captured.timestamp_us != 0
            ? static_cast<std::int64_t>(captured.timestamp_us)
            : std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - started).count();
          livekit::VideoCaptureOptions capture_options;
          capture_options.timestamp_us = timestamp;
          capture_options.metadata = livekit::VideoFrameMetadata{};
          capture_options.metadata->user_timestamp_us =
            static_cast<std::uint64_t>(timestamp);
          capture_options.metadata->frame_id = static_cast<std::uint32_t>(
            (std::min<std::uint64_t>)(
              frames + 1,
              (std::numeric_limits<std::uint32_t>::max)()
            )
          );
          if (source->capture(std::move(lease), capture_options)) {
            encoder_backpressure_stall.noteProgress();
            ++frames;
            if (frame_handoff_observer_) {
              try {
                frame_handoff_observer_(
                  session_id,
                  generation,
                  frames,
                  static_cast<std::uint64_t>(timestamp)
                );
              } catch (...) {
                // Diagnostics must never interrupt the capture dataplane.
              }
            }
            if (method == "wgc_gpu") ++method_wgc_gpu;
            else if (method == "dxgi_gpu") ++method_dxgi_gpu;
            telemetry_frames.store(frames, std::memory_order_relaxed);
            telemetry_method_wgc_gpu.store(
              method_wgc_gpu, std::memory_order_relaxed);
            telemetry_method_dxgi_gpu.store(
              method_dxgi_gpu, std::memory_order_relaxed);
          } else {
            observe_encoder_backpressure(std::chrono::steady_clock::now());
          }
        } else if (capture.status == ScreenGpuFrameStatus::EncoderBackpressure) {
          observe_encoder_backpressure(std::chrono::steady_clock::now());
        } else if (capture.status == ScreenGpuFrameStatus::RecoverableLost) {
          if (!capture_loss_reported) {
            capture_loss_reported = true;
            logScreen(
              "screen_capture_recoverable_loss",
              {
                {"sessionId", session_id},
                {"generation", generation},
                {"frames", frames},
                {"method", method},
                {"hresult",
                 static_cast<std::int64_t>(capture.metrics.hresult)},
                {"reason", gpuCaptureReason(capture.error_code)}
              }
            );
          }
        } else if (
          capture.status == ScreenGpuFrameStatus::TargetClosed ||
          capture.status == ScreenGpuFrameStatus::FatalError
        ) {
          MediaCommand terminal;
          terminal.type = NativeCommandType::ScreenTerminal;
          terminal.terminal_producer = NativeTerminalProducer::ScreenCapture;
          terminal.session_id = session_id;
          terminal.generation = generation;
          terminal.terminal_incarnation = terminal_incarnation;
          terminal.internal_message =
            capture.status == ScreenGpuFrameStatus::TargetClosed
              ? "target_closed"
              : std::string(gpuCaptureReason(capture.error_code));
          running->store(false);
          logScreen(
            "screen_capture_loop_terminal",
            {
              {"sessionId", session_id},
              {"generation", generation},
              {"targetClosed",
               capture.status == ScreenGpuFrameStatus::TargetClosed},
              {"frames", frames}
            }
          );
          post_(std::move(terminal));
          break;
        }

        // The encoder handoff above stays first. Optional preview work is a
        // zero-wait bridge enqueue; its independent worker coalesces the
        // notification while resize/import/delivery is stalled.
        if (capture.status != ScreenGpuFrameStatus::RecoverableLost &&
            capturer->requestPreviewFrame() && preview_lane) {
          const auto preview_revision = captured.sequence != 0
            ? captured.sequence
            : frames + 1;
          static_cast<void>(preview_lane->request(preview_revision));
        }
        // Recovery can retire a backend without producing a preview frame.
        // Wake the optional-work lane on that typed transition, but never
        // inspect its lock-backed GPU state from the capture hot path.
        if (capture.status == ScreenGpuFrameStatus::RecoverableLost) {
          preview_work_signal_->notify();
        }

        if (capture.metrics.duplication_hold_us > 0) {
          auto observed = telemetry_duplication_hold_us_max.load(
            std::memory_order_relaxed);
          while (observed < capture.metrics.duplication_hold_us &&
                 !telemetry_duplication_hold_us_max.compare_exchange_weak(
                   observed,
                   capture.metrics.duplication_hold_us,
                   std::memory_order_relaxed,
                   std::memory_order_relaxed)) {
          }
        }

        const auto now = std::chrono::steady_clock::now();
        std::optional<OutboundStatsSample> stats;
        {
          std::lock_guard lock(sampled_stats_mutex);
          if (sampled_stats_revision != consumed_stats_revision) {
            stats = sampled_stats;
            consumed_stats_revision = sampled_stats_revision;
          }
        }
        if (stats) {
          if (stats && stats->available) {
            const auto stall = output_stall.observe(
              now,
              stats->active,
              frames,
              stats->frames_encoded,
              stats->frames_sent,
              std::chrono::seconds(5));
            if (stall == ScreenOutputStall::None) {
              reported_output_stall = ScreenOutputStall::None;
            } else if (stall != reported_output_stall) {
              reported_output_stall = stall;
              const std::string cause =
                stall == ScreenOutputStall::Encoder
                  ? "encoder_output_stalled"
                  : "rtp_output_stalled";
              logScreen(
                "screen_rtp_stall_detected",
                {
                  {"sessionId", session_id},
                  {"generation", generation},
                  {"cause", cause},
                  {"frames", frames},
                  {"framesEncoded", stats->frames_encoded},
                  {"framesSent", stats->frames_sent}
                }
              );
              throw ScreenPipelineStallError(
                stall == ScreenOutputStall::Encoder
                  ? ScreenPipelineStall::EncoderOutput
                  : ScreenPipelineStall::RtpOutput
              );
            }
          }
        }
        next_frame += interval;
        if (now > next_frame + interval) next_frame = now;
        else std::this_thread::sleep_until(next_frame);
      }
    } catch (const std::exception& error) {
      if (running->exchange(false)) {
        logScreen(
          "screen_capture_loop_error",
          {
            {"sessionId", session_id},
            {"generation", generation},
            {"frames", frames},
            {"message", sanitizeDiagnosticMessage(error.what())}
          }
        );
        MediaCommand terminal;
        terminal.type = NativeCommandType::ScreenTerminal;
        terminal.terminal_producer = NativeTerminalProducer::ScreenCapture;
        terminal.session_id = session_id;
        terminal.generation = generation;
        terminal.terminal_incarnation = terminal_incarnation;
        const auto* stall_error =
          dynamic_cast<const ScreenPipelineStallError*>(&error);
        const auto* gpu_error = dynamic_cast<const ScreenGpuCaptureError*>(&error);
        terminal.internal_message = stall_error
          ? std::string(screenPipelineStallReason(stall_error->stall()))
          : gpu_error
            ? std::string(gpuCaptureReason(gpu_error->code()))
            : "gpu_capture_unavailable";
        post_(std::move(terminal));
      }
    } catch (...) {
      if (running->exchange(false)) {
        logScreen(
          "screen_capture_loop_error_unknown",
          {
            {"sessionId", session_id},
            {"generation", generation},
            {"frames", frames}
          }
        );
        MediaCommand terminal;
        terminal.type = NativeCommandType::ScreenTerminal;
        terminal.terminal_producer = NativeTerminalProducer::ScreenCapture;
        terminal.session_id = session_id;
        terminal.generation = generation;
        terminal.terminal_incarnation = terminal_incarnation;
        terminal.internal_message = "gpu_capture_unavailable";
        post_(std::move(terminal));
      }
    }
    stats_running.store(false, std::memory_order_release);
    if (stats_thread.joinable()) stats_thread.join();
    retirePreviewCapturer(session_id, generation, capturer);
    capturer.reset();
    source.reset();
    track.reset();
    if (uninitialize_com) CoUninitialize();
    const auto preview_work = preview_lane
      ? preview_lane->snapshot()
      : ScreenPreviewWorkSnapshot{};
    logScreen(
      "screen_capture_loop_exit",
      {
        {"sessionId", session_id},
        {"generation", generation},
        {"frames", frames},
        {"methodWgcGpu", method_wgc_gpu},
        {"methodDxgiGpu", method_dxgi_gpu},
        {"previewWorkRequested", preview_work.requested},
        {"previewWorkCoalesced", preview_work.coalesced},
        {"previewDisabledDrops", preview_work.disabled_drops},
        {"running", running->load()}
      }
    );
  }

  static std::string previewKey(
    const std::string& session_id,
    std::uint64_t generation
  ) {
    return session_id + ":" + std::to_string(generation);
  }

  static std::string localPreviewTrackId(const std::string& session_id) {
    return "local-screen:" + session_id;
  }

  void registerPreviewCapturer(
    const MediaCommand& command,
    const std::string& key,
    const std::shared_ptr<ScreenGpuCapturer>& capturer,
    std::shared_ptr<ScreenPreviewWorkLane> preview_lane
  ) {
    std::lock_guard lock(preview_mutex_);
    auto& state = preview_capturers_[key];
    state.capturer = capturer;
    state.preview_lane = std::move(preview_lane);
    state.identity = std::make_shared<PreviewDeliveryIdentity>(
        PreviewDeliveryIdentity{
            command.session_id,
            command.participant_identity,
            command.generation,
        });
    state.active = true;
    if (preview_session_id_ == command.session_id &&
        preview_generation_ == command.generation) {
      capturer->setPreviewDemand(preview_demand_);
      state.preview_lane->setEnabled(preview_demand_.demanded);
    } else {
      capturer->setPreviewDemand({});
      state.preview_lane->setEnabled(false);
    }
  }

  void rollbackPreviewCapturer(const std::string& key) noexcept {
    std::shared_ptr<ScreenGpuCapturer> retired;
    try {
      std::lock_guard lock(preview_mutex_);
      const auto found = preview_capturers_.find(key);
      if (found == preview_capturers_.end()) return;
      retired = found->second.capturer;
      found->second.active = false;
      if (found->second.preview_lane) {
        found->second.preview_lane->setEnabled(false);
      }
    } catch (...) {
      return;
    }
    try {
      submitCapturerRetirement(retired, "screen_preview_rollback");
      std::lock_guard lock(preview_mutex_);
      const auto found = preview_capturers_.find(key);
      if (found != preview_capturers_.end() &&
          found->second.capturer == retired) {
        preview_capturers_.erase(found);
      }
    } catch (...) {
      try {
        logScreen("screen_capture_launch_rollback_submit_failed");
      } catch (...) {
      }
    }
  }

  void setPreviewDemand(const MediaCommand& command) {
    ScreenPreviewDemand demand;
    demand.demanded = command.demanded;
    demand.width = static_cast<std::uint32_t>(command.width);
    demand.height = static_cast<std::uint32_t>(command.height);
    demand.fps = static_cast<std::uint32_t>(command.fps);
    demand.electron_main_pid = command.electron_main_pid;
    std::lock_guard lock(preview_mutex_);
    preview_demand_ = demand;
    preview_session_id_ = command.session_id;
    preview_generation_ = command.generation;
    const auto found = preview_capturers_.find(
      previewKey(command.session_id, command.generation));
    if (found != preview_capturers_.end() && found->second.capturer) {
      found->second.capturer->setPreviewDemand(demand);
      if (found->second.preview_lane) {
        found->second.preview_lane->setEnabled(demand.demanded);
      }
    }
  }

  void releasePreviewFrame(const MediaCommand& command) {
    const auto key = previewKey(command.session_id, command.generation);
    std::shared_ptr<ScreenGpuCapturer> capturer;
    {
      std::lock_guard lock(preview_mutex_);
      const auto found = preview_capturers_.find(key);
      if (found == preview_capturers_.end() || !found->second.capturer) return;
      capturer = found->second.capturer;
    }
    releaseScreenPreviewFrameWithRetirement(
        std::move(capturer),
        command.frame_sequence,
        [this, &key](const std::shared_ptr<ScreenGpuCapturer>& expected) {
          ScreenPreviewReleaseDetach detached;
          std::lock_guard lock(preview_mutex_);
          const auto found = preview_capturers_.find(key);
          if (found == preview_capturers_.end() ||
              found->second.capturer != expected) {
            return detached;
          }
          if (found->second.active) {
            detached.active = true;
            return detached;
          }
          detached.capturer = std::move(found->second.capturer);
          preview_capturers_.erase(found);
          return detached;
        },
        [this](std::shared_ptr<ScreenGpuCapturer> retired) noexcept {
          static_cast<void>(submitCapturerRetirement(
              std::move(retired), "screen_preview_release"));
        });
    preview_work_signal_->notify();
  }

  void retirePreviewCapturer(
    const std::string& session_id,
    std::uint64_t generation,
    const std::shared_ptr<ScreenGpuCapturer>& capturer
  ) {
    capturer->setPreviewDemand({});
    {
      std::lock_guard lock(preview_mutex_);
      const auto key = previewKey(session_id, generation);
      const auto found = preview_capturers_.find(key);
      if (found != preview_capturers_.end()) {
        found->second.active = false;
        if (found->second.preview_lane) {
          found->second.preview_lane->setEnabled(false);
        }
        if (found->second.capturer->previewFramesInFlight() == 0) {
          preview_capturers_.erase(found);
        }
      }
    }
    MediaCommand removed;
    removed.type = NativeCommandType::LocalScreenPreviewTrackRemoved;
    removed.session_id = session_id;
    removed.generation = generation;
    removed.track_id = localPreviewTrackId(session_id);
    try {
      static_cast<void>(post_(std::move(removed)));
    } catch (const std::exception& error) {
      logScreen(
        "screen_preview_track_removed_post_failed",
        {{"message", sanitizeDiagnosticMessage(error.what())}}
      );
    } catch (...) {
      logScreen(
        "screen_preview_track_removed_post_failed",
        {{"message", "unknown preview removal delivery failure"}}
      );
    }
  }

  SequencedEmitter& emitter_;
  InternalPost post_;
  LaunchScreenWorker launch_stats_worker_;
  LaunchScreenWorker launch_capture_worker_;
  ScreenFrameHandoffObserver frame_handoff_observer_;
  AfterScreenVideoPublished after_video_published_;
  ScreenVideoPublicationObserver video_publication_observer_;
  std::shared_ptr<CaptureBackendSupervisor> capture_supervisor_ =
    std::make_shared<CaptureBackendSupervisor>();
  CleanupSupervisor* cleanup_supervisor_;
  CleanupStartProbe cleanup_start_probe_;
  std::unique_ptr<ScreenPublicationController> publication_;
  std::mutex stats_mutex_;
  std::string stats_session_id_;
  std::uint64_t stats_generation_ = 0;
  std::uint64_t stats_video_frames_ = 0;
  std::uint64_t stats_audio_epoch_ = 0;
  std::uint64_t stats_audio_frames_ = 0;
  std::uint64_t stats_audio_packets_ = 0;
  std::uint64_t stats_audio_backlog_packets_ = 0;
  std::uint64_t stats_audio_discontinuities_ = 0;
  std::uint64_t stats_method_wgc_gpu_ = 0;
  std::uint64_t stats_method_dxgi_gpu_ = 0;
  std::uint64_t stats_video_recoverable_lost_count_ = 0;
  std::uint64_t stats_video_gpu_pool_slots_available_ = 0;
  std::uint64_t stats_video_gpu_pool_slots_total_ = 0;
  std::uint64_t stats_video_dxgi_duplication_hold_us_max_ = 0;
  ScreenFrameFlowStats stats_video_frame_flow_;
  double stats_audio_peak_db_ = -120.0;
  double stats_audio_rms_db_ = -120.0;
  std::string stats_capture_method_;
  bool stats_rtp_available_ = false;
  std::uint64_t stats_rtp_packets_sent_ = 0;
  std::uint64_t stats_rtp_bytes_sent_ = 0;
  std::uint64_t stats_rtp_frames_sent_ = 0;
  std::uint64_t stats_rtp_frames_encoded_ = 0;
  std::string stats_encoder_implementation_;
  std::chrono::steady_clock::time_point next_stats_at_{};
  std::mutex preview_mutex_;
  ScreenPreviewDemand preview_demand_;
  std::string preview_session_id_;
  std::uint64_t preview_generation_ = 0;
  std::unordered_map<std::string, PreviewCapturerState> preview_capturers_;
  std::shared_ptr<ScreenPreviewWorkSignal> preview_work_signal_ =
      std::make_shared<ScreenPreviewWorkSignal>();
  std::thread preview_reaper_thread_;
};

ScreenActor::ScreenActor(
  SequencedEmitter& emitter,
  InternalPost post,
  IsCurrent is_current,
  std::shared_ptr<LiveKitVoiceSession> voice_session,
  CommitIfCurrent commit_if_current,
  Now now,
  CleanupStartProbe cleanup_start_probe,
  LaunchScreenWorker launch_stats_worker,
  LaunchScreenWorker launch_capture_worker,
  ScreenFrameHandoffObserver frame_handoff_observer,
  AfterScreenVideoPublished after_video_published,
  ScreenVideoPublicationObserver video_publication_observer
) : implementation_(std::make_shared<Implementation>(
      emitter,
      std::move(post),
      std::move(cleanup_start_probe),
      std::move(launch_stats_worker),
      std::move(launch_capture_worker),
      std::move(frame_handoff_observer),
      std::move(after_video_published),
      std::move(video_publication_observer)
    )) {
  implementation_->initializePublication(
    std::move(is_current),
    std::move(voice_session),
    std::move(commit_if_current),
    std::move(now)
  );
}

ScreenActor::~ScreenActor() { implementation_->shutdown(); }

void ScreenActor::connect(const MediaCommand& command) { implementation_->connect(command); }

void ScreenActor::startCapture(const MediaCommand& command) {
  implementation_->startCapture(command);
}

void ScreenActor::stopCapture(const MediaCommand& command, bool emit_stopped) {
  implementation_->stopCapture(command, emit_stopped);
}

void ScreenActor::disconnect(const MediaCommand& command, bool emit_stopped) {
  implementation_->disconnect(command, emit_stopped);
}

void ScreenActor::handleTerminal(const MediaCommand& command) {
  implementation_->handleTerminal(command);
}

void ScreenActor::handleWorkerCommand(const MediaCommand& command) {
  implementation_->handleWorkerCommand(command);
}

RuntimeEvent ScreenActor::probe(const MediaCommand& command) {
  return implementation_->probe(command);
}

void ScreenActor::shutdown() { implementation_->shutdown(); }
void ScreenActor::shutdown(std::chrono::steady_clock::time_point deadline) {
  implementation_->shutdown(deadline);
}

}  // namespace syrnike::desktop_native::media
