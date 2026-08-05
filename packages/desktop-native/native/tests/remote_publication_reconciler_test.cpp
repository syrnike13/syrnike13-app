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

std::shared_ptr<livekit::RemoteTrackPublication> microphonePublication() {
  livekit::proto::OwnedTrackPublication owned;
  owned.mutable_handle()->set_id(0);
  auto* info = owned.mutable_info();
  info->set_sid("microphone-track");
  info->set_name("microphone");
  info->set_kind(livekit::proto::KIND_AUDIO);
  info->set_source(livekit::proto::SOURCE_MICROPHONE);
  info->set_remote(true);
  info->set_encryption_type(livekit::proto::NONE);
  return std::make_shared<livekit::RemoteTrackPublication>(owned);
}

std::shared_ptr<livekit::RemoteTrackPublication> screenAudioPublication() {
  livekit::proto::OwnedTrackPublication owned;
  owned.mutable_handle()->set_id(0);
  auto* info = owned.mutable_info();
  info->set_sid("screen-audio-track");
  info->set_name("screen-audio");
  info->set_kind(livekit::proto::KIND_AUDIO);
  info->set_source(livekit::proto::SOURCE_SCREENSHARE_AUDIO);
  info->set_remote(true);
  info->set_encryption_type(livekit::proto::NONE);
  return std::make_shared<livekit::RemoteTrackPublication>(owned);
}

class TestTrack final : public livekit::Track {
 public:
  explicit TestTrack(std::string sid)
    : Track(
        livekit::FfiHandle{},
        std::move(sid),
        "screen",
        livekit::TrackKind::KIND_VIDEO,
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

}  // namespace

int main() try {
  publicationKindOwnsDefaultDemand();
  screenAudioFollowsMatchingScreenDemand();
  lateScreenAudioInheritsExistingScreenDemand();
  rapidResubscribeWaitsForActualUnsubscribe();
  recoveryPreservesHealthySubscriptionDuringLocalBridgeFailures();
  lateOldUnsubscribeCannotDetachReplacementTrack();
  return 0;
} catch (...) {
  return 1;
}
