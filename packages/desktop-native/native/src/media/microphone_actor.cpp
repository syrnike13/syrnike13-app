#include "microphone_actor.hpp"

#include <audioclient.h>
#include <avrt.h>
#include <windows.h>
#include <wrl/client.h>

#include <livekit/livekit.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <cstdint>
#include <exception>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "../common/diagnostic_log.hpp"
#include "audio_constants.hpp"
#include "audio_devices.hpp"
#include "audio_failure.hpp"
#include "capture_lifecycle_invariants.hpp"
#include "livekit_disconnect_reason.hpp"
#include "livekit_publication_client.hpp"
#include "microphone_audio_processor.hpp"
#include "microphone_echo_reference.hpp"
#include "microphone_metrics_cadence.hpp"
#include "microphone_publication_controller.hpp"
#include "runtime_config.hpp"
#include "runtime_config_patch.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::desktop_native::media {
namespace {

using diagnostics::DiagnosticField;

void logMicrophone(
  std::string_view event,
  std::initializer_list<DiagnosticField> fields = {}
) {
  auto& logger = diagnostics::DiagnosticLog::instance();
  if (!logger.enabled()) return;
  logger.write(event, fields);
}

struct PipelineState {
  std::string device_id;
  syrnike::voice::RuntimeConfig config;
  std::uint64_t revision = 0;
};

}  // namespace

class MicrophoneActor::Implementation {
 public:
  Implementation(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitPublicationClient> livekit_client
  ) : emitter_(emitter),
      post_(std::move(post)),
      is_current_(std::move(is_current)),
      livekit_client_(std::move(livekit_client)),
      publication_(
        emitter_,
        post_,
        is_current_,
        [this](const auto& source, const auto& session_id, auto generation) {
          addSink(source, session_id, generation);
        },
        [this](const auto& source) { removeSink(source); },
        [this] { return captureHealthy(); },
        livekit_client_
      ) {
    try {
      endpoint_monitor_ = std::make_unique<AudioEndpointMonitor>(
        eCapture,
        [this](AudioEndpointChange change) {
          MediaCommand command;
          command.type = "__microphoneEndpointChanged";
          command.device_id = std::move(change.device_id);
          command.internal_message = change.kind == AudioEndpointChangeKind::DefaultChanged
            ? "default_changed"
            : (change.kind == AudioEndpointChangeKind::Removed ? "removed" : "disabled");
          post_(std::move(command));
        }
      );
    } catch (const std::exception& error) {
      logMicrophone("microphone_endpoint_monitor_unavailable", {{"message", error.what()}});
    }
  }

  ~Implementation() { shutdown(); }

  void warm(const MediaCommand& command) {
    logMicrophone(
      "microphone_warm_start",
      {
        {"command", command.type},
        {"sessionId", command.session_id},
        {"generation", command.generation}
      }
    );
    if (command.type == "startPreview") {
      if (!publication_.activeSessionId().empty()) {
        if (!captureHealthy()) {
          throw std::runtime_error("active microphone capture pipeline is not healthy");
        }
        return;
      }
    }
    auto desired = pipelineState();
    if (command.type == "warmMicrophone") {
      desired.config = mergeRuntimeConfig(desired.config, command);
      // An empty device id is the explicit Windows default-device selection.
      desired.device_id = command.device_id;
    }
    ensureCaptureWithDefaultFallback(desired, true);
    logMicrophone(
      "microphone_warm_ok",
      {
        {"command", command.type},
        {"sessionId", command.session_id},
        {"generation", command.generation}
      }
    );
  }

