#include "audio/remote_audio_tracks.hpp"

#include <livekit/fresh_audio_stream.h>
#include <algorithm>
#include <cmath>
#include <exception>
#include <stdexcept>
#ifdef WINDOWS_MEDIA_REMOTE_AUDIO_PROBE
#include "lab/remote_audio_probe.hpp"
#endif

namespace syrnike::windows_media::audio {
namespace {
using Clock = std::chrono::steady_clock;
bool validIdentity(std::string_view value) {
  return !value.empty() && value.size() <= 256 &&
      std::all_of(value.begin(), value.end(), [](unsigned char ch) { return ch >= 0x21 && ch <= 0x7e; });
}
bool supported(const livekit::RemoteTrackPublication& publication) {
  const auto source = publication.source();
  return (publication.kind() == livekit::TrackKind::KIND_AUDIO &&
          (source == livekit::TrackSource::SOURCE_MICROPHONE ||
           source == livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO)) ||
      (publication.kind() == livekit::TrackKind::KIND_VIDEO &&
       source == livekit::TrackSource::SOURCE_SCREENSHARE);
}
}  // namespace
RemoteAudioTracks::RemoteAudioTracks(RemoteAudioMixerWorker& mixer)
    : mixer_(mixer), worker_([this] { run(); }) {}
RemoteAudioTracks::~RemoteAudioTracks() { stop(); }
void RemoteAudioTracks::retire(Publication& value) {
  if (value.port) value.port->retire();
  value.port.reset();
  value.track.reset();
}
void RemoteAudioTracks::clearRoom() {
  for (auto& value : publications_) {
    retire(value);
    value = {};
  }
  connected_ = false;
  ++revision_;
  changed_.notify_all();
}
bool RemoteAudioTracks::attachRoom(const std::shared_ptr<livekit::Room>& room) {
  if (!room || !detachRoom()) return false;
  std::scoped_lock lock(mutex_);
  if (stopping_ || done_) return false;
  room_ = room;
  return true;
}
bool RemoteAudioTracks::detachRoom() {
  std::unique_lock lock(mutex_);
  clearRoom();
  room_.reset();
  const auto revision = revision_;
  return changed_.wait_for(lock, std::chrono::seconds{5}, [&] {
    return acknowledged_ >= revision || done_;
  }) && !failed_;
}
bool RemoteAudioTracks::seedConnectedRoom() {
  for (unsigned attempt = 0; attempt < 5; ++attempt) {
    std::shared_ptr<livekit::Room> room;
    std::uint64_t revision;
    {
      std::scoped_lock lock(mutex_);
      if (!room_ || stopping_ || done_) return false;
      room = room_;
      revision = revision_;
    }
    const auto snapshot = room->remotePublications(kPublicationCapacity);
    const auto connected = room->connectionState() == livekit::ConnectionState::Connected;
    std::scoped_lock lock(mutex_);
    if (room_ != room || stopping_ || done_) return false;
    if (revision_ != revision) continue;
    if (!connected) return false;
    connected_ = true;
    if (snapshot.truncated) ++rejected_;
    for (const auto& entry : snapshot.entries)
      if (entry.participant) addPublication(entry.participant->identity(), entry.publication);
    ++revision_;
    changed_.notify_all();
    return true;
  }
  return false;
}
void RemoteAudioTracks::stop() {
  {
    std::unique_lock lock(mutex_);
    clearRoom();
    room_.reset();
    stopping_ = true;
    changed_.notify_all();
    // The SDK offers no cancellable sink destructor. A stuck native teardown
    // cannot outlive this owner or turn shutdown into an unbounded wait; the
    // existing utility-process boundary contains that terminal failure.
    if (!changed_.wait_for(lock, std::chrono::seconds{5}, [&] { return done_; })) std::terminate();
  }
  if (worker_.joinable()) worker_.join();
}
bool RemoteAudioTracks::setScreenDemand(std::span<const RemoteVideoDemand> demand) {
  if (demand.size() > demand_.size()) return false;
  for (const auto& value : demand)
    if (!validIdentity(value.participant_identity) || !validIdentity(value.publication_id)) return false;
  std::scoped_lock lock(mutex_);
  if (stopping_ || done_) return false;
  std::copy(demand.begin(), demand.end(), demand_.begin());
  for (auto index = demand.size(); index < demand_count_; ++index) demand_[index] = {};
  demand_count_ = demand.size();
  // Revoke PCM immediately; the SDK operation follows on the owner thread.
  for (auto& value : publications_)
    if (!desired(value) && value.port) {
      value.port->retire();
      value.port.reset();
    }
  ++revision_;
  changed_.notify_all();
  return true;
}
bool RemoteAudioTracks::setUserVolume(std::string_view participant, float volume, bool muted) {
  if (!validIdentity(participant) || !std::isfinite(volume) || volume < 0 || volume > 2) return false;
  std::scoped_lock lock(mutex_);
  if (stopping_ || done_) return false;
  auto found = std::find_if(users_.begin(), users_.end(), [&](const auto& user) {
    return user.participant == participant;
  });
  if (found == users_.end())
    found = std::find_if(users_.begin(), users_.end(), [](const auto& user) { return user.participant.empty(); });
  if (found == users_.end()) return false;
  *found = {std::string(participant), volume, muted};
  ++revision_;
  changed_.notify_all();
  return true;
}
void RemoteAudioTracks::setDeafened(bool enabled) {
  std::scoped_lock lock(mutex_);
  deafened_ = enabled;
  ++revision_;
  changed_.notify_all();
}
bool RemoteAudioTracks::desired(const Publication& value) const {
  if (!connected_ || !value.publication || value.failed) return false;
  if (value.publication->source() == livekit::TrackSource::SOURCE_MICROPHONE) return true;
  if (value.publication->source() != livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO) return false;
  // Product has one screen share per canonical participant. Require the exact
  // current video publication too; a camera or an old screen SID cannot match.
  for (std::size_t index = 0; index < demand_count_; ++index) {
    const auto& demand = demand_[index];
    if (demand.participant_identity != value.participant) continue;
    for (const auto& video : publications_)
      if (video.participant == value.participant && video.publication &&
          video.publication->source() == livekit::TrackSource::SOURCE_SCREENSHARE &&
          video.publication->sid() == demand.publication_id) return true;
  }
  return false;
}
void RemoteAudioTracks::onConnectionStateChanged(
    livekit::Room& room, const livekit::ConnectionStateChangedEvent& event) {
  std::scoped_lock lock(mutex_);
  if (room_.get() != &room || stopping_) return;
  connected_ = event.state == livekit::ConnectionState::Connected;
  if (event.state == livekit::ConnectionState::Disconnected) clearRoom();
  else {
    if (!connected_) for (auto& value : publications_) {
      if (value.port) value.port->retire();
      value.port.reset();
    }
    ++revision_;
    changed_.notify_all();
  }
}
void RemoteAudioTracks::onTrackPublished(livekit::Room& room, const livekit::TrackPublishedEvent& event) {
  if (!event.participant) return;
  std::scoped_lock lock(mutex_);
  if (room_.get() != &room || stopping_) return;
  // Initial publication callbacks may precede the connected-state callback.
  connected_ = room.connectionState() == livekit::ConnectionState::Connected;
  addPublication(event.participant->identity(), event.publication);
  ++revision_;
  changed_.notify_all();
}
void RemoteAudioTracks::addPublication(
    std::string_view participant, const std::shared_ptr<livekit::RemoteTrackPublication>& publication) {
  if (!publication || !validIdentity(participant) || !validIdentity(publication->sid()) || !supported(*publication)) {
    ++rejected_;
    return;
  }
  for (const auto& value : publications_) {
    if (value.publication == publication) return;
    if (value.publication && value.publication->sid() == publication->sid()) {
      ++rejected_;
      return;
    }
  }
  const auto found = std::find_if(publications_.begin(), publications_.end(),
                                 [](const auto& value) { return !value.publication; });
  const auto audio_count = std::count_if(publications_.begin(), publications_.end(), [](const auto& value) {
    return value.publication && value.publication->kind() == livekit::TrackKind::KIND_AUDIO;
  });
  if (found == publications_.end() ||
      (publication->kind() == livekit::TrackKind::KIND_AUDIO && audio_count >= kRemoteAudioTrackCapacity)) {
    ++rejected_;
    return;
  }
  found->participant = participant;
  found->publication = publication;
  found->generation = ++next_generation_;
}
void RemoteAudioTracks::onTrackUnpublished(livekit::Room& room, const livekit::TrackUnpublishedEvent& event) {
  std::scoped_lock lock(mutex_);
  if (room_.get() != &room || stopping_ || !event.participant) return;
  for (auto& value : publications_)
    if (value.publication == event.publication && value.participant == event.participant->identity()) {
      retire(value);
      value = {};
    }
  for (auto& value : publications_) if (!desired(value)) retire(value);
  ++revision_;
  changed_.notify_all();
}
void RemoteAudioTracks::onTrackSubscribed(livekit::Room& room, const livekit::TrackSubscribedEvent& event) {
  std::scoped_lock lock(mutex_);
  if (room_.get() != &room || stopping_ || !event.participant || !event.track || !event.publication) return;
  for (auto& value : publications_)
    if (value.publication == event.publication && value.participant == event.participant->identity() &&
        event.track->sid() == value.publication->sid() &&
        event.track->kind() == livekit::TrackKind::KIND_AUDIO && desired(value)) {
      if (value.track == event.track) return;
      retire(value);
      value.track = event.track;
      value.generation = ++next_generation_;
      ++revision_;
      changed_.notify_all();
      return;
    }
  ++rejected_;
}
void RemoteAudioTracks::onTrackUnsubscribed(livekit::Room& room, const livekit::TrackUnsubscribedEvent& event) {
  std::scoped_lock lock(mutex_);
  if (room_.get() != &room || stopping_ || !event.participant) return;
  for (auto& value : publications_)
    if (value.publication == event.publication && value.track == event.track &&
        value.participant == event.participant->identity()) retire(value);
  ++revision_;
  changed_.notify_all();
}
void RemoteAudioTracks::onTrackSubscriptionFailed(
    livekit::Room& room, const livekit::TrackSubscriptionFailedEvent& event) {
  std::scoped_lock lock(mutex_);
  if (room_.get() != &room || stopping_ || !event.participant) return;
  for (auto& value : publications_)
    if (value.publication && value.publication->sid() == event.track_sid &&
        value.participant == event.participant->identity()) {
      retire(value);
      value.failed = true;
      ++track_failures_;
    }
  ++revision_;
  changed_.notify_all();
}
void RemoteAudioTracks::onParticipantDisconnected(
    livekit::Room& room, const livekit::ParticipantDisconnectedEvent& event) {
  std::scoped_lock lock(mutex_);
  if (room_.get() != &room || stopping_ || !event.participant) return;
  for (auto& value : publications_)
    if (value.participant == event.participant->identity()) {
      retire(value);
      value = {};
    }
  ++revision_;
  changed_.notify_all();
}
RemoteAudioTracksStats RemoteAudioTracks::stats() const noexcept {
  return {decoded_.load(), rejected_.load(), track_failures_.load(), reading_.load(), failed_.load(),
          sdk_dropped_.load(), sdk_stale_.load(), maximum_sdk_queue_.load(), maximum_app_queue_.load()};
}
void RemoteAudioTracks::run() noexcept {
  struct Reader {
    std::shared_ptr<livekit::RemoteTrackPublication> publication;
    std::shared_ptr<livekit::Track> track;
    std::shared_ptr<RemoteAudioPcmPort> port;
    std::unique_ptr<livekit::FreshAudioStream> stream;
    std::uint64_t generation = 0;
    bool subscribed = false;
    std::uint64_t observed_dropped = 0, observed_stale = 0;
  };
  std::array<Reader, kPublicationCapacity> readers{};
  std::uint64_t applied = 0;
  const auto release = [](Reader& reader) {
    if (reader.port) reader.port->retire();
    reader.stream.reset();
    reader.track.reset();
    reader.port.reset();
    reader.observed_dropped = reader.observed_stale = 0;
  };
  try {
    while (true) {
      std::array<Publication, kPublicationCapacity> snapshot;
      std::array<UserControl, kUserCapacity> controls;
      std::array<bool, kPublicationCapacity> wanted{};
      std::uint64_t revision;
      bool deafened;
      {
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, std::chrono::milliseconds{5}, [&] { return stopping_ || revision_ != applied; });
        if (stopping_) break;
        revision = revision_;
        snapshot = publications_;
        controls = users_;
        deafened = deafened_;
        for (std::size_t index = 0; index < snapshot.size(); ++index) wanted[index] = desired(snapshot[index]);
      }
#ifdef WINDOWS_MEDIA_REMOTE_AUDIO_PROBE
      if (const auto delay = (std::min)(lab::decoded_reader_delay_ms.exchange(0), std::uint32_t{1500}); delay) {
        std::unique_lock lock(mutex_);
        if (changed_.wait_for(lock, std::chrono::milliseconds{delay}, [&] { return stopping_; })) break;
      }
#endif
      if (revision != applied) {
        std::array<RemoteAudioInput, kRemoteAudioTrackCapacity> inputs{};
        std::size_t count = 0;
        for (std::size_t index = 0; index < readers.size(); ++index) {
          auto& reader = readers[index];
          const auto& value = snapshot[index];
          if (reader.generation != value.generation || reader.track != value.track || !wanted[index] ||
              (reader.port && !reader.port->active())) release(reader);
          try {
            if (reader.publication != value.publication) {
              // Removed publications are already detached by the SDK. Never
              // send an operation through an old Room's publication handle.
              reader.publication = value.publication;
              reader.subscribed = false;
            }
            if (reader.publication && reader.subscribed != wanted[index] &&
                reader.publication->kind() == livekit::TrackKind::KIND_AUDIO) {
              reader.publication->setSubscribed(wanted[index]);
              reader.subscribed = wanted[index];
            }
            reader.generation = value.generation;
            if (wanted[index] && value.track && !reader.stream) {
              reader.track = value.track;
              reader.stream = std::make_unique<livekit::FreshAudioStream>(value.track);
              reader.port = std::make_shared<RemoteAudioPcmPort>(value.generation, 2);
              bool accepted = false;
              {
                std::scoped_lock lock(mutex_);
                auto& current = publications_[index];
                accepted = current.generation == value.generation && current.track == value.track && desired(current);
                if (accepted) current.port = reader.port;
              }
              if (!accepted) release(reader);
            }
          } catch (...) {
            release(reader);
            std::scoped_lock lock(mutex_);
            if (publications_[index].generation == value.generation) {
              publications_[index].failed = true;
              retire(publications_[index]);
              ++revision_;
            }
            ++track_failures_;
          }
          if (!reader.port) continue;
          float volume = 1;
          bool muted = false;
          for (const auto& control : controls)
            if (control.participant == value.participant) {
              volume = control.volume;
              muted = control.muted;
              break;
            }
          inputs[count++] = {reader.port, volume, muted};
        }
        if (!mixer_.configure(std::span(inputs.data(), count), deafened)) throw std::runtime_error("Audio mixer retired");
        reading_ = static_cast<std::uint32_t>(count);
        applied = revision;
        {
          std::scoped_lock lock(mutex_);
          acknowledged_ = revision;
        }
        changed_.notify_all();
      }
      for (std::size_t reader_index = 0; reader_index < readers.size(); ++reader_index) {
        auto& reader = readers[reader_index];
        if (!reader.stream || !reader.port || !reader.port->active()) continue;
        // A scheduling gap never creates catch-up debt: read at most the SDK's
        // four-frame capacity, with original timestamps and its 60 ms age gate.
        for (std::size_t index = 0; index < kRemoteAudioQueueCapacity; ++index) {
          livekit::FreshAudioFrame decoded;
          const auto result = reader.stream->tryRead(decoded);
          const auto sdk_stats = reader.stream->stats();
          sdk_dropped_.fetch_add(sdk_stats.dropped - reader.observed_dropped);
          sdk_stale_.fetch_add(sdk_stats.stale - reader.observed_stale);
          reader.observed_dropped = sdk_stats.dropped;
          reader.observed_stale = sdk_stats.stale;
          maximum_sdk_queue_ = (std::max)(maximum_sdk_queue_.load(), sdk_stats.queued);
          if (result == livekit::FreshAudioReadResult::empty) break;
          if (result != livekit::FreshAudioReadResult::frame) {
            reader.port->retire();
            // A terminal decoder result belongs to this publication. Remove
            // its graph input on the next revision, without touching the Room.
            std::scoped_lock lock(mutex_);
            auto& current = publications_[reader_index];
            if (current.generation == reader.generation) {
              current.failed = true;
              retire(current);
              ++revision_;
            }
            ++track_failures_;
            break;
          }
          RemoteAudioFrame frame;
          frame.samples = decoded.samples;
          frame.sequence = decoded.sequence;
          frame.generation = reader.generation;
          frame.decoded_timestamp_100ns = std::chrono::duration_cast<
              std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(decoded.decoded_at.time_since_epoch()).count();
          frame.discontinuity = decoded.discontinuity;
          (void)reader.port->publish(frame);
          maximum_app_queue_ = (std::max)(maximum_app_queue_.load(), static_cast<std::uint64_t>(reader.port->stats().depth));
          ++decoded_;
        }
      }
    }
  } catch (...) { failed_ = true; }
  for (auto& reader : readers) {
    release(reader);
    reader.publication.reset();
  }
  if (!mixer_.configure({}, true)) failed_ = true;
  reading_ = 0;
  {
    std::scoped_lock lock(mutex_);
    done_ = true;
    acknowledged_ = revision_;
  }
  changed_.notify_all();
}
}  // namespace syrnike::windows_media::audio
