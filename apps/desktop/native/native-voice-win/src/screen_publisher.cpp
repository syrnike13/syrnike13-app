#include "screen_publisher.hpp"

#include <windows.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>

#include "livekit/livekit.h"
#include "livekit/local_audio_track.h"
#include "livekit/local_track_publication.h"
#include "livekit/local_video_track.h"
#include "livekit/room_delegate.h"

#include "protocol.hpp"
#include "runtime_config.hpp"
#include "screen_audio_capture.hpp"
#include "screen_video_capture.hpp"

namespace syrnike::voice {
namespace {

class NativeRoomDelegate final : public livekit::RoomDelegate {
public:
  void onConnectionStateChanged(
    livekit::Room&,
    const livekit::ConnectionStateChangedEvent& event
  ) override {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      state_ = event.state;
    }
    condition_.notify_all();
  }

  void onDisconnected(
    livekit::Room&,
    const livekit::DisconnectedEvent&
  ) override {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      state_ = livekit::ConnectionState::Disconnected;
      disconnected_ = true;
    }
    condition_.notify_all();
  }

  bool waitConnected(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(mutex_);
    return condition_.wait_for(lock, timeout, [&]() {
      return state_ == livekit::ConnectionState::Connected || disconnected_;
    }) && state_ == livekit::ConnectionState::Connected;
  }

private:
  std::mutex mutex_;
  std::condition_variable condition_;
  livekit::ConnectionState state_ = livekit::ConnectionState::Disconnected;
  bool disconnected_ = false;
};

struct ConnectedScreenRoom {
  std::string session_id;
  std::string native_identity;
  std::unique_ptr<livekit::Room> room;
  std::unique_ptr<NativeRoomDelegate> delegate;
};

struct ActiveScreenCapture {
  std::string session_id;
  std::shared_ptr<std::atomic_bool> running;
  std::thread video_thread;
  std::thread audio_thread;
  std::shared_ptr<livekit::LocalVideoTrack> video_track;
  std::shared_ptr<livekit::LocalAudioTrack> audio_track;
  std::string video_publication_sid;
  std::string audio_publication_sid;
  std::shared_ptr<livekit::AudioSource> audio_source;
  uint32_t width = 0;
  uint32_t height = 0;
  int fps = 0;
  int bitrate = 0;
  std::string audio_mode = "none";
  std::string audio_loopback_mode = "none";
  DWORD audio_target_process_id = 0;
};

int chooseScreenShareBitratePreset(int requested_bitrate) {
  if (requested_bitrate <= 625'000) return 625'000;
  if (requested_bitrate <= 2'500'000) return 2'500'000;
  if (requested_bitrate <= 4'000'000) return 4'000'000;
  return 8'000'000;
}

void emitScreenRoomReady(const StartCommand& command) {
  emit("{\"type\":\"ready\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"port\":0,\"stream_mode\":\"native-screen-preconnected\"," +
       "\"encoder\":\"webrtc\",\"codec\":\"auto-webrtc\"," +
       "\"native_participant_identity\":\"" +
       jsonEscape(command.participant_identity) + "\"}");
}

void emitScreenCaptureReady(
  const StartCommand& command,
  const ActiveScreenCapture& active,
  const ConnectedScreenRoom& connected
) {
  emit("{\"type\":\"ready\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"port\":0,\"stream_mode\":\"native\",\"encoder\":\"webrtc\"," +
       "\"codec\":\"auto-webrtc\"," +
       "\"width\":" + std::to_string(active.width) +
       ",\"height\":" + std::to_string(active.height) +
       ",\"fps\":" + std::to_string(active.fps) +
       ",\"bitrate\":" + std::to_string(active.bitrate) + "," +
       "\"audio_mode\":\"" + active.audio_mode +
       "\",\"audio_sample_rate\":48000,\"audio_channels\":2," +
       "\"audio_target_process_id\":" + std::to_string(active.audio_target_process_id) +
       ",\"audio_loopback_mode\":\"" + active.audio_loopback_mode + "\"," +
       "\"native_participant_identity\":\"" +
       jsonEscape(connected.native_identity) + "\"}");
}

void unpublishTrack(
  ConnectedScreenRoom& connected,
  const std::string& session_id,
  const std::string& kind,
  const std::string& track_sid
) {
  if (track_sid.empty()) return;
  if (auto participant = connected.room ? connected.room->localParticipant().lock() : nullptr) {
    participant->unpublishTrack(track_sid);
    emit("{\"type\":\"track_unpublished\",\"session_id\":\"" + jsonEscape(session_id) +
         "\",\"kind\":\"" + jsonEscape(kind) +
         "\",\"track_sid\":\"" + jsonEscape(track_sid) + "\"}");
  }
}

void stopScreenCapture(
  ConnectedScreenRoom& connected,
  ActiveScreenCapture& active,
  bool emit_stopped
) {
  const std::string stopped_session_id = active.session_id;

  if (active.running) active.running->store(false);
  if (active.video_thread.joinable()) active.video_thread.join();
  if (active.audio_thread.joinable()) active.audio_thread.join();

  unpublishTrack(connected, active.session_id, "video", active.video_publication_sid);
  unpublishTrack(connected, active.session_id, "audio", active.audio_publication_sid);

  active.video_track.reset();
  active.audio_track.reset();
  active.video_publication_sid.clear();
  active.audio_publication_sid.clear();
  active.audio_source.reset();
  active.running.reset();
  active.session_id.clear();
  active.width = 0;
  active.height = 0;
  active.fps = 0;
  active.bitrate = 0;
  active.audio_mode = "none";
  active.audio_loopback_mode = "none";
  active.audio_target_process_id = 0;

  if (!stopped_session_id.empty() && emit_stopped) {
    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" +
         jsonEscape(stopped_session_id) +
         "\",\"kind\":\"screen\",\"status\":\"stopped\"}");
  }
}

