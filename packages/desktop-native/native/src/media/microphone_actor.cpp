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
#include <cstdint>
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
        [this](const auto& source) { addSink(source); },
        [this](const auto& source) { removeSink(source); },
        [this] { return captureHealthy(); },
        livekit_client_
      ) {}

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
    ensureCapture(desired, true);
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
    ensureCapture(desired_pipeline, true);
    logMicrophone(
      "microphone_connect_ensure_capture_ok",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"captureHealthy", captureHealthy()}
      }
    );

    publication_.start(command, MicrophonePipelineSnapshot{
      .device_id = desired_pipeline.device_id,
      .revision = desired_pipeline.revision,
      .noise_suppression_enabled = desired_pipeline.config.noise_suppression_enabled,
      .echo_cancellation_enabled = desired_pipeline.config.echo_cancellation_enabled,
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
    if (captureThreadActive() && desired.device_id != current.device_id) {
      ensureCapture(desired, true);
    } else {
      setPipelineState(desired);
    }
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
        {"deviceSwitch", desired.device_id != current.device_id}
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
    return command.internal_message.starts_with("microphone_capture_failed:") &&
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

  void handleTerminal(const MediaCommand& command) {
    logMicrophone(
      "microphone_handle_terminal",
      {
        {"sessionId", command.session_id},
        {"generation", command.generation},
        {"message", command.internal_message}
      }
    );
    MediaCommand effective = command;
    const bool capture_failure = command.internal_message.starts_with(
      "microphone_capture_failed:"
    );
    if (capture_failure) {
      if (!isCurrentCaptureFailureCommand(command)) return;
      effective.session_id = publication_.activeSessionId();
      effective.generation = publication_.activeGeneration();
    }
    if (effective.session_id.empty()) return;
    publication_.handleTerminal(effective);
  }

  void handleWorkerCommand(const MediaCommand& command) {
    publication_.handleWorkerCommand(command);
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
    stopCapture();
    logMicrophone("microphone_shutdown_done");
  }

 private:
  void addSink(const std::shared_ptr<livekit::AudioSource>& source) {
    std::lock_guard lock(sinks_mutex_);
    sinks_.push_back(source);
  }

  void removeSink(const std::shared_ptr<livekit::AudioSource>& source) {
    if (!source) return;
    std::lock_guard lock(sinks_mutex_);
    std::erase_if(sinks_, [&](const auto& candidate) { return candidate == source; });
  }

  std::vector<std::shared_ptr<livekit::AudioSource>> sinks() {
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

  bool captureDeviceMatches(const std::string& device_id) {
    std::lock_guard lock(capture_lifecycle_mutex_);
    return capture_thread_.joinable() && capture_device_id_ == device_id;
  }

  bool captureThreadActive() {
    std::lock_guard lock(capture_lifecycle_mutex_);
    return capture_thread_.joinable();
  }

  void startCapture(const std::string& device_id) {
    logMicrophone("microphone_capture_start_begin");
    {
      std::lock_guard lock(capture_startup_mutex_);
      capture_ready_ = false;
      capture_startup_error_.clear();
    }
    const auto epoch = capture_epoch_.fetch_add(1) + 1;
    {
      std::lock_guard lock(capture_lifecycle_mutex_);
      capture_device_id_ = device_id;
      capture_running_.store(true);
      capture_thread_ = std::thread([this, device_id = capture_device_id_, epoch] {
        captureLoop(device_id, epoch);
      });
    }
    std::unique_lock startup_lock(capture_startup_mutex_);
    capture_startup_changed_.wait_for(
      startup_lock,
      std::chrono::seconds(5),
      [&] { return capture_ready_ || !capture_startup_error_.empty(); }
    );
    if (capture_ready_) return;
    const auto error = capture_startup_error_.empty()
      ? std::string("microphone capture startup timed out")
      : capture_startup_error_;
    startup_lock.unlock();
    stopCapture();
    logMicrophone("microphone_capture_start_failed", {{"message", error}});
    throw std::runtime_error(error);
  }

  void ensureCapture(const PipelineState& desired, bool allow_rollback) {
    const auto previous = pipelineState();
    logMicrophone(
      "microphone_ensure_capture_start",
      {
        {"desiredRevision", desired.revision},
        {"allowRollback", allow_rollback},
        {"captureHealthy", captureHealthy()}
      }
    );
    if (captureDeviceMatches(desired.device_id) && captureHealthy()) {
      setPipelineState(desired);
      logMicrophone("microphone_ensure_capture_reused");
      return;
    }
    const bool rollback_candidate = allow_rollback && captureHealthy();
    setPipelineState(desired);
    stopCapture();
    try {
      startCapture(desired.device_id);
      logMicrophone("microphone_ensure_capture_started");
    } catch (const std::exception& error) {
      setPipelineState(previous);
      if (rollback_candidate) {
        logMicrophone("microphone_ensure_capture_rollback_start");
        try {
          startCapture(previous.device_id);
          logMicrophone("microphone_ensure_capture_rollback_ok");
        } catch (const std::exception& rollback_error) {
          logMicrophone(
            "microphone_ensure_capture_rollback_failed",
            {{"message", rollback_error.what()}}
          );
          MediaCommand terminal;
          terminal.type = "__microphoneTerminal";
          terminal.internal_message =
            "microphone_capture_failed:" + std::string(rollback_error.what());
          terminal.internal_epoch = capture_epoch_.load();
          post_(std::move(terminal));
        }
      }
      logMicrophone("microphone_ensure_capture_failed", {{"message", error.what()}});
      throw std::runtime_error(error.what());
    }
  }

  void stopCapture() {
    logMicrophone("microphone_capture_stop_start");
    capture_running_.store(false);
    if (capture_thread_.joinable()) capture_thread_.join();
    std::lock_guard lock(capture_lifecycle_mutex_);
    capture_device_id_.clear();
    logMicrophone("microphone_capture_stop_done");
  }

  void captureLoop(std::string device_id, std::uint64_t epoch) {
    logMicrophone("microphone_capture_loop_start", {{"epoch", epoch}});
    const auto com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_initialized = SUCCEEDED(com_result);
    DWORD task_index = 0;
    HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);
    std::string terminal_error;

    try {
      auto device = captureDevice(device_id);
      ComPtr<IAudioClient> audio_client;
      auto result = device->Activate(
        __uuidof(IAudioClient), CLSCTX_ALL, nullptr,
        reinterpret_cast<void**>(audio_client.GetAddressOf())
      );
      if (FAILED(result)) throw std::runtime_error("failed to activate microphone IAudioClient");
      auto format = desiredCaptureFormat();
      result = audio_client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        10'000'000,
        0,
        &format,
        nullptr
      );
      if (FAILED(result)) throw std::runtime_error("failed to initialize microphone stream");
      ComPtr<IAudioCaptureClient> capture_client;
      result = audio_client->GetService(IID_PPV_ARGS(&capture_client));
      if (FAILED(result)) throw std::runtime_error("failed to open microphone capture client");
      result = audio_client->Start();
      if (FAILED(result)) throw std::runtime_error("failed to start microphone stream");
      {
        std::lock_guard lock(capture_startup_mutex_);
        capture_ready_ = true;
      }
      capture_startup_changed_.notify_all();
      logMicrophone("microphone_capture_loop_ready", {{"epoch", epoch}});

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
        if (FAILED(result)) throw std::runtime_error("microphone packet query failed");
        if (packet_frames == 0) {
          std::this_thread::sleep_for(std::chrono::milliseconds(2));
          continue;
        }
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        result = capture_client->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (FAILED(result)) throw std::runtime_error("microphone buffer read failed");
        const auto* samples = reinterpret_cast<const float*>(data);
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
            livekit::AudioFrame frame(
              std::move(pcm),
              syrnike::voice::kSampleRate,
              syrnike::voice::kChannels,
              syrnike::voice::kSamplesPer10Ms
            );
            active_sinks[sink_index]->captureFrame(frame);
          }
          const auto now = std::chrono::steady_clock::now();
          if (preview.consumer && metrics_cadence.shouldEmit(now)) {
            RuntimeEvent event;
            event.type = "microphoneMetrics";
            event.input_db = processed.gate_metrics.input_db;
            event.threshold_db = processed.gate_metrics.threshold_db;
            event.gate_open = processed.gate_metrics.open;
            emitter_.emit(std::move(event));
          }
          raw_frame.clear();
        }
        capture_client->ReleaseBuffer(frames);
      }
      echo_reference.stop();
      audio_client->Stop();
    } catch (const std::exception& error) {
      terminal_error = error.what();
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
      if (!was_ready && !terminal_error.empty()) capture_startup_error_ = terminal_error;
    }
    capture_startup_changed_.notify_all();

    if (avrt) AvRevertMmThreadCharacteristics(avrt);
    if (com_initialized) CoUninitialize();
    if (!terminal_error.empty() && capture_running_.exchange(false) && was_ready) {
      MediaCommand command;
      command.type = "__microphoneTerminal";
      command.internal_message = "microphone_capture_failed:" + terminal_error;
      command.internal_epoch = epoch;
      post_(std::move(command));
    }
    logMicrophone(
      "microphone_capture_loop_exit",
      {
        {"epoch", epoch},
        {"wasReady", was_ready},
        {"hadError", !terminal_error.empty()}
      }
    );
  }

  SequencedEmitter& emitter_;
  InternalPost post_;
  IsCurrent is_current_;
  std::shared_ptr<LiveKitPublicationClient> livekit_client_;
  std::mutex pipeline_mutex_;
  PipelineState pipeline_;
  std::mutex sinks_mutex_;
  std::vector<std::shared_ptr<livekit::AudioSource>> sinks_;
  std::mutex capture_lifecycle_mutex_;
  std::thread capture_thread_;
  std::atomic_bool capture_running_{false};
  std::atomic_uint64_t capture_epoch_{0};
  std::string capture_device_id_;
  std::mutex capture_startup_mutex_;
  std::condition_variable capture_startup_changed_;
  bool capture_ready_ = false;
  std::string capture_startup_error_;
  std::mutex preview_mutex_;
  std::string preview_session_id_;
  std::uint64_t preview_generation_ = 0;
  PreviewConsumer preview_consumer_;
  MicrophonePublicationController publication_;
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
void MicrophoneActor::handleTerminal(const MediaCommand& command) {
  implementation_->handleTerminal(command);
}
void MicrophoneActor::handleWorkerCommand(const MediaCommand& command) {
  implementation_->handleWorkerCommand(command);
}
RuntimeEvent MicrophoneActor::probe(const MediaCommand& command) {
  return implementation_->probe(command);
}
void MicrophoneActor::shutdown() { implementation_->shutdown(); }

}  // namespace syrnike::desktop_native::media
