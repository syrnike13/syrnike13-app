#include <chrono>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

#include <livekit/ffi_handle.h>
#include <livekit/remote_track_publication.h>
#include <livekit/track.h>

#include "ffi.pb.h"
#include "media/remote_publication_reconciler.hpp"

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

std::shared_ptr<livekit::RemoteTrackPublication> screenPublication(
  const std::string& sid = "screen-track"
) {
  livekit::proto::OwnedTrackPublication owned;
  owned.mutable_handle()->set_id(0);
  auto* info = owned.mutable_info();
  info->set_sid(sid);
  info->set_name("screen");
  info->set_kind(livekit::proto::KIND_VIDEO);
  info->set_source(livekit::proto::SOURCE_SCREENSHARE);
  info->set_width(1920);
  info->set_height(1080);
  info->set_remote(true);
  info->set_encryption_type(livekit::proto::NONE);
  return std::make_shared<livekit::RemoteTrackPublication>(owned);
}

std::shared_ptr<livekit::RemoteTrackPublication> cameraPublication(
  const std::string& sid = "camera-track"
) {
  livekit::proto::OwnedTrackPublication owned;
  owned.mutable_handle()->set_id(0);
  auto* info = owned.mutable_info();
  info->set_sid(sid);
  info->set_name("camera");
  info->set_kind(livekit::proto::KIND_VIDEO);
  info->set_source(livekit::proto::SOURCE_CAMERA);
  info->set_width(1280);
  info->set_height(720);
  info->set_remote(true);
  info->set_encryption_type(livekit::proto::NONE);
  return std::make_shared<livekit::RemoteTrackPublication>(owned);
}

std::shared_ptr<livekit::RemoteTrackPublication> microphonePublication(
  const std::string& sid = "microphone-track"
) {
  livekit::proto::OwnedTrackPublication owned;
  owned.mutable_handle()->set_id(0);
  auto* info = owned.mutable_info();
  info->set_sid(sid);
  info->set_name("microphone");
  info->set_kind(livekit::proto::KIND_AUDIO);
  info->set_source(livekit::proto::SOURCE_MICROPHONE);
  info->set_remote(true);
  info->set_encryption_type(livekit::proto::NONE);
  return std::make_shared<livekit::RemoteTrackPublication>(owned);
}

std::shared_ptr<livekit::RemoteTrackPublication> screenAudioPublication(
  const std::string& sid = "screen-audio-track"
) {
  livekit::proto::OwnedTrackPublication owned;
  owned.mutable_handle()->set_id(0);
  auto* info = owned.mutable_info();
  info->set_sid(sid);
  info->set_name("screen-audio");
  info->set_kind(livekit::proto::KIND_AUDIO);
  info->set_source(livekit::proto::SOURCE_SCREENSHARE_AUDIO);
  info->set_remote(true);
  info->set_encryption_type(livekit::proto::NONE);
  return std::make_shared<livekit::RemoteTrackPublication>(owned);
}

class TestTrack final : public livekit::Track {
 public:
  explicit TestTrack(
    std::string sid,
    livekit::TrackKind kind = livekit::TrackKind::KIND_VIDEO
  )
    : Track(
        livekit::FfiHandle{},
        std::move(sid),
        "screen",
        kind,
        livekit::StreamState::STATE_ACTIVE,
        false,
        true
      ) {}
};

void publicationKindOwnsDefaultDemand() {
  using namespace syrnike::desktop_native::media;
  RemotePublicationReconciler reconciler;
  const auto audio = reconciler.registerPublication(
    microphonePublication(),
    "source"
  );
  const auto screen_audio = reconciler.registerPublication(
    screenAudioPublication(),
    "source"
  );
  const auto video = reconciler.registerPublication(
    screenPublication(),
    "source"
  );

  require(
    audio && !audio->is_video && audio->demanded,
    "remote audio was not subscribed by default"
  );
  require(
    screen_audio && !screen_audio->is_video && !screen_audio->demanded,
    "screen audio ignored screen Media Demand ownership"
  );
  require(
    video && video->is_video && !video->demanded,
    "remote video ignored Media Demand ownership"
  );
}

void screenAudioFollowsMatchingScreenDemand() {
  using namespace syrnike::desktop_native::media;
  RemotePublicationReconciler reconciler;
  reconciler.registerPublication(screenAudioPublication(), "source");
  reconciler.registerPublication(screenPublication(), "source");

  reconciler.setVideoDemand("screen-track", true);
  const auto enabled = reconciler.syncScreenAudioDemand("source");
  require(
    enabled.size() == 1 && enabled.front() == "screen-audio-track",
    "starting screen demand did not enable matching screen audio"
  );
  require(
    reconciler.planReconcile("screen-audio-track").command ==
      RemotePublicationReconcileCommand::Subscribe,
    "enabled screen audio did not request subscription"
  );

  reconciler.setVideoDemand("screen-track", false);
  const auto disabled = reconciler.syncScreenAudioDemand("source");
  require(
    disabled.size() == 1 && disabled.front() == "screen-audio-track",
    "stopping screen demand did not disable matching screen audio"
  );
  require(
    reconciler.planReconcile("screen-audio-track").command ==
      RemotePublicationReconcileCommand::Unsubscribe,
    "disabled screen audio did not request unsubscribe"
  );
}

