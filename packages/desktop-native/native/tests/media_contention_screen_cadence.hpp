#pragma once

#include <cstdint>

namespace syrnike::desktop_native::tests {

struct ContentionScreenCadence final {
  double total_fps = 0;
  double ordinary_fps = 0;
};

class ContentionRecoveryIntervals final {
 public:
  [[nodiscard]] bool record(double started_ms, double completed_ms) noexcept {
    if (started_ms < 0 || completed_ms < started_ms) return false;
    const auto duration_ms = completed_ms - started_ms;
    if (duration_ms > maximum_ms_) maximum_ms_ = duration_ms;
    if (!has_interval_) {
      has_interval_ = true;
      covered_through_ms_ = completed_ms;
      total_ms_ = duration_ms;
      return true;
    }
    if (started_ms >= covered_through_ms_) {
      total_ms_ += duration_ms;
    } else if (completed_ms > covered_through_ms_) {
      total_ms_ += completed_ms - covered_through_ms_;
    }
    if (completed_ms > covered_through_ms_) {
      covered_through_ms_ = completed_ms;
    }
    return true;
  }

  [[nodiscard]] double totalMs() const noexcept { return total_ms_; }
  [[nodiscard]] double maximumMs() const noexcept { return maximum_ms_; }

 private:
  bool has_interval_ = false;
  double covered_through_ms_ = 0;
  double total_ms_ = 0;
  double maximum_ms_ = 0;
};

[[nodiscard]] constexpr ContentionScreenCadence contentionScreenCadence(
    std::uint64_t frames,
    double elapsed_ms,
    double injected_recovery_ms) noexcept {
  const auto bounded_recovery_ms = injected_recovery_ms < 0
      ? 0
      : injected_recovery_ms > elapsed_ms ? elapsed_ms : injected_recovery_ms;
  const auto ordinary_elapsed_ms = elapsed_ms - bounded_recovery_ms;
  return {
      elapsed_ms > 0 ? frames * 1'000.0 / elapsed_ms : 0,
      ordinary_elapsed_ms > 0
          ? frames * 1'000.0 / ordinary_elapsed_ms
          : 0,
  };
}

}  // namespace syrnike::desktop_native::tests
