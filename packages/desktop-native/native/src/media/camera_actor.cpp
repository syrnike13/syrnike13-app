#include "camera_actor.hpp"

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
    if (command.livekit_url.empty() || command.livekit_token.empty()) {
      throw std::invalid_argument("camera LiveKit credentials are required");
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
    state->command = command;
    auto worker = std::make_unique<Attempt>();
    worker->state = state;
    {
      std::lock_guard lock(mutex_);
      current_attempt_ = state;
      attempts_.push_back(std::move(worker));
      attempts_.back()->thread = std::thread([this, state] { runAttempt(state); });
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
    std::atomic_bool cancelled{false};
    std::atomic_bool finished{false};
    std::atomic_bool reply_emitted{false};
  };

  struct Attempt {
    std::shared_ptr<AttemptState> state;
    std::thread thread;
  };

  void stopActive() {
    std::thread thread;
    std::unique_ptr<LiveKitRoomSession> room;
    std::string publication_sid;
    {
      std::lock_guard lock(mutex_);
      if (running_) running_->store(false);
      thread = std::move(capture_thread_);
      room = std::move(room_);
      publication_sid = std::move(publication_sid_);
      running_.reset();
      source_.reset();
      track_.reset();
      session_id_.clear();
      generation_ = 0;
    }
    if (thread.joinable() && thread.get_id() != std::this_thread::get_id()) thread.join();
    if (room && !publication_sid.empty()) room->unpublishTrack(publication_sid);
  }

  void cancelAttempts(bool emit_replies) {
    std::vector<MediaCommand> cancelled;
    {
      std::lock_guard lock(mutex_);
      for (auto& attempt : attempts_) {
        if (attempt->state->finished.load()) continue;
        attempt->state->cancelled.store(true);
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
    if (attempt->cancelled.load() ||
        !is_current_(attempt->command.session_id, attempt->command.generation)) return false;
    std::lock_guard lock(mutex_);
    return current_attempt_ == attempt && !attempt->cancelled.load();
  }

  void runAttempt(const std::shared_ptr<AttemptState>& attempt) {
    const auto command = attempt->command;
    std::unique_ptr<LiveKitRoomSession> room;
    std::string publication_sid;
    try {
      room = client_->createCameraSession(command.session_id, command.generation, post_);
      livekit::RoomOptions room_options;
      room_options.auto_subscribe = true;
      if (!room->connect(command.livekit_url, command.livekit_token, room_options) ||
          !room->waitConnected(std::chrono::seconds(20))) {
        throw std::runtime_error("LiveKit camera Room connection failed");
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
      publication_sid = room->publishVideoTrack(track, options);
      if (publication_sid.empty()) throw std::runtime_error("LiveKit camera publication SID is empty");

      auto running = std::make_shared<std::atomic_bool>(true);
      {
        std::lock_guard lock(mutex_);
        if (current_attempt_ != attempt || attempt->cancelled.load() ||
            !is_current_(command.session_id, command.generation)) {
          throw std::runtime_error("stale camera generation");
        }
        session_id_ = command.session_id;
        generation_ = command.generation;
        room_ = std::move(room);
        publication_sid_ = publication_sid;
        source_ = source;
        track_ = std::move(track);
        running_ = running;
        capture_thread_ = std::thread([this, command, width, height, fps, source, running] {
          captureLoop(command, width, height, fps, source, running);
        });
        current_attempt_.reset();
      }
      if (!attempt->reply_emitted.exchange(true)) emitter_.emit(reply(command));
      RuntimeEvent event;
      event.type = "sessionLifecycle"; event.session_id = command.session_id;
      event.generation = command.generation; event.kind = "camera"; event.status = "running";
      event.device_id = command.device_id; event.width = width; event.height = height; event.fps = fps;
      emitter_.emit(std::move(event));
    } catch (const std::exception& error) {
      if (room && !publication_sid.empty()) room->unpublishTrack(publication_sid);
      if (!attempt->reply_emitted.exchange(true)) {
        auto failed = reply(command);
        failed.ok = false;
        const bool cancelled = attempt->cancelled.load() ||
          !is_current_(command.session_id, command.generation);
        failed.error = NativeError{cancelled ? "stale_generation" : "native_command_failed",
          cancelled ? "Camera connection attempt was superseded" : error.what(),
          "connectCamera", !cancelled, command.session_id, command.generation};
        emitter_.emit(std::move(failed));
      }
    } catch (...) {
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
  std::unique_ptr<LiveKitRoomSession> room_;
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
void CameraActor::disconnect(const MediaCommand& command, bool emit) {
  implementation_->disconnect(command, emit);
}
void CameraActor::handleTerminal(const MediaCommand& command) {
  implementation_->handleTerminal(command);
}
void CameraActor::shutdown() { implementation_->shutdown(); }

}  // namespace syrnike::desktop_native::media
