// Synthetic call participant for local measurements against a LiveKit server.
// It talks (tone bursts on a microphone track), optionally shares a synthetic
// screen with stereo screen audio, and optionally watches another
// participant's screen share, then prints one JSON line with what it observed.
#include <windows.h>
#include <timeapi.h>
#include <livekit/livekit.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <variant>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;

struct Options {
  std::string url, token, watch;
  int seconds = 30;
  bool speak = false, screen_audio = false;
  int screen_width = 0, screen_height = 0, screen_fps = 0;
  // Stamps screen frames this much earlier than their audio, so a viewer's
  // audio/video synchronization has a known offset to remove.
  int screen_skew_ms = 0;
};

Options parse(int argc, char** argv) {
  Options options;
  for (int index = 1; index + 1 < argc; index += 2) {
    const std::string key = argv[index], value = argv[index + 1];
    if (key == "--url") options.url = value;
    else if (key == "--token") options.token = value;
    else if (key == "--seconds") options.seconds = std::atoi(value.c_str());
    else if (key == "--speak") options.speak = value == "1";
    else if (key == "--watch") options.watch = value;
    else if (key == "--screen-audio") options.screen_audio = value == "1";
    else if (key == "--screen-skew-ms") options.screen_skew_ms = std::atoi(value.c_str());
    else if (key == "--screen")
      sscanf_s(value.c_str(), "%dx%d@%d", &options.screen_width, &options.screen_height, &options.screen_fps);
  }
  return options;
}

// Counts the watched sharer's track mute/unmute (a paused window share).
struct MuteWatch final : livekit::RoomDelegate {
  std::string identity;
  std::atomic<int> muted{0}, unmuted{0};
  void onTrackMuted(livekit::Room&, const livekit::TrackMutedEvent& event) override {
    if (event.participant && event.participant->identity() == identity) ++muted;
  }
  void onTrackUnmuted(livekit::Room&, const livekit::TrackUnmutedEvent& event) override {
    if (event.participant && event.participant->identity() == identity) ++unmuted;
  }
};

struct WatchStats {
  std::mutex mutex;
  std::uint64_t frames = 0;
  int width = 0, height = 0, max_width = 0, max_height = 0;
  std::uint64_t small_frames = 0;
  double max_gap_ms = 0;
  std::uint64_t gaps_over_100ms = 0;
  Clock::time_point first{}, last{};
};
}  // namespace

