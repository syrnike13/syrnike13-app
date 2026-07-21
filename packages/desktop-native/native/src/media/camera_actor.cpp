#include "camera_actor.hpp"

#include "media_operation.hpp"

#include <mfapi.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

namespace syrnike::desktop_native::media {
namespace {

RuntimeEvent reply(const MediaCommand& command) {
  RuntimeEvent event;
  event.type = "reply";
  event.request_id = command.request_id;
  event.session_id = command.session_id;
  event.generation = command.generation;
  event.ok = true;
  return event;
}

RuntimeEvent cancelledReply(const MediaCommand& command) {
  auto event = reply(command);
  event.ok = false;
  event.error = NativeError{"stale_generation", "Camera connection attempt was superseded",
    "connectCamera", false, command.session_id, command.generation};
  return event;
}

MediaCommand trackCommand(MediaCommand command) {
  command.livekit_url.clear();
  command.livekit_token.clear();
  return command;
}

}  // namespace

class CameraActor::Implementation {
 public:
  Implementation(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitPublicationClient> client,
    std::shared_ptr<CameraCaptureFactory> factory
  ) : emitter_(emitter), post_(std::move(post)), is_current_(std::move(is_current)),
      client_(std::move(client)), factory_(std::move(factory)) {}

  ~Implementation() { shutdown(); }

  void connect(const MediaCommand& command) {
    reapFinishedAttempts();
    if (!is_current_(command.session_id, command.generation)) {
      throw std::runtime_error("stale camera generation");
    }
    if (command.participant_identity.empty()) {
      throw std::invalid_argument("camera participantIdentity is required");
    }
    {
      std::lock_guard lock(mutex_);
      if (running_ && session_id_ == command.session_id && generation_ == command.generation) {
        emitter_.emit(reply(command));
        return;
      }
    }
    cancelAttempts(true);
    stopActive();
    if (unfinishedAttemptCount() >= 2) {
      throw std::runtime_error("camera publication capacity is still occupied");
    }

    auto state = std::make_shared<AttemptState>();
    state->command = trackCommand(command);
    auto worker = std::make_unique<Attempt>();
    worker->state = state;
    worker->thread = std::thread([this, state] {
      while (!state->committed.load(std::memory_order_acquire)) {
        std::this_thread::yield();
      }
      runAttempt(state);
    });
    try {
      std::lock_guard lock(mutex_);
      attempts_.push_back(std::move(worker));
      current_attempt_ = state;
      state->committed.store(true, std::memory_order_release);
    } catch (...) {
      state->operation.requestCancel();
      state->committed.store(true, std::memory_order_release);
      if (worker && worker->thread.joinable()) worker->thread.join();
      throw;
    }
  }

  void disconnect(const MediaCommand& command, bool emit_event) {
    cancelAttempts(true);
    stopActive();
    reapFinishedAttempts();
    if (!emit_event) return;
    emitter_.emit(reply(command));
    RuntimeEvent event;
    event.type = "sessionLifecycle";
    event.session_id = command.session_id;
    event.generation = command.generation;
    event.kind = "camera";
    event.status = "stopped";
    emitter_.emit(std::move(event));
  }

  RuntimeEvent probe(const MediaCommand& command) {
    reapFinishedAttempts();
    RuntimeEvent result = reply(command);
    result.state = "available";
    std::lock_guard lock(mutex_);
    for (const auto& attempt : attempts_) {
      if (attempt->state->finished.load()) continue;
      if (attempt->state->operation.expired()) {
        result.ok = false;
        result.error = NativeError{
          "actor_unresponsive",
          "camera publication worker exceeded its operation deadline",
          "probeCameraActor",
          true,
          attempt->state->command.session_id,
          attempt->state->command.generation,
        };
        return result;
      }
      result.state = "busy";
    }
    return result;
  }

  void releasePreviewFrame(const MediaCommand& command) {
    client_->releaseLocalCameraPreviewFrame(
      command.track_id,
      command.frame_sequence
    );
  }

