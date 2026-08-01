#include "screen_actor.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <exception>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <utility>

#include <livekit/d3d11_h264_video_source.h>

#include <objbase.h>

#include "../common/diagnostic_log.hpp"
#include "livekit_disconnect_reason.hpp"
#include "media_runtime_support.hpp"
#include "capture_backend_supervisor.hpp"
#include "screen_audio_capture.hpp"
#include "screen_capture_priority.hpp"
#include "screen_gpu_capture.hpp"

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
    case ScreenGpuCaptureErrorCode::InteropUnavailable:
    case ScreenGpuCaptureErrorCode::FormatUnsupported:
      return "gpu_interop_unavailable";
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
  event.type = "screenBackendRestart";
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
    if (launcher) return launcher(std::move(work));
    return std::thread(std::move(work));
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

class ScreenCapturerRetireDispatcher::Implementation final {
 public:
  explicit Implementation(LaunchWorker launcher)
      : state_(std::make_shared<State>()) {
    if (!launcher) {
      launcher = [](std::function<void()> work) {
        return std::thread(std::move(work));
      };
    }
    state_->launcher = std::move(launcher);
    for (auto& slot : state_->slots) {
      slot.capturers.reserve(kCapturersPerSlot);
    }
    management_thread_ = std::thread([state = state_] {
      runManagement(std::move(state));
    });
  }

  ~Implementation() {
    close(std::chrono::steady_clock::now() + kNativeShutdownBudget);
  }

  void submit(
      std::vector<std::shared_ptr<ScreenGpuCapturer>> capturers) {
    if (capturers.empty()) return;
    {
      std::lock_guard lock(state_->mutex);
      auto& slot = claimSlot(*state_);
      slot.capturers = std::move(capturers);
      slot.occupied = true;
    }
    state_->changed.notify_all();
  }

  void submit(std::shared_ptr<ScreenGpuCapturer> capturer) {
    if (!capturer) return;
    {
      std::lock_guard lock(state_->mutex);
      auto& slot = claimSlot(*state_);
      slot.capturers.push_back(std::move(capturer));
      slot.occupied = true;
    }
    state_->changed.notify_all();
  }

  void submitShutdown(
      std::vector<std::shared_ptr<ScreenGpuCapturer>> capturers) noexcept {
    if (capturers.empty()) return;
    {
      std::lock_guard lock(state_->mutex);
      auto& slot = state_->slots[kRuntimeSlotCount];
      slot.capturers = std::move(capturers);
      slot.occupied = true;
    }
    state_->changed.notify_all();
  }

  void close(std::chrono::steady_clock::time_point deadline) noexcept {
    if (!management_thread_.joinable()) return;
    {
      std::lock_guard lock(state_->mutex);
      state_->closing = true;
    }
    state_->changed.notify_all();
    bool finished = false;
    {
      std::unique_lock lock(state_->mutex);
      state_->finished_changed.wait_until(
          lock, deadline, [&] { return state_->finished; });
      finished = state_->finished;
    }
    if (finished) {
      management_thread_.join();
    } else {
      management_thread_.detach();
      logScreen(
        "screen_capturer_retire_dispatcher_detached",
        {{"reason", "shutdown_deadline"}}
      );
    }
  }

 private:
  static constexpr std::size_t kRuntimeSlotCount = 8;
  static constexpr std::size_t kSlotCount = kRuntimeSlotCount + 1;
  static constexpr std::size_t kCapturersPerSlot = 8;

  struct Slot {
    std::vector<std::shared_ptr<ScreenGpuCapturer>> capturers;
    bool occupied = false;
    bool launched = false;
  };

  struct State {
    std::mutex mutex;
    std::condition_variable changed;
    std::condition_variable finished_changed;
    std::array<Slot, kSlotCount> slots;
    LaunchWorker launcher;
    bool closing = false;
    bool finished = false;
  };

  static Slot& claimSlot(State& state) {
    for (std::size_t index = 0; index < kRuntimeSlotCount; ++index) {
      if (!state.slots[index].occupied) return state.slots[index];
    }
    throw std::runtime_error("screen capturer retire capacity exhausted");
  }