  void connect(const MediaCommand& command) {
    logMicrophone(
      "microphone_connect_start",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"muted", command.muted},
        {"audioBitrate", static_cast<std::uint64_t>(command.audio_bitrate)}
      }
    );
    if (!is_current_(command.session_id, command.generation)) {
      logMicrophone(
        "microphone_connect_stale_before_start",
        {{"sessionId", command.session_id}, {"generation", command.generation}}
      );
      throw std::runtime_error("stale microphone connect generation");
    }
    validateMicrophonePublicationCommand(command);
    const auto desired_pipeline = pipelineState();
    logMicrophone(
      "microphone_connect_ensure_capture_start",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"pipelineRevision", desired_pipeline.revision}
      }
    );
    const auto effective_pipeline = ensureCaptureWithDefaultFallback(
      desired_pipeline,
      true
    );
    logMicrophone(
      "microphone_connect_ensure_capture_ok",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"captureHealthy", captureHealthy()}
      }
    );

    publication_.start(command, MicrophonePipelineSnapshot{
      .device_id = effective_pipeline.device_id,
      .revision = effective_pipeline.revision,
      .noise_suppression_enabled = effective_pipeline.config.noise_suppression_enabled,
      .echo_cancellation_enabled = effective_pipeline.config.echo_cancellation_enabled,
    });
  }

  RuntimeEvent configure(const MediaCommand& command) {
    logMicrophone(
      "microphone_configure_start",
      {
        {"revision", command.revision},
        {"hasRevision", command.has_revision}
      }
    );
    const auto current = pipelineState();
    if (command.has_revision && command.revision < current.revision) {
      throw std::runtime_error("stale microphone configuration revision");
    }
    auto desired = current;
    desired.config = mergeRuntimeConfig(desired.config, command);
    desired.device_id = command.device_id;
    if (command.has_revision) desired.revision = command.revision;
    if (captureThreadActive() &&
        (desired.device_id != current.device_id ||
         microphoneCaptureConfigRequiresRestart(current.config, desired.config))) {
      desired = ensureCaptureWithDefaultFallback(desired, true);
    } else {
      setPipelineState(desired);
    }
    emitInputFallbackIfPending(
      publication_.activeSessionId(),
      publication_.activeGeneration()
    );
    RuntimeEvent reply;
    reply.type = "reply";
    reply.request_id = command.request_id;
    reply.ok = true;
    reply.kind = "microphoneConfig";
    reply.device_id = desired.device_id;
    reply.revision = desired.revision;
    logMicrophone(
      "microphone_configure_ok",
      {
        {"revision", desired.revision},
        {"deviceSwitch", desired.device_id != current.device_id},
        {"captureRestart", microphoneCaptureConfigRequiresRestart(
          current.config,
          desired.config
        )}
      }
    );
    return reply;
  }

  void setMuted(const MediaCommand& command) {
    const auto started_at = diagnostics::DiagnosticLog::instance().steadyNowMs();
    logMicrophone(
      "microphone_set_muted_start",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"muted", command.muted}
      }
    );
    publication_.setMuted(command);
    logMicrophone(
      "microphone_set_muted_ok",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"muted", command.muted},
        {"durationMs", diagnostics::DiagnosticLog::instance().steadyNowMs() - started_at}
      }
    );
  }

  void setPreviewConsumer(
    const std::string& session_id,
    std::uint64_t generation,
    PreviewConsumer consumer
  ) {
    std::lock_guard lock(preview_mutex_);
    preview_session_id_ = session_id;
    preview_generation_ = generation;
    preview_consumer_ = std::move(consumer);
  }

  void clearPreviewConsumer(const std::string& session_id, std::uint64_t generation) {
    std::lock_guard lock(preview_mutex_);
    if (preview_session_id_ != session_id || preview_generation_ != generation) return;
    preview_consumer_ = {};
    preview_session_id_.clear();
    preview_generation_ = 0;
  }

  bool isCurrentCaptureFailureCommand(const MediaCommand& command) {
    return command.device_kind == "microphone_capture" &&
      syrnike::desktop_native::media::isCurrentCaptureFailure(
        command.internal_epoch,
        capture_epoch_.load(),
        capture_running_.load(),
        captureReady()
      );
  }

  void disconnect(const MediaCommand& command, bool emit_stopped) {
    logMicrophone(
      "microphone_disconnect_start",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"emitStopped", emit_stopped}
      }
    );
    const auto previous_session_id = publication_.activeSessionId();
    const auto previous_generation = publication_.activeGeneration();
    publication_.disconnect(command, emit_stopped);
    logMicrophone(
      "microphone_disconnect_cleanup_done",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"hadActiveRoom", !previous_session_id.empty()},
        {"activeGeneration", previous_generation}
      }
    );
  }

  bool handleTerminal(const MediaCommand& command) {
    logMicrophone(
      "microphone_handle_terminal",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"message", command.internal_message}
      }
    );
    MediaCommand effective = command;
    const bool capture_failure = command.device_kind == "microphone_capture";
    if (capture_failure) {
      if (!isCurrentCaptureFailureCommand(command)) return false;
      effective.session_id = publication_.activeSessionId();
      effective.generation = publication_.activeGeneration();
      if (audioFailureCodeAllowsDefaultFallback(command.video_source)) {
        const auto current = pipelineState();
        auto desired = current;
        const bool explicit_device =
          !current.device_id.empty() && current.device_id != "default";
        if (explicit_device) desired.device_id.clear();
        try {
          ensureCapture(desired, false, true);
          input_fallback_pending_ = false;
          if (explicit_device) input_fallback_warning_pending_ = true;
          emitInputFallbackIfPending(
            effective.session_id,
            effective.generation
          );
          if (!explicit_device && !effective.session_id.empty()) {
            RuntimeEvent recovered;
            recovered.type = "sessionLifecycle";
            recovered.session_id = effective.session_id;
            recovered.generation = effective.generation;
            recovered.kind = "microphone";
            recovered.status = "running";
            recovered.device_id = "default";
            recovered.detail = "audio_input_default_recovered";
            emitter_.emit(std::move(recovered));
          }
          logMicrophone(
            "microphone_capture_recovered",
            {
              {"sessionId", effective.session_id},
              {"generation", effective.generation},
              {"fallbackDefault", explicit_device}
            }
          );
          return false;
        } catch (const std::exception& recovery_error) {
          const auto recovery_failure = describeAudioFailure(recovery_error);
          input_fallback_pending_ = audioFailureAllowsDefaultFallback(
            recovery_failure.kind
          );
          logMicrophone(
            input_fallback_pending_
              ? "microphone_capture_recovery_deferred"
              : "microphone_capture_recovery_terminal",
            {
              {"sessionId", effective.session_id},
              {"generation", effective.generation},
              {"message", recovery_error.what()}
            }
          );
          if (input_fallback_pending_ && !effective.session_id.empty()) {
            RuntimeEvent unavailable;
            unavailable.type = "sessionLifecycle";
            unavailable.session_id = effective.session_id;
            unavailable.generation = effective.generation;
            unavailable.kind = "microphone";
            unavailable.status = "starting";
            unavailable.detail = recovery_failure.message;
            unavailable.error = NativeError{
              .code = recovery_failure.code,
              .message = recovery_failure.message,
              .stage = "recoverMicrophoneInput",
              .retryable = recovery_failure.retryable,
              .session_id = effective.session_id,
              .generation = effective.generation,
              .hresult = recovery_failure.hresult == S_OK
                ? std::optional<std::int64_t>{}
                : std::optional<std::int64_t>{
                    static_cast<std::int64_t>(recovery_failure.hresult)
                  },
            };
            emitter_.emit(std::move(unavailable));
            // Keep the publication and its session identity alive. A later
            // endpoint notification retries the local capture pipeline.
            return false;
          }
          if (input_fallback_pending_) return true;
          effective.internal_message = recovery_failure.message;
          effective.video_source = recovery_failure.code;
          effective.diagnostic_retryable = recovery_failure.retryable;
          effective.diagnostic_hresult =
            static_cast<std::int64_t>(recovery_failure.hresult);
        }
      }
    }
    if (effective.session_id.empty()) return capture_failure;
    publication_.handleTerminal(effective);
    return capture_failure;
  }

  void handleWorkerCommand(const MediaCommand& command) {
    if (command.type == "__microphoneEndpointChanged") {
      handleEndpointChange(command);
      return;
    }
    publication_.handleWorkerCommand(command);
    if (command.type == "__microphoneAttemptReady" &&
        publication_.activeSessionId() == command.session_id &&
        publication_.activeGeneration() == command.generation) {
      emitInputFallbackIfPending(command.session_id, command.generation);
    }
  }

  RuntimeEvent probe(const MediaCommand& command) {
    RuntimeEvent result;
    result.type = "reply";
    result.request_id = command.request_id;
    result.session_id = command.session_id;
    result.generation = command.generation;

    const auto capacity = publication_.capacityStatus();
    if (capacity != MicrophonePublicationCapacityStatus::ActorUnresponsive) {
      result.state = capacity == MicrophonePublicationCapacityStatus::ActorBusy
        ? "busy"
        : "available";
      return result;
    }

    result.ok = false;
    result.error = NativeError{
      .code = "actor_unresponsive",
      .message = "microphone publication worker exceeded its operation deadline",
      .stage = "probeMicrophoneActor",
      .retryable = true,
      .session_id = command.session_id,
      .generation = command.session_id.empty()
        ? std::optional<std::uint64_t>{}
        : std::optional<std::uint64_t>{command.generation},
    };
    logMicrophone("microphone_probe_unresponsive");
    return result;
  }

  void shutdown() {
    logMicrophone("microphone_shutdown_start");
    publication_.shutdown();
    shutdownSinks();
    stopCapture();
    logMicrophone("microphone_shutdown_done");
  }

 private:
  struct SinkState {
    std::shared_ptr<livekit::AudioSource> source;
    std::string session_id;
    std::uint64_t generation = 0;
    std::mutex mutex;
    std::condition_variable changed;
    std::deque<std::vector<std::int16_t>> frames;
    bool running = true;
    std::thread worker;
  };

  void addSink(
    const std::shared_ptr<livekit::AudioSource>& source,
    const std::string& session_id,
    std::uint64_t generation
  ) {
    auto sink = std::make_shared<SinkState>();
    sink->source = source;
    sink->session_id = session_id;
    sink->generation = generation;
    sink->worker = std::thread([this, sink] {
      while (true) {
        std::vector<std::int16_t> pcm;
        {
          std::unique_lock lock(sink->mutex);
          sink->changed.wait(lock, [&] {
            return !sink->running || !sink->frames.empty();
          });
          if (!sink->running && sink->frames.empty()) break;
          pcm = std::move(sink->frames.front());
          sink->frames.pop_front();
        }
        try {
          livekit::AudioFrame frame(
            std::move(pcm),
            syrnike::voice::kSampleRate,
            syrnike::voice::kChannels,
            syrnike::voice::kSamplesPer10Ms
          );
          sink->source->captureFrame(frame);
        } catch (const std::exception& error) {
          {
            std::lock_guard lock(sink->mutex);
            sink->running = false;
            sink->frames.clear();
          }
          MediaCommand terminal;
          terminal.type = "__microphoneTerminal";
          terminal.session_id = sink->session_id;
          terminal.generation = sink->generation;
          terminal.internal_message = error.what();
          terminal.video_source = "microphone_sink_failed";
          terminal.device_kind = "microphone_publication";
          terminal.diagnostic_retryable = true;
          post_(std::move(terminal));
        } catch (...) {
          {
            std::lock_guard lock(sink->mutex);
            sink->running = false;
            sink->frames.clear();
          }
          MediaCommand terminal;
          terminal.type = "__microphoneTerminal";
          terminal.session_id = sink->session_id;
          terminal.generation = sink->generation;
          terminal.internal_message = "unknown LiveKit audio sink failure";
          terminal.video_source = "microphone_sink_failed";
          terminal.device_kind = "microphone_publication";
          terminal.diagnostic_retryable = true;
          post_(std::move(terminal));
        }
      }
    });
    std::lock_guard lock(sinks_mutex_);
    sinks_.push_back(std::move(sink));
    logMicrophone(
      "microphone_sink_attached",
      {{"sinkCount", static_cast<std::uint64_t>(sinks_.size())}}
    );
  }

  void removeSink(const std::shared_ptr<livekit::AudioSource>& source) {
    if (!source) return;
    std::shared_ptr<SinkState> removed;
    std::size_t remaining = 0;
    {
      std::lock_guard lock(sinks_mutex_);
      const auto found = std::find_if(sinks_.begin(), sinks_.end(), [&](const auto& candidate) {
        return candidate->source == source;
      });
      if (found != sinks_.end()) {
        removed = std::move(*found);
        sinks_.erase(found);
      }
      remaining = sinks_.size();
    }
    if (removed) {
      {
        std::lock_guard lock(removed->mutex);
        removed->running = false;
        removed->frames.clear();
      }
      removed->changed.notify_all();
      if (removed->worker.joinable() &&
          removed->worker.get_id() != std::this_thread::get_id()) {
        removed->worker.join();
      }
    }
    logMicrophone(
      "microphone_sink_detached",
      {{"sinkCount", static_cast<std::uint64_t>(remaining)}}
    );
  }

  std::vector<std::shared_ptr<SinkState>> sinks() {
    std::lock_guard lock(sinks_mutex_);
    return sinks_;
  }

  PipelineState pipelineState() {
    std::lock_guard lock(pipeline_mutex_);
    return pipeline_;
  }

  void setPipelineState(const PipelineState& state) {
    std::lock_guard lock(pipeline_mutex_);
    pipeline_ = state;
  }

  struct PreviewTarget {
    std::string session_id;
    std::uint64_t generation = 0;
    PreviewConsumer consumer;
  };

  PreviewTarget previewTarget() {
    std::lock_guard lock(preview_mutex_);
    return PreviewTarget{preview_session_id_, preview_generation_, preview_consumer_};
  }

  bool captureReady() {
    std::lock_guard lock(capture_startup_mutex_);
    return capture_ready_;
  }

  bool captureHealthy() {
    return capture_running_.load() && captureReady();
  }

  bool capturePipelineMatches(const PipelineState& pipeline) {
    std::lock_guard lock(capture_lifecycle_mutex_);
    return capture_thread_.joinable() &&
      capture_device_id_ == pipeline.device_id &&
      capture_bypass_system_audio_input_processing_ ==
        pipeline.config.bypass_system_audio_input_processing;
  }

  bool captureThreadActive() {
    std::lock_guard lock(capture_lifecycle_mutex_);
    return capture_thread_.joinable();
  }

  void startCapture(const PipelineState& pipeline) {
    logMicrophone("microphone_capture_start_begin");
    {
      std::lock_guard lock(capture_startup_mutex_);
      capture_ready_ = false;
      capture_startup_failure_.reset();
    }
    const auto epoch = capture_epoch_.fetch_add(1) + 1;
    {
      std::lock_guard lock(capture_lifecycle_mutex_);
      capture_device_id_ = pipeline.device_id;
      capture_bypass_system_audio_input_processing_ =
        pipeline.config.bypass_system_audio_input_processing;
      capture_running_.store(true);
      capture_thread_ = std::thread([
        this,
        device_id = capture_device_id_,
        bypass_system_audio_input_processing =
          capture_bypass_system_audio_input_processing_,
        epoch
      ] {
        captureLoop(device_id, bypass_system_audio_input_processing, epoch);
      });
    }
    std::unique_lock startup_lock(capture_startup_mutex_);
    capture_startup_changed_.wait_for(
      startup_lock,
      std::chrono::seconds(5),
      [&] { return capture_ready_ || capture_startup_failure_.has_value(); }
    );
    if (capture_ready_) return;
    const auto failure = capture_startup_failure_.value_or(AudioFailureInfo{
      AudioFailureKind::OperationTimedOut,
      std::string(audioFailureCode(AudioFailureKind::OperationTimedOut)),
      "microphone capture produced no healthy PCM frame before deadline",
      HRESULT_FROM_WIN32(WAIT_TIMEOUT),
      true,
    });
    startup_lock.unlock();
    stopCapture();
    logMicrophone("microphone_capture_start_failed", {{"message", failure.message}});
    throw AudioFailure(failure.kind, failure.message, failure.hresult);
  }

  void ensureCapture(
    const PipelineState& desired,
    bool allow_rollback,
    bool force_restart = false
  ) {
    const auto previous = pipelineState();
    logMicrophone(
      "microphone_ensure_capture_start",
      {
        {"desiredRevision", desired.revision},
        {"allowRollback", allow_rollback},
        {"captureHealthy", captureHealthy()}
      }
    );
    if (!force_restart && capturePipelineMatches(desired) && captureHealthy()) {
      setPipelineState(desired);
      logMicrophone("microphone_ensure_capture_reused");
      return;
    }
    const bool rollback_candidate = allow_rollback && captureHealthy();
    if (rollback_candidate) {
      probeCaptureDevice(
        desired.device_id,
        desiredCaptureFormat(),
        std::chrono::milliseconds(750)
      );
      logMicrophone("microphone_candidate_pcm_healthy");
    }
    setPipelineState(desired);
    stopCapture();
    try {
      startCapture(desired);
      logMicrophone("microphone_ensure_capture_started");
    } catch (const AudioFailure&) {
      const auto original = std::current_exception();
      setPipelineState(previous);
      if (rollback_candidate) {
        logMicrophone("microphone_ensure_capture_rollback_start");
        try {
          startCapture(previous);
          logMicrophone("microphone_ensure_capture_rollback_ok");
        } catch (const std::exception& rollback_error) {
          logMicrophone(
            "microphone_ensure_capture_rollback_failed",
            {{"message", rollback_error.what()}}
          );
          MediaCommand terminal;
          terminal.type = "__microphoneTerminal";
          const auto failure = describeAudioFailure(rollback_error);
          terminal.internal_message = failure.message;
          terminal.video_source = failure.code;
          terminal.device_kind = "microphone_capture";
          terminal.diagnostic_retryable = failure.retryable;
          terminal.diagnostic_hresult = static_cast<std::int64_t>(failure.hresult);
          terminal.internal_epoch = capture_epoch_.load();
          post_(std::move(terminal));
        }
      }
      try {
        std::rethrow_exception(original);
      } catch (const std::exception& error) {
        logMicrophone("microphone_ensure_capture_failed", {{"message", error.what()}});
      }
      std::rethrow_exception(original);
    } catch (const std::exception& error) {
      setPipelineState(previous);
      if (rollback_candidate) {
        logMicrophone("microphone_ensure_capture_rollback_start");
        try {
          startCapture(previous);
          logMicrophone("microphone_ensure_capture_rollback_ok");
        } catch (const std::exception& rollback_error) {
          logMicrophone(
            "microphone_ensure_capture_rollback_failed",
            {{"message", rollback_error.what()}}
          );
        }
      }
      logMicrophone("microphone_ensure_capture_failed", {{"message", error.what()}});
      throw;
    }
  }

  bool captureDemanded() {
    if (!publication_.activeSessionId().empty()) return true;
    return !previewTarget().session_id.empty();
  }

  void postCaptureTerminal(const AudioFailureInfo& failure) {
    MediaCommand terminal;
    terminal.type = "__microphoneTerminal";
    terminal.internal_message = failure.message;
    terminal.video_source = failure.code;
    terminal.device_kind = "microphone_capture";
    terminal.diagnostic_retryable = failure.retryable;
    terminal.diagnostic_hresult = static_cast<std::int64_t>(failure.hresult);
    terminal.internal_epoch = capture_epoch_.load();
    post_(std::move(terminal));
  }

  PipelineState ensureCaptureWithDefaultFallback(
    const PipelineState& desired,
    bool allow_rollback,
    bool force_restart = false
  ) {
    try {
      ensureCapture(desired, allow_rollback, force_restart);
      return pipelineState();
    } catch (const AudioFailure& failure) {
      const bool endpoint_missing =
        audioFailureAllowsDefaultFallback(failure.kind());
      if (
        !endpoint_missing || desired.device_id.empty() ||
        desired.device_id == "default"
      ) {
        throw;
      }
      auto fallback = desired;
      fallback.device_id.clear();
      try {
        ensureCapture(fallback, allow_rollback, force_restart);
      } catch (const AudioFailure& fallback_failure) {
        if (audioFailureAllowsDefaultFallback(fallback_failure.kind())) {
          input_fallback_pending_ = true;
        }
        throw;
      }
      input_fallback_warning_pending_ = true;
      input_fallback_pending_ = false;
      return pipelineState();
    }
  }

  void emitInputFallbackIfPending(
    const std::string& session_id,
    std::uint64_t generation
  ) {
    if (!input_fallback_warning_pending_) return;
    auto event_session_id = session_id;
    auto event_generation = generation;
    if (event_session_id.empty()) {
      event_session_id = publication_.activeSessionId();
      event_generation = publication_.activeGeneration();
    }
    if (event_session_id.empty()) return;
    input_fallback_warning_pending_ = false;
    RuntimeEvent event;
    event.type = "sessionLifecycle";
    event.session_id = event_session_id;
    event.generation = event_generation;
    event.kind = "microphone";
    event.status = "running";
    event.device_id = "default";
    event.detail = "audio_input_fallback_default";
    event.error = NativeError{
      "audio_input_fallback_default",
      "Selected audio input is unavailable; using system default",
      "configureMicrophoneInput",
      false,
      event_session_id,
      event_generation,
    };
    emitter_.emit(std::move(event));
  }

  static void enqueueSinkFrame(
    const std::shared_ptr<SinkState>& sink,
    std::vector<std::int16_t> pcm
  ) {
    {
      std::lock_guard lock(sink->mutex);
      if (!sink->running) return;
      constexpr std::size_t kMaxPendingFrames = 8;
      if (sink->frames.size() >= kMaxPendingFrames) sink->frames.pop_front();
      sink->frames.push_back(std::move(pcm));
    }
    sink->changed.notify_one();
  }

  void shutdownSinks() {
    std::vector<std::shared_ptr<SinkState>> sinks;
    {
      std::lock_guard lock(sinks_mutex_);
      sinks = std::move(sinks_);
      sinks_.clear();
    }
    for (const auto& sink : sinks) {
      {
        std::lock_guard lock(sink->mutex);
        sink->running = false;
        sink->frames.clear();
      }
      sink->changed.notify_all();
    }
    for (const auto& sink : sinks) {
      if (sink->worker.joinable() && sink->worker.get_id() != std::this_thread::get_id()) {
        sink->worker.join();
      }
    }
  }

  void handleEndpointChange(const MediaCommand& command) {
    const auto current = pipelineState();
    const bool follows_default = current.device_id.empty() || current.device_id == "default";
    const bool selected_lost = !follows_default && current.device_id == command.device_id;
    AudioEndpointChange change;
    change.flow = eCapture;
    change.kind = command.internal_message == "default_changed"
      ? AudioEndpointChangeKind::DefaultChanged
      : (command.internal_message == "removed"
          ? AudioEndpointChangeKind::Removed
          : AudioEndpointChangeKind::Disabled);
    change.device_id = command.device_id;
    if (!audioEndpointChangeRequiresDefaultRetry(
          current.device_id,
          input_fallback_pending_,
          change
        )) return;

    auto desired = current;
    const bool fallback_recovery = selected_lost || input_fallback_pending_;
    const bool explicit_fallback = !follows_default && fallback_recovery;
    if (fallback_recovery) desired.device_id.clear();
    if (!captureThreadActive() && !captureDemanded()) {
      if (fallback_recovery) {
        setPipelineState(desired);
        input_fallback_warning_pending_ = explicit_fallback;
        input_fallback_pending_ = false;
      }
      return;
    }
    try {
      ensureCapture(desired, true, true);
      input_fallback_pending_ = false;
    } catch (const std::exception& error) {
      const auto failure = describeAudioFailure(error);
      input_fallback_pending_ =
        fallback_recovery && audioFailureAllowsDefaultFallback(failure.kind);
      if (!input_fallback_pending_) postCaptureTerminal(failure);
      throw;
    }
    const auto session_id = publication_.activeSessionId();
    const auto generation = publication_.activeGeneration();
    if (session_id.empty()) {
      if (fallback_recovery) input_fallback_warning_pending_ = true;
      const auto actual = pipelineState();
      publication_.updatePendingPipeline(
        command.session_id,
        command.generation,
        MicrophonePipelineSnapshot{
          .device_id = actual.device_id,
          .revision = actual.revision,
          .noise_suppression_enabled = actual.config.noise_suppression_enabled,
          .echo_cancellation_enabled = actual.config.echo_cancellation_enabled,
        }
      );
      return;
    }
    RuntimeEvent event;
    event.type = "sessionLifecycle";
    event.session_id = session_id;
    event.generation = generation;
    event.kind = "microphone";
    event.status = "running";
    event.device_id = desired.device_id.empty() ? "default" : desired.device_id;
    event.detail = explicit_fallback
      ? "audio_input_fallback_default"
      : (fallback_recovery
          ? "audio_input_default_recovered"
          : "audio_input_default_changed");
    if (explicit_fallback) {
      input_fallback_warning_pending_ = false;
      event.error = NativeError{
        "audio_input_fallback_default",
        "Selected audio input disappeared; using system default",
        "configureMicrophoneInput",
        false,
        session_id,
        generation,
      };
    }
    emitter_.emit(std::move(event));
  }

  void stopCapture() {
    logMicrophone("microphone_capture_stop_start");
    capture_running_.store(false);
    if (capture_thread_.joinable()) capture_thread_.join();
    std::lock_guard lock(capture_lifecycle_mutex_);
    capture_device_id_.clear();
    capture_bypass_system_audio_input_processing_ = true;
    logMicrophone("microphone_capture_stop_done");
  }

  void captureLoop(
    std::string device_id,
    bool bypass_system_audio_input_processing,
    std::uint64_t epoch
  ) {
    logMicrophone("microphone_capture_loop_start", {{"epoch", epoch}});
    const auto com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_initialized = SUCCEEDED(com_result);
    DWORD task_index = 0;
    HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);
    std::optional<AudioFailureInfo> terminal_failure;

    try {
      auto device = captureDevice(device_id);
      const auto activate_audio_client = [&] {
        ComPtr<IAudioClient> client;
        const auto activate_result = device->Activate(
          __uuidof(IAudioClient), CLSCTX_ALL, nullptr,
          reinterpret_cast<void**>(client.GetAddressOf())
        );
        if (FAILED(activate_result)) {
          throwAudioFailure(activate_result, "failed to activate microphone IAudioClient");
        }
        return client;
      };
      auto audio_client = activate_audio_client();
      bool raw_applied = false;
      std::string raw_status = bypass_system_audio_input_processing
        ? "fallback"
        : "not_requested";
      if (bypass_system_audio_input_processing) {
        ComPtr<IAudioClient2> audio_client2;
        if (SUCCEEDED(audio_client.As(&audio_client2))) {
          AudioClientProperties properties{};
          properties.cbSize = sizeof(properties);
          properties.bIsOffload = FALSE;
          // The microphone stays warm outside active voice sessions. Marking
          // that persistent capture as Communications makes Windows attenuate
          // game and media streams for the lifetime of the application.
          properties.eCategory = AudioCategory_Other;
          properties.Options = AUDCLNT_STREAMOPTIONS_RAW;
          if (SUCCEEDED(audio_client2->SetClientProperties(&properties))) {
            raw_applied = true;
            raw_status = "applied";
          }
        }
      }
      auto format = desiredCaptureFormat();
      auto initialize_audio_client = [&](const ComPtr<IAudioClient>& client) {
        return client->Initialize(
          AUDCLNT_SHAREMODE_SHARED,
          AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
          10'000'000,
          0,
          &format,
          nullptr
        );
      };
      auto result = initialize_audio_client(audio_client);
      if (FAILED(result) && raw_applied) {
        audio_client = activate_audio_client();
        raw_applied = false;
        raw_status = "fallback";
        result = initialize_audio_client(audio_client);
      }
      logMicrophone(
        "microphone_capture_raw_mode",
        {
          {"requested", bypass_system_audio_input_processing},
          {"status", raw_status}
        }
      );
      if (FAILED(result)) {
        throwAudioFailure(result, "failed to initialize microphone stream");
      }
      ComPtr<IAudioCaptureClient> capture_client;
      result = audio_client->GetService(IID_PPV_ARGS(&capture_client));
      if (FAILED(result)) {
        throwAudioFailure(result, "failed to open microphone capture client");
      }
      result = audio_client->Start();
      if (FAILED(result)) {
        throwAudioFailure(
          result,
          "failed to start microphone stream",
          AudioFailureKind::ClientStartFailed
        );
      }
      syrnike::voice::MicrophoneAudioProcessor processor;
      syrnike::voice::MicrophoneEchoReference echo_reference;
      bool echo_enabled = pipelineState().config.echo_cancellation_enabled;
      if (echo_enabled) echo_reference.start();
      std::vector<float> raw_frame;
      raw_frame.reserve(syrnike::voice::kSamplesPer10Ms);
      std::vector<std::int16_t> silent_reference(syrnike::voice::kSamplesPer10Ms, 0);
      MicrophoneMetricsCadence metrics_cadence(std::chrono::steady_clock::now());

      while (capture_running_.load()) {
        UINT32 packet_frames = 0;
        result = capture_client->GetNextPacketSize(&packet_frames);
        if (FAILED(result)) {
          throwAudioFailure(result, "microphone packet query failed", AudioFailureKind::IoFailed);
        }
        if (packet_frames == 0) {
          std::this_thread::sleep_for(std::chrono::milliseconds(2));
          continue;
        }
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        result = capture_client->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (FAILED(result)) {
          throwAudioFailure(result, "microphone buffer read failed", AudioFailureKind::IoFailed);
        }
        const auto* samples = reinterpret_cast<const float*>(data);
        bool produced_pcm_frame = false;
        for (UINT32 index = 0; index < frames; ++index) {
          raw_frame.push_back(
            (flags & AUDCLNT_BUFFERFLAGS_SILENT) || !samples ? 0.0f : samples[index]
          );
          if (raw_frame.size() != syrnike::voice::kSamplesPer10Ms) continue;
          const auto active_pipeline = pipelineState();
          const auto active_config = active_pipeline.config;
          if (active_config.echo_cancellation_enabled != echo_enabled) {
            echo_enabled = active_config.echo_cancellation_enabled;
            if (echo_enabled) echo_reference.start(); else echo_reference.stop();
          }
          const auto reference = echo_enabled ? echo_reference.popFrame() : std::nullopt;
          const auto reference_status = echo_reference.status();
          const std::vector<std::int16_t>* reference_ptr = nullptr;
          if (echo_enabled && reference_status.available) {
            reference_ptr = reference ? &*reference : &silent_reference;
          }
          auto processed = processor.processFrame(raw_frame, active_config, reference_ptr);
          const auto preview = previewTarget();
          if (preview.consumer) {
            preview.consumer(processed.pcm);
          }
          const auto active_sinks = sinks();
          for (std::size_t sink_index = 0; sink_index < active_sinks.size(); ++sink_index) {
            auto pcm = sink_index + 1 == active_sinks.size()
              ? std::move(processed.pcm)
              : processed.pcm;
            enqueueSinkFrame(active_sinks[sink_index], std::move(pcm));
          }
          const auto now = std::chrono::steady_clock::now();
          if (metrics_cadence.shouldEmit(now)) {
            RuntimeEvent event;
            event.type = "microphoneMetrics";
            event.revision = active_pipeline.revision;
            event.input_db = processed.gate_metrics.input_db;
            event.threshold_db = processed.gate_metrics.threshold_db;
            event.gate_open = processed.gate_metrics.open;
            emitter_.emit(std::move(event));
          }
          produced_pcm_frame = true;
          raw_frame.clear();
        }
        result = capture_client->ReleaseBuffer(frames);
        if (FAILED(result)) {
          throwAudioFailure(result, "microphone buffer release failed", AudioFailureKind::IoFailed);
        }
        if (produced_pcm_frame) {
          bool became_ready = false;
          {
            std::lock_guard lock(capture_startup_mutex_);
            if (!capture_ready_) {
              capture_ready_ = true;
              became_ready = true;
            }
          }
          if (became_ready) {
            capture_startup_changed_.notify_all();
            logMicrophone("microphone_capture_loop_ready", {{"epoch", epoch}});
          }
        }
      }
      echo_reference.stop();
      audio_client->Stop();
    } catch (const std::exception& error) {
      terminal_failure = describeAudioFailure(error);
      logMicrophone(
        "microphone_capture_loop_error",
        {{"epoch", epoch}, {"message", error.what()}}
      );
    }

    bool was_ready = false;
    {
      std::lock_guard lock(capture_startup_mutex_);
      was_ready = capture_ready_;
      capture_ready_ = false;
      if (!was_ready && terminal_failure) capture_startup_failure_ = terminal_failure;
    }
    capture_startup_changed_.notify_all();

    if (avrt) AvRevertMmThreadCharacteristics(avrt);
    if (com_initialized) CoUninitialize();
    if (terminal_failure && capture_running_.exchange(false) && was_ready) {
      MediaCommand command;
      command.type = "__microphoneTerminal";
      command.internal_message = terminal_failure->message;
      command.video_source = terminal_failure->code;
      command.device_kind = "microphone_capture";
      command.diagnostic_retryable = terminal_failure->retryable;
      command.diagnostic_hresult = static_cast<std::int64_t>(terminal_failure->hresult);
      command.internal_epoch = epoch;
      post_(std::move(command));
    }
    logMicrophone(
      "microphone_capture_loop_exit",
      {
        {"epoch", epoch},
        {"wasReady", was_ready},
        {"hadError", terminal_failure.has_value()}
      }
    );
  }

  SequencedEmitter& emitter_;
  InternalPost post_;
  IsCurrent is_current_;
  std::shared_ptr<LiveKitPublicationClient> livekit_client_;
  std::mutex pipeline_mutex_;
  PipelineState pipeline_;
  bool input_fallback_pending_ = false;
  bool input_fallback_warning_pending_ = false;
  std::mutex sinks_mutex_;
  std::vector<std::shared_ptr<SinkState>> sinks_;
  std::mutex capture_lifecycle_mutex_;
  std::thread capture_thread_;
  std::atomic_bool capture_running_{false};
  std::atomic_uint64_t capture_epoch_{0};
  std::string capture_device_id_;
  bool capture_bypass_system_audio_input_processing_ = true;
  std::mutex capture_startup_mutex_;
  std::condition_variable capture_startup_changed_;
  bool capture_ready_ = false;
  std::optional<AudioFailureInfo> capture_startup_failure_;
  std::mutex preview_mutex_;
  std::string preview_session_id_;
  std::uint64_t preview_generation_ = 0;
  PreviewConsumer preview_consumer_;
  MicrophonePublicationController publication_;
  std::unique_ptr<AudioEndpointMonitor> endpoint_monitor_;
};

