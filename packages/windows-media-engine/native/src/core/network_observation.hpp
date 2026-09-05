#pragma once
#include <cstdint>
#include <optional>
namespace syrnike::windows_media {
struct OutgoingNetworkObservation {
  std::uint64_t measured_at_ms = 0;
  std::optional<std::uint64_t> available_outgoing_bitrate;
};
}