  static void runManagement(std::shared_ptr<State> state) noexcept {
    for (;;) {
      std::size_t slot_index = kSlotCount;
      {
        std::unique_lock lock(state->mutex);
        state->changed.wait(lock, [&] {
          if (state->closing) return true;
          return std::any_of(
            state->slots.begin(), state->slots.end(),
            [](const Slot& slot) {
              return slot.occupied && !slot.launched;
            });
        });
        for (std::size_t index = 0; index < state->slots.size(); ++index) {
          if (state->slots[index].occupied &&
              !state->slots[index].launched) {
            slot_index = index;
            state->slots[index].launched = true;
            break;
          }
        }
        if (slot_index == kSlotCount) {
          const bool occupied = std::any_of(
            state->slots.begin(), state->slots.end(),
            [](const Slot& slot) { return slot.occupied; });
          if (occupied || !state->closing) {
            state->changed.wait_for(lock, std::chrono::milliseconds(25));
            continue;
          }
          state->finished = true;
          state->finished_changed.notify_all();
          return;
        }
      }
      try {
        auto worker = state->launcher([state, slot_index] {
          // The occupied/launched flags prevent every other thread from
          // touching this preallocated slot until COM destruction completes.
          state->slots[slot_index].capturers.clear();
          {
            std::lock_guard lock(state->mutex);
            auto& slot = state->slots[slot_index];
            slot.launched = false;
            slot.occupied = false;
          }
          state->changed.notify_all();
        });
        worker.detach();
      } catch (...) {
        {
          std::lock_guard lock(state->mutex);
          state->slots[slot_index].launched = false;
        }
        logScreen(
          "screen_capturer_retire_worker_failed",
          {{"reason", "worker_launch_failed"}}
        );
        std::unique_lock lock(state->mutex);
        state->changed.wait_for(lock, std::chrono::milliseconds(25));
      }
    }
  }

  std::shared_ptr<State> state_;
  std::thread management_thread_;
};

ScreenCapturerRetireDispatcher::ScreenCapturerRetireDispatcher(
    LaunchWorker launcher)
    : implementation_(
          std::make_shared<Implementation>(std::move(launcher))) {}

ScreenCapturerRetireDispatcher::~ScreenCapturerRetireDispatcher() {
  if (implementation_) implementation_->close(
      std::chrono::steady_clock::now() + kNativeShutdownBudget);
}

void ScreenCapturerRetireDispatcher::submit(
    std::shared_ptr<ScreenGpuCapturer> capturer) {
  implementation_->submit(std::move(capturer));
}

void ScreenCapturerRetireDispatcher::submit(
    std::vector<std::shared_ptr<ScreenGpuCapturer>> capturers) {
  implementation_->submit(std::move(capturers));
}

void ScreenCapturerRetireDispatcher::submitShutdown(
    std::vector<std::shared_ptr<ScreenGpuCapturer>> capturers) noexcept {
  implementation_->submitShutdown(std::move(capturers));
}

void ScreenCapturerRetireDispatcher::close(
    std::chrono::steady_clock::time_point deadline) noexcept {
  implementation_->close(deadline);
}

