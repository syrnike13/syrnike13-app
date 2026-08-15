#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <new>
#include <optional>
#include <span>
#include <stdexcept>
#include <thread>
#include <vector>

#include "media/audio_constants.hpp"
#include "media/microphone_audio_processor.hpp"
#include "media/microphone_capture_accumulator.hpp"
#include "media/microphone_pcm_queue.hpp"
#include "media/realtime_snapshot.hpp"
#include "media/runtime_config.hpp"

namespace {

thread_local bool count_allocations = false;
std::atomic_size_t allocation_count{0};
std::atomic_size_t deallocation_count{0};

void noteAllocation() noexcept {
  if (count_allocations) {
    allocation_count.fetch_add(1, std::memory_order_relaxed);
  }
}

void noteDeallocation() noexcept {
  if (count_allocations) {
    deallocation_count.fetch_add(1, std::memory_order_relaxed);
  }
}

struct RoutingSnapshot {
  explicit RoutingSnapshot(std::size_t value)
      : revision(value), owned_payload(64, value) {}
  std::size_t revision = 0;
  std::vector<std::size_t> owned_payload;
};

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

void* operator new(std::size_t size) {
  noteAllocation();
  if (void* allocation = std::malloc(size)) return allocation;
  throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
  noteAllocation();
  if (void* allocation = std::malloc(size)) return allocation;
  throw std::bad_alloc();
}

void operator delete(void* allocation) noexcept {
  noteDeallocation();
  std::free(allocation);
}
void operator delete[](void* allocation) noexcept {
  noteDeallocation();
  std::free(allocation);
}
void operator delete(void* allocation, std::size_t) noexcept {
  noteDeallocation();
  std::free(allocation);
}
void operator delete[](void* allocation, std::size_t) noexcept {
  noteDeallocation();
  std::free(allocation);
}

int main() try {
  using Clock = std::chrono::steady_clock;
  // 60,000 ten-millisecond callbacks are ten minutes of steady media time.
  constexpr std::size_t kIterations = 60'000;
  constexpr auto kP99Budget = std::chrono::microseconds(2'000);
  constexpr std::size_t kSamples = syrnike::voice::kSamplesPer10Ms;

  std::array<float, kSamples> raw{};
  for (std::size_t index = 0; index < raw.size(); ++index) {
    raw[index] =
        static_cast<float>(static_cast<int>(index % 37) - 18) / 64.0f;
  }
  syrnike::voice::RuntimeConfig config;
  config.noise_suppression_enabled = false;
  config.echo_cancellation_enabled = false;
  config.automatic_gain_control_enabled = false;
  config.voice_gate_enabled = true;
  config.voice_gate_auto_threshold = true;
  config.voice_gate_lookahead_ms = 20;

  syrnike::voice::MicrophoneAudioProcessor processor;
  auto warm = processor.processFrame(raw, config, {});
  require(warm.pcm.size() == kSamples, "microphone processor warmup failed");

  syrnike::voice::MicrophoneCaptureFrameAccumulator accumulator(kSamples);
  for (float sample : raw) static_cast<void>(accumulator.push(sample));

  using Queue = syrnike::desktop_native::media::MicrophonePcmQueue<>;
  std::array<Queue, 3> sinks;
  std::array<std::int16_t, kSamples> sink_output{};
  std::array<std::chrono::nanoseconds, kIterations> durations{};
  std::size_t accumulator_allocations = 0;
  std::size_t processor_allocations = 0;
  std::size_t fanout_allocations = 0;

  allocation_count.store(0, std::memory_order_relaxed);
  count_allocations = true;
  for (std::size_t iteration = 0; iteration < kIterations; ++iteration) {
    const auto started = Clock::now();
    const auto before_accumulator = allocation_count.load(std::memory_order_relaxed);
    std::optional<std::span<const float>> accumulated;
    for (float sample : raw) accumulated = accumulator.push(sample);
    require(accumulated.has_value(), "10ms accumulator lost frame cadence");
    const auto after_accumulator = allocation_count.load(std::memory_order_relaxed);
    const auto processed = processor.processFrame(*accumulated, config, {});
    const auto after_processor = allocation_count.load(std::memory_order_relaxed);
    const std::size_t active_sink_count =
        iteration < kIterations / 2 ? 1 : sinks.size();
    for (std::size_t sink_index = 0;
         sink_index < active_sink_count;
         ++sink_index) {
      auto& sink = sinks[sink_index];
      require(
          sink.push(processed.pcm) ==
              syrnike::desktop_native::media::MicrophonePcmQueuePush::Queued,
          "bounded microphone sink queue rejected nominal PCM");
      require(sink.pop(sink_output), "bounded microphone sink queue lost PCM");
    }
    const auto after_fanout = allocation_count.load(std::memory_order_relaxed);
    accumulator_allocations += after_accumulator - before_accumulator;
    processor_allocations += after_processor - after_accumulator;
    fanout_allocations += after_fanout - after_processor;
    durations[iteration] = Clock::now() - started;
  }
  count_allocations = false;

  const auto allocations = allocation_count.load(std::memory_order_acquire);
  if (allocations != 0) {
    std::cerr << "microphone hot-path allocations: total=" << allocations
              << " accumulator=" << accumulator_allocations
              << " processor=" << processor_allocations
              << " fanout=" << fanout_allocations << '\n';
  }
  require(allocations == 0,
          "steady 10ms microphone callback allocated heap storage");
  std::sort(durations.begin(), durations.end());
  const auto p99 = durations[(durations.size() * 99) / 100];
  require(p99 < kP99Budget,
          "steady 10ms microphone callback exceeded its 2ms p99 budget");
  require(std::all_of(sinks.begin(), sinks.end(), [](const auto& sink) {
            return sink.empty() && sink.capacity() == 8;
          }),
          "microphone fan-out did not return fixed queue capacity");

  Queue ownership_queue;
  std::atomic_bool producer_finished{false};
  std::atomic_size_t full_retries{0};
  std::atomic_size_t ordering_failures{0};
  constexpr std::size_t kOwnershipFrames = 20'000;
  std::array<std::int16_t, kSamples> pressure_frame{};
  for (std::size_t sequence = 0; sequence < Queue::capacity(); ++sequence) {
    pressure_frame[0] = static_cast<std::int16_t>(sequence);
    require(
      ownership_queue.push(pressure_frame) ==
        syrnike::desktop_native::media::MicrophonePcmQueuePush::Queued,
      "microphone SPSC queue lost its advertised fixed capacity"
    );
  }
  pressure_frame[0] = static_cast<std::int16_t>(Queue::capacity());
  require(
    ownership_queue.push(pressure_frame) ==
      syrnike::desktop_native::media::MicrophonePcmQueuePush::Full,
    "microphone SPSC queue did not expose bounded overflow"
  );
  full_retries.fetch_add(1, std::memory_order_relaxed);
  std::thread producer([&] {
    std::array<std::int16_t, kSamples> frame{};
    for (std::size_t sequence = Queue::capacity();
         sequence < kOwnershipFrames;
         ++sequence) {
      frame[0] = static_cast<std::int16_t>(sequence % 30'000);
      while (ownership_queue.push(frame) ==
             syrnike::desktop_native::media::MicrophonePcmQueuePush::Full) {
        full_retries.fetch_add(1, std::memory_order_relaxed);
        std::this_thread::yield();
      }
    }
    producer_finished.store(true, std::memory_order_release);
  });
  std::thread consumer([&] {
    std::array<std::int16_t, kSamples> frame{};
    std::size_t expected = 0;
    while (expected < kOwnershipFrames) {
      if (!ownership_queue.pop(frame)) {
        if (producer_finished.load(std::memory_order_acquire) &&
            ownership_queue.empty()) break;
        std::this_thread::yield();
        continue;
      }
      if (frame[0] != static_cast<std::int16_t>(expected % 30'000)) {
        ordering_failures.fetch_add(1, std::memory_order_relaxed);
      }
      ++expected;
    }
    if (expected != kOwnershipFrames) {
      ordering_failures.fetch_add(1, std::memory_order_relaxed);
    }
  });
  producer.join();
  consumer.join();
  require(ordering_failures.load(std::memory_order_acquire) == 0,
          "microphone SPSC handoff crossed producer/consumer ownership");
  require(ownership_queue.empty() && full_retries.load() > 0,
          "microphone SPSC pressure was not bounded and observable");

  using SnapshotDomain =
    syrnike::desktop_native::media::RealtimeSnapshotDomain<RoutingSnapshot>;
  SnapshotDomain routing(
    std::make_unique<const RoutingSnapshot>(0)
  );
  auto routing_reader = routing.claimReader();
  std::atomic_bool routing_started{false};
  std::atomic_bool routing_stop{false};
  std::atomic_size_t routing_errors{0};
  allocation_count.store(0, std::memory_order_relaxed);
  deallocation_count.store(0, std::memory_order_relaxed);
  std::thread realtime_reader([&] {
    count_allocations = true;
    routing_started.store(true, std::memory_order_release);
    while (!routing_stop.load(std::memory_order_acquire)) {
      auto snapshot = routing.acquire(routing_reader);
      if (snapshot.get().owned_payload.size() != 64) {
        routing_errors.fetch_add(1, std::memory_order_relaxed);
      }
    }
    count_allocations = false;
  });
  while (!routing_started.load(std::memory_order_acquire)) {
    std::this_thread::yield();
  }
  for (std::size_t revision = 1; revision <= 2'000; ++revision) {
    routing.publish(std::make_unique<const RoutingSnapshot>(revision));
  }
  routing_stop.store(true, std::memory_order_release);
  realtime_reader.join();
  routing.reclaim();
  require(
    routing_errors.load(std::memory_order_acquire) == 0 &&
      allocation_count.load(std::memory_order_acquire) == 0 &&
      deallocation_count.load(std::memory_order_acquire) == 0,
    "concurrent microphone routing swap allocated or reclaimed on realtime"
  );

  std::cout << "microphone hot path passed: iterations=" << kIterations
            << " logicalMinutes=10 singleSinkFrames=" << kIterations / 2
            << " multiSinkFrames=" << kIterations / 2
            << " allocations=0 p99Us="
            << std::chrono::duration_cast<std::chrono::microseconds>(p99).count()
            << " sinks=" << sinks.size() << " queueCapacity=8"
            << " ownershipFrames=" << kOwnershipFrames
            << " fullRetries=" << full_retries.load() << '\n';
  return 0;
} catch (const std::exception& error) {
  count_allocations = false;
  std::cerr << error.what() << '\n';
  return 1;
}