void lateScreenAudioInheritsExistingScreenDemand() {
  using namespace syrnike::desktop_native::media;
  RemotePublicationReconciler reconciler;
  reconciler.registerPublication(screenPublication(), "source");
  reconciler.setVideoDemand("screen-track", true);
  const auto screen_audio = reconciler.registerPublication(
    screenAudioPublication(),
    "source"
  );

  require(
    screen_audio && screen_audio->demanded,
    "late screen audio did not inherit matching screen demand"
  );
}

void rapidResubscribeWaitsForActualUnsubscribe() {
  using namespace syrnike::desktop_native::media;
  RemotePublicationReconciler reconciler;
  const auto publication = screenPublication();
  const auto track = std::make_shared<TestTrack>("screen-track");

  reconciler.registerPublication(publication, "source");
  require(
    reconciler.planReconcile("screen-track").command ==
      RemotePublicationReconcileCommand::None,
    "an initially unsubscribed publication sent a redundant command"
  );

  reconciler.setVideoDemand("screen-track", true);
  require(
    reconciler.planReconcile("screen-track").command ==
      RemotePublicationReconcileCommand::Subscribe,
    "initial Media Demand did not request subscription"
  );
  const auto subscribed = reconciler.onTrackSubscribed(
    "screen-track",
    publication,
    track
  );
  require(
    subscribed.matched && subscribed.demanded && !subscribed.duplicate,
    "actual subscription did not attach the demanded track"
  );

  reconciler.setVideoDemand("screen-track", false);
  require(
    reconciler.planReconcile("screen-track").command ==
      RemotePublicationReconcileCommand::Unsubscribe,
    "stopping Media Demand did not request unsubscribe"
  );
  reconciler.setVideoDemand("screen-track", true);
  require(
    reconciler.planReconcile("screen-track").command ==
      RemotePublicationReconcileCommand::Deferred,
    "subscribe overtook the pending actual unsubscribe"
  );

  const auto unsubscribed = reconciler.onTrackUnsubscribed(
    "screen-track",
    publication,
    track
  );
  require(
    unsubscribed.matched && unsubscribed.current &&
      unsubscribed.resubscribe,
    "actual unsubscribe did not release the old track and preserve Media Demand"
  );
  require(
    reconciler.planReconcile("screen-track").command ==
      RemotePublicationReconcileCommand::Subscribe,
    "subscription was not resumed after actual unsubscribe"
  );
}

void recoveryPreservesHealthySubscriptionDuringLocalBridgeFailures() {
  using namespace syrnike::desktop_native::media;
  RemotePublicationReconciler reconciler;
  const auto publication = screenPublication();
  const auto track = std::make_shared<TestTrack>("screen-track");

  reconciler.registerPublication(publication, "source");
  reconciler.setVideoDemand("screen-track", true);
  require(
    reconciler.planReconcile("screen-track").command ==
      RemotePublicationReconcileCommand::Subscribe,
    "recovery setup did not enter subscribing"
  );
  require(
    reconciler.planVideoRecovery("screen-track").action ==
      RemotePublicationRecoveryAction::RequestUnsubscribe,
    "stuck subscribing state did not first cancel the pending subscribe"
  );
  require(
    reconciler.planVideoRecovery("screen-track").action ==
      RemotePublicationRecoveryAction::Reconcile,
    "recovery did not wait one transition before resubscribing"
  );
  require(
    reconciler.planReconcile("screen-track").command ==
      RemotePublicationReconcileCommand::Subscribe,
    "recovery did not request a replacement subscription"
  );
  reconciler.onTrackSubscribed("screen-track", publication, track);

  require(
    reconciler.planVideoRecovery("screen-track").action ==
      RemotePublicationRecoveryAction::RestartLocalBridge,
    "healthy SDK track did not recover at the smallest failed layer"
  );
  require(
    reconciler.planVideoRecovery("screen-track").action ==
      RemotePublicationRecoveryAction::RestartLocalBridge,
    "repeated local bridge failure replaced a healthy SDK subscription"
  );
}

