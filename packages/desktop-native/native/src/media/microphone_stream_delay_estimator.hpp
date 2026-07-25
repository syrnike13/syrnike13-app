#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>

namespace syrnike::voice {

struct MicrophoneStreamTimingSample {
  std::uint64_t capture_device_position = 0;
  std::uint64_t capture_qpc_100ns = 0;
  std::uint64_t render_device_position = 0;
  std::uint64_t render_qpc_100ns = 0;
  int capture_latency_ms = 0;
  int render_latency_ms = 0;
};

class MicrophoneStreamDelayEstimator final {
 public:
  int update(const MicrophoneStreamTimingSample& sample) {
    if (previous_) {
      const auto capture_clock_error = clockProgressErrorMs(
        previous_->capture_device_position,
        previous_->capture_qpc_100ns,
        sample.capture_device_position,
        sample.capture_qpc_100ns
      );
      const auto render_clock_error = clockProgressErrorMs(
        previous_->render_device_position,
        previous_->render_qpc_100ns,
        sample.render_device_position,
        sample.render_qpc_100ns
      );
      if (capture_clock_error > kClockDiscontinuityMs ||
          render_clock_error > kClockDiscontinuityMs) {
        smoothed_delay_ms_.reset();
      }
    }
    previous_ = sample;

    const auto qpc_delta_ms = static_cast<double>(
      static_cast<std::int64_t>(sample.capture_qpc_100ns) -
      static_cast<std::int64_t>(sample.render_qpc_100ns)
    ) / 10'000.0;
    const auto measured = std::clamp(
      static_cast<double>(
        sample.capture_latency_ms + sample.render_latency_ms
      ) + qpc_delta_ms,
      0.0,
      500.0
    );
    if (!smoothed_delay_ms_) {
      smoothed_delay_ms_ = measured;
    } else {
      *smoothed_delay_ms_ =
        *smoothed_delay_ms_ * 0.8 + measured * 0.2;
    }
    return static_cast<int>(std::lround(*smoothed_delay_ms_));
  }

  void reset() noexcept {
    previous_.reset();
    smoothed_delay_ms_.reset();
  }

 private:
  static constexpr double kSamplesPerMs = 48.0;
  static constexpr double kClockDiscontinuityMs = 100.0;

  static double clockProgressErrorMs(
    std::uint64_t previous_position,
    std::uint64_t previous_qpc,
    std::uint64_t position,
    std::uint64_t qpc
  ) {
    if (position < previous_position || qpc < previous_qpc) {
      return kClockDiscontinuityMs + 1.0;
    }
    const auto device_elapsed_ms =
      static_cast<double>(position - previous_position) / kSamplesPerMs;
    const auto qpc_elapsed_ms =
      static_cast<double>(qpc - previous_qpc) / 10'000.0;
    return std::abs(device_elapsed_ms - qpc_elapsed_ms);
  }

  std::optional<MicrophoneStreamTimingSample> previous_;
  std::optional<double> smoothed_delay_ms_;
};

}  // namespace syrnike::voice