void disconnectScreenRoom(ConnectedScreenRoom& connected, ActiveScreenCapture& active) {
  stopScreenCapture(connected, active, !active.session_id.empty());
  connected.room.reset();
  connected.delegate.reset();
  if (!connected.session_id.empty()) {
    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(connected.session_id) +
         "\",\"kind\":\"screen\",\"status\":\"stopped\",\"message\":\"screen_disconnected\"}");
  }
  connected.session_id.clear();
  connected.native_identity.clear();
}

bool connectScreenRoom(const StartCommand& command, ConnectedScreenRoom& connected) {
  const auto started_at = std::chrono::steady_clock::now();
  auto elapsedMs = [&]() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started_at
    ).count();
  };

  if (command.session_id.empty() || command.livekit_url.empty() || command.livekit_token.empty()) {
    emitError("invalid_start_command", "missing sessionId or LiveKit credentials");
    return false;
  }

  if (connected.room && connected.native_identity == command.participant_identity) {
    connected.session_id = command.session_id;
    emitScreenRoomReady(command);
    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
         "\",\"kind\":\"screen\",\"status\":\"running\",\"message\":\"screen_preconnected\"," +
         "\"elapsed_ms\":" + std::to_string(elapsedMs()) + "}");
    return true;
  }

  connected.room.reset();
  connected.delegate.reset();
  connected.session_id = command.session_id;
  connected.native_identity = command.participant_identity;

  emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"kind\":\"screen\",\"status\":\"starting\",\"message\":\"livekit_connecting\",\"elapsed_ms\":" +
       std::to_string(elapsedMs()) + "}");

  auto room = std::make_unique<livekit::Room>();
  auto delegate = std::make_unique<NativeRoomDelegate>();
  room->setDelegate(delegate.get());
  livekit::RoomOptions room_options;
  room_options.auto_subscribe = false;
  room_options.single_peer_connection = false;

  bool connected_room = false;
  try {
    connected_room = room->connect(command.livekit_url, command.livekit_token, room_options);
  } catch (const std::exception& error) {
    emitError("livekit_connect_failed", error.what());
    return false;
  }
  if (!connected_room) {
    emitError("livekit_connect_failed", "LiveKit native screen share connect returned false");
    return false;
  }
  if (!delegate->waitConnected(std::chrono::milliseconds(10'000))) {
    room.reset();
    emitError("livekit_connect_failed", "LiveKit native screen share did not reach connected state");
    return false;
  }

  connected.room = std::move(room);
  connected.delegate = std::move(delegate);

  emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"kind\":\"screen\",\"status\":\"starting\",\"message\":\"livekit_connected\",\"elapsed_ms\":" +
       std::to_string(elapsedMs()) + "}");
  emitScreenRoomReady(command);
  emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"kind\":\"screen\",\"status\":\"running\",\"message\":\"screen_preconnected\"," +
       "\"elapsed_ms\":" + std::to_string(elapsedMs()) + "}");
  return true;
}

