#include "screen_actor.hpp"

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
#include <utility>

#include "../common/diagnostic_log.hpp"
#include "livekit_disconnect_reason.hpp"
#include "screen_audio_capture.hpp"
#include "screen_capture_priority.hpp"
#include "screen_video_capture.hpp"

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
          const std::shared_ptr<livekit::VideoSource>& video_source,
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
    ended.reason = reason == "target_closed" ? "target_closed" : "runtime_error";
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
    const std::shared_ptr<livekit::VideoSource>& video_source,
    const std::shared_ptr<livekit::AudioSource>& audio_source,
    const std::shared_ptr<std::atomic_bool>& running,
    const std::function<bool()>& is_current,
    std::thread& capture_thread,
    std::thread& audio_thread
  ) {
    auto capturer = syrnike::voice::ScreenVideoCapturer::create(
      description.target,
      description.width,
      description.height
    );
    if (!is_current()) throw std::runtime_error("stale screen capture generation");
    capture_thread = std::thread(
      [this,
       session_id = command.session_id,
       generation = command.generation,
       width = description.width,
       height = description.height,
       fps = description.fps,
       source = video_source,
       running,
       capturer = std::move(capturer)]() mutable {
        captureLoop(
          std::move(session_id),
          generation,
          width,
          height,
          fps,
          std::move(source),
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
    stats_method_wgc_ = 0;
    stats_method_dxgi_ = 0;
    stats_method_gdi_blt_ = 0;
    stats_audio_peak_db_ = -120.0;
    stats_audio_rms_db_ = -120.0;
    stats_capture_method_.clear();
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
      event.method_wgc = stats_method_wgc_;
      event.method_dxgi = stats_method_dxgi_;
      event.method_gdi_blt = stats_method_gdi_blt_;
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
    std::uint64_t method_wgc,
    std::uint64_t method_dxgi,
    std::uint64_t method_gdi_blt
  ) {
    {
      std::lock_guard lock(stats_mutex_);
      if (stats_session_id_ != session_id || stats_generation_ != generation) return;
      stats_video_frames_ = frames;
      stats_capture_method_ = method;
      stats_method_wgc_ = method_wgc;
      stats_method_dxgi_ = method_dxgi;
      stats_method_gdi_blt_ = method_gdi_blt;
    }
    emitStatsIfDue(session_id, generation);
  }

  void captureLoop(
    std::string session_id,
    std::uint64_t generation,
    std::uint32_t width,
    std::uint32_t height,
    int fps,
    std::shared_ptr<livekit::VideoSource> source,
    std::shared_ptr<std::atomic_bool> running,
    std::unique_ptr<syrnike::voice::ScreenVideoCapturer> capturer
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
    std::uint64_t frames = 0;
    std::uint64_t method_wgc = 0;
    std::uint64_t method_dxgi = 0;
    std::uint64_t method_gdi_blt = 0;
    std::string method = capturer->method();
    syrnike::voice::ScreenVideoFrame captured;

    try {
      while (running->load()) {
        const auto capture = capturer->capture(captured);
        if (!capture.method.empty()) method = capture.method;
        if (capture.status == syrnike::voice::ScreenCaptureFrameStatus::NewFrame) {
          livekit::VideoFrame frame(
            static_cast<int>(width),
            static_cast<int>(height),
            livekit::VideoBufferType::BGRA,
            std::move(captured.bgra)
          );
          const auto timestamp = std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - started
          ).count();
          source->captureFrame(frame, timestamp);
          ++frames;
          if (method == "wgc") ++method_wgc;
          else if (method == "dxgi") ++method_dxgi;
          else if (method == "gdi_blt") ++method_gdi_blt;
        } else if (
          capture.status == syrnike::voice::ScreenCaptureFrameStatus::TargetClosed ||
          capture.status == syrnike::voice::ScreenCaptureFrameStatus::FatalError
        ) {
          MediaCommand terminal;
          terminal.type = "__screenTerminal";
          terminal.session_id = session_id;
          terminal.generation = generation;
          terminal.internal_message =
            capture.status == syrnike::voice::ScreenCaptureFrameStatus::TargetClosed
              ? "target_closed"
              : "capture_failed";
          running->store(false);
          logScreen(
            "screen_capture_loop_terminal",
            {
              {"sessionId", session_id},
              {"generation", generation},
              {"targetClosed",
               capture.status == syrnike::voice::ScreenCaptureFrameStatus::TargetClosed},
              {"frames", frames}
            }
          );
          post_(std::move(terminal));
          break;
        }

        const auto now = std::chrono::steady_clock::now();
        recordVideoStats(
          session_id,
          generation,
          frames,
          method,
          method_wgc,
          method_dxgi,
          method_gdi_blt
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
        terminal.internal_message = "capture_failed";
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
        terminal.internal_message = "capture_failed";
        post_(std::move(terminal));
      }
    }
    logScreen(
      "screen_capture_loop_exit",
      {
        {"sessionId", session_id},
        {"generation", generation},
        {"frames", frames},
        {"methodWgc", method_wgc},
        {"methodDxgi", method_dxgi},
        {"methodGdiBlt", method_gdi_blt},
        {"running", running->load()}
      }
    );
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
  std::uint64_t stats_method_wgc_ = 0;
  std::uint64_t stats_method_dxgi_ = 0;
  std::uint64_t stats_method_gdi_blt_ = 0;
  double stats_audio_peak_db_ = -120.0;
  double stats_audio_rms_db_ = -120.0;
  std::string stats_capture_method_;
  std::chrono::steady_clock::time_point next_stats_at_{};
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
