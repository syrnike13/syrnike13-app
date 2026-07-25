#pragma once

#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <utility>

namespace syrnike::desktop_native::media {

template <std::size_t SlotCount, typename ProbeSlot>
std::size_t countScreenGpuAvailableSlots(ProbeSlot&& probe_slot) noexcept {
  std::size_t available = 0;
  for (std::size_t slot = 0; slot < SlotCount; ++slot) {
    if (probe_slot(slot)) ++available;
  }
  return available;
}

// Tracks the ownership generation independently from IDXGIKeyedMutex. The
// keyed mutex remains the synchronization authority; this state makes retry
// decisions generation-safe and exposes the number of slots available to the
// producer without probing or consuming a mutex key.
template <std::size_t SlotCount>
class ScreenGpuSlotState final {
 public:
  static_assert(SlotCount > 0);

  [[nodiscard]] constexpr std::size_t total() const noexcept {
    return SlotCount;
  }

  [[nodiscard]] std::size_t available() const noexcept {
    return available_.load(std::memory_order_acquire);
  }

  [[nodiscard]] std::uint64_t sequence(std::size_t slot) const noexcept {
    return slots_[slot].sequence.load(std::memory_order_acquire);
  }

  void producerAcquired(std::size_t slot) noexcept {
    auto& state = slots_[slot];
    if (state.sequence.exchange(0, std::memory_order_acq_rel) != 0) {
      available_.fetch_add(1, std::memory_order_acq_rel);
    }
    state.pending_discard_sequence.store(0, std::memory_order_release);
  }

  void publish(std::size_t slot, std::uint64_t sequence) noexcept {
    slots_[slot].sequence.store(sequence, std::memory_order_release);
    slots_[slot].pending_discard_sequence.store(0, std::memory_order_release);
    available_.fetch_sub(1, std::memory_order_acq_rel);
  }

  void cancelPublish(std::size_t slot, std::uint64_t sequence) noexcept {
    auto expected = sequence;
    if (slots_[slot].sequence.compare_exchange_strong(
            expected, 0, std::memory_order_acq_rel)) {
      available_.fetch_add(1, std::memory_order_acq_rel);
    }
  }

  template <typename TryAcquireConsumer, typename ReleaseProducer>
  bool discard(
      std::size_t slot,
      std::uint64_t sequence,
      TryAcquireConsumer&& try_acquire_consumer,
      ReleaseProducer&& release_producer) noexcept {
    auto& state = slots_[slot];
    if (sequence == 0 ||
        state.sequence.load(std::memory_order_acquire) != sequence) {
      return false;
    }
    if (!try_acquire_consumer()) {
      if (state.sequence.load(std::memory_order_acquire) == sequence) {
        state.pending_discard_sequence.store(
            sequence, std::memory_order_release);
      }
      return false;
    }
    return reclaim(
        state, sequence, static_cast<ReleaseProducer&&>(release_producer));
  }

  template <typename TryAcquireConsumer, typename ReleaseProducer>
  bool retry(
      std::size_t slot,
      TryAcquireConsumer&& try_acquire_consumer,
      ReleaseProducer&& release_producer) noexcept {
    auto& state = slots_[slot];
    auto pending =
        state.pending_discard_sequence.load(std::memory_order_acquire);
    if (pending == 0) return false;
    if (state.sequence.load(std::memory_order_acquire) != pending) {
      state.pending_discard_sequence.compare_exchange_strong(
          pending, 0, std::memory_order_acq_rel);
      return false;
    }
    if (!try_acquire_consumer()) return false;
    return reclaim(
        state, pending, static_cast<ReleaseProducer&&>(release_producer));
  }

 private:
  struct Slot {
    std::atomic<std::uint64_t> sequence{0};
    std::atomic<std::uint64_t> pending_discard_sequence{0};
  };

  template <typename ReleaseProducer>
  bool reclaim(
      Slot& state,
      std::uint64_t sequence,
      ReleaseProducer&& release_producer) noexcept {
    auto expected = sequence;
    if (!state.sequence.compare_exchange_strong(
            expected, 0, std::memory_order_acq_rel)) {
      release_producer();
      return false;
    }
    state.pending_discard_sequence.store(0, std::memory_order_release);
    available_.fetch_add(1, std::memory_order_acq_rel);
    if (!release_producer()) {
      expected = 0;
      if (state.sequence.compare_exchange_strong(
              expected, sequence, std::memory_order_acq_rel)) {
        state.pending_discard_sequence.store(
            sequence, std::memory_order_release);
        available_.fetch_sub(1, std::memory_order_acq_rel);
      }
      return false;
    }
    return true;
  }

