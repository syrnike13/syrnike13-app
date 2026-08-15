#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace syrnike::desktop_native::tests {

template <std::size_t Capacity>
class ObservedVideoHandoffTable final {
  static_assert(Capacity > 0);

 public:
  void observe(
      std::uint64_t frame_id,
      std::uint64_t timestamp_us) noexcept {
    if (frame_id == 0 || timestamp_us == 0) return;
    const auto ticket = next_ticket_.fetch_add(1, std::memory_order_relaxed) + 1;
    auto& entry = entries_[(ticket - 1) % Capacity];
    entry.published_ticket.store(0, std::memory_order_release);
    entry.frame_id.store(frame_id, std::memory_order_relaxed);
    entry.timestamp_us.store(timestamp_us, std::memory_order_relaxed);
    entry.published_ticket.store(ticket, std::memory_order_release);
  }

  [[nodiscard]] bool claim(
      std::uint64_t frame_id,
      std::uint64_t timestamp_us) noexcept {
    if (frame_id == 0 || timestamp_us == 0 ||
        claimed_.load(std::memory_order_acquire)) {
      return false;
    }
    const auto newest = next_ticket_.load(std::memory_order_acquire);
    const auto available = newest < Capacity ? newest : Capacity;
    for (std::uint64_t offset = 0; offset < available; ++offset) {
      const auto ticket = newest - offset;
      const auto& entry = entries_[(ticket - 1) % Capacity];
      const auto published_before =
          entry.published_ticket.load(std::memory_order_acquire);
      if (published_before != ticket) continue;
      const auto observed_frame_id =
          entry.frame_id.load(std::memory_order_relaxed);
      const auto observed_timestamp_us =
          entry.timestamp_us.load(std::memory_order_relaxed);
      const auto published_after =
          entry.published_ticket.load(std::memory_order_acquire);
      if (published_before != published_after ||
          observed_frame_id != frame_id ||
          observed_timestamp_us != timestamp_us) {
        continue;
      }
      bool expected = false;
      return claimed_.compare_exchange_strong(
          expected,
          true,
          std::memory_order_acq_rel,
          std::memory_order_acquire);
    }
    return false;
  }

 private:
  struct Entry final {
    std::atomic_uint64_t published_ticket{0};
    std::atomic_uint64_t frame_id{0};
    std::atomic_uint64_t timestamp_us{0};
  };

  std::array<Entry, Capacity> entries_{};
  std::atomic_uint64_t next_ticket_{0};
  std::atomic_bool claimed_{false};
};

}  // namespace syrnike::desktop_native::tests
