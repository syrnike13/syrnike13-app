#include "screen_actor.hpp"

#include <livekit/livekit.h>
#include <livekit/local_audio_track.h>
#include <livekit/local_track_publication.h>
#include <livekit/local_video_track.h>
#include <livekit/room_delegate.h>

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

#include "screen_capture_priority.hpp"
#include "screen_audio_capture.hpp"
#include "screen_session_invariants.hpp"
#include "screen_video_capture.hpp"

namespace syrnike::desktop_native::media {
namespace {

class ScreenRoomDelegate final : public livekit::RoomDelegate {
 public:
  explicit ScreenRoomDelegate(ScreenActor::InternalPost post) : post_(std::move(post)) {}

  void updateIdentity(std::string session_id, std::uint64_t generation) {
    std::lock_guard lock(mutex_);
    session_id_ = std::move(session_id);
    generation_ = generation;
  }

  void onConnectionStateChanged(
    livekit::Room&,
    const livekit::ConnectionStateChangedEvent& event
  ) override {
    bool terminal = false;
    {
      std::lock_guard lock(mutex_);
      state_ = event.state;
      if (state_ == livekit::ConnectionState::Connected) was_connected_ = true;
      terminal = state_ == livekit::ConnectionState::Disconnected && was_connected_ && !intentional_;
    }
    changed_.notify_all();
    if (terminal) postTerminal("livekit_disconnected");
  }

  void onDisconnected(livekit::Room&, const livekit::DisconnectedEvent&) override {
    bool terminal = false;
    {
      std::lock_guard lock(mutex_);
      state_ = livekit::ConnectionState::Disconnected;
      disconnected_ = true;
      terminal = !intentional_;
    }
    changed_.notify_all();
    if (terminal) postTerminal("livekit_disconnected");
  }

  bool waitConnected() {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, std::chrono::seconds(10), [&] {
      return state_ == livekit::ConnectionState::Connected || disconnected_;
    }) && state_ == livekit::ConnectionState::Connected;
  }

  void markIntentional() {
    std::lock_guard lock(mutex_);
    intentional_ = true;
  }

 private:
  void postTerminal(const char* message) {
    if (terminal_posted_.exchange(true)) return;
    MediaCommand command;
    command.type = "__screenTerminal";
    {
      std::lock_guard lock(mutex_);
      command.session_id = session_id_;
      command.generation = generation_;
    }
    command.internal_message = message;
    post_(std::move(command));
  }

  ScreenActor::InternalPost post_;
  std::mutex mutex_;
  std::condition_variable changed_;
  livekit::ConnectionState state_ = livekit::ConnectionState::Disconnected;
  std::string session_id_;
  std::uint64_t generation_ = 0;
  bool disconnected_ = false;
  bool intentional_ = false;
  bool was_connected_ = false;
  std::atomic_bool terminal_posted_{false};
};

int screenBitrate(int requested) {
  if (requested <= 625'000) return 625'000;
  if (requested <= 2'500'000) return 2'500'000;
  if (requested <= 4'000'000) return 4'000'000;
  return 8'000'000;
}

}  // namespace

class ScreenActor::Implementation {
 public:
  Implementation(SequencedEmitter& emitter, InternalPost post, IsCurrent is_current)
    : emitter_(emitter), post_(std::move(post)), is_current_(std::move(is_current)) {}

  ~Implementation() { shutdown(); }

