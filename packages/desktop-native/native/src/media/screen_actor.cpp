#include "screen_actor.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
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
    case ScreenGpuCaptureErrorCode::DeviceLost:
      return "gpu_device_lost";
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

class ScreenActor::Implementation {
 public:
  Implementation(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitPublicationClient> livekit_client,
    CommitIfCurrent commit_if_current,
    Now now
  ) : emitter_(emitter),
      post_(std::move(post)),
      publication_(std::make_unique<ScreenPublicationController>(
        emitter,
        post_,
        std::move(is_current),
        std::move(livekit_client),
        std::move(commit_if_current),
        std::move(now),
        [this](const MediaCommand& command) {
          return describePublication(command);
        },
        [this](
          const MediaCommand& command,
          const ScreenPublicationDescription& description,
          const std::shared_ptr<livekit::D3D11H264VideoSource>& video_source,
          const std::shared_ptr<livekit::LocalVideoTrack>& video_track,
          const std::shared_ptr<livekit::AudioSource>& audio_source,
          const std::shared_ptr<std::atomic_bool>& running,
          const std::function<bool()>& is_current,
          std::thread& capture_thread,
          std::thread& audio_thread
        ) {
          startCaptureWorkers(
            command,
            description,
            video_source,
            video_track,
            audio_source,
            running,
            is_current,
            capture_thread,
            audio_thread
          );
        },
        [this](const std::string& session_id, std::uint64_t generation) {
          resetStats(session_id, generation);
        }
      )) {}

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
    RuntimeEvent ended;
    ended.type = "screenCaptureEnded";
    ended.session_id = command.session_id;
    ended.generation = command.generation;
    constexpr std::string_view allowed_reasons[] = {
      "target_closed",
      "gpu_capture_unavailable",
      "gpu_encoder_unavailable",
      "gpu_interop_unavailable",
      "gpu_device_lost",
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
    stopped.session_id = command.session_id;
    stopped.generation = command.generation;
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
    publication_->handleWorkerCommand(command);
  }

  RuntimeEvent probe(const MediaCommand& command) {
    return publication_->probe(command);
  }

  void shutdown() {
    if (!publication_) return;
    publication_->shutdown();
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
    const std::shared_ptr<std::atomic_bool>& running,
    const std::function<bool()>& is_current,
    std::thread& capture_thread,
    std::thread& audio_thread
  ) {
    std::shared_ptr<ScreenGpuCapturer> capturer;
    try {
      capturer = ScreenGpuCapturer::create(
        description.target,
        description.width,
        description.height
      );
    } catch (const ScreenGpuCaptureError& error) {
      throw std::runtime_error(std::string(gpuCaptureReason(error.code())));
    }
    if (!is_current()) throw std::runtime_error("stale screen capture generation");
    registerPreviewCapturer(command, capturer);
    capture_thread = std::thread(
      [this,
       session_id = command.session_id,
       generation = command.generation,
       width = description.width,
       height = description.height,
       fps = description.fps,
       participant_identity = command.participant_identity,
       source = video_source,
       track = video_track,
       running,
       capturer = std::move(capturer)]() mutable {
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
      }
    );
    if (description.publish_audio) {
      startAudioCapture(
        command,
        description.target,
        audio_source,
        running,
        audio_thread
      );
    }
  }

  void startAudioCapture(
    const MediaCommand& command,
    const syrnike::voice::ScreenCaptureTarget& target,
    const std::shared_ptr<livekit::AudioSource>& audio_source,
    const std::shared_ptr<std::atomic_bool>& running,
    std::thread& audio_thread
  ) {
    const auto session_id = command.session_id;
    const auto generation = command.generation;
    auto on_failure = [this, session_id, generation](std::string message) {
      MediaCommand terminal;
      terminal.type = "__screenTerminal";
      terminal.session_id = session_id;
      terminal.generation = generation;
      terminal.internal_message = "screen_audio_capture_failed:" + message;
      post_(std::move(terminal));
    };
    auto on_stats = [this, session_id, generation](
      std::uint64_t frames,
      std::uint64_t packets,
      double peak_db,
      double rms_db
    ) {
      recordAudioStats(session_id, generation, frames, packets, peak_db, rms_db);
    };
    if (target.window) {
      audio_thread = std::thread(
        syrnike::voice::captureProcessLoopbackAudio,
        target.process_id,
        session_id,
        audio_source,
        running,
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
        std::move(on_failure),
        std::move(on_stats)
      );
    }
  }

