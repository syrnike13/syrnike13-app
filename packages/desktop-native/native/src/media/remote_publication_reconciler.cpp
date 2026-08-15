#include "remote_publication_reconciler.hpp"

#include <array>
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
      existing->second.publication != next.publication) {
    next.requires_publication_identity = true;
  }
  if (existing != publications_.end() &&
      existing->second.participant_identity == next.participant_identity &&
      existing->second.source == next.source &&
      existing->second.is_video == next.is_video) {
    if (existing->second.publication == next.publication) {
      return snapshot(existing->second);
    }
    next.demanded = existing->second.demanded;
    next.revision = existing->second.revision;
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
  if (found->second.demanded == demanded) {
    return snapshot(found->second);
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
    resetAudioRetry(publication);
    ++publication.revision;
    changed.push_back(publication_id);
  }
  return changed;
}

RemotePublicationReconcilePlan
RemotePublicationReconciler::planReconcile(
  const std::string& publication_id,
  std::uint64_t expected_revision
) {
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(publication_id);
  if (found == publications_.end() || !found->second.publication) return {};
  auto& publication = found->second;
  if (expected_revision != 0 &&
      publication.revision != expected_revision) {
    return {};
  }
  publication.audio_retry_dispatched = false;
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

std::optional<RemotePublicationAudioRetry>
RemotePublicationReconciler::markReconcileFailed(
  const RemotePublicationReconcilePlan& plan,
  std::chrono::steady_clock::time_point now
) {
  if (!plan.publication) return std::nullopt;
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(plan.publication->sid());
  if (found != publications_.end() &&
      found->second.publication == plan.publication &&
      found->second.revision == plan.revision) {
    found->second.phase = Phase::Failed;
    ++found->second.revision;
    return scheduleAudioRetry(
      plan.publication->sid(),
      found->second,
      now
    );
  }
  return std::nullopt;
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
  if (found == publications_.end()) return {};
  auto& state = found->second;
  if (!publicationMatches(state, publication)) {
    const bool compatible_source = publication &&
      publication->source() == state.source;
    const bool compatible_kind = publication &&
      ((state.is_video &&
        publication->kind() == livekit::TrackKind::KIND_VIDEO) ||
       (!state.is_video &&
        publication->kind() == livekit::TrackKind::KIND_AUDIO));
    if (!compatible_source || !compatible_kind || state.current_track ||
        state.phase != Phase::Subscribing || !state.demanded) {
      return {};
    }
    // TrackSubscribed is the SDK's actual-state commit. It may surface the
    // participant map's canonical publication object after reconnect; adopt it
    // only while this SID has no healthy track and a subscribe edge is active.
    state.publication = publication;
    state.requires_publication_identity = false;
  }
  if (!publication &&
      (state.requires_publication_identity ||
       (state.current_track && state.current_track != track))) {
    return {};
  }
  RemotePublicationSubscribedResult result{
    true,
    state.demanded,
    state.current_track == track,
    state.is_video
  };
  state.phase = Phase::Subscribed;
  state.current_track = track;
  state.requires_publication_identity = false;
  resetAudioRetry(state);
  ++state.revision;
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
  if (state.current_track) {
    result.current = track && state.current_track == track;
    if (!result.current) return result;
    state.current_track.reset();
  } else if (state.phase != Phase::Unsubscribing) {
    return result;
  }
  state.phase = Phase::Unsubscribed;
  resetAudioRetry(state);
  ++state.revision;
  result.resubscribe = state.demanded;
  return result;
}

bool RemotePublicationReconciler::contains(
  const std::string& publication_id
) const {
  std::lock_guard lock(mutex_);
  return publications_.contains(publication_id);
}

void RemotePublicationReconciler::resetAudioRetriesForReconnect() {
  std::lock_guard lock(mutex_);
  for (auto& [_, publication] : publications_) {
    if (!isRetryableAudio(publication)) continue;
    resetAudioRetry(publication);
    publication.phase = publication.current_track
      ? Phase::Subscribed
      : Phase::Unsubscribed;
    ++publication.revision;
  }
}

std::optional<RemotePublicationSubscriptionFailure>
RemotePublicationReconciler::markSubscriptionFailed(
  const std::string& publication_id,
  bool ignore_when_track_exists,
  std::chrono::steady_clock::time_point now
) {
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(publication_id);
  if (found == publications_.end() || !found->second.demanded ||
      (ignore_when_track_exists && found->second.current_track)) {
    return std::nullopt;
  }
  auto& publication = found->second;
  if (isRetryableAudio(publication) && publication.phase == Phase::Failed &&
      (publication.audio_retry_pending ||
       publication.audio_retry_dispatched ||
       publication.audio_retry_attempt >= 3)) {
    RemotePublicationSubscriptionFailure coalesced{
      snapshot(publication),
      std::nullopt,
      publication.audio_retry_attempt >= 3 &&
        !publication.audio_retry_pending &&
        !publication.audio_retry_dispatched
    };
    if (publication.audio_retry_pending) {
      coalesced.retry = RemotePublicationAudioRetry{
        publication_id,
        publication.revision,
        publication.audio_retry_attempt,
        publication.audio_retry_due
      };
    }
    return coalesced;
  }
  publication.phase = Phase::Failed;
  ++publication.revision;
  auto retry = scheduleAudioRetry(publication_id, publication, now);
  RemotePublicationSubscriptionFailure result{
    snapshot(publication),
    std::move(retry),
    isRetryableAudio(publication) &&
      publication.audio_retry_attempt >= 3 &&
      !publication.audio_retry_pending &&
      !publication.audio_retry_dispatched
  };
  if (!result.retry && publication.audio_retry_pending) {
    result.retry = RemotePublicationAudioRetry{
      publication_id,
      publication.revision,
      publication.audio_retry_attempt,
      publication.audio_retry_due
    };
  }
  return result;
}

std::optional<std::chrono::steady_clock::time_point>
RemotePublicationReconciler::nextAudioRetryDeadline() const {
  std::optional<std::chrono::steady_clock::time_point> next;
  std::lock_guard lock(mutex_);
  for (const auto& [_, publication] : publications_) {
    if (!publication.audio_retry_pending) continue;
    if (!next || publication.audio_retry_due < *next) {
      next = publication.audio_retry_due;
    }
  }
  return next;
}

bool RemotePublicationReconciler::audioFailureOwnsReconcile(
  const std::string& publication_id
) const {
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(publication_id);
  return found != publications_.end() &&
    isRetryableAudio(found->second) &&
    found->second.demanded &&
    found->second.phase == Phase::Failed;
}

std::vector<RemotePublicationAudioRetry>
RemotePublicationReconciler::takeDueAudioRetries(
  std::chrono::steady_clock::time_point now
) {
  std::vector<RemotePublicationAudioRetry> due;
  std::lock_guard lock(mutex_);
  for (auto& [publication_id, publication] : publications_) {
    if (!publication.audio_retry_pending || publication.audio_retry_due > now) {
      continue;
    }
    publication.audio_retry_pending = false;
    publication.audio_retry_dispatched = true;
    due.push_back(RemotePublicationAudioRetry{
      publication_id,
      publication.revision,
      publication.audio_retry_attempt,
      publication.audio_retry_due
    });
  }
  return due;
}

std::optional<RemotePublicationAudioRetry>
RemotePublicationReconciler::markAudioRetryDispatchFailed(
  const RemotePublicationAudioRetry& retry,
  std::chrono::steady_clock::time_point now
) {
  std::lock_guard lock(mutex_);
  const auto found = publications_.find(retry.publication_id);
  if (found == publications_.end() ||
      found->second.revision != retry.revision ||
      !found->second.audio_retry_dispatched) {
    return std::nullopt;
  }
  found->second.audio_retry_dispatched = false;
  return scheduleAudioRetry(retry.publication_id, found->second, now);
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
    publication.current_track,
    publication.revision
  };
}

