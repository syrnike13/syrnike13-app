#include <livekit/livekit.h>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>

int main() try {
  const auto* url = std::getenv("LIVEKIT_URL");
  const auto* token = std::getenv("LIVEKIT_PUBLISHER_TOKEN");
  if (!url || !token) return 1;
  livekit::initialize(livekit::LogLevel::Error);
  {
    livekit::Room room;
    if (!room.connect(url, token, {})) return 2;
    auto participant = room.localParticipant().lock();
    if (!participant) return 3;
    auto source = std::make_shared<livekit::VideoSource>(1920, 1080);
    auto track = livekit::LocalVideoTrack::createLocalVideoTrack(
        "contract-probe", source);
    livekit::TrackPublishOptions options;
    options.source = livekit::TrackSource::SOURCE_CAMERA;
    options.simulcast = false;
    options.video_encoding = livekit::VideoEncodingOptions{8'000'000, 60.0};
    options.video_codec = livekit::VideoCodec::H264;
    participant->publishTrack(track, options);
    auto frame =
        livekit::VideoFrame::create(1920, 1080, livekit::VideoBufferType::RGBA);
    std::fill(frame.data(), frame.data() + frame.dataSize(), 128);
    const auto started = std::chrono::steady_clock::now();
    auto next_frame = started;
    const auto* scenario = std::getenv("VIDEO_LAB_SCENARIO");
    for (std::uint64_t sequence = 0;; ++sequence) {
      const auto now = std::chrono::steady_clock::now();
      if (now - started > std::chrono::minutes(12)) break;
      if (sequence == 300 && scenario &&
          std::string_view(scenario) == "replace") {
        participant->unpublishTrack(track->publication()->sid());
        std::this_thread::sleep_for(std::chrono::seconds(2));
        track = livekit::LocalVideoTrack::createLocalVideoTrack(
            "contract-probe", source);
        participant->publishTrack(track, options);
      }
      for (std::size_t offset = 0; offset < frame.dataSize(); offset += 4) {
        frame.data()[offset] =
            static_cast<std::uint8_t>((sequence / 3) % 200 + 20);
        frame.data()[offset + 3] = 255;
      }
      livekit::VideoCaptureOptions capture;
      capture.timestamp_us =
          std::chrono::duration_cast<std::chrono::microseconds>(
              now.time_since_epoch())
              .count();
      source->captureFrame(frame, capture);
      next_frame = std::max(next_frame + std::chrono::microseconds(16667),
                            std::chrono::steady_clock::now());
      std::this_thread::sleep_until(next_frame);
    }
    if (!room.disconnect()) return 4;
  }
  livekit::shutdown();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
