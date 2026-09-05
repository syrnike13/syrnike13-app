#include "audio/screen_audio_pcm.hpp"
#include <iostream>
#include <stdexcept>

using namespace syrnike::windows_media::audio;
namespace {
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
void packetization() {
  PcmQueue queue;
  queue.begin(1);
  PcmPacketizer packetizer(queue);
  packetizer.begin(1);
  std::array<std::int16_t, 960> input;
  input.fill(1234);
  constexpr std::int64_t began = 100'000'000;
  packetizer.ingest(std::span(input).first(160), 80, 0, began, false, false, false,
                    began + 100'000);
  require(!queue.take(began + 100'000), "partial audio packet escaped");
  packetizer.ingest(std::span(input).first(800), 400, 80, began + 16'666, false, false, false,
                    began + 100'000);
  auto packet = queue.take(began + 100'000);
  require(packet && packet->capture_timestamp_100ns == began && packet->sequence == 1 &&
              packet->samples.back() == 1234,
          "fragmented packet changed samples or first-sample clock");
  packetizer.ingest({}, 480, 480, began + 100'000, true, false, false, began + 200'000);
  packet = queue.take(began + 200'000);
  require(packet && packet->samples[0] == 0 && packet->samples.back() == 0,
          "silent buffer read stale PCM");
  packetizer.ingest(std::span(input).first(160), 80, 960, began + 200'000, false, false, false,
                    began + 300'000);
  packetizer.ingest(input, 480, 5000, began + 300'000, false, true, false, began + 400'000);
  packet = queue.take(began + 400'000);
  require(packet && packet->discontinuity && packet->capture_timestamp_100ns == began + 300'000,
          "discontinuity spliced pre-gap partial PCM");
  packetizer.ingest(input, 480, 5480, began + 400'000, false, false, true, began + 500'000);
  require(!queue.take(began + 500'000), "invalid QPC was advertised as valid audio time");
}
void boundedSlowConsumer() {
  PcmQueue queue;
  queue.begin(7);
  PcmPacket packet;
  packet.generation = 7;
  constexpr std::int64_t began = 100'000'000;
  for (int i = 0; i < 60000; ++i) {
    packet.sequence = static_cast<std::uint64_t>(i);
    packet.capture_timestamp_100ns = began + i * 100'000LL;
    require(queue.push(packet, packet.capture_timestamp_100ns + 100'000), "fresh PCM rejected");
    require(queue.stats().depth <= 8, "PCM queue grew under ten-minute consumer stall");
  }
  const auto stats = queue.stats();
  require(stats.maximum_depth == 8 && stats.superseded == 59992,
          "slow consumer did not replace oldest PCM");
  require(!queue.take(packet.capture_timestamp_100ns + 2'000'000),
          "stale queued PCM escaped age budget");
  queue.begin(8);
  require(!queue.push(packet, packet.capture_timestamp_100ns),
          "old audio generation entered new queue");
  queue.stop();
  packet.generation = 8;
  require(!queue.push(packet, packet.capture_timestamp_100ns), "late PCM survived stop");
}
void stalledWorkerRecovery() {
  PcmQueue queue;
  queue.begin(1);
  PcmPacket packet;
  packet.generation = 1;
  for (std::uint64_t sequence = 1; sequence <= 30; ++sequence) {
    packet.sequence = sequence;
    packet.capture_timestamp_100ns = 100'000'000 + static_cast<std::int64_t>(sequence) * 100'000;
    require(queue.push(packet, packet.capture_timestamp_100ns), "recovery input rejected");
  }
  queue.discardBacklogExceptLatest();
  const auto latest = queue.take(packet.capture_timestamp_100ns + 100'000);
  require(latest && latest->sequence == 30 && queue.stats().superseded == 29,
          "worker recovery replayed accumulated PCM instead of latest packet");
  require(!queue.take(packet.capture_timestamp_100ns + 100'000), "recovery left a burst backlog");
}
}  // namespace
int main() {
  try {
    packetization();
    boundedSlowConsumer();
    stalledWorkerRecovery();
    std::cout << "screen audio PCM: passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
