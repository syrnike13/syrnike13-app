#include "livekit/livekit_network_sampler.hpp"
#include <algorithm>
#include <cmath>

namespace syrnike::windows_media {
OutgoingNetworkObservation LiveKitNetworkSampler::snapshot() const noexcept {
  std::scoped_lock lock(mutex_);
  return observation_;
}
void LiveKitNetworkSampler::sampleOnSdkLane(
    const std::shared_ptr<livekit::Room>& room) noexcept {
  const auto now = static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now().time_since_epoch()).count());
  try {
    if (pending_ && pending_->wait_for(std::chrono::milliseconds{0}) == std::future_status::ready) {
      const auto stats = pending_->get();
      pending_.reset();
      OutgoingNetworkObservation result;
      if (requested_room_.lock() == room) {
        const auto count = (std::min)(stats.publisher_stats.size(), std::size_t{256});
        std::string selected;
        for (std::size_t i = 0; i < count; ++i)
          if (const auto* value = std::get_if<livekit::RtcTransportStats>(&stats.publisher_stats[i].stats)) {
            selected = value->transport.selected_candidate_pair_id;
            if (!selected.empty()) break;
          }
        for (std::size_t i = 0; i < count; ++i)
          if (const auto* value = std::get_if<livekit::RtcCandidatePairStats>(&stats.publisher_stats[i].stats);
              value && !selected.empty() && value->rtc.id == selected) {
            const auto bitrate = value->candidate_pair.available_outgoing_bitrate;
            // Missing fields are zero in this SDK's public value type.
            if (std::isfinite(bitrate) && bitrate > 0 && bitrate < 1e12) {
              result.available_outgoing_bitrate = static_cast<std::uint64_t>(bitrate);
              // A late response must not make an old measurement fresh again.
              result.measured_at_ms = requested_at_ms_;
            }
            break;
          }
      }
      std::scoped_lock lock(mutex_);
      observation_ = result;
    }
    if (!pending_ && room && now - requested_at_ms_ >= 500) {
      requested_at_ms_ = now;
      requested_room_ = room;
      pending_.emplace(room->getStats());
    }
  } catch (...) {
    pending_.reset();
    requested_at_ms_ = now;
    std::scoped_lock lock(mutex_);
    observation_ = {};
  }
}
}
