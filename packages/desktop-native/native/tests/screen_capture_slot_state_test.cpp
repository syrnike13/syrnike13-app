#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <stdexcept>

#include "media/screen_capture_slot_state.hpp"

namespace {

enum class KeyState {
  Producer,
  Consumer,
  ConsumerHeld,
};

struct FakeKeyedMutex {
  KeyState state = KeyState::Producer;

  bool acquireProducer() noexcept {
    if (state != KeyState::Producer) return false;
    state = KeyState::ConsumerHeld;
    return true;
  }

  bool publishConsumer() noexcept {
    if (state != KeyState::ConsumerHeld) return false;
    state = KeyState::Consumer;
    return true;
  }

  bool acquireConsumer() noexcept {
    if (state != KeyState::Consumer) return false;
    state = KeyState::ConsumerHeld;
    return true;
  }

  bool releaseProducer() noexcept {
    if (state != KeyState::ConsumerHeld) return false;
    state = KeyState::Producer;
    return true;
  }
};

enum class FaultInjectedResult {
  NewFrame,
  EncoderBackpressure,
};

template <std::size_t SlotCount>
FaultInjectedResult processFrame(
    syrnike::desktop_native::media::ScreenGpuSlotState<SlotCount>& slots,
    std::array<FakeKeyedMutex, SlotCount>& mutexes,
    std::uint64_t sequence) {
  for (std::size_t slot = 0; slot < SlotCount; ++slot) {
    slots.retry(
        slot,
        [&] { return mutexes[slot].acquireConsumer(); },
        [&] { return mutexes[slot].releaseProducer(); });
  }
  for (std::size_t slot = 0; slot < SlotCount; ++slot) {
    if (!mutexes[slot].acquireProducer()) continue;
    slots.producerAcquired(slot);
    slots.publish(slot, sequence);
    if (!mutexes[slot].publishConsumer()) {
      throw std::runtime_error("fake producer could not publish consumer key");
    }
    return FaultInjectedResult::NewFrame;
  }
  return FaultInjectedResult::EncoderBackpressure;
}

std::size_t physicallyAvailable(
    std::array<FakeKeyedMutex, 5>& mutexes) noexcept {
  return syrnike::desktop_native::media::
      countScreenGpuAvailableSlots<5>([&](std::size_t slot) {
        if (!mutexes[slot].acquireProducer()) return false;
        return mutexes[slot].releaseProducer();
      });
}

}  // namespace