  void handleTerminal(const MediaCommand& command) {
    {
      std::lock_guard lock(mutex_);
      if (command.session_id != session_id_ || command.generation != generation_) return;
    }
    stopActive();
    RuntimeEvent event;
    event.type = "cameraTerminal";
    event.session_id = command.session_id;
    event.generation = command.generation;
    event.kind = "camera";
    event.status = "error";
    event.error = NativeError{"camera_capture_failed",
      command.internal_message.empty() ? "Camera capture failed" : command.internal_message,
      "connectCamera", true, command.session_id, command.generation};
    emitter_.emit(std::move(event));
  }

  void shutdown() {
    cancelAttempts(true);
    stopActive();
    std::vector<std::unique_ptr<Attempt>> attempts;
    {
      std::lock_guard lock(mutex_);
      attempts = std::move(attempts_);
      current_attempt_.reset();
    }
    for (auto& attempt : attempts) {
      if (attempt->thread.joinable() && attempt->thread.get_id() != std::this_thread::get_id()) {
        attempt->thread.join();
      }
    }
  }

 private:
  struct AttemptState {
    MediaCommand command;
    MediaOperation operation;
    std::atomic_bool committed{false};
    std::atomic_bool finished{false};
    std::atomic_bool reply_emitted{false};
  };

  struct Attempt {
    std::shared_ptr<AttemptState> state;
    std::thread thread;
  };

  void stopActive() {
    std::thread thread;
    std::unique_ptr<LiveKitTrackPublication> publication;
    std::string publication_sid;
    {
      std::lock_guard lock(mutex_);
      if (running_) running_->store(false);
      thread = std::move(capture_thread_);
      publication = std::move(publication_);
      publication_sid = std::move(publication_sid_);
      running_.reset();
      source_.reset();
      track_.reset();
      session_id_.clear();
      generation_ = 0;
    }
    if (thread.joinable() && thread.get_id() != std::this_thread::get_id()) thread.join();
    cleanupFailedAttempt(publication.get(), publication_sid);
  }

  void cancelAttempts(bool emit_replies) {
    std::vector<MediaCommand> cancelled;
    {
      std::lock_guard lock(mutex_);
      for (auto& attempt : attempts_) {
        if (attempt->state->finished.load()) continue;
        attempt->state->operation.requestCancel();
        if (emit_replies && !attempt->state->command.request_id.empty() &&
            !attempt->state->reply_emitted.exchange(true)) {
          cancelled.push_back(attempt->state->command);
        }
      }
      current_attempt_.reset();
    }
    for (const auto& command : cancelled) emitter_.emit(cancelledReply(command));
  }

  std::size_t unfinishedAttemptCount() {
    std::lock_guard lock(mutex_);
    return static_cast<std::size_t>(std::count_if(
      attempts_.begin(),
      attempts_.end(),
      [](const auto& attempt) { return !attempt->state->finished.load(); }
    ));
  }

  void reapFinishedAttempts() {
    std::vector<std::unique_ptr<Attempt>> finished;
    {
      std::lock_guard lock(mutex_);
      for (auto iterator = attempts_.begin(); iterator != attempts_.end();) {
        if (!(*iterator)->state->finished.load()) {
          ++iterator;
          continue;
        }
        finished.push_back(std::move(*iterator));
        iterator = attempts_.erase(iterator);
      }
    }
    for (auto& attempt : finished) {
      if (attempt->thread.joinable() && attempt->thread.get_id() != std::this_thread::get_id()) {
        attempt->thread.join();
      }
    }
  }

  bool attemptIsCurrent(const std::shared_ptr<AttemptState>& attempt) {
    if (attempt->operation.cancelled() || attempt->operation.expired() ||
        !is_current_(attempt->command.session_id, attempt->command.generation)) return false;
    std::lock_guard lock(mutex_);
    return current_attempt_ == attempt && !attempt->operation.cancelled() &&
      !attempt->operation.expired();
  }

