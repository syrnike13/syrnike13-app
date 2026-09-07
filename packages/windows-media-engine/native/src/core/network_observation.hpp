#pragma once
#include <cstdint>
#include <optional>
namespace syrnike::windows_media {
struct OutgoingNetworkObservation {
  std::uint64_t measured_at_ms = 0;
  std::optional<std::uint64_t> available_outgoing_bitrate;
  // Current pre-encoded sender allocation, not a network measurement. It is
  // replaced by a newer SDK command and reset with the source generation.
  std::optional<std::uint64_t> sender_bitrate_allocation;
  std::optional<std::uint32_t> packet_send_delay_us;
  std::uint64_t packet_send_delay_measured_at_ms = 0;
};
// Backpressure is based on measured packet queueing, never a bitrate/FPS quota.
// Expired or missing observations cannot indefinitely stop raw admission.
inline bool screenPacketQueueBackpressured(const OutgoingNetworkObservation& value,
                                         std::uint64_t now_ms) noexcept {
  return value.packet_send_delay_us && *value.packet_send_delay_us >= 30'000 &&
      value.packet_send_delay_measured_at_ms > 0 &&
      value.packet_send_delay_measured_at_ms <= now_ms &&
      now_ms - value.packet_send_delay_measured_at_ms <= 250;
}
}
