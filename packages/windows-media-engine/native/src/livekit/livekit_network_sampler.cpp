#include "livekit/livekit_network_sampler.hpp"
#include <livekit/remote_track_publication.h>
#include <livekit/remote_participant.h>
#include <algorithm>
#include <cmath>
#include <string_view>
#include <vector>

namespace syrnike::windows_media {
void LiveKitNetworkSampler::attachRoom(const std::shared_ptr<livekit::Room>& room) {
  std::scoped_lock lock(mutex_);
  subscribed_room_ = room;
  subscribed_tracks_.clear();
  tracks_truncated_ = false;
  inbound_observation_.reset();
  transport_metrics_.reset();
}
void LiveKitNetworkSampler::detachRoom() { attachRoom({}); }
void LiveKitNetworkSampler::onTrackSubscribed(livekit::Room& room, const livekit::TrackSubscribedEvent& event) {
  if (!event.track || !event.publication || !event.participant) return;
  std::scoped_lock lock(mutex_);
  if (subscribed_room_.lock().get() != &room) return;
  const auto id = event.publication->sid();
  const auto found = std::find_if(subscribed_tracks_.begin(), subscribed_tracks_.end(),
      [&](const auto& entry) { return entry.id == id; });
  SubscribedTrack value{id, event.participant->identity(), event.publication->source(), event.track};
  if (found != subscribed_tracks_.end()) *found = std::move(value);
  else if (subscribed_tracks_.size() < 128) subscribed_tracks_.push_back(std::move(value));
  else tracks_truncated_ = true;
}
void LiveKitNetworkSampler::onTrackUnsubscribed(livekit::Room& room, const livekit::TrackUnsubscribedEvent& event) {
  std::scoped_lock lock(mutex_);
  if (subscribed_room_.lock().get() != &room) return;
  std::erase_if(subscribed_tracks_, [&](const auto& entry) { return entry.track == event.track; });
}
void LiveKitNetworkSampler::onTrackUnpublished(livekit::Room& room, const livekit::TrackUnpublishedEvent& event) {
  if (!event.publication) return;
  std::scoped_lock lock(mutex_);
  if (subscribed_room_.lock().get() != &room) return;
  std::erase_if(subscribed_tracks_, [&](const auto& entry) { return entry.id == event.publication->sid(); });
}
void LiveKitNetworkSampler::onParticipantDisconnected(livekit::Room& room,
                                                    const livekit::ParticipantDisconnectedEvent& event) {
  if (!event.participant) return;
  std::scoped_lock lock(mutex_);
  if (subscribed_room_.lock().get() != &room) return;
  std::erase_if(subscribed_tracks_, [&](const auto& entry) { return entry.participant == event.participant->identity(); });
}
InboundNetworkObservation inboundNetworkObservation(
    std::span<const livekit::RtcStats> stats, std::span<const InboundTrackSource> tracks,
    std::uint64_t sampled_at_ms, bool publications_truncated) {
  InboundNetworkObservation result;
  const auto audio_metrics = [&] {
    return std::array<DiagnosticMetric, 16>{{
        {"streams", 0}, {"packets_received", 0}, {"packets_lost", 0},
        {"bytes_received", 0}, {"total_samples_received", 0}, {"jitter_max_ms", 0},
        {"concealed_samples", 0}, {"silent_concealed_samples", 0}, {"concealment_events", 0},
        {"inserted_samples_for_deceleration", 0}, {"removed_samples_for_acceleration", 0},
        {"jitter_buffer_delay", 0}, {"jitter_buffer_emitted_count", 0},
        {"sampled_at_ms", static_cast<double>(sampled_at_ms)}, {"unmapped_streams", 0},
        {"reports_truncated", publications_truncated || stats.size() > 256 ? 1.0 : 0.0},
    }};
  };
  result.microphone = audio_metrics();
  result.screen_audio = audio_metrics();
  result.video = {{
      {"streams", 0}, {"packets_received", 0}, {"packets_lost", 0},
      {"frames_decoded", 0}, {"frames_dropped", 0}, {"freeze_count", 0},
      {"total_freezes_duration", 0}, {"pause_count", 0}, {"total_pause_duration", 0},
      {"jitter_buffer_delay", 0}, {"jitter_buffer_emitted_count", 0},
      {"sampled_at_ms", static_cast<double>(sampled_at_ms)},
      {"reports_truncated", publications_truncated || stats.size() > 256 ? 1.0 : 0.0},
  }};
  const auto add = [](auto& metrics, std::string_view name, double value) {
    const auto metric = std::find_if(metrics.begin(), metrics.end(), [&](const auto& entry) {
      return entry.name == name;
    });
    if (metric != metrics.end() && std::isfinite(value)) metric->value += value;
  };
  const auto maximum = [](auto& metrics, std::string_view name, double value) {
    const auto metric = std::find_if(metrics.begin(), metrics.end(), [&](const auto& entry) {
      return entry.name == name;
    });
    if (metric != metrics.end() && std::isfinite(value)) metric->value = (std::max)(metric->value, value);
  };
  for (const auto& report : stats.first((std::min)(stats.size(), std::size_t{256}))) {
    const auto* value = std::get_if<livekit::RtcInboundRtpStats>(&report.stats);
    if (!value) continue;
    const auto& inbound = value->inbound;
    if (value->stream.kind == "video") {
      auto& metrics = result.video;
      add(metrics, "streams", 1);
      add(metrics, "packets_received", static_cast<double>(value->received.packets_received));
      add(metrics, "packets_lost", static_cast<double>(value->received.packets_lost));
      add(metrics, "frames_decoded", inbound.frames_decoded);
      add(metrics, "frames_dropped", inbound.frames_dropped);
      add(metrics, "freeze_count", inbound.freeze_count);
      add(metrics, "total_freezes_duration", inbound.total_freeze_duration);
      add(metrics, "pause_count", inbound.pause_count);
      add(metrics, "total_pause_duration", inbound.total_pause_duration);
      add(metrics, "jitter_buffer_delay", inbound.jitter_buffer_delay);
      add(metrics, "jitter_buffer_emitted_count", static_cast<double>(inbound.jitter_buffer_emitted_count));
    } else if (value->stream.kind == "audio") {
      const auto track = std::find_if(tracks.begin(), tracks.end(), [&](const auto& entry) {
        return !inbound.track_identifier.empty() && entry.track_id == inbound.track_identifier;
      });
      if (track == tracks.end() ||
          (track->source != livekit::TrackSource::SOURCE_MICROPHONE &&
           track->source != livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO)) {
        add(result.microphone, "unmapped_streams", 1);
        add(result.screen_audio, "unmapped_streams", 1);
        continue;
      }
      auto& metrics = track->source == livekit::TrackSource::SOURCE_MICROPHONE
          ? result.microphone : result.screen_audio;
      add(metrics, "streams", 1);
      add(metrics, "packets_received", static_cast<double>(value->received.packets_received));
      add(metrics, "packets_lost", static_cast<double>(value->received.packets_lost));
      add(metrics, "bytes_received", static_cast<double>(inbound.bytes_received));
      add(metrics, "total_samples_received", static_cast<double>(inbound.total_samples_received));
      maximum(metrics, "jitter_max_ms", value->received.jitter * 1000.0);
      add(metrics, "concealed_samples", static_cast<double>(inbound.concealed_samples));
      add(metrics, "silent_concealed_samples", static_cast<double>(inbound.silent_concealed_samples));
      add(metrics, "concealment_events", static_cast<double>(inbound.concealment_events));
      add(metrics, "inserted_samples_for_deceleration", static_cast<double>(inbound.inserted_samples_for_deceleration));
      add(metrics, "removed_samples_for_acceleration", static_cast<double>(inbound.removed_samples_for_acceleration));
      add(metrics, "jitter_buffer_delay", inbound.jitter_buffer_delay);
      add(metrics, "jitter_buffer_emitted_count", static_cast<double>(inbound.jitter_buffer_emitted_count));
    }
  }
  return result;
}
namespace {
struct PeerTransportTotals {
  bool found = false;
  double bytes_sent = 0, bytes_received = 0, packets_sent = 0, packets_received = 0;
  double rtt_ms = -1, available_outgoing = -1, available_incoming = -1;
};
bool usablePositive(double value) noexcept { return std::isfinite(value) && value > 0 && value < 1e12; }
PeerTransportTotals peerTransportTotals(std::span<const livekit::RtcStats> reports) {
  PeerTransportTotals result;
  std::vector<std::string> selected;
  for (const auto& report : reports)
    if (const auto* value = std::get_if<livekit::RtcTransportStats>(&report.stats)) {
      result.found = true;
      result.bytes_sent += static_cast<double>(value->transport.bytes_sent);
      result.bytes_received += static_cast<double>(value->transport.bytes_received);
      result.packets_sent += static_cast<double>(value->transport.packets_sent);
      result.packets_received += static_cast<double>(value->transport.packets_received);
      if (!value->transport.selected_candidate_pair_id.empty())
        selected.push_back(value->transport.selected_candidate_pair_id);
    }
  const livekit::RtcCandidatePairStats* pair = nullptr;
  for (const auto& report : reports)
    if (const auto* value = std::get_if<livekit::RtcCandidatePairStats>(&report.stats)) {
      const bool is_selected = std::find(selected.begin(), selected.end(), value->rtc.id) != selected.end();
      // Without a transport report fall back to the nominated pair.
      if (is_selected || (!pair && selected.empty() && value->candidate_pair.nominated)) pair = value;
      if (is_selected) break;
    }
  if (pair) {
    const auto& value = pair->candidate_pair;
    if (!result.found) {
      result.found = true;
      result.bytes_sent = static_cast<double>(value.bytes_sent);
      result.bytes_received = static_cast<double>(value.bytes_received);
      result.packets_sent = static_cast<double>(value.packets_sent);
      result.packets_received = static_cast<double>(value.packets_received);
    }
    if (usablePositive(value.current_round_trip_time)) result.rtt_ms = value.current_round_trip_time * 1000.0;
    if (usablePositive(value.available_outgoing_bitrate)) result.available_outgoing = value.available_outgoing_bitrate;
    if (usablePositive(value.available_incoming_bitrate)) result.available_incoming = value.available_incoming_bitrate;
  }
  return result;
}
}  // namespace
TransportNetworkMetrics transportNetworkMetrics(const livekit::SessionStats& stats, std::uint64_t sampled_at_ms) {
  const auto bounded = [](const std::vector<livekit::RtcStats>& reports) {
    return std::span<const livekit::RtcStats>(reports).first((std::min)(reports.size(), std::size_t{256}));
  };
  const auto publisher_reports = bounded(stats.publisher_stats);
  const auto subscriber_reports = bounded(stats.subscriber_stats);
  const auto publisher = peerTransportTotals(publisher_reports);
  const auto subscriber = peerTransportTotals(subscriber_reports);
  double audio_packets_sent = 0, audio_bytes_sent = 0;
  double remote_lost = -1, remote_fraction_lost = -1, remote_rtt_ms = -1, remote_jitter_ms = -1;
  for (const auto& report : publisher_reports) {
    if (const auto* value = std::get_if<livekit::RtcOutboundRtpStats>(&report.stats);
        value && value->stream.kind == "audio") {
      audio_packets_sent += static_cast<double>(value->sent.packets_sent);
      audio_bytes_sent += static_cast<double>(value->sent.bytes_sent);
    } else if (const auto* remote = std::get_if<livekit::RtcRemoteInboundRtpStats>(&report.stats);
               remote && remote->stream.kind == "audio") {
      // Loss/RTT of our outgoing audio as the SFU reported it via RTCP.
      remote_lost = (std::max)(remote_lost, 0.0) + static_cast<double>((std::max)(remote->received.packets_lost, std::int64_t{0}));
      if (std::isfinite(remote->remote_inbound.fraction_lost))
        remote_fraction_lost = (std::max)(remote_fraction_lost, remote->remote_inbound.fraction_lost);
      if (usablePositive(remote->remote_inbound.round_trip_time))
        remote_rtt_ms = (std::max)(remote_rtt_ms, remote->remote_inbound.round_trip_time * 1000.0);
      if (std::isfinite(remote->received.jitter) && remote->received.jitter >= 0)
        remote_jitter_ms = (std::max)(remote_jitter_ms, remote->received.jitter * 1000.0);
    }
  }
  // ICE RTT is the network ping. Prefer the publisher transport (our voice
  // path); subscriber and RTCP RTT cover a listen-only or early session.
  const double ping_ms = publisher.rtt_ms >= 0 ? publisher.rtt_ms
      : subscriber.rtt_ms >= 0 ? subscriber.rtt_ms : remote_rtt_ms;
  const bool any = publisher.found || subscriber.found;
  return {{
      {"sampled_at_ms", static_cast<double>(sampled_at_ms)},
      {"ping_ms", ping_ms},
      {"available_outgoing_bitrate", publisher.available_outgoing},
      {"available_incoming_bitrate", subscriber.available_incoming},
      {"bytes_sent", any ? publisher.bytes_sent + subscriber.bytes_sent : -1},
      {"bytes_received", any ? publisher.bytes_received + subscriber.bytes_received : -1},
      {"packets_sent", any ? publisher.packets_sent + subscriber.packets_sent : -1},
      {"packets_received", any ? publisher.packets_received + subscriber.packets_received : -1},
      {"audio_packets_sent", audio_packets_sent},
      {"audio_bytes_sent", audio_bytes_sent},
      {"audio_remote_packets_lost", remote_lost},
      {"audio_remote_fraction_lost", remote_fraction_lost},
      {"audio_remote_rtt_ms", remote_rtt_ms},
      {"audio_remote_jitter_ms", remote_jitter_ms},
  }};
}
std::optional<TransportNetworkMetrics> LiveKitNetworkSampler::transportSnapshot() const {
  std::scoped_lock lock(mutex_);
  return transport_metrics_;
}
std::optional<InboundNetworkObservation> LiveKitNetworkSampler::inboundSnapshot() const {
  std::scoped_lock lock(mutex_);
  return inbound_observation_;
}
OutgoingNetworkObservation LiveKitNetworkSampler::snapshot() const noexcept {
  std::scoped_lock lock(mutex_);
  return observation_;
}
void LiveKitNetworkSampler::sampleInboundOnSdkLane(
    const std::shared_ptr<livekit::Room>& room, std::uint64_t now) noexcept {
  try {
    if (inbound_requested_room_.lock() != room) {
      pending_inbound_.clear();
      inbound_requested_room_ = room;
      inbound_requested_at_ms_ = 0;
    }
    if (!room) return;
    if (!pending_inbound_.empty()) {
      const bool ready = std::all_of(pending_inbound_.begin(), pending_inbound_.end(), [](const auto& request) {
        return request.stats.wait_for(std::chrono::milliseconds{0}) == std::future_status::ready;
      });
      if (!ready) return;
      std::vector<livekit::RtcStats> reports;
      std::vector<InboundTrackSource> sources;
      bool truncated;
      {
        std::scoped_lock lock(mutex_);
        truncated = tracks_truncated_;
      }
      for (auto& request : pending_inbound_) {
        bool current;
        {
          std::scoped_lock lock(mutex_);
          current = subscribed_room_.lock() == room &&
              std::any_of(subscribed_tracks_.begin(), subscribed_tracks_.end(), [&](const auto& entry) {
                return entry.id == request.source.track_id && entry.track == request.track.lock();
              });
        }
        try {
          auto stats = request.stats.get();
          if (!current) continue;
          sources.push_back(request.source);
          truncated = truncated || stats.size() > 256;
          for (auto& report : std::span(stats).first((std::min)(stats.size(), std::size_t{256}))) {
            if (auto* inbound = std::get_if<livekit::RtcInboundRtpStats>(&report.stats)) {
              // Track::getStats scopes the report to this subscription. Its
              // WebRTC track identifier need not equal the publication SID.
              inbound->inbound.track_identifier = request.source.track_id;
              if (reports.size() < 256) reports.push_back(std::move(report));
              else truncated = true;
            }
          }
        } catch (...) {
          truncated = true;
        }
      }
      pending_inbound_.clear();
      auto observation = inboundNetworkObservation(reports, sources, inbound_requested_at_ms_, truncated);
      std::scoped_lock lock(mutex_);
      if (subscribed_room_.lock() == room) inbound_observation_ = std::move(observation);
    }
    if (pending_inbound_.empty() && now - inbound_requested_at_ms_ >= 2000) {
      std::vector<SubscribedTrack> tracks;
      {
        std::scoped_lock lock(mutex_);
        if (subscribed_room_.lock() != room) return;
        tracks = subscribed_tracks_;
      }
      inbound_requested_at_ms_ = now;
      for (const auto& track : tracks)
        pending_inbound_.push_back({{track.id, track.source}, track.track, track.track->getStats()});
      if (tracks.empty()) {
        auto observation = inboundNetworkObservation({}, {}, now);
        std::scoped_lock lock(mutex_);
        if (subscribed_room_.lock() == room) inbound_observation_ = std::move(observation);
      }
    }
  } catch (...) {
    pending_inbound_.clear();
    inbound_requested_at_ms_ = now;
    std::scoped_lock lock(mutex_);
    inbound_observation_.reset();
  }
}
void LiveKitNetworkSampler::sampleOnSdkLane(
    const std::shared_ptr<livekit::Room>& room) noexcept {
  const auto now = static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now().time_since_epoch()).count());
  // Room::getStats in the pinned SDK can omit inbound RTP reports. Keep
  // subscription-scoped requests independent of the outgoing pressure gate.
  sampleInboundOnSdkLane(room, now);
  try {
    if (pending_ && pending_->wait_for(std::chrono::milliseconds{0}) == std::future_status::ready) {
      const auto stats = pending_->get();
      pending_.reset();
      OutgoingNetworkObservation result;
      std::optional<TransportNetworkMetrics> transport;
      if (room && requested_room_.lock() == room) {
        transport = transportNetworkMetrics(stats, requested_at_ms_);
        if (previous_packet_room_.lock() != room) packet_delay_.reset();
        previous_packet_room_ = room;
        const auto count = (std::min)(stats.publisher_stats.size(), std::size_t{256});
        const livekit::RtcOutboundRtpStats* video = nullptr;
        // Truncation cannot prove that a second video is absent.
        std::size_t videos = stats.publisher_stats.size() > count ? 2 : 0;
        for (std::size_t i = 0; i < count; ++i)
          if (const auto* value = std::get_if<livekit::RtcOutboundRtpStats>(&stats.publisher_stats[i].stats);
              value && value->stream.kind == "video") {
            video = value;
            ++videos;
          }
        // This observation is unambiguous only for one outgoing video stream.
        // Audio and another video's counters must not become screen pressure.
        if (videos == 1 && video) {
          const auto delay = packet_delay_.observe(video->rtc.id, video->sent.packets_sent,
              video->outbound.total_packet_send_delay, requested_at_ms_);
          result.packet_send_delay_us = delay.delay_us;
          result.packet_send_delay_measured_at_ms = delay.measured_at_ms;
        } else {
          packet_delay_.reset();
        }
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
      transport_metrics_ = std::move(transport);
    }
    // getStats collects every peer-connection report on WebRTC's network
    // thread. Sample only as often as the 250 ms packet-delay gate needs,
    // not on every 20 ms SDK lane wake.
    if (!pending_ && room && now - requested_at_ms_ >= 150) {
      requested_at_ms_ = now;
      requested_room_ = room;
      pending_.emplace(room->getStats());
    }
  } catch (...) {
    pending_.reset();
    packet_delay_.reset();
    requested_at_ms_ = now;
    std::scoped_lock lock(mutex_);
    observation_ = {};
    transport_metrics_.reset();
  }
}
}