void lateOldUnsubscribeCannotDetachReplacementTrack() {
  using namespace syrnike::desktop_native::media;
  RemotePublicationReconciler reconciler;
  const auto publication = screenPublication();
  const auto old_track = std::make_shared<TestTrack>("screen-track-old");
  const auto replacement = std::make_shared<TestTrack>("screen-track-new");

  reconciler.registerPublication(publication, "source");
  reconciler.setVideoDemand("screen-track", true);
  reconciler.onTrackSubscribed("screen-track", publication, old_track);
  reconciler.onTrackSubscribed("screen-track", publication, replacement);
  require(
    reconciler.planVideoRecovery("screen-track").action ==
      RemotePublicationRecoveryAction::RestartLocalBridge &&
      reconciler.planVideoRecovery("screen-track").action ==
        RemotePublicationRecoveryAction::RestartLocalBridge,
    "replacement track did not remain on bridge-only recovery"
  );
  const auto stale = reconciler.onTrackUnsubscribed(
    "screen-track",
    publication,
    old_track
  );

  require(
    stale.matched && !stale.current && !stale.resubscribe,
    "late unsubscribe was treated as the current transition"
  );
  require(
    reconciler.isCurrentDemandedTrack("screen-track", replacement),
    "late unsubscribe detached the replacement track"
  );
}

void microphoneFailureSchedulesOneBoundedRetry() {
  using namespace std::chrono_literals;
  using namespace syrnike::desktop_native::media;
  RemotePublicationReconciler reconciler;
  const auto publication = microphonePublication();
  const auto registered = reconciler.registerPublication(publication, "source");
  require(registered.has_value(), "microphone publication was not registered");
  require(
    reconciler.planReconcile("microphone-track", registered->revision).command ==
      RemotePublicationReconcileCommand::Subscribe,
    "microphone setup did not request its initial subscription"
  );

  const auto started = std::chrono::steady_clock::time_point{10s};
  const auto failure = reconciler.markSubscriptionFailed(
    "microphone-track",
    true,
    started
  );
  require(
    failure && failure->retry && failure->retry->attempt == 1 &&
      failure->retry->due_at == started + 250ms &&
      reconciler.audioFailureOwnsReconcile("microphone-track"),
    "microphone failure did not schedule the first bounded retry"
  );
  require(
    reconciler.takeDueAudioRetries(started + 249ms).empty(),
    "microphone retry became due before its backoff"
  );
  const auto due = reconciler.takeDueAudioRetries(started + 250ms);
  require(
    due.size() == 1 && due.front().publication_id == "microphone-track" &&
      due.front().revision == failure->retry->revision,
    "microphone retry did not produce one revision-fenced reconcile token"
  );
  require(
    reconciler.takeDueAudioRetries(started + 250ms).empty(),
    "microphone retry token was dispatched more than once"
  );
  require(
    reconciler.planReconcile(
      due.front().publication_id,
      due.front().revision
    ).command == RemotePublicationReconcileCommand::Subscribe,
    "due microphone retry did not resume subscription reconciliation"
  );
}

void screenAudioRetryIsIndependentAndCancelledWithDemand() {
  using namespace std::chrono_literals;
  using namespace syrnike::desktop_native::media;
  RemotePublicationReconciler reconciler;
  reconciler.registerPublication(screenPublication(), "source");
  reconciler.registerPublication(screenAudioPublication(), "source");
  reconciler.setVideoDemand("screen-track", true);
  reconciler.syncScreenAudioDemand("source");
  require(
    reconciler.planReconcile("screen-audio-track").command ==
      RemotePublicationReconcileCommand::Subscribe,
    "screen audio setup did not request subscription"
  );

  const auto started = std::chrono::steady_clock::time_point{20s};
  const auto audio_failure = reconciler.markSubscriptionFailed(
    "screen-audio-track",
    true,
    started
  );
  require(
    audio_failure && audio_failure->retry &&
      audio_failure->retry->due_at == started + 250ms,
    "screen audio failure did not schedule its own bounded retry"
  );
  const auto video_failure = reconciler.markSubscriptionFailed(
    "screen-track",
    true,
    started
  );
  require(
    video_failure && !video_failure->retry &&
      !reconciler.audioFailureOwnsReconcile("screen-track"),
    "screen video entered the audio retry policy"
  );

  reconciler.setVideoDemand("screen-track", false);
  reconciler.syncScreenAudioDemand("source");
  require(
    reconciler.takeDueAudioRetries(started + 250ms).empty(),
    "removing screen Media Demand did not cancel its audio retry"
  );
}