void captureScreenVideo(
  const std::string session_id,
  uint32_t width,
  uint32_t height,
  int fps,
  std::chrono::microseconds frame_interval,
  std::shared_ptr<livekit::VideoSource> video_source,
  std::unique_ptr<ScreenVideoCapturer> video_capturer,
  std::shared_ptr<std::atomic_bool> running
) {
  uint32_t frame_count = 0;
  ScreenVideoFrame captured_frame;
  auto next_frame_at = std::chrono::steady_clock::now();
  auto next_video_stats_at = next_frame_at + std::chrono::seconds(1);
  uint32_t interval_frame_count = 0;
  uint32_t interval_late_count = 0;
  std::chrono::microseconds interval_capture_time{0};
  std::int64_t timestamp_us = 0;

  while (g_running.load() && running->load()) {
    const auto capture_started_at = std::chrono::steady_clock::now();
    if (video_capturer->capture(captured_frame)) {
      const auto capture_elapsed = std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::steady_clock::now() - capture_started_at);
      livekit::VideoFrame frame(
          static_cast<int>(width),
          static_cast<int>(height),
          livekit::VideoBufferType::BGRA,
          std::move(captured_frame.bgra));
      video_source->captureFrame(frame, timestamp_us);
      frame_count += 1;
      interval_frame_count += 1;
      interval_capture_time += capture_elapsed;
      timestamp_us += 1000000 / fps;
      if (frame_count % static_cast<uint32_t>(fps) == 0) {
        emit("{\"type\":\"frame_method\",\"method\":\"" + jsonEscape(captured_frame.method) +
             "\",\"active_method\":\"" + jsonEscape(captured_frame.method) + "\",\"count\":" +
             std::to_string(frame_count) + "}");
      }
    }

    next_frame_at += frame_interval;
    const auto now = std::chrono::steady_clock::now();
    if (now > next_frame_at + frame_interval) {
      interval_late_count += 1;
      next_frame_at = now;
    } else {
      std::this_thread::sleep_until(next_frame_at);
    }
    const auto stats_now = std::chrono::steady_clock::now();
    if (stats_now >= next_video_stats_at) {
      const auto avg_capture_us = interval_frame_count > 0
          ? interval_capture_time.count() / interval_frame_count
          : 0;
      emit("{\"type\":\"screen_video_frame\",\"session_id\":\"" +
           jsonEscape(session_id) +
           "\",\"frames\":" + std::to_string(frame_count) +
           ",\"interval_frames\":" + std::to_string(interval_frame_count) +
           ",\"target_fps\":" + std::to_string(fps) +
           ",\"late_frames\":" + std::to_string(interval_late_count) +
           ",\"avg_capture_us\":" + std::to_string(avg_capture_us) +
           ",\"method\":\"" + jsonEscape(captured_frame.method) + "\"}");
      interval_frame_count = 0;
      interval_late_count = 0;
      interval_capture_time = std::chrono::microseconds{0};
      next_video_stats_at = stats_now + std::chrono::seconds(1);
    }
  }
}