  RuntimeEvent connect(const MediaCommand& command) {
    if (!is_current_(command.session_id, command.generation)) {
      throw std::runtime_error("stale screen connect generation");
    }
    validateConnect(command);
    const bool credentials_match =
      room_ &&
      connected_url_ == command.livekit_url &&
      connected_token_ == command.livekit_token &&
      participant_identity_ == command.participant_identity;
    if (!canReuseActiveScreenRoom(
      capture_active_,
      active_session_id_,
      active_generation_,
      command.session_id,
      command.generation,
      credentials_match
    )) {
      throw std::logic_error(
        "cannot preconnect or retag a screen room while capture is active"
      );
    }
    if (capture_active_) return successfulReply(command);
    if (credentials_match) {
      active_session_id_ = command.session_id;
      active_generation_ = command.generation;
      delegate_->updateIdentity(active_session_id_, active_generation_);
      return successfulReply(command);
    }

    disconnectRoom();
    auto room = std::make_unique<livekit::Room>();
    auto delegate = std::make_unique<ScreenRoomDelegate>(post_);
    delegate->updateIdentity(command.session_id, command.generation);
    room->setDelegate(delegate.get());
    livekit::RoomOptions options;
    options.auto_subscribe = false;
    options.single_peer_connection = false;
    if (!room->connect(command.livekit_url, command.livekit_token, options)) {
      throw std::runtime_error("LiveKit screen connect returned false");
    }
    if (!delegate->waitConnected()) {
      delegate->markIntentional();
      room->disconnect();
      throw std::runtime_error("LiveKit screen connection timed out");
    }
    if (!is_current_(command.session_id, command.generation)) {
      delegate->markIntentional();
      room->disconnect();
      throw std::runtime_error("stale screen connect generation");
    }
    room_ = std::move(room);
    delegate_ = std::move(delegate);
    connected_url_ = command.livekit_url;
    connected_token_ = command.livekit_token;
    participant_identity_ = command.participant_identity;
    active_session_id_ = command.session_id;
    active_generation_ = command.generation;
    return successfulReply(command);
  }

  RuntimeEvent startCapture(const MediaCommand& command) {
    if (!is_current_(command.session_id, command.generation)) {
      throw std::runtime_error("stale screen capture generation");
    }
    stopCaptureInternal(false);
    connect(command);
    try {
    const auto target = syrnike::voice::resolveScreenCaptureTarget(command.source_id);
    std::uint32_t width = 0;
    std::uint32_t height = 0;
    syrnike::voice::resolveScreenCaptureSize(
      target,
      static_cast<std::uint32_t>(command.width),
      static_cast<std::uint32_t>(command.height),
      width,
      height
    );
    const int fps = std::clamp(command.fps, 1, 240);
    const int bitrate = screenBitrate(command.bitrate);
    const bool publish_audio =
      command.audio_requested && (!target.window || target.process_id != 0);
    if (publish_audio) {
      syrnike::voice::validateScreenLoopbackAudio(target, command.exclude_process_id);
    }
    auto source = std::make_shared<livekit::VideoSource>(
      static_cast<int>(width), static_cast<int>(height)
    );
    auto capturer = syrnike::voice::ScreenVideoCapturer::create(target, width, height);
    auto running = std::make_shared<std::atomic_bool>(true);

    active_session_id_ = command.session_id;
    active_generation_ = command.generation;
    delegate_->updateIdentity(active_session_id_, active_generation_);
    capture_running_ = running;
    capture_width_ = static_cast<int>(width);
    capture_height_ = static_cast<int>(height);
    capture_fps_ = fps;
    capture_bitrate_ = bitrate;
    resetStats(command.session_id, command.generation);
    video_source_ = source;
    capture_thread_ = std::thread(
      [this,
       session_id = command.session_id,
       generation = command.generation,
       width,
       height,
       fps,
       source,
       running,
       capturer = std::move(capturer)]() mutable {
        captureLoop(
          std::move(session_id), generation, width, height, fps,
          std::move(source), std::move(running), std::move(capturer)
        );
      }
    );

      auto participant = room_->localParticipant().lock();
      if (!participant) throw std::runtime_error("LiveKit screen participant is unavailable");
      video_track_ = livekit::LocalVideoTrack::createLocalVideoTrack("screen", video_source_);
      livekit::TrackPublishOptions options;
      options.source = livekit::TrackSource::SOURCE_SCREENSHARE;
      options.stream = "screen";
      options.simulcast = false;
      options.video_encoding = livekit::VideoEncodingOptions{
        static_cast<std::uint64_t>(bitrate), static_cast<double>(fps),
      };
      participant->publishTrack(video_track_, options);
      const auto publication = video_track_->publication();
      if (!publication) throw std::runtime_error("LiveKit screen publication was not acknowledged");
      video_publication_sid_ = publication->sid();
      if (video_publication_sid_.empty()) {
        throw std::runtime_error("LiveKit screen publication SID is empty");
      }
      if (!is_current_(command.session_id, command.generation)) {
        throw std::runtime_error("stale screen publish generation");
      }

      if (publish_audio) {
        audio_source_ = std::make_shared<livekit::AudioSource>(48'000, 2);
        audio_track_ = livekit::LocalAudioTrack::createLocalAudioTrack(
          "screen-audio", audio_source_
        );
        livekit::AudioEncodingOptions audio_encoding;
        audio_encoding.max_bitrate = command.audio_bitrate;
        livekit::TrackPublishOptions audio_options;
        audio_options.audio_encoding = audio_encoding;
        audio_options.dtx = false;
        audio_options.red = false;
        audio_options.source = livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO;
        participant->publishTrack(audio_track_, audio_options);
        const auto audio_publication = audio_track_->publication();
        if (!audio_publication) {
          throw std::runtime_error("LiveKit screen audio publication was not acknowledged");
        }
        audio_publication_sid_ = audio_publication->sid();
        if (audio_publication_sid_.empty()) {
          throw std::runtime_error("LiveKit screen audio publication SID is empty");
        }
        audio_mode_ = target.window ? "process" : "system_exclude";
        loopback_mode_ = target.window
          ? "include_target_process_tree"
          : "exclude_target_process_tree";
        audio_target_process_id_ = target.window
          ? target.process_id
          : command.exclude_process_id;
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
          recordAudioStats(
            session_id, generation, frames, packets, peak_db, rms_db
          );
        };
        if (target.window) {
          audio_thread_ = std::thread(
            syrnike::voice::captureProcessLoopbackAudio,
            target.process_id,
            command.session_id,
            audio_source_,
            capture_running_,
            std::move(on_failure),
            std::move(on_stats)
          );
        } else {
          audio_thread_ = std::thread(
            syrnike::voice::captureSystemLoopbackAudio,
            command.exclude_process_id,
            command.session_id,
            audio_source_,
            capture_running_,
            std::move(on_failure),
            std::move(on_stats)
          );
        }
      }
      capture_active_ = true;
    auto result = successfulReply(command);
    result.kind = "screen";
    result.width = static_cast<int>(width);
    result.height = static_cast<int>(height);
    result.fps = fps;
    result.bitrate = bitrate;
    result.audio_mode = audio_mode_;
    result.loopback_mode = loopback_mode_;
    result.audio_target_process_id = audio_target_process_id_;
    result.native_participant_identity = participant_identity_;
    return result;
    } catch (...) {
      stopCaptureInternal(false);
      disconnectRoom();
      throw;
    }
  }