void healthyAudioTrackRejectsStaleFailureAndOldUnsubscribe() {
  using namespace std::chrono_literals;
  using namespace syrnike::desktop_native::media;
  const auto verify = [](
    RemotePublicationReconciler& reconciler,
    const std::shared_ptr<livekit::RemoteTrackPublication>& publication,
    const std::string& publication_id
  ) {
    const auto old_track = std::make_shared<TestTrack>(
      publication_id + "-old",
      livekit::TrackKind::KIND_AUDIO
    );
    const auto healthy_track = std::make_shared<TestTrack>(
      publication_id + "-healthy",
      livekit::TrackKind::KIND_AUDIO
    );
    reconciler.planReconcile(publication_id);
    reconciler.onTrackSubscribed(publication_id, publication, old_track);
    reconciler.onTrackSubscribed(publication_id, publication, healthy_track);

    require(
      !reconciler.onTrackSubscribed(
        publication_id,
        {},
        old_track
      ).matched,
      "identity-less stale subscribe replaced a healthy audio track"
    );
    require(
      !reconciler.markSubscriptionFailed(
        publication_id,
        true,
        std::chrono::steady_clock::time_point{30s}
      ),
      "stale subscription failure replaced a healthy audio track"
    );
    const auto stale = reconciler.onTrackUnsubscribed(
      publication_id,
      publication,
      old_track
    );
    require(
      stale.matched && !stale.current && !stale.resubscribe &&
        reconciler.isCurrentDemandedTrack(publication_id, healthy_track),
      "old audio unsubscribe detached the healthy replacement"
    );
  };

  RemotePublicationReconciler microphone;
  const auto microphone_publication = microphonePublication();
  microphone.registerPublication(microphone_publication, "microphone-source");
  verify(microphone, microphone_publication, "microphone-track");

  RemotePublicationReconciler screen_audio;
  const auto screen_publication = screenPublication("screen-track-audio-guard");
  const auto screen_audio_publication = screenAudioPublication(
    "screen-audio-track-guard"
  );
  screen_audio.registerPublication(screen_publication, "screen-source");
  screen_audio.registerPublication(screen_audio_publication, "screen-source");
  screen_audio.setVideoDemand("screen-track-audio-guard", true);
  screen_audio.syncScreenAudioDemand("screen-source");
  verify(
    screen_audio,
    screen_audio_publication,
    "screen-audio-track-guard"
  );
}

void audioRetryBackoffIsCappedAndCoalesced() {
  using namespace std::chrono_literals;
  using namespace syrnike::desktop_native::media;
  RemotePublicationReconciler reconciler;
  const auto publication = microphonePublication();
  reconciler.registerPublication(publication, "source");
  reconciler.planReconcile("microphone-track");
  const auto started = std::chrono::steady_clock::time_point{40s};

  const auto first = reconciler.markSubscriptionFailed(
    "microphone-track",
    true,
    started
  );
  const auto duplicate = reconciler.markSubscriptionFailed(
    "microphone-track",
    true,
    started + 1ms
  );
  require(
    first && first->retry && duplicate && duplicate->retry &&
      duplicate->retry->attempt == 1 &&
      duplicate->retry->due_at == first->retry->due_at,
    "duplicate audio failure created another retry"
  );

  auto due = reconciler.takeDueAudioRetries(started + 250ms);
  require(due.size() == 1, "first audio retry was not dispatched once");
  auto plan = reconciler.planReconcile(
    due.front().publication_id,
    due.front().revision
  );
  const auto second = reconciler.markReconcileFailed(plan, started + 250ms);
  require(
    second && second->attempt == 2 &&
      second->due_at == started + 1250ms,
    "second audio retry did not use one-second backoff"
  );

  due = reconciler.takeDueAudioRetries(started + 1250ms);
  plan = reconciler.planReconcile(due.front().publication_id, due.front().revision);
  const auto third = reconciler.markReconcileFailed(plan, started + 1250ms);
  require(
    third && third->attempt == 3 &&
      third->due_at == started + 6250ms,
    "third audio retry did not use five-second backoff"
  );

  due = reconciler.takeDueAudioRetries(started + 6250ms);
  plan = reconciler.planReconcile(due.front().publication_id, due.front().revision);
  const auto exhausted = reconciler.markSubscriptionFailed(
    "microphone-track",
    true,
    started + 6250ms
  );
  require(
    plan.command == RemotePublicationReconcileCommand::Subscribe &&
      exhausted && !exhausted->retry && exhausted->retry_exhausted &&
      !reconciler.nextAudioRetryDeadline() &&
      reconciler.audioFailureOwnsReconcile("microphone-track"),
    "audio retry exceeded its three-attempt budget"
  );
}

