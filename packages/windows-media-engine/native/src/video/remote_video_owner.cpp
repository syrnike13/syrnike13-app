#include "video/remote_video_owner.hpp"

#include <algorithm>

namespace syrnike::windows_media::video {
namespace {
bool identifier(std::string_view text) {
  return !text.empty() && text.size() <= kMaximumIdentifierLength &&
      std::all_of(text.begin(), text.end(), [](unsigned char value) { return value >= 0x21 && value <= 0x7e; });
}
}  // namespace
RemoteVideoOwner::RemoteVideoOwner() : worker_([this] { run(); }) {}
RemoteVideoOwner::~RemoteVideoOwner() { stop(); }
void RemoteVideoOwner::apply(std::uint64_t revision, std::span<const RemoteVideoDemand> demand, bool connected) {
  std::lock_guard lock(mutex_);
  if (stopping_ || done_ || revision < desired_revision_) return;
  if (demand.size() > kMaximumRemoteVideoDemands) {
    failed_ = true;
    return;
  }
  desired_revision_ = revision;
  demand_.assign(demand.begin(), demand.end());
  allowed_ = connected;
  if (connected && !demand.empty()) snapshot_.stopped = false;
  ++revision_;
  changed_.notify_all();
}
void RemoteVideoOwner::beginStop() {
  std::lock_guard lock(mutex_);
  stopping_ = true;
  changed_.notify_all();
}
void RemoteVideoOwner::stop() {
  std::lock_guard join_lock(join_mutex_);
  beginStop();
  {
    std::unique_lock lock(mutex_);
    if (!changed_.wait_for(lock, kShutdownDeadline, [&] { return done_; })) std::terminate();
  }
  if (worker_.joinable()) worker_.join();
}
RemoteVideoOwnerSnapshot RemoteVideoOwner::snapshot() const {
  std::lock_guard lock(mutex_);
  return snapshot_;
}
std::optional<TextureLease> RemoteVideoOwner::takeFrame(const std::string& id) {
  std::shared_ptr<RemoteVideoTrack> owner;
  {
    std::lock_guard lock(mutex_);
    if (!allowed_ || !connected_ || stopping_) return {};
    const auto found = owners_->find(id);
    if (found == owners_->end()) return {};
    owner = found->second;
  }
  auto frame = owner->takeFrame();
  bool current;
  {
    std::lock_guard lock(mutex_);
    const auto found = owners_->find(id);
    current = allowed_ && connected_ && !stopping_ && found != owners_->end() && found->second == owner &&
        std::any_of(demand_.begin(), demand_.end(), [&](const auto& demand) { return demand.publication_id == id; });
  }
  if (!current && frame) {
    SharedTexturePool::processPool().release(frame->generation, frame->sequence, frame->slot);
    return {};
  }
  return frame;
}
bool RemoteVideoOwner::attachRoom(const std::shared_ptr<livekit::Room>& room) {
  if (!room || !detachRoom()) return false;
  std::lock_guard lock(mutex_);
  if (stopping_ || done_) return false;
  room_ = room;
  failed_ = false;
  return true;
}
bool RemoteVideoOwner::detachRoom() {
  std::unique_lock lock(mutex_);
  room_.reset();
  connected_ = false;
  publications_.clear();
  ++inventory_revision_;
  const auto revision = ++revision_;
  changed_.notify_all();
  return changed_.wait_for(lock, kShutdownDeadline, [&] { return acknowledged_ >= revision || done_; });
}
void RemoteVideoOwner::addPublication(std::string_view participant,
                                     std::shared_ptr<livekit::RemoteTrackPublication> publication) {
  if (!publication || publication->kind() != livekit::TrackKind::KIND_VIDEO ||
      (publication->source() != livekit::TrackSource::SOURCE_CAMERA &&
       publication->source() != livekit::TrackSource::SOURCE_SCREENSHARE)) return;
  if (!identifier(participant) || !identifier(publication->sid())) { failed_ = true; return; }
  const auto found = std::find_if(publications_.begin(), publications_.end(), [&](const auto& entry) {
    return entry.value.publication_id == publication->sid();
  });
  if (found != publications_.end()) return;
  if (publications_.size() == kMaximumRemoteVideoDemands) { failed_ = true; return; }
  publications_.push_back({{std::string(participant), publication->sid(),
      publication->source() == livekit::TrackSource::SOURCE_SCREENSHARE}, std::move(publication), {}});
  ++inventory_revision_;
}
bool RemoteVideoOwner::seedConnectedRoom() {
  for (unsigned attempt = 0; attempt < 5; ++attempt) {
    std::shared_ptr<livekit::Room> room;
    std::uint64_t revision;
    {
      std::lock_guard lock(mutex_);
      if (!room_ || stopping_ || done_) return false;
      room = room_;
      revision = revision_;
    }
    const auto publications = room->remotePublications(kMaximumRemoteVideoDemands);
    const auto connected = room->connectionState() == livekit::ConnectionState::Connected;
    std::lock_guard lock(mutex_);
    if (room_ != room || stopping_) return false;
    if (revision_ != revision) continue;
    if (!connected) return false;
    connected_ = true;
    failed_ = failed_ || publications.truncated;
    for (const auto& entry : publications.entries)
      if (entry.participant) addPublication(entry.participant->identity(), entry.publication);
    ++revision_;
    changed_.notify_all();
    return true;
  }
  std::lock_guard lock(mutex_);
  failed_ = true;
  return false;
}
void RemoteVideoOwner::onConnectionStateChanged(livekit::Room& room, const livekit::ConnectionStateChangedEvent& event) {
  std::lock_guard lock(mutex_);
  if (room_.get() != &room || stopping_) return;
  connected_ = event.state == livekit::ConnectionState::Connected;
  if (event.state == livekit::ConnectionState::Disconnected) {
    publications_.clear();
    ++inventory_revision_;
  }
  ++revision_;
  changed_.notify_all();
}
void RemoteVideoOwner::onTrackPublished(livekit::Room& room, const livekit::TrackPublishedEvent& event) {
  std::lock_guard lock(mutex_);
  if (room_.get() != &room || stopping_ || !event.participant) return;
  addPublication(event.participant->identity(), event.publication);
  ++revision_;
  changed_.notify_all();
}
void RemoteVideoOwner::onTrackUnpublished(livekit::Room& room, const livekit::TrackUnpublishedEvent& event) {
  std::lock_guard lock(mutex_);
  if (room_.get() != &room || stopping_) return;
  const auto removed = std::erase_if(publications_, [&](const auto& entry) { return entry.publication == event.publication; });
  if (removed) ++inventory_revision_;
  ++revision_;
  changed_.notify_all();
}
void RemoteVideoOwner::onTrackSubscribed(livekit::Room& room, const livekit::TrackSubscribedEvent& event) {
  std::lock_guard lock(mutex_);
  if (room_.get() != &room || stopping_) return;
  for (auto& entry : publications_) if (entry.publication == event.publication) entry.track = event.track;
  ++revision_;
  changed_.notify_all();
}
void RemoteVideoOwner::onTrackUnsubscribed(livekit::Room& room, const livekit::TrackUnsubscribedEvent& event) {
  std::lock_guard lock(mutex_);
  if (room_.get() != &room || stopping_) return;
  for (auto& entry : publications_) if (entry.track == event.track) entry.track.reset();
  ++revision_;
  changed_.notify_all();
}
void RemoteVideoOwner::onParticipantDisconnected(livekit::Room& room, const livekit::ParticipantDisconnectedEvent& event) {
  std::lock_guard lock(mutex_);
  if (room_.get() != &room || stopping_ || !event.participant) return;
  if (std::erase_if(publications_, [&](const auto& entry) { return entry.value.participant_identity == event.participant->identity(); }))
    ++inventory_revision_;
  ++revision_;
  changed_.notify_all();
}
void RemoteVideoOwner::run() noexcept {
  Owners owners;
  std::uint64_t applied = 0, created = 0, retired = 0;
  try {
    for (;;) {
      std::vector<Publication> publications;
      std::vector<RemoteVideoDemand> demand;
      std::uint64_t revision, desired_revision, inventory_revision;
      bool enabled, failed;
      {
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, std::chrono::milliseconds(20), [&] { return stopping_ || revision_ != applied; });
        if (stopping_) break;
        revision = revision_;
        desired_revision = desired_revision_;
        inventory_revision = inventory_revision_;
        publications = publications_;
        demand = demand_;
        enabled = allowed_ && connected_ && room_;
        failed = failed_;
      }
      const auto wanted = [&](const Publication& publication) {
        return enabled && std::any_of(demand.begin(), demand.end(), [&](const auto& value) {
          return value.publication_id == publication.value.publication_id &&
              value.participant_identity == publication.value.participant_identity;
        });
      };
      // Signal all removals before joining any reader. Their teardown proceeds
      // independently instead of serializing each SDK close latency.
      for (const auto& [id, owner] : owners)
        if (std::none_of(publications.begin(), publications.end(), [&](const auto& value) {
              return value.value.publication_id == id && wanted(value);
            })) owner->beginStop();
      std::erase_if(owners, [&](const auto& entry) {
        if (std::any_of(publications.begin(), publications.end(), [&](const auto& value) {
              return value.value.publication_id == entry.first && wanted(value);
            })) return false;
        entry.second->stop();
        ++retired;
        return true;
      });
      bool capacity_exceeded = false;
      for (const auto& publication : publications) {
        if (!wanted(publication)) continue;
        auto found = owners.find(publication.value.publication_id);
        if (found == owners.end()) {
          if (owners.size() >= SharedTexturePool::kGenerations) {
            capacity_exceeded = true;
            continue;
          }
          auto owner = std::make_shared<RemoteVideoTrack>(publication.value.participant_identity, "", publication.value.publication_id);
          owner->demand(true);
          found = owners.emplace(publication.value.publication_id, std::move(owner)).first;
          ++created;
        }
        found->second->seedPublication(publication.publication, publication.track);
      }
      RemoteVideoOwnerSnapshot current;
      RemoteVideoTrackStats total;
      for (const auto& [id, owner] : owners) {
        const auto stats = owner->stats();
        total.decoded += stats.decoded;
        total.reader_starts += stats.reader_starts;
        total.reader_ends += stats.reader_ends;
        total.stale_decoded += stats.stale_decoded;
      }
      current.metrics = {{
        {"publications", static_cast<double>(publications.size())},
        {"demanded", static_cast<double>(demand.size())},
        {"owners", static_cast<double>(owners.size())},
        {"sdk_tracks", static_cast<double>(std::count_if(publications.begin(), publications.end(),
            [](const auto& publication) { return publication.track != nullptr; }))},
        {"decoded", static_cast<double>(total.decoded)},
        {"reader_starts", static_cast<double>(total.reader_starts)},
        {"reader_ends", static_cast<double>(total.reader_ends)},
        {"stale_decoded", static_cast<double>(total.stale_decoded)},
        {"owner_creations", static_cast<double>(created)},
        {"owner_retirements", static_cast<double>(retired)},
      }};
      current.inventory_revision = inventory_revision;
      for (const auto& publication : publications) current.publications.push_back(publication.value);
      current.stopped = owners.empty();
      current.path.revision = desired_revision;
      const bool decoder_failed = std::any_of(owners.begin(), owners.end(), [](const auto& entry) { return entry.second->failed(); });
      const bool running = !owners.empty() && std::all_of(owners.begin(), owners.end(), [](const auto& entry) { return entry.second->decoded() > 0; });
      current.path.state = !enabled || demand.empty() ? MediaPathState::Off : failed || decoder_failed ? MediaPathState::Failed :
          running ? MediaPathState::Running : MediaPathState::Starting;
      if (failed || decoder_failed) current.path.failure = EngineFailure{
          "remote_video_failed", "Remote video inventory or decoder failed", "remote_video", true};
      else if (capacity_exceeded) {
        current.path.warning = true;
        current.path.failure = EngineFailure{
            "remote_video_capacity", "Remote video decoder capacity reached", "remote_video", true};
      }
      {
        std::lock_guard lock(mutex_);
        owners_ = std::make_shared<Owners>(owners);
        snapshot_ = std::move(current);
        acknowledged_ = revision;
      }
      changed_.notify_all();
      applied = revision;
    }
  } catch (...) {
    std::lock_guard lock(mutex_);
    failed_ = true;
  }
  for (const auto& [id, owner] : owners) owner->beginStop();
  for (const auto& [id, owner] : owners) owner->stop();
  owners.clear();
  {
    std::lock_guard lock(mutex_);
    owners_ = std::make_shared<Owners>();
    snapshot_.stopped = true;
    snapshot_.path.state = failed_ ? MediaPathState::Failed : MediaPathState::Off;
    done_ = true;
  }
  changed_.notify_all();
}
}  // namespace syrnike::windows_media::video
