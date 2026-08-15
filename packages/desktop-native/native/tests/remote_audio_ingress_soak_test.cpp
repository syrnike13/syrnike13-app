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

std::uint64_t fake_now_us = 1'000'000;

std::uint64_t fakeSteadyNowUs() noexcept {
  return fake_now_us;
}

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

  RemoteAudioIngress freshness(&fakeSteadyNowUs);
  freshness.activate(3);
  for (std::size_t index = 0; index < 8; ++index) {
    packet.fill(static_cast<std::int16_t>(100 + index));
    freshness.onAudioFrame(view(packet));
    fake_now_us += 10'000;
  }
  const auto recovered = freshness.enforceFreshness(
      fake_now_us,
      kRemoteAudioIngressFramesPerPacket * 2);
  require(
      recovered.recovered && recovered.scheduled_playout_age_us >
          syrnike::desktop_native::media::
              kRemoteAudioLocalPlayoutAgeBudgetUs &&
          freshness.queuedFrames() ==
              syrnike::desktop_native::media::
                  kRemoteAudioIngressRecoveryPackets &&
          recovered.discarded_packets == 6,
      "sub-overflow wake gaps did not snap stale playout to 20 ms");
  require(
      freshness.tryRead(output, 3) == RemoteAudioIngressReadResult::Frame &&
          output.samples.front() == 106,
      "freshness recovery did not resume at the first newest packet");

  for (std::size_t cycle = 0; cycle < 2'000; ++cycle) {
    while (freshness.tryRead(output, 3) ==
           RemoteAudioIngressReadResult::Frame) {
    }
    for (std::size_t index = 0; index < 7; ++index) {
      packet.fill(static_cast<std::int16_t>(200 + index));
      freshness.onAudioFrame(view(packet));
      fake_now_us += 10'000;
    }
    fake_now_us += 20'000;
    const auto cycle_recovery = freshness.enforceFreshness(
        fake_now_us,
        kRemoteAudioIngressFramesPerPacket * 2);
    require(
        cycle_recovery.recovered && freshness.queuedFrames() <= 2,
        "repeated sub-overflow gaps preserved stale local playout");
  }
  const auto freshness_telemetry = freshness.telemetry();
  require(
      freshness_telemetry.freshness_recoveries == 2'001 &&
          freshness_telemetry.discontinuities == 2'001 &&
          freshness_telemetry.stale_frames_discarded == 10'006 &&
          freshness_telemetry.last_scheduled_playout_age_us >
              syrnike::desktop_native::media::
                  kRemoteAudioLocalPlayoutAgeBudgetUs &&
          freshness_telemetry.last_oldest_queued_age_us > 0,
      "freshness recovery counters or age metrics were not exact");

  freshness.activate(4);
  require(
      freshness.queuedFrames() == 0 &&
          !freshness.enforceFreshness(fake_now_us, 0).recovered,
      "device-generation reset retained stale local playout state");

  RemoteAudioIngress partial(&fakeSteadyNowUs);
  partial.activate(5);
  packet.fill(777);
  partial.onAudioFrame(view(packet));
  require(
      partial.tryRead(output, 5) == RemoteAudioIngressReadResult::Frame,
      "partial-frame freshness fixture did not read its packet");
  fake_now_us += 100'000;
  const auto partial_recovery = partial.enforceFreshness(
      fake_now_us,
      kRemoteAudioIngressFramesPerPacket,
      output.ingress_steady_us,
      kRemoteAudioIngressFramesPerPacket / 2);
  require(
      partial_recovery.recovered &&
          partial_recovery.discarded_packets == 1 &&
          partial.queuedFrames() == 0,
      "a stale partially consumed packet survived the local age budget");

  RemoteAudioIngress mixed_voice(&fakeSteadyNowUs);
  RemoteAudioIngress mixed_stream(&fakeSteadyNowUs);
  mixed_voice.activate(6);
  mixed_stream.activate(6);
  for (std::size_t sequence = 0; sequence < 35'000; ++sequence) {
    packet.fill(static_cast<std::int16_t>(sequence % 20'000));
    mixed_voice.onAudioFrame(view(packet));
    mixed_stream.onAudioFrame(view(packet));
    fake_now_us += 10'000;
    require(
        mixed_voice.tryRead(output, 6) == RemoteAudioIngressReadResult::Frame,
        "mixed-participant nominal track lost cadence");
    if (sequence % 7 == 6) {
      fake_now_us += 20'000;
      require(
          mixed_stream.enforceFreshness(
              fake_now_us,
              kRemoteAudioIngressFramesPerPacket * 2).recovered,
          "mixed-participant stalled track missed freshness recovery");
      while (mixed_stream.tryRead(output, 6) ==
             RemoteAudioIngressReadResult::Frame) {
      }
    }
  }
  require(
      mixed_voice.telemetry().freshness_recoveries == 0 &&
          mixed_voice.telemetry().dropped_frames == 0 &&
          mixed_stream.telemetry().freshness_recoveries == 5'000 &&
          mixed_stream.telemetry().dropped_frames == 0,
      "mixed participants coupled nominal cadence to stalled recovery");

  std::cout
      << "remote audio ingress soak and bounded recovery tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