void audioSuccessAndReconnectResetRetryBudget() {
  using namespace std::chrono_literals;
  using namespace syrnike::desktop_native::media;
  RemotePublicationReconciler reconciler;
  auto publication = microphonePublication();
  reconciler.registerPublication(publication, "source");
  reconciler.planReconcile("microphone-track");
  const auto started = std::chrono::steady_clock::time_point{50s};
  const auto first = reconciler.markSubscriptionFailed(
    "microphone-track",
    true,
    started
  );
  const auto due = reconciler.takeDueAudioRetries(started + 250ms);
  const auto plan = reconciler.planReconcile(
    due.front().publication_id,
    due.front().revision
  );
  const auto second = reconciler.markReconcileFailed(plan, started + 250ms);
  require(
    first && first->retry && second && second->attempt == 2,
    "audio retry setup did not reach the second attempt"
  );

  const auto healthy = std::make_shared<TestTrack>(
    "microphone-healthy",
    livekit::TrackKind::KIND_AUDIO
  );
  reconciler.onTrackSubscribed("microphone-track", publication, healthy);
  require(
    reconciler.takeDueAudioRetries(second->due_at).empty() &&
      !reconciler.audioFailureOwnsReconcile("microphone-track"),
    "successful audio subscription left an old retry armed"
  );
  const auto unsubscribed = reconciler.onTrackUnsubscribed(
    "microphone-track",
    publication,
    healthy
  );
  require(
    unsubscribed.current && unsubscribed.resubscribe,
    "healthy audio unsubscribe did not preserve demand"
  );
  reconciler.planReconcile("microphone-track");
  const auto after_success = reconciler.markSubscriptionFailed(
    "microphone-track",
    true,
    started + 2s
  );
  require(
    after_success && after_success->retry &&
      after_success->retry->attempt == 1,
    "successful audio subscription did not reset retry budget"
  );

  auto old_retry = *after_success->retry;
  reconciler.resetAudioRetriesForReconnect();
  require(
    reconciler.takeDueAudioRetries(old_retry.due_at).empty() &&
      reconciler.planReconcile(
        old_retry.publication_id,
        old_retry.revision
      ).command == RemotePublicationReconcileCommand::None,
    "reconnect did not fence the old audio retry"
  );
  reconciler.planReconcile("microphone-track");
  const auto after_reconnect = reconciler.markSubscriptionFailed(
    "microphone-track",
    true,
    started + 3s
  );
  require(
    after_reconnect && after_reconnect->retry &&
      after_reconnect->retry->attempt == 1,
    "reconnect did not reset retry budget"
  );

  old_retry = *after_reconnect->retry;
  const auto old_publication = publication;
  publication = microphonePublication();
  const auto replacement = reconciler.registerPublication(publication, "source");
  const auto stale_track = std::make_shared<TestTrack>(
    "microphone-stale",
    livekit::TrackKind::KIND_AUDIO
  );
  require(
    replacement && replacement->revision != old_retry.revision &&
      reconciler.takeDueAudioRetries(old_retry.due_at).empty() &&
      reconciler.planReconcile(
        old_retry.publication_id,
        old_retry.revision
      ).command == RemotePublicationReconcileCommand::None &&
      !reconciler.onTrackSubscribed(
        "microphone-track",
        old_publication,
        stale_track
      ).matched &&
      !reconciler.onTrackSubscribed(
        "microphone-track",
        {},
        stale_track
      ).matched,
    "publication replacement did not fence the old retry generation"
  );
  reconciler.planReconcile("microphone-track", replacement->revision);
  const auto after_replacement = reconciler.markSubscriptionFailed(
    "microphone-track",
    true,
    started + 4s
  );
  require(
    after_replacement && after_replacement->retry &&
      after_replacement->retry->attempt == 1,
    "publication replacement did not reset retry budget"
  );
}

void rejectedRetryPostBacksOffWithoutStorming() {
  using namespace std::chrono_literals;
  using namespace syrnike::desktop_native::media;
  RemotePublicationReconciler reconciler;
  const auto publication = microphonePublication();
  reconciler.registerPublication(publication, "source");
  reconciler.planReconcile("microphone-track");
  const auto started = std::chrono::steady_clock::time_point{60s};
  const auto failure = reconciler.markSubscriptionFailed(
    "microphone-track",
    true,
    started
  );
  const auto due = reconciler.takeDueAudioRetries(started + 250ms);
  require(
    failure && failure->retry && due.size() == 1,
    "blocked retry setup did not dispatch one token"
  );
  require(
    reconciler.registerPublication(publication, "source")->revision ==
      due.front().revision,
    "duplicate publication callback invalidated an in-flight retry"
  );
  require(
    !reconciler.markSubscriptionFailed(
      "microphone-track",
      true,
      started + 251ms
    )->retry,
    "failure callback duplicated an in-flight retry post"
  );

  const auto rescheduled = reconciler.markAudioRetryDispatchFailed(
    due.front(),
    started + 250ms
  );
  require(
    rescheduled && rescheduled->attempt == 2 &&
      rescheduled->due_at == started + 1250ms &&
      !reconciler.markAudioRetryDispatchFailed(
        due.front(),
        started + 250ms
      ),
    "rejected retry post was not rescheduled exactly once"
  );
  require(
    reconciler.takeDueAudioRetries(started + 1249ms).empty() &&
      reconciler.takeDueAudioRetries(started + 1250ms).size() == 1 &&
      reconciler.takeDueAudioRetries(started + 1250ms).empty(),
    "blocked retry post stormed before or at its next deadline"
  );
}

