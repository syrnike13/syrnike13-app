#include "remote_publication_reconciler.hpp"

#include <utility>

namespace syrnike::desktop_native::media {

std::optional<RemotePublicationSnapshot>
RemotePublicationReconciler::registerPublication(
  std::shared_ptr<livekit::RemoteTrackPublication> publication,
  std::string participant_identity
) {
  if (!publication) return std::nullopt;
  const auto publication_id = publication->sid();
  const auto source = publication->source();
  const bool is_video =
    publication->kind() == livekit::TrackKind::KIND_VIDEO &&
    (source == livekit::TrackSource::SOURCE_CAMERA ||
     source == livekit::TrackSource::SOURCE_SCREENSHARE);
  const bool is_audio =
    publication->kind() == livekit::TrackKind::KIND_AUDIO;
  if (!is_video && !is_audio) return std::nullopt;
  std::lock_guard lock(mutex_);
  bool demanded =
    is_audio &&
    source != livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO;
  if (source == livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO) {
    for (const auto& [_, current] : publications_) {
      if (current.participant_identity == participant_identity &&
          current.is_video &&
          current.source == livekit::TrackSource::SOURCE_SCREENSHARE &&
          current.demanded) {
        demanded = true;
        break;
      }
    }
  }
  const auto existing = publications_.find(publication_id);
  Publication next{
    std::move(publication),
    std::move(participant_identity),
    source,
    is_video,
    demanded
  };
  if (existing != publications_.end() &&
      existing->second.participant_identity == next.participant_identity &&
      existing->second.source == next.source &&
      existing->second.is_video == next.is_video) {
    next.demanded = existing->second.demanded;
    next.current_track = existing->second.current_track;
    next.revision = existing->second.revision;
    next.phase = existing->second.phase;
  }
  ++next.revision;
  const auto result = publications_.insert_or_assign(
    publication_id,
    std::move(next)
  );
  return snapshot(result.first->second);
}

std::optional<RemotePublicationSnapshot>
RemotePublicationReconciler::removePublication(
  const std::string& publication_id,
  const std::shared_ptr<livekit::RemoteTrackPublication>& expected_publication
) {
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(publication_id);
  if (found == publications_.end() ||
      !publicationMatches(found->second, expected_publication)) {
    return std::nullopt;
  }
  auto removed = snapshot(found->second);
  publications_.erase(found);
  return removed;
}

std::vector<RemotePublicationSnapshot>
RemotePublicationReconciler::removeParticipant(
  const std::string& participant_identity
) {
  std::vector<RemotePublicationSnapshot> removed;
  std::lock_guard lock(mutex_);
  for (auto entry = publications_.begin(); entry != publications_.end();) {
    if (entry->second.participant_identity != participant_identity) {
      ++entry;
      continue;
    }
    removed.push_back(snapshot(entry->second));
    entry = publications_.erase(entry);
  }
  return removed;
}

std::vector<RemotePublicationSnapshot> RemotePublicationReconciler::clear() {
  std::vector<RemotePublicationSnapshot> removed;
  std::lock_guard lock(mutex_);
  removed.reserve(publications_.size());
  for (const auto& entry : publications_) {
    removed.push_back(snapshot(entry.second));
  }
  publications_.clear();
  return removed;
}

std::vector<std::string>
RemotePublicationReconciler::publicationIds() const {
  std::vector<std::string> ids;
  std::lock_guard lock(mutex_);
  ids.reserve(publications_.size());
  for (const auto& entry : publications_) {
    ids.push_back(entry.first);
  }
  return ids;
}

bool RemotePublicationReconciler::matches(
  const std::string& publication_id,
  const std::shared_ptr<livekit::RemoteTrackPublication>& publication
) const {
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(publication_id);
  return found != publications_.end() &&
    publicationMatches(found->second, publication);
}

std::optional<RemotePublicationSnapshot>
RemotePublicationReconciler::setVideoDemand(
  const std::string& publication_id,
  bool demanded
) {
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(publication_id);
  if (found == publications_.end() || !found->second.is_video) {
    return std::nullopt;
  }
  found->second.demanded = demanded;
  ++found->second.revision;
  return snapshot(found->second);
}

std::vector<std::string>
RemotePublicationReconciler::syncScreenAudioDemand(
  const std::string& participant_identity
) {
  std::vector<std::string> changed;
  std::lock_guard lock(mutex_);
  bool demanded = false;
  for (const auto& [_, publication] : publications_) {
    if (publication.participant_identity == participant_identity &&
        publication.is_video &&
        publication.source == livekit::TrackSource::SOURCE_SCREENSHARE &&
        publication.demanded) {
      demanded = true;
      break;
    }
  }
  for (auto& [publication_id, publication] : publications_) {
    if (publication.participant_identity != participant_identity ||
        publication.source !=
          livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO ||
        publication.demanded == demanded) {
      continue;
    }
    publication.demanded = demanded;
    ++publication.revision;
    changed.push_back(publication_id);
  }
  return changed;
}

RemotePublicationReconcilePlan
RemotePublicationReconciler::planReconcile(
  const std::string& publication_id
) {
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(publication_id);
  if (found == publications_.end() || !found->second.publication) return {};
  auto& publication = found->second;
  RemotePublicationReconcilePlan plan{
    RemotePublicationReconcileCommand::None,
    publication.publication,
    publication.demanded,
    publication.revision
  };
  if (publication.demanded) {
    // FFI requests return before the matching track event. Sending subscribe
    // while an actual unsubscribe is pending can leave LiveKit with no track
    // and no replacement event, so only callbacks advance an in-flight edge.
    if (publication.phase == Phase::Subscribing ||
        publication.phase == Phase::Unsubscribing) {
      plan.command = RemotePublicationReconcileCommand::Deferred;
      return plan;
    }
    if (publication.phase == Phase::Subscribed) return plan;
    plan.command = RemotePublicationReconcileCommand::Subscribe;
    publication.phase = Phase::Subscribing;
  } else {
    if (publication.phase == Phase::Subscribing ||
        publication.phase == Phase::Subscribed ||
        publication.phase == Phase::Failed) {
      plan.command = RemotePublicationReconcileCommand::Unsubscribe;
      publication.phase = Phase::Unsubscribing;
    } else if (publication.phase == Phase::Unsubscribing) {
      plan.command = RemotePublicationReconcileCommand::Deferred;
      return plan;
    } else {
      return plan;
    }
  }
  plan.revision = ++publication.revision;
  return plan;
}

void RemotePublicationReconciler::markReconcileFailed(
  const RemotePublicationReconcilePlan& plan
) {
  if (!plan.publication) return;
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(plan.publication->sid());
  if (found != publications_.end() &&
      found->second.publication == plan.publication &&
      found->second.revision == plan.revision) {
    found->second.phase = Phase::Failed;
  }
}

bool RemotePublicationReconciler::isReconcileCurrent(
  const RemotePublicationReconcilePlan& plan
) const {
  if (!plan.publication) return false;
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(plan.publication->sid());
  return found != publications_.end() &&
    found->second.publication == plan.publication &&
    found->second.revision == plan.revision &&
    found->second.demanded == plan.demanded;
}

RemotePublicationSubscribedResult
RemotePublicationReconciler::onTrackSubscribed(
  const std::string& publication_id,
  const std::shared_ptr<livekit::RemoteTrackPublication>& publication,
  const std::shared_ptr<livekit::Track>& track
) {
  if (!track) return {};
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(publication_id);
  if (found == publications_.end() ||
      !publicationMatches(found->second, publication)) {
    return {};
  }
  auto& state = found->second;
  RemotePublicationSubscribedResult result{
    true,
    state.demanded,
    state.current_track == track,
    state.is_video
  };
  if (!state.is_video) {
    state.phase = Phase::Subscribed;
    return result;
  }
  state.phase = Phase::Subscribed;
  state.current_track = track;
  return result;
}

RemotePublicationUnsubscribedResult
RemotePublicationReconciler::onTrackUnsubscribed(
  const std::string& publication_id,
  const std::shared_ptr<livekit::RemoteTrackPublication>& publication,
  const std::shared_ptr<livekit::Track>& track
) {
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(publication_id);
  if (found == publications_.end() ||
      !publicationMatches(found->second, publication)) {
    return {};
  }
  auto& state = found->second;
  RemotePublicationUnsubscribedResult result{
    true,
    false,
    false,
    state.is_video
  };
  if (!state.is_video) {
    state.phase = Phase::Unsubscribed;
    result.resubscribe = state.demanded;
    return result;
  }
  if (state.current_track) {
    result.current = track && state.current_track == track;
    if (!result.current) return result;
    state.current_track.reset();
  } else if (state.phase != Phase::Unsubscribing) {
    return result;
  }
  state.phase = Phase::Unsubscribed;
  result.resubscribe = state.demanded;
  return result;
}

std::optional<RemotePublicationSnapshot>
RemotePublicationReconciler::markSubscriptionFailed(
  const std::string& publication_id,
  bool ignore_when_track_exists
) {
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(publication_id);
  if (found == publications_.end() || !found->second.demanded ||
      (ignore_when_track_exists && found->second.current_track)) {
    return std::nullopt;
  }
  found->second.phase = Phase::Failed;
  return snapshot(found->second);
}

RemotePublicationRecoveryPlan
RemotePublicationReconciler::planVideoRecovery(
  const std::string& publication_id
) {
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(publication_id);
  if (found == publications_.end() || !found->second.is_video ||
      !found->second.demanded) {
    return {};
  }
  auto& publication = found->second;
  RemotePublicationRecoveryPlan plan{
    RemotePublicationRecoveryAction::None,
    snapshot(publication),
    publication.revision
  };
  const bool restart_local_bridge =
    publication.current_track &&
    publication.phase == Phase::Subscribed;
  if (restart_local_bridge) {
    plan.action = RemotePublicationRecoveryAction::RestartLocalBridge;
    return plan;
  }
  const bool request_unsubscribe =
    publication.current_track ||
    publication.phase == Phase::Subscribing ||
    publication.phase == Phase::Subscribed;
  if (request_unsubscribe) {
    publication.phase = Phase::Unsubscribing;
    plan.action = RemotePublicationRecoveryAction::RequestUnsubscribe;
  } else {
    publication.current_track.reset();
    publication.phase = Phase::Unsubscribed;
    plan.action = RemotePublicationRecoveryAction::Reconcile;
  }
  plan.revision = ++publication.revision;
  plan.publication = snapshot(publication);
  return plan;
}

void RemotePublicationReconciler::markRecoveryFailed(
  const RemotePublicationRecoveryPlan& plan
) {
  if (!plan.publication.publication) return;
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(plan.publication.publication->sid());
  if (found != publications_.end() &&
      found->second.publication == plan.publication.publication &&
      found->second.revision == plan.revision) {
    found->second.phase = Phase::Failed;
  }
}

bool RemotePublicationReconciler::isCurrentDemandedTrack(
  const std::string& publication_id,
  const std::shared_ptr<livekit::Track>& track
) const {
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(publication_id);
  return found != publications_.end() &&
    found->second.demanded &&
    found->second.current_track == track;
}

RemotePublicationSnapshot RemotePublicationReconciler::snapshot(
  const Publication& publication
) {
  return {
    publication.publication,
    publication.participant_identity,
    publication.source,
    publication.is_video,
    publication.demanded,
    publication.current_track
  };
}

bool RemotePublicationReconciler::publicationMatches(
  const Publication& current,
  const std::shared_ptr<livekit::RemoteTrackPublication>& expected
) {
  return !expected || current.publication == expected;
}

}  // namespace syrnike::desktop_native::media