bool startScreenCapture(
  const StartCommand& command,
  ConnectedScreenRoom& connected,
  ActiveScreenCapture& active
) {
  const auto started_at = std::chrono::steady_clock::now();
  auto elapsedMs = [&]() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started_at
    ).count();
  };

  if (!connected.room && !connectScreenRoom(command, connected)) return false;
  if (!connected.room) return false;

  stopScreenCapture(connected, active, !active.session_id.empty());

  try {
    const ScreenCaptureTarget target = resolveScreenCaptureTarget(command.source_id);
    uint32_t width = 0;
    uint32_t height = 0;
    resolveScreenCaptureSize(
        target,
        static_cast<uint32_t>(command.width > 0 ? command.width : 1920),
        static_cast<uint32_t>(command.height > 0 ? command.height : 1080),
        width,
        height);
    const int fps = command.fps > 0 ? command.fps : 60;
    const int requested_bitrate = command.bitrate > 0 ? command.bitrate : 8'000'000;
    const int bitrate = chooseScreenShareBitratePreset(requested_bitrate);
    const auto frame_interval = std::chrono::microseconds(1000000 / fps);

    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
         "\",\"kind\":\"screen\",\"status\":\"starting\",\"message\":\"capture_target_resolved\",\"elapsed_ms\":" +
         std::to_string(elapsedMs()) + "}");

    auto video_source = std::make_shared<livekit::VideoSource>(
        static_cast<int>(width),
        static_cast<int>(height));
    auto video_capturer = ScreenVideoCapturer::create(target, width, height);
    auto running = std::make_shared<std::atomic_bool>(true);

    active.session_id = command.session_id;
    active.running = running;
    active.width = width;
    active.height = height;
    active.fps = fps;
    active.bitrate = bitrate;

    active.video_thread = std::thread(
      captureScreenVideo,
      command.session_id,
      width,
      height,
      fps,
      frame_interval,
      video_source,
      std::move(video_capturer),
      running);

    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
         "\",\"kind\":\"screen\",\"status\":\"starting\",\"message\":\"video_source_ready\",\"width\":" +
         std::to_string(width) + ",\"height\":" + std::to_string(height) +
         ",\"fps\":" + std::to_string(fps) +
         ",\"bitrate\":" + std::to_string(bitrate) +
         ",\"requested_bitrate\":" + std::to_string(requested_bitrate) +
         ",\"elapsed_ms\":" + std::to_string(elapsedMs()) + "}");

    const bool publish_audio =
        command.audio_requested && (!target.window || target.process_id != 0);
    if (publish_audio) {
      validateScreenLoopbackAudio(target, static_cast<DWORD>(command.exclude_process_id));
    }
    active.audio_mode =
        publish_audio ? (target.window ? "process" : "system_exclude") : "none";
    active.audio_loopback_mode =
        publish_audio
            ? (target.window ? "include_target_process_tree" : "exclude_target_process_tree")
            : "none";
    active.audio_target_process_id =
        publish_audio
            ? (target.window ? target.process_id : static_cast<DWORD>(command.exclude_process_id))
            : 0;

    if (auto participant = connected.room->localParticipant().lock()) {
      emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
           "\",\"kind\":\"screen\",\"status\":\"starting\",\"message\":\"publishing_video_track\",\"elapsed_ms\":" +
           std::to_string(elapsedMs()) + "}");
      auto video_track = livekit::LocalVideoTrack::createLocalVideoTrack("screen", video_source);
      livekit::TrackPublishOptions video_publish_options;
      video_publish_options.source = livekit::TrackSource::SOURCE_SCREENSHARE;
      video_publish_options.stream = "screen";
      video_publish_options.simulcast = false;
      video_publish_options.video_encoding = livekit::VideoEncodingOptions{
          static_cast<std::uint64_t>(bitrate),
          static_cast<double>(fps),
      };
      participant->publishTrack(video_track, video_publish_options);
      active.video_track = video_track;
      if (const auto publication = video_track->publication()) {
        active.video_publication_sid = publication->sid();
      }
      if (active.video_publication_sid.empty()) {
        throw std::runtime_error("LiveKit native screen video publication SID is empty");
      }
      emit("{\"type\":\"track_published\",\"session_id\":\"" +
            jsonEscape(command.session_id) +
           "\",\"kind\":\"video\",\"source\":\"screen_share\",\"encoder\":\"webrtc\","
           "\"codec\":\"auto-webrtc\",\"width\":" + std::to_string(width) +
           ",\"height\":" + std::to_string(height) +
           ",\"fps\":" + std::to_string(fps) +
           ",\"bitrate\":" + std::to_string(bitrate) + "}");

      if (publish_audio) {
        active.audio_source = std::make_shared<livekit::AudioSource>(48000, 2);
        emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
             "\",\"kind\":\"screen\",\"status\":\"starting\",\"message\":\"publishing_audio_track\",\"elapsed_ms\":" +
             std::to_string(elapsedMs()) + "}");
        active.audio_track =
            livekit::LocalAudioTrack::createLocalAudioTrack("screen-audio", active.audio_source);
        livekit::AudioEncodingOptions audio_encoding;
        audio_encoding.max_bitrate = command.audio_bitrate;
        livekit::TrackPublishOptions audio_publish_options;
        audio_publish_options.audio_encoding = audio_encoding;
        audio_publish_options.dtx = false;
        audio_publish_options.red = false;
        audio_publish_options.source = livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO;
        participant->publishTrack(active.audio_track, audio_publish_options);
        if (const auto publication = active.audio_track ? active.audio_track->publication() : nullptr) {
          active.audio_publication_sid = publication->sid();
        }
        if (active.audio_publication_sid.empty()) {
          throw std::runtime_error("LiveKit native screen audio publication SID is empty");
        }
        emit("{\"type\":\"track_published\",\"session_id\":\"" +
              jsonEscape(command.session_id) +
             "\",\"kind\":\"audio\",\"source\":\"screen_share_audio\","
             "\"audio_mode\":\"" + active.audio_mode +
             "\",\"audio_sample_rate\":48000,\"audio_channels\":2,"
             "\"audio_target_process_id\":" + std::to_string(active.audio_target_process_id) +
             ",\"audio_loopback_mode\":\"" + active.audio_loopback_mode + "\"}");
      }
    } else {
      throw std::runtime_error("local participant is unavailable");
    }

    emitScreenCaptureReady(command, active, connected);
    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
         "\",\"kind\":\"screen\",\"status\":\"running\",\"audio_mode\":\"" + active.audio_mode +
         "\",\"audio_sample_rate\":48000,\"audio_channels\":2,"
         "\"audio_target_process_id\":" + std::to_string(active.audio_target_process_id) +
         ",\"audio_loopback_mode\":\"" + active.audio_loopback_mode + "\","
         "\"width\":" + std::to_string(width) +
         ",\"height\":" + std::to_string(height) +
         ",\"fps\":" + std::to_string(fps) +
         ",\"bitrate\":" + std::to_string(bitrate) +
         ",\"elapsed_ms\":" + std::to_string(elapsedMs()) + "}");

    if (active.audio_source) {
      if (target.window) {
        active.audio_thread = std::thread(
            captureProcessLoopbackAudio,
            target.process_id,
            command.session_id,
            active.audio_source,
            running);
      } else {
        active.audio_thread = std::thread(
            captureSystemLoopbackAudio,
            static_cast<DWORD>(command.exclude_process_id),
            command.session_id,
            active.audio_source,
            running);
      }
    }

    return true;
  } catch (const std::exception& error) {
    stopScreenCapture(connected, active, false);
    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
         "\",\"kind\":\"screen\",\"status\":\"error\",\"message\":\"" + jsonEscape(error.what()) + "\"}");
    emitError("screen_capture_failed", error.what());
    return false;
  }
}

}  // namespace