  void cleanupFailedAttempt(
    LiveKitTrackPublication* publication,
    const std::string& publication_sid
  ) noexcept {
    if (publication_sid.empty()) return;
    try {
      client_->stopLocalCameraPreview(publication_sid);
    } catch (...) {
      // Preserve the original publication failure; preview cleanup is best effort.
    }
    if (!publication) return;
    try {
      publication->unpublishTrack(publication_sid);
    } catch (...) {
      // A failed unpublish must not escape the attempt thread or suppress its reply.
    }
  }

  void runAttempt(const std::shared_ptr<AttemptState>& attempt) {
    const auto command = attempt->command;
    std::unique_ptr<LiveKitTrackPublication> publication;
    std::string publication_sid;
    try {
      publication = client_->createCameraPublication(
        command.session_id, command.generation);
      if (!publication->isRoomConnected()) {
        throw std::runtime_error("LiveKit voice Room is not connected");
      }
      if (!attemptIsCurrent(attempt)) throw std::runtime_error("stale camera generation");
      std::unique_lock publication_lock(publication_mutex_);
      if (!attemptIsCurrent(attempt)) throw std::runtime_error("stale camera generation");
      const auto width = std::clamp(command.width, 16, 7680);
      const auto height = std::clamp(command.height, 16, 4320);
      const auto fps = std::clamp(command.fps, 1, 240);
      auto source = std::make_shared<livekit::VideoSource>(width, height);
      auto track = livekit::LocalVideoTrack::createLocalVideoTrack("camera", source);
      livekit::TrackPublishOptions options;
      options.source = livekit::TrackSource::SOURCE_CAMERA;
      options.stream = "camera";
      options.simulcast = false;
      options.video_encoding = livekit::VideoEncodingOptions{
        static_cast<std::uint64_t>(command.bitrate), static_cast<double>(fps)};
      publication_sid = publication->publishVideoTrack(track, options);
      if (publication_sid.empty()) throw std::runtime_error("LiveKit camera publication SID is empty");
      client_->startLocalCameraPreview(
        command.session_id,
        command.generation,
        publication_sid,
        command.participant_identity,
        track
      );

      auto running = std::make_shared<std::atomic_bool>(true);
      auto capture_committed = std::make_shared<std::atomic_bool>(false);
      auto capture_session_id = command.session_id;
      auto capture_thread = std::thread([
        this, command, width, height, fps, source, running, capture_committed
      ] {
        while (!capture_committed->load(std::memory_order_acquire) && running->load()) {
          std::this_thread::yield();
        }
        if (running->load()) captureLoop(command, width, height, fps, source, running);
      });
      {
        std::lock_guard lock(mutex_);
        if (current_attempt_ != attempt || attempt->operation.cancelled() ||
            attempt->operation.expired() ||
            !is_current_(command.session_id, command.generation)) {
          running->store(false);
          capture_committed->store(true, std::memory_order_release);
          capture_thread.join();
          throw std::runtime_error("stale camera generation");
        }
        session_id_ = std::move(capture_session_id);
        generation_ = command.generation;
        publication_ = std::move(publication);
        publication_sid_ = publication_sid;
        source_ = source;
        track_ = std::move(track);
        running_ = running;
        capture_thread_ = std::move(capture_thread);
        current_attempt_.reset();
        capture_committed->store(true, std::memory_order_release);
      }
      if (!attempt->reply_emitted.exchange(true)) emitter_.emit(reply(command));
      RuntimeEvent event;
      event.type = "sessionLifecycle"; event.session_id = command.session_id;
      event.generation = command.generation; event.kind = "camera"; event.status = "running";
      event.device_id = command.device_id; event.width = width; event.height = height; event.fps = fps;
      emitter_.emit(std::move(event));
    } catch (const std::exception& error) {
      cleanupFailedAttempt(publication.get(), publication_sid);
      if (!attempt->reply_emitted.exchange(true)) {
        auto failed = reply(command);
        failed.ok = false;
        const bool cancelled = attempt->operation.cancelled() ||
          !is_current_(command.session_id, command.generation);
        const bool expired = attempt->operation.expired();
        failed.error = NativeError{
          cancelled ? "stale_generation" :
            (expired ? "native_operation_timeout" : "native_command_failed"),
          cancelled ? "Camera connection attempt was superseded" :
            (expired ? "Camera publication deadline expired" : error.what()),
          "connectCamera", !cancelled, command.session_id, command.generation};
        emitter_.emit(std::move(failed));
      }
    } catch (...) {
      cleanupFailedAttempt(publication.get(), publication_sid);
      if (!attempt->reply_emitted.exchange(true)) {
        auto failed = reply(command); failed.ok = false;
        failed.error = NativeError{"native_command_failed", "Camera publication failed",
          "connectCamera", true, command.session_id, command.generation};
        emitter_.emit(std::move(failed));
      }
    }
    attempt->finished.store(true);
  }

