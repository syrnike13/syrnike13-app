#include "audio/microphone_pcm.hpp"
#include <iostream>
#include <stdexcept>
#include <thread>

using namespace syrnike::windows_media::audio;
namespace {
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void fragmentedAndInvalidPcm() {
  MicrophonePcmPort port;
  MicrophonePacketizer packetizer(port, 7);
  std::array<std::int16_t, 480> input;
  input.fill(1234);
  packetizer.ingest(std::span(input).first(80), 80, 0, 1'000'000, false, false, false);
  require(!port.take(), "Partial PCM escaped");
  packetizer.ingest(std::span(input).first(400), 400, 80, 1'016'666, false, false, false);
  const auto complete = port.take();
  require(complete && complete->generation == 7 && complete->timestamp_100ns == 1'000'000 &&
              complete->samples.front() == 1234 && complete->samples.back() == 1234,
          "Fragmented PCM lost samples/clock");
  packetizer.ingest({}, 480, 480, 1'100'000, true, false, false);
  const auto silent = port.take();
  require(silent && silent->samples == std::array<std::int16_t, 480>{}, "Silence retained samples");
  packetizer.ingest(input, 80, 960, 1'200'000, false, false, false);
  packetizer.ingest(input, 480, 5000, 1'300'000, false, true, false);
  const auto gap = port.take();
  require(gap && gap->discontinuity && gap->timestamp_100ns == 1'300'000, "Gap spliced old PCM");
  packetizer.ingest(input, 480, 5480, 1'400'000, false, false, true);
  require(!port.take(), "Invalid clock escaped");
  packetizer.ingest({}, 480, 5960, 1'500'000, false, false, false);
  require(!port.take() && packetizer.stats().invalid_buffers == 1, "Short buffer read");
}
void concurrentLatest() {
  MicrophonePcmPort port;
  constexpr std::uint64_t count = 100'000;
  std::thread producer([&port] {
    MicrophoneFrame frame;
    for (std::uint64_t sequence = 1; sequence <= count; ++sequence) {
      frame.sequence = sequence;
      frame.generation = sequence;
      frame.samples.fill(static_cast<std::int16_t>(sequence % 30'000));
      port.publish(frame);
    }
  });
  bool torn = false;
  std::uint64_t last = 0;
  while (last < count) {
    const auto frame = port.take();
    if (!frame) { std::this_thread::yield(); continue; }
    if (frame->sequence <= last || frame->generation != frame->sequence) torn = true;
    for (const auto sample : frame->samples)
      if (sample != static_cast<std::int16_t>(frame->sequence % 30'000)) torn = true;
    last = frame->sequence;
  }
  producer.join();
  require(!torn, "Concurrent port exposed torn/reordered PCM");
  require(!port.take(), "Port replayed consumed frame");
  MicrophoneFrame frame;
  for (std::uint64_t sequence = 1; sequence <= count; ++sequence) {
    frame.sequence = sequence;
    port.publish(frame);
  }
  require(port.take()->sequence == count, "Slow consumer received backlog");
}
void convertedEndpointClock() {
  MicrophonePcmPort port;
  MicrophonePacketizer packetizer(port, 1);
  std::array<std::int16_t, 480> input{};
  for (std::uint64_t index = 0; index < 10; ++index)
    packetizer.ingest(input, 480, index * 441, 1'000'000 + static_cast<std::int64_t>(index) * 100'000,
                      false, index == 0, false);
  require(packetizer.stats().discontinuities == 1 && packetizer.stats().consecutive_healthy_frames == 3,
          "Endpoint 44.1 kHz position was compared to 48 kHz converted PCM");
  packetizer.ingest(input, 480, 20 * 441, 3'000'000, false, false, false);
  require(packetizer.stats().discontinuities == 2, "Unflagged QPC gap escaped");
}
}  // namespace
int main() try {
  fragmentedAndInvalidPcm();
  concurrentLatest();
  convertedEndpointClock();
  std::cout << "Microphone PCM contracts passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
