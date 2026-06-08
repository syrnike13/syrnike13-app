#include "screen_publisher.hpp"

#include <windows.h>

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
#include <vector>

#include "livekit/livekit.h"
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

void startStopCommandThread() {
  std::thread([]() {
    std::string line;
    while (g_running.load() && std::getline(std::cin, line)) {
      if (commandMatches(line, "stop")) {
        g_running.store(false);
        break;
      }
    }
  }).detach();
}

}  // namespace

void runScreenPublisher(const StartCommand& command) {
  g_running.store(true);
  startStopCommandThread();

  try {
    if (command.session_id.empty() || command.livekit_url.empty() || command.livekit_token.empty()) {
      emitError("invalid_start_command", "missing sessionId or LiveKit credentials");
      return;
    }

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
    const int bitrate = command.bitrate > 0 ? command.bitrate : 8'000'000;
    const auto frame_interval = std::chrono::microseconds(1000000 / fps);
    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
         "\",\"kind\":\"screen\",\"status\":\"starting\"}");

    livekit::initialize(livekit::LogLevel::Info);
    auto room = std::make_unique<livekit::Room>();
    NativeRoomDelegate delegate;
    room->setDelegate(&delegate);
    livekit::RoomOptions room_options;
    room_options.auto_subscribe = false;
    room_options.single_peer_connection = false;

    bool connected = false;
    try {
      connected = room->connect(command.livekit_url, command.livekit_token, room_options);
    } catch (const std::exception& error) {
      livekit::shutdown();
      emitError("livekit_connect_failed", error.what());
      return;
    }
    if (!connected) {
      livekit::shutdown();
      emitError("livekit_connect_failed", "LiveKit native screen share connect returned false");
      return;
    }
    if (!delegate.waitConnected(std::chrono::milliseconds(10'000))) {
      room.reset();
      livekit::shutdown();
      emitError("livekit_connect_failed", "LiveKit native screen share did not reach connected state");
      return;
    }

    auto video_source = std::make_shared<livekit::VideoSource>(
        static_cast<int>(width),
        static_cast<int>(height));
    auto video_capturer = ScreenVideoCapturer::create(target, width, height);
    std::shared_ptr<livekit::AudioSource> audio_source;
    const bool publish_audio =
        command.audio_requested && (!target.window || target.process_id != 0);
    if (publish_audio) {
      validateScreenLoopbackAudio(target, static_cast<DWORD>(command.exclude_process_id));
    }
    const std::string audio_mode =
        publish_audio ? (target.window ? "process" : "system_exclude") : "none";
    const std::string audio_loopback_mode =
        publish_audio
            ? (target.window ? "include_target_process_tree" : "exclude_target_process_tree")
            : "none";
    const DWORD audio_target_process_id =
        publish_audio
            ? (target.window ? target.process_id : static_cast<DWORD>(command.exclude_process_id))
            : 0;
    try {
      if (auto participant = room->localParticipant().lock()) {
        auto video_track = livekit::LocalVideoTrack::createLocalVideoTrack("screen", video_source);
        livekit::TrackPublishOptions video_publish_options;
        video_publish_options.source = livekit::TrackSource::SOURCE_SCREENSHARE;
        video_publish_options.simulcast = false;
        video_publish_options.video_encoding = livekit::VideoEncodingOptions{
            static_cast<std::uint64_t>(bitrate),
            static_cast<double>(fps)};
        participant->publishTrack(video_track, video_publish_options);
        emit("{\"type\":\"track_published\",\"session_id\":\"" +
             jsonEscape(command.session_id) +
             "\",\"kind\":\"video\",\"source\":\"screen_share\",\"encoder\":\"webrtc\","
             "\"codec\":\"auto-webrtc\",\"width\":" + std::to_string(width) +
             ",\"height\":" + std::to_string(height) +
             ",\"fps\":" + std::to_string(fps) +
             ",\"bitrate\":" + std::to_string(bitrate) + "}");
        if (publish_audio) {
          audio_source = std::make_shared<livekit::AudioSource>(48000, 2);
          participant->publishAudioTrack(
              "screen-audio",
              audio_source,
              livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO);
          emit("{\"type\":\"track_published\",\"session_id\":\"" +
               jsonEscape(command.session_id) +
               "\",\"kind\":\"audio\",\"source\":\"screen_share_audio\","
               "\"audio_mode\":\"" + audio_mode +
               "\",\"audio_sample_rate\":48000,\"audio_channels\":2,"
               "\"audio_target_process_id\":" + std::to_string(audio_target_process_id) +
               ",\"audio_loopback_mode\":\"" + audio_loopback_mode + "\"}");
        }
      } else {
        throw std::runtime_error("local participant is unavailable");
      }
    } catch (const std::exception& error) {
      room.reset();
      livekit::shutdown();
      emitError("livekit_publish_failed", error.what());
      return;
    }

    emit("{\"type\":\"ready\",\"port\":0,\"stream_mode\":\"native\",\"encoder\":\"webrtc\","
         "\"codec\":\"auto-webrtc\","
         "\"width\":" + std::to_string(width) +
         ",\"height\":" + std::to_string(height) +
         ",\"fps\":" + std::to_string(fps) +
         ",\"bitrate\":" + std::to_string(bitrate) + ","
         "\"audio_mode\":\"" + audio_mode +
         "\",\"audio_sample_rate\":48000,\"audio_channels\":2,"
         "\"audio_target_process_id\":" + std::to_string(audio_target_process_id) +
         ",\"audio_loopback_mode\":\"" + audio_loopback_mode + "\","
         "\"native_participant_identity\":\"" +
         jsonEscape(command.participant_identity) + "\"}");
    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
         "\",\"kind\":\"screen\",\"status\":\"running\",\"audio_mode\":\"" + audio_mode +
         "\",\"audio_sample_rate\":48000,\"audio_channels\":2,"
         "\"audio_target_process_id\":" + std::to_string(audio_target_process_id) +
         ",\"audio_loopback_mode\":\"" + audio_loopback_mode + "\","
         "\"width\":" + std::to_string(width) +
         ",\"height\":" + std::to_string(height) +
         ",\"fps\":" + std::to_string(fps) +
         ",\"bitrate\":" + std::to_string(bitrate) + "}");

    uint32_t frame_count = 0;
    ScreenVideoFrame captured_frame;
    std::thread audio_thread;
    if (audio_source) {
      if (target.window) {
        audio_thread = std::thread(
            captureProcessLoopbackAudio,
            target.process_id,
            command.session_id,
            audio_source);
      } else {
        audio_thread = std::thread(
            captureSystemLoopbackAudio,
            static_cast<DWORD>(command.exclude_process_id),
            command.session_id,
            audio_source);
      }
    }

    auto next_frame_at = std::chrono::steady_clock::now();
    auto next_video_stats_at = next_frame_at + std::chrono::seconds(1);
    uint32_t interval_frame_count = 0;
    uint32_t interval_late_count = 0;
    std::chrono::microseconds interval_capture_time{0};
    std::int64_t timestamp_us = 0;
    while (g_running.load()) {
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
             jsonEscape(command.session_id) +
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

    emit("{\"type\":\"stopped\"}");
    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
         "\",\"kind\":\"screen\",\"status\":\"stopped\"}");
    if (audio_thread.joinable()) audio_thread.join();
    room.reset();
    livekit::shutdown();
  } catch (const std::exception& error) {
    livekit::shutdown();
    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
         "\",\"kind\":\"screen\",\"status\":\"error\",\"message\":\"" + jsonEscape(error.what()) + "\"}");
    emitError("screen_capture_failed", error.what());
  }
}

}  // namespace syrnike::voice