  void stopCapture(const MediaCommand& command, bool emit_stopped) {
    if (!is_current_(command.session_id, command.generation)) {
      throw std::runtime_error("stale screen stop generation");
    }
    if (!command.session_id.empty() && active_session_id_ != command.session_id) return;
    stopCaptureInternal(emit_stopped);
  }

  void disconnect(const MediaCommand& command, bool emit_stopped) {
    if ((command.type == "disconnectScreen" || command.terminal || command.force) &&
        !is_current_(command.session_id, command.generation)) {
      throw std::runtime_error("stale screen disconnect generation");
    }
    if (
      !command.terminal && !command.force && !command.session_id.empty() &&
      !matchesActive(command)
    ) return;
    if (!command.session_id.empty() && active_session_id_ != command.session_id) return;
    stopCaptureInternal(emit_stopped);
    disconnectRoom();
  }

  void handleTerminal(const MediaCommand& command) {
    if (command.internal_message != "livekit_disconnected" && !capture_active_) return;
    if (!matchesActive(command)) return;
    const auto reason = command.internal_message.empty()
      ? std::string("runtime_error")
      : command.internal_message;
    stopCaptureInternal(false);
    disconnectRoom();
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

  void shutdown() {
    stopCaptureInternal(false);
    disconnectRoom();
  }

 private:
  RuntimeEvent successfulReply(const MediaCommand& command) const {
    RuntimeEvent result;
    result.type = "reply";
    result.request_id = command.request_id;
    result.session_id = command.session_id;
    result.generation = command.generation;
    result.ok = true;
    return result;
  }

  void validateConnect(const MediaCommand& command) const {
    if (command.livekit_url.empty()) throw std::invalid_argument("LiveKit URL is required");
    if (command.livekit_token.empty()) throw std::invalid_argument("LiveKit token is required");
    if (command.participant_identity.empty()) {
      throw std::invalid_argument("participantIdentity is required");
    }
  }

  bool matchesActive(const MediaCommand& command) const {
    return active_session_id_ == command.session_id && active_generation_ == command.generation;
  }

  void stopCaptureInternal(bool emit_stopped) {
    const auto stopped_session_id = active_session_id_;
    const auto stopped_generation = active_generation_;
    const bool was_active = capture_active_;
    capture_active_ = false;
    if (capture_running_) capture_running_->store(false);
    if (capture_thread_.joinable()) capture_thread_.join();
    if (audio_thread_.joinable()) audio_thread_.join();
    if (!video_publication_sid_.empty()) {
      if (auto participant = room_ ? room_->localParticipant().lock() : nullptr) {
        try { participant->unpublishTrack(video_publication_sid_); } catch (...) {}
      }
    }
    video_publication_sid_.clear();
    if (!audio_publication_sid_.empty()) {
      if (auto participant = room_ ? room_->localParticipant().lock() : nullptr) {
        try { participant->unpublishTrack(audio_publication_sid_); } catch (...) {}
      }
    }
    audio_publication_sid_.clear();
    video_track_.reset();
    audio_track_.reset();
    video_source_.reset();
    audio_source_.reset();
    capture_running_.reset();
    capture_width_ = 0;
    capture_height_ = 0;
    capture_fps_ = 0;
    capture_bitrate_ = 0;
    audio_mode_ = "none";
    loopback_mode_.clear();
    audio_target_process_id_ = 0;
    if (emit_stopped && was_active && !stopped_session_id.empty()) {
      RuntimeEvent event;
      event.type = "sessionStopped";
      event.session_id = stopped_session_id;
      event.generation = stopped_generation;
      event.reason = "stopped";
      emitter_.emit(std::move(event));
    }
  }

  void disconnectRoom() {
    if (delegate_) delegate_->markIntentional();
    if (room_) {
      try { room_->disconnect(); } catch (...) {}
    }
    room_.reset();
    delegate_.reset();
    connected_url_.clear();
    connected_token_.clear();
    participant_identity_.clear();
    active_session_id_.clear();
    active_generation_ = 0;
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
    } catch (...) {
      if (running->exchange(false)) {
        MediaCommand terminal;
        terminal.type = "__screenTerminal";
        terminal.session_id = std::move(session_id);
        terminal.generation = generation;
        terminal.internal_message = "capture_failed";
        post_(std::move(terminal));
      }
    }
  }