  void captureLoop(
    MediaCommand command, int width, int height, int fps,
    std::shared_ptr<livekit::VideoSource> source,
    std::shared_ptr<std::atomic_bool> running
  ) {
    const auto com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool com_ok = SUCCEEDED(com);
    const auto mf = MFStartup(MF_VERSION, MFSTARTUP_LITE);
    try {
      if (FAILED(mf)) throw std::runtime_error("Media Foundation startup failed");
      auto capture = factory_->create(command.device_id,
        static_cast<std::uint32_t>(width), static_cast<std::uint32_t>(height), fps);
      CameraFrame captured;
      const auto started = std::chrono::steady_clock::now();
      while (running->load()) {
        if (!capture->read(captured, *running)) break;
        if (!running->load() || captured.bgra.empty()) continue;
        livekit::VideoFrame frame(static_cast<int>(captured.width),
          static_cast<int>(captured.height), livekit::VideoBufferType::BGRA,
          std::move(captured.bgra));
        const auto timestamp = std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::steady_clock::now() - started).count();
        source->captureFrame(frame, timestamp);
      }
    } catch (const std::exception& error) {
      if (running->exchange(false)) {
        MediaCommand terminal;
        terminal.type = "__cameraTerminal";
        terminal.session_id = command.session_id;
        terminal.generation = command.generation;
        terminal.internal_message = error.what();
        post_(std::move(terminal));
      }
    }
    if (SUCCEEDED(mf)) MFShutdown();
    if (com_ok) CoUninitialize();
  }

  SequencedEmitter& emitter_;
  InternalPost post_;
  IsCurrent is_current_;
  std::shared_ptr<LiveKitPublicationClient> client_;
  std::shared_ptr<CameraCaptureFactory> factory_;
  std::mutex mutex_;
  std::mutex publication_mutex_;
  std::string session_id_;
  std::uint64_t generation_ = 0;
  std::unique_ptr<LiveKitTrackPublication> publication_;
  std::string publication_sid_;
  std::shared_ptr<livekit::VideoSource> source_;
  std::shared_ptr<livekit::LocalVideoTrack> track_;
  std::shared_ptr<std::atomic_bool> running_;
  std::thread capture_thread_;
  std::shared_ptr<AttemptState> current_attempt_;
  std::vector<std::unique_ptr<Attempt>> attempts_;
};

CameraActor::CameraActor(SequencedEmitter& emitter, InternalPost post, IsCurrent current,
  std::shared_ptr<LiveKitPublicationClient> client,
  std::shared_ptr<CameraCaptureFactory> factory)
  : implementation_(std::make_unique<Implementation>(emitter, std::move(post),
      std::move(current), std::move(client), std::move(factory))) {}
CameraActor::~CameraActor() = default;
void CameraActor::connect(const MediaCommand& command) { implementation_->connect(command); }
RuntimeEvent CameraActor::probe(const MediaCommand& command) {
  return implementation_->probe(command);
}
void CameraActor::disconnect(const MediaCommand& command, bool emit) {
  implementation_->disconnect(command, emit);
}
void CameraActor::releasePreviewFrame(const MediaCommand& command) {
  implementation_->releasePreviewFrame(command);
}
void CameraActor::handleTerminal(const MediaCommand& command) {
  implementation_->handleTerminal(command);
}
void CameraActor::shutdown() { implementation_->shutdown(); }

}  // namespace syrnike::desktop_native::media