int main() try {
  using namespace std::chrono_literals;
  using syrnike::desktop_native::media::ScreenGpuSlotState;
  using syrnike::desktop_native::media::ScreenPreviewLeaseState;

  ScreenGpuSlotState<5> gpu_slots;
  std::array<FakeKeyedMutex, 5> mutexes;
  for (std::uint64_t sequence = 1; sequence <= 5; ++sequence) {
    if (processFrame(gpu_slots, mutexes, sequence) !=
        FaultInjectedResult::NewFrame) {
      throw std::runtime_error("failed to fill fault-injected GPU pool");
    }
  }
  if (physicallyAvailable(mutexes) != 0 ||
      processFrame(gpu_slots, mutexes, 6) !=
          FaultInjectedResult::EncoderBackpressure) {
    throw std::runtime_error("full GPU pool did not report backpressure");
  }

  // The encoder holds key 1 while a rejected lease asks discard() to reclaim
  // the same generation. The retry cannot steal the key, so it must remain
  // pending until the encoder returns key 0.
  if (!mutexes[0].acquireConsumer()) {
    throw std::runtime_error("failed to hold keyed mutex consumer ownership");
  }
  const bool discarded = gpu_slots.discard(
      0,
      1,
      [&] { return mutexes[0].acquireConsumer(); },
      [&] { return mutexes[0].releaseProducer(); });
  if (discarded) {
    throw std::runtime_error("discard unexpectedly stole held keyed mutex");
  }
  if (!mutexes[0].releaseProducer()) {
    throw std::runtime_error("encoder failed to return producer key");
  }
  if (physicallyAvailable(mutexes) != 1 ||
      processFrame(gpu_slots, mutexes, 7) != FaultInjectedResult::NewFrame) {
    throw std::runtime_error(
        "pending discard left permanent encoder backpressure");
  }

  // A later unaccepted generation is reclaimed directly and becomes visible
  // to the telemetry probe as one producer-available slot.
  if (!gpu_slots.discard(
          0,
          7,
          [&] { return mutexes[0].acquireConsumer(); },
          [&] { return mutexes[0].releaseProducer(); }) ||
      physicallyAvailable(mutexes) != 1 || gpu_slots.available() != 1) {
    throw std::runtime_error("discard did not return the GPU slot");
  }

  if (!gpu_slots.abandon(1, 2) || gpu_slots.available() != 2 ||
      gpu_slots.abandon(1, 2)) {
    throw std::runtime_error(
        "terminal-device lease abandonment was not generation-safe");
  }

  ScreenPreviewLeaseState<3> preview_slots;
  const auto started = std::chrono::steady_clock::time_point{10s};
  const auto first = preview_slots.reserve(100, started, 0);
  if (!first || *first != 0) {
    throw std::runtime_error("failed to reserve first preview slot");
  }
  std::size_t expired_slot = 3;
  std::size_t expired_count = 0;
  preview_slots.expire(
      started + 10s,
      5s,
      [&](std::size_t slot, std::uint64_t) {
        expired_slot = slot;
        ++expired_count;
      });
  if (expired_slot != 3 || preview_slots.inFlight() != 1) {
    throw std::runtime_error(
        "unfinished GPU preview conversion was expired and reused");
  }
  preview_slots.publishPending(100);
  const auto delivered = preview_slots.takePending();
  if (!delivered || *delivered != 100 || preview_slots.inFlight() != 1) {
    throw std::runtime_error("preview lease was not delivered");
  }
  preview_slots.expire(
      started + 10s,
      5s,
      [&](std::size_t slot, std::uint64_t) {
        expired_slot = slot;
        ++expired_count;
      });
  preview_slots.expire(
      started + 20s,
      5s,
      [&](std::size_t, std::uint64_t) { ++expired_count; });
  if (expired_slot != 0 || expired_count != 1 ||
      preview_slots.inFlight() != 1) {
    throw std::runtime_error(
        "renderer fence timeout made a delivered preview slot reusable");
  }
  const auto replacement = preview_slots.reserve(101, started + 10s, 0);
  if (!replacement || *replacement != 1) {
    throw std::runtime_error(
        "replacement preview reused the renderer-owned allocation");
  }
  if (preview_slots.release(100) != first ||
      preview_slots.release(100).has_value()) {
    throw std::runtime_error(
        "delayed preview fence was not exact and idempotent");
  }
  const auto released_replacement =
      preview_slots.reserve(102, started + 10s, 0);
  if (!released_replacement || *released_replacement != 0) {
    throw std::runtime_error(
        "preview slot did not return after its renderer fence");
  }

  auto now = started;
  int hold_us = 0;
  int release_calls = 0;
  bool downstream_started = false;
  bool released_before_downstream = false;
  {
    syrnike::desktop_native::media::ScreenDxgiFrameLease frame_lease(
        hold_us,
        started,
        [&]() noexcept {
          ++release_calls;
          released_before_downstream = !downstream_started;
          return 0L;
        },
        [&] { return now; });
    now += 2ms;
    if (frame_lease.release() != 0) {
      throw std::runtime_error("fault-injected DXGI release failed");
    }
    downstream_started = true;
    now += 23ms;
  }
  if (hold_us != 2'000 || hold_us >= 5'000 || release_calls != 1 ||
      !released_before_downstream || now - started != 25ms) {
    throw std::runtime_error(
        "DXGI frame lease included post-release NV12/preview work");
  }

  std::cout << "screen GPU slot, preview lease, and DXGI hold tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