class ScreenActor::Implementation final
    : public std::enable_shared_from_this<ScreenActor::Implementation> {
 public:
  Implementation(
    SequencedEmitter& emitter,
    InternalPost post,
    LaunchRetireWorker launch_retire_worker,
    LaunchScreenWorker launch_stats_worker,
    LaunchScreenWorker launch_capture_worker
  ) : emitter_(emitter),
      post_(std::move(post)),
      launch_stats_worker_(std::move(launch_stats_worker)),
      launch_capture_worker_(std::move(launch_capture_worker)),
      capturer_retire_dispatcher_(
          std::move(launch_retire_worker)) {
    preview_reaper_thread_ = std::thread([this] {
      while (!preview_reaper_stop_.load(std::memory_order_acquire)) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        std::vector<std::pair<
          std::string,
          std::shared_ptr<ScreenGpuCapturer>>> candidates;
        {
          std::lock_guard lock(preview_mutex_);
          for (const auto& [key, state] : preview_capturers_) {
            if (!state.active && state.capturer) {
              candidates.emplace_back(key, state.capturer);
            }
          }
        }
        std::vector<std::pair<
          std::string,
          std::shared_ptr<ScreenGpuCapturer>>> completed;
        for (auto& candidate : candidates) {
          candidate.second->pollRetirement();
          if (candidate.second->previewFramesInFlight() == 0) {
            completed.push_back(std::move(candidate));
          }
        }
        std::vector<std::shared_ptr<ScreenGpuCapturer>> retired;
        {
          std::lock_guard lock(preview_mutex_);
          for (const auto& [key, capturer] : completed) {
            const auto found = preview_capturers_.find(key);
            if (found == preview_capturers_.end() || found->second.active ||
                found->second.capturer != capturer) {
              continue;
            }
            retired.push_back(std::move(found->second.capturer));
            preview_capturers_.erase(found);
          }
        }
        // D3D/WGC teardown is allowed to block only this retire thread.
        retired.clear();
      }
    });
  }

  void initializePublication(
    IsCurrent is_current,
    std::shared_ptr<LiveKitPublicationClient> livekit_client,
    CommitIfCurrent commit_if_current,
    Now now
  ) {
    const auto owner = weak_from_this();
    publication_ = std::make_unique<ScreenPublicationController>(
        emitter_,
        post_,
        std::move(is_current),
        std::move(livekit_client),
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
          const std::shared_ptr<livekit::AudioSource>& audio_source,
          const std::shared_ptr<ScreenGpuCapturer>& capturer,
          const std::shared_ptr<std::atomic_bool>& running,
          const std::shared_ptr<syrnike::voice::ScreenAudioStopSignal>& audio_stop,
          const std::function<bool()>& is_current,
          std::thread& capture_thread,
          std::thread& audio_thread
        ) {
          const auto implementation = owner.lock();
          if (!implementation) {
            throw std::runtime_error("screen actor is shutting down");
          }
          implementation->startCaptureWorkers(
            command,
            description,
            video_source,
            video_track,
            audio_source,
            capturer,
            running,
            audio_stop,
            is_current,
            capture_thread,
            audio_thread
          );
        },
        [owner](const std::string& session_id, std::uint64_t generation) {
          if (const auto implementation = owner.lock()) {
            implementation->resetStats(session_id, generation);
          }
        }
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
    ended.type = "screenCaptureEnded";
    ended.session_id = session_id;
    ended.generation = generation;
    constexpr std::string_view allowed_reasons[] = {
      "target_closed",
      "gpu_capture_unavailable",
      "gpu_encoder_unavailable",
      "gpu_interop_unavailable",
      "gpu_device_lost",
      "rtp_stall_recovery_exhausted",
      "screen_recovery_timeout",
    };
    ended.reason = "runtime_error";
    for (const auto allowed : allowed_reasons) {
      if (reason == allowed) {
        ended.reason = reason;
        break;
      }
    }
    ended.detail = reason;
    emitter_.emit(std::move(ended));
    RuntimeEvent stopped;
    stopped.type = "sessionStopped";
    stopped.session_id = session_id;
    stopped.generation = generation;
    stopped.reason = reason;
    emitter_.emit(std::move(stopped));
  }

  void handleWorkerCommand(const MediaCommand& command) {
    if (command.type == "setLocalScreenPreviewDemand") {
      setPreviewDemand(command);
      return;
    }
    if (command.type == "releaseLocalScreenPreviewFrame") {
      releasePreviewFrame(command);
      return;
    }
    if (command.type == "__screenExecutePublicationRestart") {
      publication_->executePublicationRestart(command);
      return;
    }
    if (command.type == "__screenRecoveryFailed") {
      publication_->disconnect(command, false);
      emitCaptureEnded(
        command.session_id,
        command.generation,
        command.internal_message.empty()
          ? std::string("gpu_encoder_unavailable")
          : command.internal_message
      );
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
    preview_reaper_stop_.store(true, std::memory_order_release);
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
    if (!retired.empty()) {
      capturer_retire_dispatcher_.submitShutdown(std::move(retired));
    }
    capturer_retire_dispatcher_.close(deadline);
  }

 private:
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

  void startCaptureWorkers(
    const MediaCommand& command,
    const ScreenPublicationDescription& description,
    const std::shared_ptr<livekit::D3D11H264VideoSource>& video_source,
    const std::shared_ptr<livekit::LocalVideoTrack>& video_track,
    const std::shared_ptr<livekit::AudioSource>& audio_source,
    const std::shared_ptr<ScreenGpuCapturer>& capturer,
    const std::shared_ptr<std::atomic_bool>& running,
    const std::shared_ptr<syrnike::voice::ScreenAudioStopSignal>& audio_stop,
    const std::function<bool()>& is_current,
    std::thread& capture_thread,
    std::thread& audio_thread
  ) {
    const auto owner = shared_from_this();
    if (!capturer) {
      throw std::runtime_error("gpu_capture_unavailable: missing prepared capturer");
    }
    if (!is_current()) throw std::runtime_error("stale screen capture generation");
    const auto preview_key =
      previewKey(command.session_id, command.generation);
    std::function<void()> rollback = [this, preview_key] {
      rollbackPreviewCapturer(preview_key);
    };
    std::function<void()> capture_work = [this,
       session_id = command.session_id,
       generation = command.generation,
       width = description.width,
       height = description.height,
       fps = description.fps,
       participant_identity = command.participant_identity,
       source = video_source,
       track = video_track,
       running,
       capturer]() mutable {
        captureLoop(
          std::move(session_id),
          generation,
          width,
          height,
          fps,
          std::move(participant_identity),
          std::move(source),
          std::move(track),
          std::move(running),
          std::move(capturer)
        );
    };
    registerPreviewCapturer(command, preview_key, capturer);
    capture_thread = launchScreenCaptureWorker(
      launch_capture_worker_,
      owner,
      std::move(capture_work),
      std::move(rollback)
    );
    if (description.publish_audio) {
      startAudioCapture(
        command,
        description.target,
        audio_source,
        running,
        audio_stop,
        audio_thread
      );
    }
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
    auto on_failure = [owner, session_id, generation](std::string message) {
      const auto implementation = owner.lock();
      if (!implementation) return;
      MediaCommand terminal;
      terminal.type = "__screenTerminal";
      terminal.session_id = session_id;
      terminal.generation = generation;
      terminal.internal_message = "screen_audio_capture_failed:" + message;
      implementation->post_(std::move(terminal));
    };
    auto on_stats = [owner, session_id, generation](
      std::uint64_t frames,
      std::uint64_t packets,
      double peak_db,
      double rms_db
    ) {
      if (const auto implementation = owner.lock()) {
        implementation->recordAudioStats(
          session_id,
          generation,
          frames,
          packets,
          peak_db,
          rms_db
        );
      }
    };
    if (target.window) {
      audio_thread = std::thread(
        syrnike::voice::captureProcessLoopbackAudio,
        target.process_id,
        session_id,
        audio_source,
        running,
        stop_signal,
        std::move(on_failure),
        std::move(on_stats)
      );
    } else {
      audio_thread = std::thread(
        syrnike::voice::captureSystemLoopbackAudio,
        command.exclude_process_id,
        session_id,
        audio_source,
        running,
        stop_signal,
        std::move(on_failure),
        std::move(on_stats)
      );
    }
  }

  void resetStats(const std::string& session_id, std::uint64_t generation) {
    bool new_publication_session = false;
    std::lock_guard lock(stats_mutex_);
    new_publication_session =
      stats_session_id_ != session_id || stats_generation_ != generation;
    stats_session_id_ = session_id;
    stats_generation_ = generation;
    stats_video_frames_ = 0;
    stats_audio_frames_ = 0;
    stats_audio_packets_ = 0;
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
    if (new_publication_session) {
      capture_supervisor_->resetPublicationRecovery();
    }
  }

  void emitStatsIfDue(const std::string& session_id, std::uint64_t generation) {
    std::optional<RuntimeEvent> snapshot;
    {
      std::lock_guard lock(stats_mutex_);
      if (stats_session_id_ != session_id || stats_generation_ != generation) return;
      const auto now = std::chrono::steady_clock::now();
      if (now < next_stats_at_) return;
      RuntimeEvent event;
      event.type = "stats";
      event.session_id = stats_session_id_;
      event.generation = stats_generation_;
      event.frames = stats_video_frames_;
      event.audio_frames = stats_audio_frames_;
      event.audio_packets = stats_audio_packets_;
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
    std::uint64_t frames,
    std::uint64_t packets,
    double peak_db,
    double rms_db
  ) {
    {
      std::lock_guard lock(stats_mutex_);
      if (stats_session_id_ != session_id || stats_generation_ != generation) return;
      stats_audio_frames_ = frames;
      stats_audio_packets_ = packets;
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
    std::string participant_identity,
    std::shared_ptr<livekit::D3D11H264VideoSource> source,
    std::shared_ptr<livekit::LocalVideoTrack> track,
    std::shared_ptr<std::atomic_bool> running,
    std::shared_ptr<ScreenGpuCapturer> capturer
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
    bool rtp_stall_reported = false;
    bool capture_loss_reported = false;
    const auto request_publication_recovery =
      [&](std::string cause, std::chrono::steady_clock::time_point now) {
        const auto decision =
          capture_supervisor_->observePublicationStall(now);
        if (decision.action != CaptureBackendAction::RestartPublication) {
          return;
        }
        MediaCommand recovery;
        recovery.type = "__screenExecutePublicationRestart";
        recovery.session_id = session_id;
        recovery.generation = generation;
        recovery.revision = capture_supervisor_->publicationRecoveryCount();
        recovery.internal_message = std::move(cause);
        if (post_(std::move(recovery))) {
          rtp_stall_reported = true;
          running->store(false);
        }
      };
    std::uint64_t frames = 0;
    std::uint64_t method_wgc_gpu = 0;
    std::uint64_t method_dxgi_gpu = 0;
    std::string method = capturer->method();
    ScreenGpuFrame captured;
    const HRESULT com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool uninitialize_com = SUCCEEDED(com_result);
    std::atomic_bool stats_running{true};
    std::mutex sampled_stats_mutex;
    std::optional<OutboundStatsSample> sampled_stats;
    std::uint64_t sampled_stats_revision = 0;
    std::uint64_t consumed_stats_revision = 0;
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
        ScreenPreviewFrame preview;
        if (capturer->takePreviewFrame(preview)) {
            MediaCommand preview_command;
            preview_command.type = "__localScreenPreviewFrame";
            preview_command.session_id = session_id;
            preview_command.generation = generation;
            preview_command.track_id = localPreviewTrackId(session_id);
            preview_command.participant_identity = participant_identity;
            preview_command.video_source = "screen";
            preview_command.frame_sequence = preview.sequence;
            preview_command.timestamp_us = preview.timestamp_us;
            preview_command.width = static_cast<int>(preview.width);
            preview_command.height = static_cast<int>(preview.height);
            preview_command.nt_handle = preview.nt_handle;
            try {
              preview_command.on_drop = [capturer, sequence = preview.sequence] {
                capturer->releasePreviewFrame(sequence);
              };
            } catch (...) {
              capturer->releasePreviewFrame(preview.sequence);
              throw;
            }
            if (!post_(std::move(preview_command))) {
              capturer->releasePreviewFrame(preview.sequence);
            }
        }
        ScreenPreviewFailure preview_failure;
        if (capturer->takePreviewFailure(preview_failure)) {
          MediaCommand failure;
          failure.type = "__localScreenPreviewFailed";
          failure.session_id = session_id;
          failure.generation = generation;
          failure.track_id = localPreviewTrackId(session_id);
          failure.video_source = std::string(gpuCaptureReason(preview_failure.code));
          failure.internal_message = std::move(preview_failure.message);
          failure.diagnostic_hresult = preview_failure.hresult;
          failure.diagnostic_suppressed = preview_failure.suppressed;
          post_(std::move(failure));
        }
        if (capture.status == ScreenGpuFrameStatus::NewFrame) {
          capture_loss_reported = false;
          auto lease = std::make_unique<ScreenTextureLease>(capturer, captured);
          const auto timestamp = captured.timestamp_us != 0
            ? static_cast<std::int64_t>(captured.timestamp_us)
            : std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - started).count();
          if (source->capture(std::move(lease), timestamp)) {
            encoder_backpressure_stall.noteProgress();
            ++frames;
            if (method == "wgc_gpu") ++method_wgc_gpu;
            else if (method == "dxgi_gpu") ++method_dxgi_gpu;
          }
        } else if (capture.status == ScreenGpuFrameStatus::EncoderBackpressure) {
          const auto now = std::chrono::steady_clock::now();
          if (!rtp_stall_reported && encoder_backpressure_stall.observe(
                now, std::chrono::seconds(2))) {
            logScreen(
              "screen_encoder_backpressure_stall",
              {
                {"sessionId", session_id},
                {"generation", generation},
                {"frames", frames},
                {"method", method}
              }
            );
            request_publication_recovery("encoder_backpressure", now);
          }
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
          terminal.type = "__screenTerminal";
          terminal.session_id = session_id;
          terminal.generation = generation;
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
            if (!rtp_stall_reported &&
                stall != ScreenOutputStall::None) {
              const std::string cause =
                stall == ScreenOutputStall::Encoder
                  ? "encoder_output_stalled"
                  : "rtp_output_stalled";
              logScreen(
                "screen_rtp_stall_detected",
                {
                  {"sessionId", session_id},
                  {"generation", generation},
                  {"frames", frames},
                  {"framesEncoded", stats->frames_encoded},
                  {"framesSent", stats->frames_sent}
                }
              );
              request_publication_recovery(cause, now);
            }
          }
        }
        recordVideoStats(
          session_id,
          generation,
          frames,
          method,
          method_wgc_gpu,
          method_dxgi_gpu,
          capturer->recoverableLossCount(),
          capturer->frameSlotsAvailable(),
          capturer->frameSlotsTotal(),
          capturer->frameFlowStats(),
          capture.metrics.duplication_hold_us
        );
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
        terminal.type = "__screenTerminal";
        terminal.session_id = session_id;
        terminal.generation = generation;
        const auto* gpu_error = dynamic_cast<const ScreenGpuCaptureError*>(&error);
        terminal.internal_message = gpu_error
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
        terminal.type = "__screenTerminal";
        terminal.session_id = session_id;
        terminal.generation = generation;
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
    logScreen(
      "screen_capture_loop_exit",
      {
        {"sessionId", session_id},
        {"generation", generation},
        {"frames", frames},
        {"methodWgcGpu", method_wgc_gpu},
        {"methodDxgiGpu", method_dxgi_gpu},
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
    const std::shared_ptr<ScreenGpuCapturer>& capturer
  ) {
    std::lock_guard lock(preview_mutex_);
    auto& state = preview_capturers_[key];
    state.capturer = capturer;
    state.active = true;
    if (preview_session_id_ == command.session_id &&
        preview_generation_ == command.generation) {
      capturer->setPreviewDemand(preview_demand_);
    } else {
      capturer->setPreviewDemand({});
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
    } catch (...) {
      return;
    }
    try {
      capturer_retire_dispatcher_.submit(retired);
      std::lock_guard lock(preview_mutex_);
      const auto found = preview_capturers_.find(key);
      if (found != preview_capturers_.end() &&
          found->second.capturer == retired) {
        preview_capturers_.erase(found);
      }
    } catch (...) {
      // Preserve ownership for the existing retire reaper if the fixed
      // dispatcher capacity is temporarily occupied. The reaper extracts and
      // destroys outside preview_mutex_.
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
    }
  }

  void releasePreviewFrame(const MediaCommand& command) {
    std::lock_guard lock(preview_mutex_);
    const auto key = previewKey(command.session_id, command.generation);
    const auto found = preview_capturers_.find(key);
    if (found == preview_capturers_.end() || !found->second.capturer) return;
    found->second.capturer->releasePreviewFrame(command.frame_sequence);
    if (!found->second.active &&
        found->second.capturer->previewFramesInFlight() == 0) {
      preview_capturers_.erase(found);
    }
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
        if (found->second.capturer->previewFramesInFlight() == 0) {
          preview_capturers_.erase(found);
        }
      }
    }
    MediaCommand removed;
    removed.type = "__localScreenPreviewTrackRemoved";
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
  std::shared_ptr<CaptureBackendSupervisor> capture_supervisor_ =
    std::make_shared<CaptureBackendSupervisor>();
  ScreenCapturerRetireDispatcher capturer_retire_dispatcher_;
  std::unique_ptr<ScreenPublicationController> publication_;
  std::mutex stats_mutex_;
  std::string stats_session_id_;
  std::uint64_t stats_generation_ = 0;
  std::uint64_t stats_video_frames_ = 0;
  std::uint64_t stats_audio_frames_ = 0;
  std::uint64_t stats_audio_packets_ = 0;
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
  struct PreviewCapturerState {
    std::shared_ptr<ScreenGpuCapturer> capturer;
    bool active = false;
  };
  std::mutex preview_mutex_;
  ScreenPreviewDemand preview_demand_;
  std::string preview_session_id_;
  std::uint64_t preview_generation_ = 0;
  std::unordered_map<std::string, PreviewCapturerState> preview_capturers_;
  std::atomic_bool preview_reaper_stop_{false};
  std::thread preview_reaper_thread_;
};

ScreenActor::ScreenActor(
  SequencedEmitter& emitter,
  InternalPost post,
  IsCurrent is_current,
  std::shared_ptr<LiveKitPublicationClient> livekit_client,
  CommitIfCurrent commit_if_current,
  Now now,
  LaunchRetireWorker launch_retire_worker,
  LaunchScreenWorker launch_stats_worker,
  LaunchScreenWorker launch_capture_worker
) : implementation_(std::make_shared<Implementation>(
      emitter,
      std::move(post),
      std::move(launch_retire_worker),
      std::move(launch_stats_worker),
      std::move(launch_capture_worker)
    )) {
  implementation_->initializePublication(
    std::move(is_current),
    std::move(livekit_client),
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