bool RemotePublicationReconciler::publicationMatches(
  const Publication& current,
  const std::shared_ptr<livekit::RemoteTrackPublication>& expected
) {
  return !expected || current.publication == expected;
}

bool RemotePublicationReconciler::isRetryableAudio(
  const Publication& publication
) {
  return !publication.is_video &&
    (publication.source == livekit::TrackSource::SOURCE_MICROPHONE ||
     publication.source == livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO);
}

void RemotePublicationReconciler::resetAudioRetry(Publication& publication) {
  publication.audio_retry_attempt = 0;
  publication.audio_retry_pending = false;
  publication.audio_retry_dispatched = false;
  publication.audio_retry_due = {};
}

std::optional<RemotePublicationAudioRetry>
RemotePublicationReconciler::scheduleAudioRetry(
  const std::string& publication_id,
  Publication& publication,
  std::chrono::steady_clock::time_point now
) {
  using namespace std::chrono_literals;
  static constexpr std::array<std::chrono::milliseconds, 3> delays{
    250ms,
    1s,
    5s
  };
  if (!publication.demanded || !isRetryableAudio(publication) ||
      publication.current_track || publication.audio_retry_pending ||
      publication.audio_retry_dispatched ||
      publication.audio_retry_attempt >= delays.size()) {
    return std::nullopt;
  }
  const auto delay = delays[publication.audio_retry_attempt];
  ++publication.audio_retry_attempt;
  publication.audio_retry_pending = true;
  publication.audio_retry_due = now + delay;
  ++publication.revision;
  return RemotePublicationAudioRetry{
    publication_id,
    publication.revision,
    publication.audio_retry_attempt,
    publication.audio_retry_due
  };
}

}  // namespace syrnike::desktop_native::media
