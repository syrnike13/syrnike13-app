#pragma once
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace syrnike::windows_media {
struct PacketSendDelayObservation {
  std::optional<std::uint32_t> delay_us;
  std::uint64_t measured_at_ms = 0;
};

// One bounded counter history, used only on the Room SDK lane. The caller
// resets it when Room identity changes or video statistics are ambiguous.
class PacketSendDelayEstimator final {
 public:
  void reset() noexcept { previous_.reset(); observation_ = {}; }
  PacketSendDelayObservation observe(std::string_view id, std::uint64_t packets,
                                    double seconds, std::uint64_t time_ms) {
    if (id.empty() || id.size() > 128 || !std::isfinite(seconds) || seconds <= 0 || !time_ms) {
      reset();
      return {};
    }
    const bool same = previous_ && previous_->id == id && time_ms > previous_->time_ms &&
        time_ms - previous_->time_ms <= 2000 && packets >= previous_->packets &&
        seconds >= previous_->seconds;
    if (!same) observation_ = {};
    else if (packets > previous_->packets) {
      observation_ = {};
      const double delay = (seconds - previous_->seconds) * 1e6 /
          static_cast<double>(packets - previous_->packets);
      if (std::isfinite(delay) && delay >= 0 && delay <= 60'000'000)
        observation_ = {static_cast<std::uint32_t>(delay), time_ms};
    } else if (seconds != previous_->seconds) {
      observation_ = {};
    }
    // Identical counters are not a new measurement. Keep its original time
    // so the raw gate expires normally even if no more packets are sent.
    previous_ = Counter{std::string(id), packets, seconds, time_ms};
    return observation_;
  }
 private:
  struct Counter { std::string id; std::uint64_t packets; double seconds; std::uint64_t time_ms; };
  std::optional<Counter> previous_;
  PacketSendDelayObservation observation_;
};
}