  void resetStats(const std::string& session_id, std::uint64_t generation) {
    std::lock_guard lock(stats_mutex_);
    stats_session_id_ = session_id;
    stats_generation_ = generation;
    stats_video_frames_ = 0;
    stats_audio_frames_ = 0;
    stats_audio_packets_ = 0;
    stats_method_wgc_gpu_ = 0;
    stats_method_dxgi_gpu_ = 0;
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
      event.rtp_stats_available = stats_rtp_available_;
      event.rtp_packets_sent = stats_rtp_packets_sent_;
      event.rtp_bytes_sent = stats_rtp_bytes_sent_;
      event.rtp_frames_sent = stats_rtp_frames_sent_;
      event.rtp_frames_encoded = stats_rtp_frames_encoded_;
      event.encoder_implementation = stats_encoder_implementation_;
      snapshot = std::move(event);
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
    std::uint64_t method_dxgi_gpu
  ) {
    {
      std::lock_guard lock(stats_mutex_);
      if (stats_session_id_ != session_id || stats_generation_ != generation) return;
      stats_video_frames_ = frames;
      stats_capture_method_ = method;
      stats_method_wgc_gpu_ = method_wgc_gpu;
      stats_method_dxgi_gpu_ = method_dxgi_gpu;
    }
    emitStatsIfDue(session_id, generation);
  }

  void sampleOutboundStats(
    const std::string& session_id,
    std::uint64_t generation,
    const std::shared_ptr<livekit::LocalVideoTrack>& track
  ) {
    if (!track || !diagnostics::DiagnosticLog::instance().enabled()) return;
    try {
      const auto records = track->getStats().get();
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
        if (stats_session_id_ != session_id || stats_generation_ != generation) return;
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
    } catch (const std::exception& error) {
      logScreen(
        "screen_rtp_stats_error",
        {
          {"sessionId", session_id},
          {"generation", generation},
          {"message", sanitizeDiagnosticMessage(error.what())}
        }
      );
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
    auto next_rtp_stats_at = next_frame + std::chrono::seconds(1);
    const auto started = next_frame;
    std::uint64_t frames = 0;
    std::uint64_t method_wgc_gpu = 0;
    std::uint64_t method_dxgi_gpu = 0;
    std::string method = capturer->method();
    ScreenGpuFrame captured;
    const HRESULT com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool uninitialize_com = SUCCEEDED(com_result);

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
          auto lease = std::make_unique<ScreenTextureLease>(capturer, captured);
          const auto timestamp = captured.timestamp_us != 0
            ? static_cast<std::int64_t>(captured.timestamp_us)
            : std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - started).count();
          if (source->capture(std::move(lease), timestamp)) {
            ++frames;
            if (method == "wgc_gpu") ++method_wgc_gpu;
            else if (method == "dxgi_gpu") ++method_dxgi_gpu;
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
        if (now >= next_rtp_stats_at) {
          sampleOutboundStats(session_id, generation, track);
          next_rtp_stats_at = now + std::chrono::seconds(1);
        }
        recordVideoStats(
          session_id,
          generation,
          frames,
          method,
          method_wgc_gpu,
          method_dxgi_gpu
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
    const std::shared_ptr<ScreenGpuCapturer>& capturer
  ) {
    std::lock_guard lock(preview_mutex_);
    auto& state = preview_capturers_[previewKey(command.session_id, command.generation)];
    state.capturer = capturer;
    state.active = true;
    if (preview_session_id_ == command.session_id &&
        preview_generation_ == command.generation) {
      capturer->setPreviewDemand(preview_demand_);
    } else {
      capturer->setPreviewDemand({});
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
    MediaCommand removed;
    removed.type = "__localScreenPreviewTrackRemoved";
    removed.session_id = session_id;
    removed.generation = generation;
    removed.track_id = localPreviewTrackId(session_id);
    post_(std::move(removed));
    std::lock_guard lock(preview_mutex_);
    const auto key = previewKey(session_id, generation);
    const auto found = preview_capturers_.find(key);
    if (found == preview_capturers_.end()) return;
    found->second.active = false;
    if (found->second.capturer->previewFramesInFlight() == 0) {
      preview_capturers_.erase(found);
    }
  }

  SequencedEmitter& emitter_;
  InternalPost post_;
  std::unique_ptr<ScreenPublicationController> publication_;
  std::mutex stats_mutex_;
  std::string stats_session_id_;
  std::uint64_t stats_generation_ = 0;
  std::uint64_t stats_video_frames_ = 0;
  std::uint64_t stats_audio_frames_ = 0;
  std::uint64_t stats_audio_packets_ = 0;
  std::uint64_t stats_method_wgc_gpu_ = 0;
  std::uint64_t stats_method_dxgi_gpu_ = 0;
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
};

ScreenActor::ScreenActor(
  SequencedEmitter& emitter,
  InternalPost post,
  IsCurrent is_current,
  std::shared_ptr<LiveKitPublicationClient> livekit_client,
  CommitIfCurrent commit_if_current,
  Now now
) : implementation_(std::make_unique<Implementation>(
      emitter,
      std::move(post),
      std::move(is_current),
      std::move(livekit_client),
      std::move(commit_if_current),
      std::move(now)
    )) {}

ScreenActor::~ScreenActor() = default;

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

}  // namespace syrnike::desktop_native::media
