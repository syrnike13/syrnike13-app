#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include <livekit/remote_track_publication.h>
#include <livekit/track.h>

namespace syrnike::desktop_native::media {

enum class RemotePublicationReconcileCommand {
  None,
  Deferred,
  Subscribe,
  Unsubscribe,
};

enum class RemotePublicationRecoveryAction {
  None,
  RestartLocalBridge,
  RequestUnsubscribe,
  Reconcile,
};

struct RemotePublicationSnapshot {
  std::shared_ptr<livekit::RemoteTrackPublication> publication;
  std::string participant_identity;
  livekit::TrackSource source = livekit::TrackSource::SOURCE_UNKNOWN;
  bool is_video = false;
  bool demanded = false;
  std::shared_ptr<livekit::Track> current_track;
};

struct RemotePublicationReconcilePlan {
  RemotePublicationReconcileCommand command =
    RemotePublicationReconcileCommand::None;
  std::shared_ptr<livekit::RemoteTrackPublication> publication;
  bool demanded = false;
  std::uint64_t revision = 0;
};

struct RemotePublicationSubscribedResult {
  bool matched = false;
  bool demanded = false;
  bool duplicate = false;
  bool is_video = false;
};

struct RemotePublicationUnsubscribedResult {
  bool matched = false;
  bool current = false;
  bool resubscribe = false;
  bool is_video = false;
};

struct RemotePublicationRecoveryPlan {
  RemotePublicationRecoveryAction action =
    RemotePublicationRecoveryAction::None;
  RemotePublicationSnapshot publication;
  std::uint64_t revision = 0;
};

class RemotePublicationReconciler final {
 public:
  // Owns desired/actual publication state. Returned plans describe SDK side
  // effects but never execute them, so callers retain the Room operation path.
  std::optional<RemotePublicationSnapshot> registerPublication(
    std::shared_ptr<livekit::RemoteTrackPublication> publication,
    std::string participant_identity
  );
  std::optional<RemotePublicationSnapshot> removePublication(
    const std::string& publication_id,
    const std::shared_ptr<livekit::RemoteTrackPublication>& expected_publication
  );
  std::vector<RemotePublicationSnapshot> removeParticipant(
    const std::string& participant_identity
  );
  std::vector<RemotePublicationSnapshot> clear();
  std::vector<std::string> publicationIds() const;

  bool matches(
    const std::string& publication_id,
    const std::shared_ptr<livekit::RemoteTrackPublication>& publication
  ) const;
  std::optional<RemotePublicationSnapshot> setVideoDemand(
    const std::string& publication_id,
    bool demanded
  );
  std::vector<std::string> syncScreenAudioDemand(
    const std::string& participant_identity
  );
  RemotePublicationReconcilePlan planReconcile(
    const std::string& publication_id
  );
  void markReconcileFailed(const RemotePublicationReconcilePlan& plan);
  bool isReconcileCurrent(const RemotePublicationReconcilePlan& plan) const;

  RemotePublicationSubscribedResult onTrackSubscribed(
    const std::string& publication_id,
    const std::shared_ptr<livekit::RemoteTrackPublication>& publication,
    const std::shared_ptr<livekit::Track>& track
  );
  RemotePublicationUnsubscribedResult onTrackUnsubscribed(
    const std::string& publication_id,
    const std::shared_ptr<livekit::RemoteTrackPublication>& publication,
    const std::shared_ptr<livekit::Track>& track
  );
  std::optional<RemotePublicationSnapshot> markSubscriptionFailed(
    const std::string& publication_id,
    bool ignore_when_track_exists
  );

  RemotePublicationRecoveryPlan planVideoRecovery(
    const std::string& publication_id
  );
  void markRecoveryFailed(const RemotePublicationRecoveryPlan& plan);
  bool isCurrentDemandedTrack(
    const std::string& publication_id,
    const std::shared_ptr<livekit::Track>& track
  ) const;

 private:
  enum class Phase {
    Unsubscribed,
    Subscribing,
    Subscribed,
    Unsubscribing,
    Failed,
  };

  struct Publication {
    std::shared_ptr<livekit::RemoteTrackPublication> publication;
    std::string participant_identity;
    livekit::TrackSource source = livekit::TrackSource::SOURCE_UNKNOWN;
    bool is_video = false;
    bool demanded = false;
    std::shared_ptr<livekit::Track> current_track;
    std::uint64_t revision = 0;
    Phase phase = Phase::Unsubscribed;
  };

  static RemotePublicationSnapshot snapshot(const Publication& publication);
  static bool publicationMatches(
    const Publication& current,
    const std::shared_ptr<livekit::RemoteTrackPublication>& expected
  );

  mutable std::mutex mutex_;
  std::unordered_map<std::string, Publication> publications_;
};

}  // namespace syrnike::desktop_native::media