void canonicalPublicationCommitsOnlyOnActiveSubscribeEdge() {
  using namespace syrnike::desktop_native::media;
  RemotePublicationReconciler reconciler;
  const auto original = microphonePublication("canonical-track");
  const auto replacement = microphonePublication("canonical-track");
  const auto canonical = microphonePublication("canonical-track");
  reconciler.registerPublication(original, "source");
  const auto registered = reconciler.registerPublication(replacement, "source");
  const auto stale_track = std::make_shared<TestTrack>(
    "canonical-stale",
    livekit::TrackKind::KIND_AUDIO
  );
  require(
    !reconciler.onTrackSubscribed(
      "canonical-track",
      canonical,
      stale_track
    ).matched,
    "canonical publication replaced state without an active subscribe edge"
  );

  require(
    reconciler.planReconcile(
      "canonical-track",
      registered->revision
    ).command == RemotePublicationReconcileCommand::Subscribe,
    "canonical publication setup did not start subscribe edge"
  );
  const auto healthy_track = std::make_shared<TestTrack>(
    "canonical-healthy",
    livekit::TrackKind::KIND_AUDIO
  );
  const auto committed = reconciler.onTrackSubscribed(
    "canonical-track",
    canonical,
    healthy_track
  );
  require(
    committed.matched && committed.demanded &&
      reconciler.matches("canonical-track", canonical) &&
      reconciler.isCurrentDemandedTrack("canonical-track", healthy_track) &&
      !reconciler.onTrackSubscribed(
        "canonical-track",
        original,
        stale_track
      ).matched,
    "canonical subscribe commit did not fence the older publication"
  );
}

void microphonePublicationRemovalCancelsRetry() {
  using namespace std::chrono_literals;
  using namespace syrnike::desktop_native::media;
  RemotePublicationReconciler reconciler;
  const auto publication = microphonePublication("removed-microphone");
  reconciler.registerPublication(publication, "source");
  reconciler.planReconcile("removed-microphone");
  const auto started = std::chrono::steady_clock::time_point{70s};
  const auto failed = reconciler.markSubscriptionFailed(
    "removed-microphone",
    true,
    started
  );
  require(
    failed && failed->retry &&
      reconciler.removePublication("removed-microphone", publication) &&
      reconciler.takeDueAudioRetries(started + 250ms).empty() &&
      reconciler.planReconcile(
        "removed-microphone",
        failed->retry->revision
      ).command == RemotePublicationReconcileCommand::None,
    "microphone publication removal did not cancel its retry"
  );
}