  SequencedEmitter& emitter_;
  InternalPost post_;
  IsCurrent is_current_;
  std::unique_ptr<livekit::Room> room_;
  std::unique_ptr<ScreenRoomDelegate> delegate_;
  std::string connected_url_;
  std::string connected_token_;
  std::string participant_identity_;
  std::string active_session_id_;
  std::uint64_t active_generation_ = 0;
  std::shared_ptr<std::atomic_bool> capture_running_;
  std::thread capture_thread_;
  std::shared_ptr<livekit::VideoSource> video_source_;
  std::shared_ptr<livekit::LocalVideoTrack> video_track_;
  std::string video_publication_sid_;
  std::shared_ptr<livekit::AudioSource> audio_source_;
  std::shared_ptr<livekit::LocalAudioTrack> audio_track_;
  std::string audio_publication_sid_;
  std::thread audio_thread_;
  std::string audio_mode_ = "none";
  std::string loopback_mode_;
  std::uint32_t audio_target_process_id_ = 0;
  int capture_width_ = 0;
  int capture_height_ = 0;
  int capture_fps_ = 0;
  int capture_bitrate_ = 0;
  bool capture_active_ = false;
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

ScreenActor::ScreenActor(SequencedEmitter& emitter, InternalPost post, IsCurrent is_current)
  : implementation_(std::make_unique<Implementation>(
      emitter, std::move(post), std::move(is_current)
    )) {}
ScreenActor::~ScreenActor() = default;
RuntimeEvent ScreenActor::connect(const MediaCommand& command) {
  return implementation_->connect(command);
}
RuntimeEvent ScreenActor::startCapture(const MediaCommand& command) {
  return implementation_->startCapture(command);
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
void ScreenActor::shutdown() { implementation_->shutdown(); }

}  // namespace syrnike::desktop_native::media