  std::array<Slot, SlotCount> slots_;
  std::atomic<std::size_t> available_{SlotCount};
};

template <std::size_t SlotCount>
class ScreenPreviewLeaseState final {
 public:
  using TimePoint = std::chrono::steady_clock::time_point;

  [[nodiscard]] std::optional<std::size_t> reserve(
      std::uint64_t sequence,
      TimePoint now,
      std::size_t first_slot) noexcept {
    for (std::size_t attempt = 0; attempt < SlotCount; ++attempt) {
      const auto slot = (first_slot + attempt) % SlotCount;
      if (slots_[slot].occupied) continue;
      slots_[slot] = {sequence, now, true};
      return slot;
    }
    return std::nullopt;
  }

  void publishPending(std::uint64_t sequence) noexcept {
    pending_sequence_ = sequence;
  }

  [[nodiscard]] std::optional<std::uint64_t> takePending() noexcept {
    return std::exchange(pending_sequence_, std::nullopt);
  }

  [[nodiscard]] std::optional<std::uint64_t> pending() const noexcept {
    return pending_sequence_;
  }

  [[nodiscard]] bool occupied(std::size_t slot) const noexcept {
    return slots_[slot].occupied;
  }

  [[nodiscard]] std::uint64_t sequence(std::size_t slot) const noexcept {
    return slots_[slot].sequence;
  }

  [[nodiscard]] std::size_t inFlight() const noexcept {
    std::size_t count = 0;
    for (const auto& slot : slots_) {
      if (slot.occupied) ++count;
    }
    return count;
  }

  [[nodiscard]] std::optional<std::size_t> release(
      std::uint64_t sequence) noexcept {
    for (std::size_t slot = 0; slot < SlotCount; ++slot) {
      if (!slots_[slot].occupied || slots_[slot].sequence != sequence) continue;
      clear(slot);
      return slot;
    }
    return std::nullopt;
  }

  template <typename OnExpired>
  void expire(
      TimePoint now,
      std::chrono::steady_clock::duration timeout,
      OnExpired&& on_expired) noexcept {
    for (std::size_t slot = 0; slot < SlotCount; ++slot) {
      const auto& state = slots_[slot];
      if (!state.occupied || state.leased_at == TimePoint{} ||
          now - state.leased_at < timeout) {
        continue;
      }
      const auto sequence = state.sequence;
      clear(slot);
      on_expired(slot, sequence);
    }
  }

 private:
  struct Slot {
    std::uint64_t sequence = 0;
    TimePoint leased_at{};
    bool occupied = false;
  };

  void clear(std::size_t slot) noexcept {
    if (pending_sequence_ == slots_[slot].sequence) pending_sequence_.reset();
    slots_[slot] = {};
  }

  std::array<Slot, SlotCount> slots_;
  std::optional<std::uint64_t> pending_sequence_;
};

inline int screenCaptureDurationMicros(
    std::chrono::steady_clock::time_point started_at,
    std::chrono::steady_clock::time_point finished_at) noexcept {
  const auto micros = std::chrono::duration_cast<std::chrono::microseconds>(
      finished_at - started_at).count();
  return micros <= 0
      ? 0
      : static_cast<int>(micros > std::numeric_limits<int>::max()
            ? std::numeric_limits<int>::max()
            : micros);
}

template <typename ReleaseFrame, typename Now>
class ScreenDxgiFrameLease final {
 public:
  ScreenDxgiFrameLease(
      int& hold_metric_us,
      std::chrono::steady_clock::time_point acquired_at,
      ReleaseFrame release_frame,
      Now now)
      : hold_metric_us_(hold_metric_us),
        acquired_at_(acquired_at),
        release_frame_(static_cast<ReleaseFrame&&>(release_frame)),
        now_(static_cast<Now&&>(now)) {}

  ScreenDxgiFrameLease(const ScreenDxgiFrameLease&) = delete;
  ScreenDxgiFrameLease& operator=(const ScreenDxgiFrameLease&) = delete;

  ~ScreenDxgiFrameLease() {
    if (!released_) static_cast<void>(release());
  }

  long release() noexcept {
    if (released_) return 0;
    const long result = release_frame_();
    hold_metric_us_ = screenCaptureDurationMicros(acquired_at_, now_());
    released_ = true;
    return result;
  }

  [[nodiscard]] bool released() const noexcept { return released_; }

 private:
  int& hold_metric_us_;
  std::chrono::steady_clock::time_point acquired_at_;
  ReleaseFrame release_frame_;
  Now now_;
  bool released_ = false;
};

}  // namespace syrnike::desktop_native::media