void serverMuteRecoveryPreservesTwoViewerMediaState() {
  using namespace std::chrono_literals;
  using namespace syrnike::desktop_native::media;

  struct ViewerMedia {
    std::shared_ptr<livekit::RemoteTrackPublication> microphone_publication;
    std::shared_ptr<livekit::RemoteTrackPublication> camera_publication;
    std::shared_ptr<livekit::RemoteTrackPublication> screen_publication;
    std::shared_ptr<livekit::RemoteTrackPublication> screen_audio_publication;
    std::shared_ptr<TestTrack> microphone_track;
    std::shared_ptr<TestTrack> camera_track;
    std::shared_ptr<TestTrack> screen_track;
    std::shared_ptr<TestTrack> screen_audio_track;
    std::uint64_t camera_revision = 0;
    std::uint64_t screen_revision = 0;
    std::uint64_t screen_audio_revision = 0;
  };

  const auto subscribe = [](
    RemotePublicationReconciler& reconciler,
    const std::shared_ptr<livekit::RemoteTrackPublication>& publication,
    const std::shared_ptr<TestTrack>& track
  ) {
    const auto plan = reconciler.planReconcile(publication->sid());
    require(
      plan.command == RemotePublicationReconcileCommand::Subscribe,
      "demanded integration publication did not request subscription"
    );
    const auto subscribed = reconciler.onTrackSubscribed(
      publication->sid(),
      publication,
      track
    );
    require(
      subscribed.matched && subscribed.demanded && !subscribed.duplicate,
      "integration publication did not commit its demanded track"
    );
  };

  const auto seed_viewer = [&](RemotePublicationReconciler& reconciler) {
    ViewerMedia media{
      microphonePublication("publisher-microphone-1"),
      cameraPublication("publisher-camera"),
      screenPublication("publisher-screen"),
      screenAudioPublication("publisher-screen-audio"),
      std::make_shared<TestTrack>(
        "publisher-microphone-1-track",
        livekit::TrackKind::KIND_AUDIO
      ),
      std::make_shared<TestTrack>("publisher-camera-track"),
      std::make_shared<TestTrack>("publisher-screen-track"),
      std::make_shared<TestTrack>(
        "publisher-screen-audio-track",
        livekit::TrackKind::KIND_AUDIO
      )
    };
    reconciler.registerPublication(
      media.microphone_publication,
      "publisher"
    );
    reconciler.registerPublication(media.camera_publication, "publisher");
    reconciler.registerPublication(media.screen_publication, "publisher");
    reconciler.registerPublication(
      media.screen_audio_publication,
      "publisher"
    );
    reconciler.setVideoDemand(media.camera_publication->sid(), true);
    reconciler.setVideoDemand(media.screen_publication->sid(), true);
    reconciler.syncScreenAudioDemand("publisher");
    subscribe(
      reconciler,
      media.microphone_publication,
      media.microphone_track
    );
    subscribe(reconciler, media.camera_publication, media.camera_track);
    subscribe(reconciler, media.screen_publication, media.screen_track);
    subscribe(
      reconciler,
      media.screen_audio_publication,
      media.screen_audio_track
    );
    media.camera_revision =
      reconciler.planReconcile(media.camera_publication->sid()).revision;
    media.screen_revision =
      reconciler.planReconcile(media.screen_publication->sid()).revision;
    media.screen_audio_revision =
      reconciler.planReconcile(media.screen_audio_publication->sid()).revision;
    return media;
  };

  const auto require_unrelated_media_stable = [](
    RemotePublicationReconciler& reconciler,
    const ViewerMedia& media
  ) {
    const auto camera =
      reconciler.planReconcile(media.camera_publication->sid());
    const auto screen =
      reconciler.planReconcile(media.screen_publication->sid());
    const auto screen_audio =
      reconciler.planReconcile(media.screen_audio_publication->sid());
    require(
      reconciler.isCurrentDemandedTrack(
        media.camera_publication->sid(),
        media.camera_track
      ) &&
        reconciler.isCurrentDemandedTrack(
          media.screen_publication->sid(),
          media.screen_track
        ) &&
        reconciler.isCurrentDemandedTrack(
          media.screen_audio_publication->sid(),
          media.screen_audio_track
        ) &&
        camera.command == RemotePublicationReconcileCommand::None &&
        screen.command == RemotePublicationReconcileCommand::None &&
        screen_audio.command == RemotePublicationReconcileCommand::None &&
        camera.revision == media.camera_revision &&
        screen.revision == media.screen_revision &&
        screen_audio.revision == media.screen_audio_revision,
      "server mute changed an unrelated publication, demand, or revision"
    );
  };

  RemotePublicationReconciler viewer_a;
  RemotePublicationReconciler viewer_b;
  auto media_a = seed_viewer(viewer_a);
  auto media_b = seed_viewer(viewer_b);
  const auto initial_microphone_sid = media_a.microphone_publication->sid();
  const auto viewer_a_microphone_revision =
    viewer_a.planReconcile(initial_microphone_sid).revision;
  const auto viewer_b_microphone_revision =
    viewer_b.planReconcile(initial_microphone_sid).revision;
  const auto viewer_a_publication_ids = viewer_a.publicationIds();
  const auto viewer_b_publication_ids = viewer_b.publicationIds();

  for (std::uint32_t cycle = 1; cycle <= 3; ++cycle) {
    const auto viewer_a_microphone =
      viewer_a.planReconcile(initial_microphone_sid);
    const auto viewer_b_microphone =
      viewer_b.planReconcile(initial_microphone_sid);
    require(
      viewer_a.publicationIds() == viewer_a_publication_ids &&
        viewer_b.publicationIds() == viewer_b_publication_ids &&
        viewer_a.isCurrentDemandedTrack(
          initial_microphone_sid,
          media_a.microphone_track
        ) &&
        viewer_b.isCurrentDemandedTrack(
          initial_microphone_sid,
          media_b.microphone_track
        ) &&
        viewer_a_microphone.command ==
          RemotePublicationReconcileCommand::None &&
        viewer_b_microphone.command ==
          RemotePublicationReconcileCommand::None &&
        viewer_a_microphone.revision == viewer_a_microphone_revision &&
        viewer_b_microphone.revision == viewer_b_microphone_revision,
      "server mute cycle changed microphone identity, demand, or revision"
    );
    require_unrelated_media_stable(viewer_a, media_a);
    require_unrelated_media_stable(viewer_b, media_b);
  }

  const auto retry_started = std::chrono::steady_clock::time_point{80s};

  for (std::uint32_t cycle = 1; cycle <= 3; ++cycle) {
    require(
      viewer_a.removePublication(
        media_a.microphone_publication->sid(),
        media_a.microphone_publication
      ).has_value() &&
        viewer_b.removePublication(
          media_b.microphone_publication->sid(),
          media_b.microphone_publication
        ).has_value(),
      "publication replacement did not remove the current microphone"
    );
    require_unrelated_media_stable(viewer_a, media_a);
    require_unrelated_media_stable(viewer_b, media_b);

    const auto microphone_sid =
      "publisher-microphone-" + std::to_string(cycle + 1);
    media_a.microphone_publication = microphonePublication(microphone_sid);
    media_b.microphone_publication = microphonePublication(microphone_sid);
    media_a.microphone_track = std::make_shared<TestTrack>(
      microphone_sid + "-viewer-a",
      livekit::TrackKind::KIND_AUDIO
    );
    media_b.microphone_track = std::make_shared<TestTrack>(
      microphone_sid + "-viewer-b",
      livekit::TrackKind::KIND_AUDIO
    );
    viewer_a.registerPublication(media_a.microphone_publication, "publisher");
    viewer_b.registerPublication(media_b.microphone_publication, "publisher");

    if (cycle == 1) {
      require(
        viewer_a.planReconcile(microphone_sid).command ==
          RemotePublicationReconcileCommand::Subscribe,
        "viewer A did not start its restored microphone subscription"
      );
      const auto failure = viewer_a.markSubscriptionFailed(
        microphone_sid,
        true,
        retry_started
      );
      require(
        failure && failure->retry && failure->retry->attempt == 1 &&
          failure->retry->due_at == retry_started + 250ms &&
          viewer_a.takeDueAudioRetries(retry_started + 249ms).empty(),
        "viewer A did not retain the bounded first audio retry"
      );
      const auto due =
        viewer_a.takeDueAudioRetries(retry_started + 250ms);
      require(
        due.size() == 1 && due.front().publication_id == microphone_sid,
        "viewer A did not dispatch exactly one restored-audio retry"
      );
      require(
        viewer_a.planReconcile(
          microphone_sid,
          due.front().revision
        ).command == RemotePublicationReconcileCommand::Subscribe,
        "viewer A retry did not resume the fenced subscription"
      );
      const auto recovered = viewer_a.onTrackSubscribed(
        microphone_sid,
        media_a.microphone_publication,
        media_a.microphone_track
      );
      require(
        recovered.matched && recovered.demanded &&
          !viewer_a.nextAudioRetryDeadline(),
        "viewer A recovery did not cancel its completed retry"
      );
    } else {
      subscribe(
        viewer_a,
        media_a.microphone_publication,
        media_a.microphone_track
      );
    }
    subscribe(
      viewer_b,
      media_b.microphone_publication,
      media_b.microphone_track
    );
    require(
      !viewer_b.nextAudioRetryDeadline() &&
        viewer_a.publicationIds().size() == 4 &&
        viewer_b.publicationIds().size() == 4 &&
        viewer_a.contains(microphone_sid) &&
        viewer_b.contains(microphone_sid),
      "publication replacement duplicated a publication or coupled retry state"
    );
    require_unrelated_media_stable(viewer_a, media_a);
    require_unrelated_media_stable(viewer_b, media_b);
  }

  viewer_a.resetAudioRetriesForReconnect();
  viewer_b.resetAudioRetriesForReconnect();
  require(
    viewer_a.planReconcile(media_a.microphone_publication->sid()).command ==
        RemotePublicationReconcileCommand::None &&
      viewer_b.planReconcile(media_b.microphone_publication->sid()).command ==
        RemotePublicationReconcileCommand::None &&
      viewer_a.isCurrentDemandedTrack(
        media_a.screen_audio_publication->sid(),
        media_a.screen_audio_track
      ) &&
      viewer_b.isCurrentDemandedTrack(
        media_b.screen_audio_publication->sid(),
        media_b.screen_audio_track
      ) &&
      viewer_a.planReconcile(media_a.camera_publication->sid()).revision ==
        media_a.camera_revision &&
      viewer_b.planReconcile(media_b.screen_publication->sid()).revision ==
        media_b.screen_revision,
    "Room reconnect republished or detached healthy unrelated media"
  );
}

}  // namespace

int main() try {
  publicationKindOwnsDefaultDemand();
  screenAudioFollowsMatchingScreenDemand();
  lateScreenAudioInheritsExistingScreenDemand();
  rapidResubscribeWaitsForActualUnsubscribe();
  recoveryPreservesHealthySubscriptionDuringLocalBridgeFailures();
  lateOldUnsubscribeCannotDetachReplacementTrack();
  microphoneFailureSchedulesOneBoundedRetry();
  screenAudioRetryIsIndependentAndCancelledWithDemand();
  healthyAudioTrackRejectsStaleFailureAndOldUnsubscribe();
  audioRetryBackoffIsCappedAndCoalesced();
  audioSuccessAndReconnectResetRetryBudget();
  rejectedRetryPostBacksOffWithoutStorming();
  canonicalPublicationCommitsOnlyOnActiveSubscribeEdge();
  microphonePublicationRemovalCancelsRetry();
  serverMuteRecoveryPreservesTwoViewerMediaState();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
} catch (...) {
  std::cerr << "unknown remote publication reconciler test failure\n";
  return 1;
}
