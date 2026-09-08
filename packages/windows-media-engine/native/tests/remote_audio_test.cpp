#include "audio/remote_audio_pcm.hpp"
#include "audio/remote_render_plan.hpp"
#include "audio/remote_audio_mixer_worker.hpp"

#include <atomic>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <thread>

using namespace syrnike::windows_media::audio;
namespace {
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
RemoteAudioFrame frame(std::uint64_t sequence, std::int16_t sample = 1000,
                       std::int64_t timestamp = 1'000'000, std::uint64_t generation = 1) {
  RemoteAudioFrame result;
  result.generation = generation;
  result.sequence = sequence;
  result.decoded_timestamp_100ns = timestamp;
  result.samples.fill(sample);
  return result;
}
void queueFreshness() {
  RemoteAudioPcmPort first_stale(1);
  require(first_stale.publish(frame(1)), "First frame publish failed");
  require(!first_stale.take(2'000'000, 0), "Expired first frame was delivered");
  require(first_stale.publish(frame(2, 1000, 3'000'000)), "Recovery frame publish failed");
  const auto recovered = first_stale.take(3'000'000, 0);
  require(recovered && recovered->discontinuity, "Initial stale drop lost its discontinuity marker");
  RemoteAudioPcmPort short_port(1, 2);
  for (std::uint64_t index = 1; index <= 4; ++index)
    require(short_port.publish(frame(index)), "Short port publish failed");
  require(short_port.stats().depth == 2 && short_port.stats().overrun == 2 &&
          short_port.take(1'000'000, 0)->sequence == 3, "Short port retained excess backlog");
  RemoteAudioPcmPort invalid_port(1, 5);
  require(!invalid_port.active() && !invalid_port.publish(frame(1)), "Invalid capacity was accepted");
  RemoteAudioPcmPort port(1);
  for (std::uint64_t index = 1; index <= 10; ++index)
    require(port.publish(frame(index)), "Valid frame rejected");
  require(port.stats().depth == 4 && port.stats().overrun == 6, "Queue exceeded hard capacity");
  const auto newest_window = port.take(1'000'000, 0);
  require(newest_window && newest_window->sequence == 7 && newest_window->discontinuity,
          "Overrun retained old audio or hid gap");
  require(!port.take(2'000'000, 0) && port.stats().depth == 0 && port.stats().stale == 3,
          "Delayed consumer rendered stale backlog");
  require(port.publish(frame(11, 1000, 3'000'000)), "Fresh packet rejected");
  require(!port.take(3'100'000, 3'050'000), "Old renderer epoch PCM survived reset");
  require(!port.publish(frame(12, 1000, 4'000'000, 2)), "Foreign generation accepted");
  require(port.publish(frame(12, 1000, 4'000'000)), "Correct generation rejected");
  require(!port.publish(frame(12, 1000, 4'000'000)), "Repeated sequence accepted");
  port.retire();
  require(!port.take(4'100'000, 0) && !port.publish(frame(13)), "Retired track revived");
  require(port.stats().depth == 0, "Retired PCM reported as queued");
}
void mixingAndControls() {
  RemoteAudioPcmPort left(1), right(2);
  RemoteAudioMixer mixer;
  std::array inputs{RemoteAudioMixInput{&left, 0.5f, false},
                    RemoteAudioMixInput{&right, 2.0f, false}};
  require(mixer.setInputs(inputs), "Valid mixer config rejected");
  auto first = frame(1);
  auto second = frame(1, 2000, 1'000'000, 2);
  for (std::size_t index = 0; index < kRemoteAudioFrames; ++index) {
    first.samples[index * 2 + 1] = 0;
    second.samples[index * 2] = 0;
  }
  left.publish(first);
  right.publish(second);
  const auto output = mixer.mix(1'200'000, 0, 1);
  require(output.samples[0] == 500 && output.samples[1] == 4000,
          "Source volume/stereo separation changed");
  inputs[0].muted = true;
  require(mixer.setInputs(inputs), "Mute config rejected");
  left.publish(frame(2));
  require(mixer.mix(1'200'000, 0, 1).samples == std::array<std::int16_t, kRemoteAudioSamples>{},
          "Muted source was audible");
  require(left.stats().depth == 0, "Mute accumulated backlog");
  mixer.setDeafened(true);
  right.publish(frame(2, 2000, 1'000'000, 2));
  require(mixer.mix(1'200'000, 0, 1).samples == std::array<std::int16_t, kRemoteAudioSamples>{},
          "Deafen was audible");
  mixer.setDeafened(false);
  require(mixer.mix(1'200'000, 0, 1).samples == std::array<std::int16_t, kRemoteAudioSamples>{},
          "Undeafen replayed backlog");
  inputs[0].volume = std::numeric_limits<float>::quiet_NaN();
  require(!mixer.setInputs(inputs), "NaN gain accepted");
  inputs[0] = inputs[1];
  require(!mixer.setInputs(inputs), "Same PCM consumed twice");
  require(mixer.stats().maximum_age_100ns == 200'000 && mixer.stats().age_histogram[1] == 4,
          "Decoded-to-mix age accounting wrong");
}
void limiterAndRetirement() {
  RemoteAudioPcmPort port(1);
  RemoteAudioMixer mixer;
  const std::array inputs{RemoteAudioMixInput{&port, 2, false}};
  require(mixer.setInputs(inputs), "Limiter config rejected");
  port.publish(frame(1, 30'000));
  const auto output = mixer.mix(1'000'000, 0, 1);
  require(output.samples[0] == 32'112 && mixer.stats().limited_frames == 1,
          "Limiter clipped or wrapped PCM");
  port.publish(frame(2));
  port.retire();
  require(mixer.mix(1'000'000, 0, 1).samples[0] == 0, "Late track remained audible");
}
void concurrentQueue() {
  RemoteAudioPcmPort port(1);
  std::atomic_bool done{false};
  std::thread producer([&] {
    for (std::uint64_t sequence = 1; sequence <= 100'000; ++sequence)
      port.publish(frame(sequence, static_cast<std::int16_t>(sequence % 30'000)));
    done.store(true, std::memory_order_release);
  });
  bool torn = false;
  std::uint64_t last = 0;
  while (!done.load(std::memory_order_acquire) || port.stats().depth != 0) {
    const auto value = port.take(1'000'000, 0);
    if (!value) { std::this_thread::yield(); continue; }
    if (value->sequence <= last) torn = true;
    for (const auto sample : value->samples)
      if (sample != static_cast<std::int16_t>(value->sequence % 30'000)) torn = true;
    last = value->sequence;
  }
  producer.join();
  require(!torn && last != 0, "Concurrent queue exposed torn or reordered PCM");
  const auto stats = port.stats();
  require(stats.accepted + stats.producer_contention == 100'000, "Ingress accounting lost frames");
}
void renderProgressAndDelay() {
  RemoteRenderPlan plan;
  auto decision = plan.observe({4800, 0, 0, 1'000'000});
  require(decision.writable_frames == 960 && !decision.healthy, "Initial padding plan is unbounded");
  require(plan.released(960), "Initial release rejected");
  require(!plan.released(960), "Double release accepted");
  for (std::uint64_t wake = 1; wake <= 3; ++wake) {
    decision = plan.observe({4800, 480, wake * 480, 1'000'000 + static_cast<std::int64_t>(wake) * 100'000});
    require(decision.writable_frames == 480 && decision.healthy == (wake == 3),
            "Candidate committed before three observed clock/padding advances");
    require(plan.released(480), "Bounded replenishment rejected");
  }
  decision = plan.observe({4800, 0, 4800, 2'300'000});
  require(decision.delayed_wake && decision.underrun && decision.writable_frames == 960,
          "Delayed wake tried to repay entire endpoint buffer debt");
  require(plan.released(960), "Recovery target rejected");
  decision = plan.observe({4800, 960, 4800, 7'300'000});
  require(decision.no_progress && !decision.healthy && !decision.writable_frames,
          "No-progress renderer kept accepting writes indefinitely");

  RemoteRenderPlan frozen_clock;
  frozen_clock.observe({4800, 0, 1, 1'000'000});
  frozen_clock.released(960);
  decision = frozen_clock.observe({4800, 480, 1, 6'000'000});
  require(decision.no_progress && !decision.healthy, "Padding alone proved liveness with frozen clock");
  RemoteRenderPlan invalid;
  require(invalid.observe({4800, 4801, 0, 1'000'000}).invalid, "Invalid padding accepted");
}
void mixerWorkerOwnershipAndCommands() {
  using Clock = std::chrono::steady_clock;
  const auto now = [] {
    return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
        Clock::now().time_since_epoch()).count();
  };
  RemoteAudioMixerWorker worker;
  auto source = std::make_shared<RemoteAudioPcmPort>(1);
  auto destination = std::make_shared<RemoteAudioPcmPort>(2);
  std::atomic_bool failed{false}, inputs_done{false}, output_done{false};
  std::thread input_control([&] {
    for (unsigned change = 0; change < 100; ++change) {
      const std::array graph{RemoteAudioInput{source, change % 2 ? 0.5f : 1.0f, false}};
      if (!worker.configure(graph, false)) failed = true;
    }
    inputs_done = true;
  });
  std::thread output_control([&] {
    for (unsigned change = 0; change < 100; ++change)
      if (!worker.bindOutput(destination, now())) failed = true;
    output_done = true;
  });
  std::uint64_t sequence = 0, received = 0;
  const auto deadline = Clock::now() + std::chrono::seconds(3);
  while (Clock::now() < deadline && (!inputs_done || !output_done || worker.stats().frames < 10)) {
    (void)source->publish(frame(++sequence, 1000, now()));
    if (destination->take(now(), 0)) ++received;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  input_control.join();
  output_control.join();
  require(!failed && worker.stats().frames >= 10 && received != 0,
          "Concurrent graph/output commands raced or starved mixer frames");
  std::weak_ptr<RemoteAudioPcmPort> source_lifetime = source;
  std::weak_ptr<RemoteAudioPcmPort> output_lifetime = destination;
  source.reset();
  destination.reset();
  require(!source_lifetime.expired() && !output_lifetime.expired(), "Acknowledged ports were not retained");
  const std::array invalid{RemoteAudioInput{}};
  require(!worker.configure(invalid, false) && !source_lifetime.expired(), "Rejected graph destroyed old inputs");
  require(worker.configure({}, false), "Graph detach failed");
  require(source_lifetime.expired(), "Detached input lifetime remained in mixer");
  require(worker.bindOutput({}, 0), "Output detach failed");
  require(output_lifetime.expired(), "Detached renderer port lifetime remained in mixer");
  require(worker.stop(Clock::now() + std::chrono::seconds(2)) && worker.retired(), "Mixer did not stop");
}
}  // namespace
int main() try {
  queueFreshness();
  mixingAndControls();
  limiterAndRetirement();
  concurrentQueue();
  renderProgressAndDelay();
  mixerWorkerOwnershipAndCommands();
  std::cout << "Remote audio freshness and mixing contracts passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
