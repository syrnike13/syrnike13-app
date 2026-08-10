#include <array>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <stdexcept>

#include "media/remote_audio_ingress.hpp"
#include "media/remote_audio_output.hpp"

namespace {

using syrnike::desktop_native::media::RemoteAudioIngress;
using syrnike::desktop_native::media::RemoteAudioIngressFrame;
using syrnike::desktop_native::media::RemoteAudioIngressReadResult;
using syrnike::desktop_native::media::kRemoteAudioIngressChannels;
using syrnike::desktop_native::media::kRemoteAudioIngressFramesPerPacket;
using syrnike::desktop_native::media::kRemoteAudioIngressSampleRate;
using syrnike::desktop_native::media::kRemoteAudioIngressSamplesPerPacket;

livekit::DecodedAudioFrameView view(
    const std::array<
        std::int16_t,
        kRemoteAudioIngressSamplesPerPacket>& samples) {
  return {
      .data = samples.data(),
      .sample_count = samples.size(),
      .sample_rate = kRemoteAudioIngressSampleRate,
      .num_channels = kRemoteAudioIngressChannels,
      .num_frames = kRemoteAudioIngressFramesPerPacket,
  };
}

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main() try {
  using namespace std::chrono_literals;
  using syrnike::desktop_native::media::kRemoteAudioIngressSlotCount;
  using syrnike::desktop_native::media::remoteAudioPlayoutStartDuration;

  RemoteAudioIngress matched;
  matched.activate(1);
  RemoteAudioIngressFrame output;
  std::array<std::int16_t, kRemoteAudioIngressSamplesPerPacket> packet{};
  constexpr std::uint64_t kPackets = 100'000;
  for (std::uint64_t sequence = 1; sequence <= kPackets; ++sequence) {
    const auto marker = static_cast<std::int16_t>(
        1 + sequence % 30'000);
    packet.fill(marker);
    matched.onAudioFrame(view(packet));
    require(
        matched.queuedFrames() == 1,
        "matched producer/consumer cadence accumulated audio backlog");
    require(
        matched.tryRead(output, 1) == RemoteAudioIngressReadResult::Frame,
        "matched producer/consumer cadence lost an audio packet");
    require(
        output.samples.front() == marker && output.samples.back() == marker,
        "matched producer/consumer cadence corrupted PCM");
  }
  const auto matched_telemetry = matched.telemetry();
  require(
      matched_telemetry.accepted_frames == kPackets &&
          matched_telemetry.dropped_frames == 0 &&
          matched_telemetry.discontinuities == 0 &&
          matched.queuedFrames() == 0,
      "matched audio soak drifted or reported a false discontinuity");

  RemoteAudioIngress stalled;
  stalled.activate(2);
  for (std::size_t index = 0;
       index < kRemoteAudioIngressSlotCount - 1;
       ++index) {
    packet.fill(static_cast<std::int16_t>(index + 1));
    stalled.onAudioFrame(view(packet));
  }
  require(
      stalled.queuedFrames() == kRemoteAudioIngressSlotCount - 1,
      "audio ingress did not fill to its documented bounded capacity");
  stalled.onAudioFrame(view(packet));
  require(
      stalled.telemetry().dropped_frames == 1,
      "a 160 ms consumer stall did not drop the overflow packet");
  require(
      stalled.tryRead(output, 2) ==
              RemoteAudioIngressReadResult::Discontinuity &&
          stalled.queuedFrames() ==
            syrnike::desktop_native::media::
              kRemoteAudioIngressRecoveryPackets,
      "overflow did not retain the bounded recovery prebuffer");

  const auto start_packets =
      static_cast<std::size_t>(remoteAudioPlayoutStartDuration() / 10ms);
  require(
      start_packets ==
        syrnike::desktop_native::media::kRemoteAudioIngressRecoveryPackets,
      "overflow recovery no longer retains exactly one 20 ms prebuffer");
  require(
      stalled.queuedFrames() == start_packets,
      "overflow recovery amplified the stall with a fresh prebuffer wait");
  require(
      stalled.tryRead(output, 2) == RemoteAudioIngressReadResult::Frame &&
        output.samples.front() ==
          static_cast<std::int16_t>(kRemoteAudioIngressSlotCount - 2),
      "overflow recovery did not resume from the first retained packet");
  require(
      stalled.tryRead(output, 2) == RemoteAudioIngressReadResult::Frame &&
        output.samples.front() ==
          static_cast<std::int16_t>(kRemoteAudioIngressSlotCount - 1),
      "overflow recovery did not preserve the newest packet");

  std::cout
      << "remote audio ingress soak and bounded recovery tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
