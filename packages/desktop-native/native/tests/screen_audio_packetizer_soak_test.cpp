#include <array>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <stdexcept>

#include "media/screen_audio_packetizer.hpp"

int main() try {
  constexpr std::size_t kPacketSamples = 960;
  constexpr std::size_t kPacketCapacity = 8;
  constexpr std::uint64_t kPackets = 100'000;
  syrnike::voice::FixedAudioPacketQueue<
    kPacketSamples,
    kPacketCapacity
  > packet_queue;
  std::uint64_t emitted = 0;

  for (std::uint64_t packet_sequence = 0;
       packet_sequence < kPackets;
       packet_sequence += 4) {
    for (std::size_t packet_offset = 0; packet_offset < 4; ++packet_offset) {
      const auto marker = static_cast<std::int16_t>(
        (packet_sequence + packet_offset) % 30'000
      );
      for (std::size_t sample = 0; sample < kPacketSamples; ++sample) {
        const auto result = packet_queue.push(marker);
        if (
          result == syrnike::voice::AudioPacketPushResult::Full ||
          (result == syrnike::voice::AudioPacketPushResult::PacketReady) !=
            (sample + 1 == kPacketSamples)
        ) {
          throw std::runtime_error("packet queue changed packet boundaries");
        }
      }
    }
    while (packet_queue.queuedPackets() > 0) {
      const auto packet = packet_queue.front();
      const auto expected = static_cast<std::int16_t>(emitted % 30'000);
      if (packet.front() != expected || packet.back() != expected) {
        throw std::runtime_error("packet queue reordered PCM samples");
      }
      packet_queue.pop();
      ++emitted;
    }
  }
  if (emitted != kPackets ||
      packet_queue.producedPackets() != kPackets ||
      packet_queue.pendingSamples() != 0 ||
      packet_queue.queuedPackets() != 0) {
    throw std::runtime_error(
      "packet queue accumulated samples during the long soak"
    );
  }

  for (std::size_t index = 0; index < kPacketSamples / 2; ++index) {
    static_cast<void>(packet_queue.push(1));
  }
  packet_queue.discardPartial();
  if (packet_queue.pendingSamples() != 0 || packet_queue.resets() != 1) {
    throw std::runtime_error(
      "packet queue discontinuity retained a partial packet"
    );
  }
  for (std::size_t index = 0; index < kPacketSamples; ++index) {
    const auto result = packet_queue.push(2);
    if (
      (result == syrnike::voice::AudioPacketPushResult::PacketReady) !=
      (index + 1 == kPacketSamples)
    ) {
      throw std::runtime_error(
        "packet queue changed packet boundaries after discontinuity"
      );
    }
  }
  const auto packet = packet_queue.front();
  if (
    packet.front() != 2 ||
    packet.back() != 2 ||
    packet_queue.queuedPackets() != 1
  ) {
    throw std::runtime_error(
      "packet queue exposed stale samples after discontinuity"
    );
  }

  syrnike::voice::FixedAudioPacketQueue<4, 2> bounded_queue;
  for (int sample = 0; sample < 8; ++sample) {
    if (
      bounded_queue.push(static_cast<std::int16_t>(sample)) ==
      syrnike::voice::AudioPacketPushResult::Full
    ) {
      throw std::runtime_error(
        "packet queue rejected data before reaching capacity"
      );
    }
  }
  if (
    bounded_queue.push(9) != syrnike::voice::AudioPacketPushResult::Full
  ) {
    throw std::runtime_error("packet queue exceeded its fixed capacity");
  }

  std::cout << "screen audio fixed packet queue soak passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