int main(int argc, char** argv) {
  const auto options = parse(argc, argv);
  if (options.url.empty() || options.token.empty()) {
    std::fprintf(stderr, "usage: bench_bot --url ws://... --token T [--seconds N] [--speak 1] "
                         "[--screen 1920x1080@30] [--screen-audio 1] [--screen-skew-ms N] [--watch identity]\n");
    return 2;
  }
  livekit::initialize(livekit::LogLevel::Warn);
  int exit_code = 0;
  {
    livekit::Room room;
    livekit::RoomOptions room_options;
    room_options.auto_subscribe = !options.watch.empty();
    MuteWatch mute_watch;
    mute_watch.identity = options.watch;
    room.setDelegate(&mute_watch);
    const auto connect_started = Clock::now();
    if (!room.connect(options.url, options.token, room_options)) {
      std::fprintf(stderr, "connect failed\n");
      livekit::shutdown();
      return 1;
    }
    const auto connected_at = Clock::now();
    const auto connect_ms = std::chrono::duration<double, std::milli>(connected_at - connect_started).count();
    auto participant = room.localParticipant().lock();
    std::atomic<bool> running{true};

    WatchStats watch;
    if (!options.watch.empty()) {
      room.setOnVideoFrameCallback(options.watch, "screen", [&](const livekit::VideoFrame& frame, std::int64_t) {
        const auto now = Clock::now();
        std::scoped_lock lock(watch.mutex);
        if (watch.frames) {
          const double gap = std::chrono::duration<double, std::milli>(now - watch.last).count();
          watch.max_gap_ms = (std::max)(watch.max_gap_ms, gap);
          if (gap > 100) ++watch.gaps_over_100ms;
        } else {
          watch.first = now;
        }
        watch.last = now;
        ++watch.frames;
        watch.width = frame.width();
        watch.height = frame.height();
        if (frame.width() < 640) ++watch.small_frames;
        if (frame.width() > watch.max_width) {
          watch.max_width = frame.width();
          watch.max_height = frame.height();
        }
      });
    }

    std::thread speaker;
    if (options.speak) {
      speaker = std::thread([&] { try {
        auto source = std::make_shared<livekit::AudioSource>(48'000, 1, 10);
        auto track = livekit::LocalAudioTrack::createLocalAudioTrack("microphone", source);
        livekit::TrackPublishOptions publish;
        publish.source = livekit::TrackSource::SOURCE_MICROPHONE;
        publish.dtx = false;
        participant->publishTrack(track, publish);
        auto frame = livekit::AudioFrame::create(48'000, 1, 480);
        std::uint64_t sample = 0;
        auto next = Clock::now();
        while (running) {
          // 700 ms of a 440 Hz tone, then 300 ms of silence: speech-like cadence.
          for (std::size_t index = 0; index < 480; ++index, ++sample) {
            const bool voiced = sample % 48'000 < 33'600;
            frame.data()[index] = voiced ? static_cast<std::int16_t>(
                6000 * std::sin(2 * 3.14159265358979 * 440 * static_cast<double>(sample) / 48'000)) : 0;
          }
          source->captureFrame(frame, 100);
          next += std::chrono::milliseconds{10};
          std::this_thread::sleep_until(next);
        }
      } catch (const std::exception& error) { std::fprintf(stderr, "speak: %s\n", error.what()); } });
    }

    std::thread sharer;
    if (options.screen_fps > 0) {
      sharer = std::thread([&] { try {
        auto source = std::make_shared<livekit::VideoSource>(options.screen_width, options.screen_height);
        auto track = livekit::LocalVideoTrack::createLocalVideoTrack("screen", source);
        livekit::TrackPublishOptions publish;
        publish.source = livekit::TrackSource::SOURCE_SCREENSHARE;
        publish.simulcast = false;
        // The server admits only product screen presets (1080p30 at 6 Mbit/s).
        publish.video_encoding = livekit::VideoEncodingOptions{6'000'000, static_cast<double>(options.screen_fps)};
        publish.video_codec = livekit::VideoCodec::H264;
        participant->publishTrack(track, publish);
        auto frame = livekit::VideoFrame::create(options.screen_width, options.screen_height,
                                                 livekit::VideoBufferType::BGRA);
        const auto period = std::chrono::microseconds{1'000'000 / options.screen_fps};
        auto next = Clock::now();
        std::uint64_t index = 0;
        while (running) {
          // A moving bar keeps the encoder producing real deltas.
          std::memset(frame.data(), 0x30, frame.dataSize());
          const int bar = static_cast<int>((index * 8) % static_cast<std::uint64_t>(options.screen_width));
          for (int row = 0; row < options.screen_height; ++row) {
            auto* line = frame.data() + static_cast<std::size_t>(row) * options.screen_width * 4;
            for (int column = bar; column < (std::min)(bar + 64, options.screen_width); ++column)
              std::memset(line + static_cast<std::size_t>(column) * 4, 0xe0, 3);
          }
          // WebRTC's clock on Windows is timeGetTime(); 0 means "now".
          source->captureFrame(frame, options.screen_skew_ms
              ? (static_cast<std::int64_t>(timeGetTime()) - options.screen_skew_ms) * 1000 : 0);
          ++index;
          next += period;
          std::this_thread::sleep_until(next);
        }
      } catch (const std::exception& error) { std::fprintf(stderr, "screen: %s\n", error.what()); } });
    }

    std::thread screen_audio;
    if (options.screen_audio) {
      screen_audio = std::thread([&] { try {
        // Direct capture, stereo: 440 Hz left, 660 Hz right.
        auto source = std::make_shared<livekit::AudioSource>(48'000, 2, 0);
        auto track = livekit::LocalAudioTrack::createLocalAudioTrack("screen-audio", source);
        livekit::TrackPublishOptions publish;
        publish.source = livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO;
        publish.dtx = false;
        publish.stereo = true;
        participant->publishTrack(track, publish);
        auto frame = livekit::AudioFrame::create(48'000, 2, 480);
        std::uint64_t sample = 0;
        auto next = Clock::now();
        while (running) {
          for (std::size_t index = 0; index < 480; ++index, ++sample) {
            const double t = static_cast<double>(sample) / 48'000;
            frame.data()[index * 2] = static_cast<std::int16_t>(5000 * std::sin(2 * 3.14159265358979 * 440 * t));
            frame.data()[index * 2 + 1] = static_cast<std::int16_t>(5000 * std::sin(2 * 3.14159265358979 * 660 * t));
          }
          source->captureFrame(frame, 100);
          next += std::chrono::milliseconds{10};
          std::this_thread::sleep_until(next);
        }
      } catch (const std::exception& error) { std::fprintf(stderr, "screen audio: %s\n", error.what()); } });
    }

    std::this_thread::sleep_for(std::chrono::seconds{options.seconds});
    // The negotiated codec of the watched sharer's screen audio and, once
    // WebRTC synchronizes that pair, how far the picture leads the sound.
    std::string watched_audio_codec = "null", watched_av_offset = "null";
    if (!options.watch.empty()) try {
      double audio_playout = 0, video_playout = 0;
      if (const auto sharer_participant = room.remoteParticipant(options.watch).lock())
        for (const auto& [sid, publication] : sharer_participant->trackPublications()) {
          if (!publication || !publication->track()) continue;
          const auto source = publication->source();
          if (source != livekit::TrackSource::SOURCE_SCREENSHARE &&
              source != livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO) continue;
          for (const auto& value : publication->track()->getStats().get()) {
            if (const auto* inbound = std::get_if<livekit::RtcInboundRtpStats>(&value.stats))
              (source == livekit::TrackSource::SOURCE_SCREENSHARE ? video_playout : audio_playout) =
                  inbound->inbound.estimated_playout_timestamp;
            if (const auto* codec = std::get_if<livekit::RtcCodecStats>(&value.stats);
                codec && source == livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO)
              watched_audio_codec = "{\"mime\":\"" + codec->codec.mime_type + "\",\"channels\":" +
                  std::to_string(codec->codec.channels) + ",\"fmtp\":\"" + codec->codec.sdp_fmtp_line + "\"}";
          }
        }
      if (audio_playout > 0 && video_playout > 0)
        watched_av_offset = std::to_string(static_cast<long long>(std::llround(video_playout - audio_playout)));
    } catch (const std::exception& error) { std::fprintf(stderr, "watched stats: %s\n", error.what()); }
    running = false;
    if (speaker.joinable()) speaker.join();
    if (sharer.joinable()) sharer.join();
    if (screen_audio.joinable()) screen_audio.join();
    room.disconnect();

    std::scoped_lock lock(watch.mutex);
    const double watched_s = watch.frames > 1
        ? std::chrono::duration<double>(watch.last - watch.first).count() : 0;
    const double first_frame_ms = watch.frames
        ? std::chrono::duration<double, std::milli>(watch.first - connected_at).count() : -1;
    std::printf("{\"connectMs\":%.1f,\"firstFrameMs\":%.1f,\"watchFrames\":%llu,\"watchFps\":%.2f,\"watchWidth\":%d,"
                "\"watchHeight\":%d,\"watchMaxWidth\":%d,\"watchMaxHeight\":%d,\"watchSmallFrames\":%llu,"
                "\"watchMaxGapMs\":%.1f,\"watchGapsOver100ms\":%llu,\"watchMuted\":%d,\"watchUnmuted\":%d,"
                "\"watchScreenAudioCodec\":%s,\"watchScreenAvOffsetMs\":%s}\n",
                connect_ms, first_frame_ms, static_cast<unsigned long long>(watch.frames),
                watched_s > 0 ? static_cast<double>(watch.frames - 1) / watched_s : 0.0,
                watch.width, watch.height, watch.max_width, watch.max_height,
                static_cast<unsigned long long>(watch.small_frames), watch.max_gap_ms,
                static_cast<unsigned long long>(watch.gaps_over_100ms), mute_watch.muted.load(),
                mute_watch.unmuted.load(), watched_audio_codec.c_str(), watched_av_offset.c_str());
    std::fflush(stdout);
  }
  livekit::shutdown();
  return exit_code;
}
