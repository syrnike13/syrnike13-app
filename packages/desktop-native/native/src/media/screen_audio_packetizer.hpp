#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>

namespace syrnike::voice {

enum class AudioPacketPushResult {
  Pending,
  PacketReady,
  Full,
};

template <std::size_t PacketSamples, std::size_t PacketCapacity>
class FixedAudioPacketQueue final {
 public:
  static_assert(PacketSamples > 0);
  static_assert(PacketCapacity > 0);

  AudioPacketPushResult push(std::int16_t sample) noexcept {
    if (completed_packets_ == PacketCapacity) {
      return AudioPacketPushResult::Full;
    }
    packets_[write_packet_][pending_samples_] = sample;
    ++pending_samples_;
    if (pending_samples_ != PacketSamples) {
      return AudioPacketPushResult::Pending;
    }
    pending_samples_ = 0;
    write_packet_ = (write_packet_ + 1) % PacketCapacity;
    ++completed_packets_;
    ++produced_packets_;
    return AudioPacketPushResult::PacketReady;
  }

  void discardPartial() noexcept {
    pending_samples_ = 0;
    ++resets_;
  }

  [[nodiscard]] std::span<const std::int16_t, PacketSamples> front()
      const noexcept {
    return packets_[read_packet_];
  }

  void pop() noexcept {
    if (completed_packets_ == 0) return;
    read_packet_ = (read_packet_ + 1) % PacketCapacity;
    --completed_packets_;
  }

  [[nodiscard]] std::size_t pendingSamples() const noexcept {
    return pending_samples_;
  }

  [[nodiscard]] std::size_t queuedPackets() const noexcept {
    return completed_packets_;
  }

  [[nodiscard]] std::uint64_t producedPackets() const noexcept {
    return produced_packets_;
  }

  [[nodiscard]] std::uint64_t resets() const noexcept {
    return resets_;
  }

 private:
  std::array<
    std::array<std::int16_t, PacketSamples>,
    PacketCapacity
  > packets_{};
  std::size_t read_packet_ = 0;
  std::size_t write_packet_ = 0;
  std::size_t pending_samples_ = 0;
  std::size_t completed_packets_ = 0;
  std::uint64_t produced_packets_ = 0;
  std::uint64_t resets_ = 0;
};

}  // namespace syrnike::voice
