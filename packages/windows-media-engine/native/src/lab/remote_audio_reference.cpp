#include <livekit/livekit.h>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <thread>

int main(int argc, char** argv) {
  try {
    if (argc != 2) return 1;
    const auto duration = std::stoul(argv[1]);
    if (duration > 700 || duration < 5) return 1;
    const auto* url = std::getenv("LIVEKIT_URL");
    const auto* token = std::getenv("LIVEKIT_REFERENCE_TOKEN");
    if (!url || !token) return 1;
    livekit::initialize(livekit::LogLevel::Warn);
    {
      livekit::Room room;
      if (!room.connect(url, token, {})) return 1;
      auto participant = room.localParticipant().lock();
      if (!participant) return 1;
      auto source = std::make_shared<livekit::AudioSource>(48000, 1, 0);
      auto track = livekit::LocalAudioTrack::createLocalAudioTrack("reference-voice", source);
      livekit::TrackPublishOptions options;
      options.source = livekit::TrackSource::SOURCE_MICROPHONE;
      options.dtx = false;
      participant->publishTrack(track, options);
      std::cout << "REMOTE_AUDIO_REFERENCE_READY" << std::endl;
      auto frame = livekit::AudioFrame::create(48000, 1, 480);
      auto next = std::chrono::steady_clock::now();
      for (std::uint64_t packet = 0; packet < duration * 100; ++packet) {
        for (std::size_t index = 0; index < frame.data().size(); ++index) {
          const auto sample = packet * 480 + index;
          const auto phase = sample % 48000;
          frame.data()[index] =
              phase >= 24000 && phase < 26400
                  ? static_cast<std::int16_t>(1500 * std::sin(2 * 3.14159265358979323846 * 3400 *
                                                              static_cast<double>(sample) / 48000))
                  : 0;
        }
        source->captureFrame(frame, 100);
        next += std::chrono::milliseconds{10};
        std::this_thread::sleep_until(next);
      }
      if (track->publication()) participant->unpublishTrack(track->publication()->sid());
      room.disconnect();
    }
    livekit::shutdown();
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << std::endl;
    return 1;
  }
}