void runScreenPublisher(const StartCommand& command) {
  g_running.store(true);
  livekit::initialize(livekit::LogLevel::Info);
  ConnectedScreenRoom connected;
  ActiveScreenCapture active;

  if (!command.livekit_url.empty() || !command.livekit_token.empty()) {
    if (!connectScreenRoom(command, connected)) {
      livekit::shutdown();
      return;
    }
    if (!command.source_id.empty()) {
      startScreenCapture(command, connected, active);
    }
  }

  std::string line;
  while (g_running.load() && std::getline(std::cin, line)) {
    if (commandMatches(line, "stop")) {
      g_running.store(false);
      break;
    }
    if (commandMatches(line, "connect_screen")) {
      connectScreenRoom(parseStartCommand(line), connected);
      continue;
    }
    if (commandMatches(line, "start") || commandMatches(line, "start_screen_capture")) {
      startScreenCapture(parseStartCommand(line), connected, active);
      continue;
    }
    if (commandMatches(line, "stop_screen_capture")) {
      stopScreenCapture(connected, active, true);
      continue;
    }
    if (commandMatches(line, "disconnect_screen")) {
      disconnectScreenRoom(connected, active);
      continue;
    }
  }

  disconnectScreenRoom(connected, active);
  livekit::shutdown();
  emit("{\"type\":\"stopped\"}");
}

}  // namespace syrnike::voice
