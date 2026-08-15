#pragma once

#include <atomic>
#include <cstddef>

namespace syrnike::desktop_native::tests {

class ContentionPublicationTeardownGate final {
 public:
  void beginPublication() noexcept {
    publications_in_flight_.fetch_add(1, std::memory_order_acq_rel);
  }

  void finishPublication() noexcept {
    publications_in_flight_.fetch_sub(1, std::memory_order_acq_rel);
  }

  void handoffPublicationToCallback() noexcept {
    callbacks_in_flight_.fetch_add(1, std::memory_order_acq_rel);
    publications_in_flight_.fetch_sub(1, std::memory_order_acq_rel);
  }

  void beginCallback() noexcept {
    callbacks_in_flight_.fetch_add(1, std::memory_order_acq_rel);
  }

  void finishCallback() noexcept {
    callbacks_in_flight_.fetch_sub(1, std::memory_order_acq_rel);
  }

  [[nodiscard]] std::size_t pending(bool screen_start_acknowledged) const
      noexcept {
    return callbacks_in_flight_.load(std::memory_order_acquire) +
        publications_in_flight_.load(std::memory_order_acquire) +
        static_cast<std::size_t>(!screen_start_acknowledged);
  }

  [[nodiscard]] bool readyToShutdown(bool screen_start_acknowledged) const
      noexcept {
    return pending(screen_start_acknowledged) == 0;
  }

 private:
  std::atomic_size_t publications_in_flight_{0};
  std::atomic_size_t callbacks_in_flight_{0};
};

}  // namespace syrnike::desktop_native::tests
