#pragma once
#include <array>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <span>
#include <livekit/room.h>
#include <livekit/room_delegate.h>
#include "core/engine.hpp"
#include "core/network_observation.hpp"
#include "core/packet_send_delay.hpp"

namespace syrnike::windows_media {
struct InboundTrackSource {
  std::string track_id;
  livekit::TrackSource source;
};
struct InboundNetworkObservation {
  std::array<DiagnosticMetric, 16> microphone{}, screen_audio{};
  std::array<DiagnosticMetric, 13> video{};
};
// Aggregate current subscribed RTP reports, not lifetime counters across track
// replacements. Only exact track identifiers attribute microphone/screen audio.
// SDK delays/durations are cumulative seconds; missing SDK fields read as zero.
// sampled_at_ms is local steady-clock time, not the diagnostic wall-clock time.
InboundNetworkObservation inboundNetworkObservation(
    std::span<const livekit::RtcStats> stats, std::span<const InboundTrackSource> tracks,
    std::uint64_t sampled_at_ms, bool publications_truncated = false);
// Connection-level health for the voice UI (ping, throughput, outgoing loss as
// reported back by the SFU). Missing values are -1; counters are cumulative.
// sampled_at_ms is local steady-clock time and identifies one getStats result.
using TransportNetworkMetrics = std::array<DiagnosticMetric, 14>;
TransportNetworkMetrics transportNetworkMetrics(
    const livekit::SessionStats& stats, std::uint64_t sampled_at_ms);
// One instance per Room transport, surviving all track/profile replacements.
// Sampling runs on the existing SDK lane, without an additional task/thread.
class LiveKitNetworkSampler final : public livekit::RoomDelegate {
 public:
  void attachRoom(const std::shared_ptr<livekit::Room>& room);
  void detachRoom();
  void onTrackSubscribed(livekit::Room&, const livekit::TrackSubscribedEvent&) override;
  void onTrackUnsubscribed(livekit::Room&, const livekit::TrackUnsubscribedEvent&) override;
  void onTrackUnpublished(livekit::Room&, const livekit::TrackUnpublishedEvent&) override;
  void onParticipantDisconnected(livekit::Room&, const livekit::ParticipantDisconnectedEvent&) override;
  void sampleOnSdkLane(const std::shared_ptr<livekit::Room>& room) noexcept;
  [[nodiscard]] OutgoingNetworkObservation snapshot() const noexcept;
  [[nodiscard]] std::optional<InboundNetworkObservation> inboundSnapshot() const;
  [[nodiscard]] std::optional<TransportNetworkMetrics> transportSnapshot() const;
 private:
  struct SubscribedTrack {
    std::string id, participant;
    livekit::TrackSource source;
    std::shared_ptr<livekit::Track> track;
  };
  struct PendingTrackStats {
    InboundTrackSource source;
    std::weak_ptr<livekit::Track> track;
    std::future<std::vector<livekit::RtcStats>> stats;
  };
  void sampleInboundOnSdkLane(const std::shared_ptr<livekit::Room>& room, std::uint64_t now) noexcept;
  mutable std::mutex mutex_;
  OutgoingNetworkObservation observation_;
  std::optional<InboundNetworkObservation> inbound_observation_;
  std::optional<TransportNetworkMetrics> transport_metrics_;
  std::weak_ptr<livekit::Room> subscribed_room_;
  std::vector<SubscribedTrack> subscribed_tracks_;
  bool tracks_truncated_ = false;
  // Only the SDK lane touches inbound futures. Never overlap batches, even
  // if a track stats request does not resolve. Room replacement fences results.
  std::vector<PendingTrackStats> pending_inbound_;
  std::weak_ptr<livekit::Room> inbound_requested_room_;
  std::uint64_t inbound_requested_at_ms_ = 0;
  // Only the SDK lane touches these members. An unresolved future prevents
  // further requests, even across profile replacements or Room disconnects.
  std::optional<std::future<livekit::SessionStats>> pending_;
  std::weak_ptr<livekit::Room> requested_room_;
  std::uint64_t requested_at_ms_ = 0;
  PacketSendDelayEstimator packet_delay_;
  std::weak_ptr<livekit::Room> previous_packet_room_;
};
}