MicrophoneActor::MicrophoneActor(
  SequencedEmitter& emitter,
  InternalPost post,
  IsCurrent is_current,
  std::shared_ptr<LiveKitPublicationClient> livekit_client
) : implementation_(std::make_unique<Implementation>(
      emitter,
      std::move(post),
      std::move(is_current),
      std::move(livekit_client)
    )) {}

MicrophoneActor::~MicrophoneActor() = default;
void MicrophoneActor::warm(const MediaCommand& command) { implementation_->warm(command); }
void MicrophoneActor::connect(const MediaCommand& command) { implementation_->connect(command); }
RuntimeEvent MicrophoneActor::configure(const MediaCommand& command) {
  return implementation_->configure(command);
}
void MicrophoneActor::setMuted(const MediaCommand& command) { implementation_->setMuted(command); }
void MicrophoneActor::setPreviewConsumer(
  const std::string& session_id,
  std::uint64_t generation,
  PreviewConsumer consumer
) {
  implementation_->setPreviewConsumer(session_id, generation, std::move(consumer));
}
void MicrophoneActor::clearPreviewConsumer(
  const std::string& session_id,
  std::uint64_t generation
) {
  implementation_->clearPreviewConsumer(session_id, generation);
}
bool MicrophoneActor::isCurrentCaptureFailure(const MediaCommand& command) {
  return implementation_->isCurrentCaptureFailureCommand(command);
}
void MicrophoneActor::disconnect(const MediaCommand& command, bool emit_stopped) {
  implementation_->disconnect(command, emit_stopped);
}
bool MicrophoneActor::handleTerminal(const MediaCommand& command) {
  return implementation_->handleTerminal(command);
}
void MicrophoneActor::handleWorkerCommand(const MediaCommand& command) {
  implementation_->handleWorkerCommand(command);
}
RuntimeEvent MicrophoneActor::probe(const MediaCommand& command) {
  return implementation_->probe(command);
}
void MicrophoneActor::shutdown() { implementation_->shutdown(); }

}  // namespace syrnike::desktop_native::media
