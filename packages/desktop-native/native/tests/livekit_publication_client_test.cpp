#include <chrono>
#include <future>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

#include <livekit/livekit.h>

#include "media/livekit_publication_client.hpp"

namespace {

using namespace std::chrono_literals;

template <typename Future>
void requireNotReady(Future& future, const char* message) {
  if (future.wait_for(0ms) != std::future_status::timeout) {
    throw std::runtime_error(message);
  }
}

template <typename Future>
void requireReady(Future& future, const char* message) {
  if (future.wait_for(1s) != std::future_status::ready) {
    throw std::runtime_error(message);
  }
}

}  // namespace

int main() try {
  using syrnike::desktop_native::media::DeterministicFakeLiveKitPublicationClient;
  using syrnike::desktop_native::media::LiveKitPublicationClient;

  auto client = std::make_shared<DeterministicFakeLiveKitPublicationClient>();
  auto noop_post = LiveKitPublicationClient::InternalPost{[](syrnike::desktop_native::MediaCommand) {
    return true;
  }};

  // Room connect/disconnect gates belong only to the voice owner. Creating a
  // track publication must never enter either gate.
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Connect, true);
  auto connect_future = std::async(std::launch::async, [&] {
    return client->connectVoice(
      "voice", 1, "wss://example.invalid", "token", noop_post);
  });
  client->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Connect, 1);
  requireNotReady(connect_future, "blocked connect completed before release");
  client->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Connect);
  requireReady(connect_future, "released connect did not finish");
  if (!connect_future.get()) {
    throw std::runtime_error("released connect returned false");
  }

  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Publish, true);
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, true);

  auto blocked_publish = client->createMicrophonePublication("voice", 1);
  auto blocked_unpublish = client->createScreenPublication("voice", 1);
  if (!blocked_publish->isRoomConnected() || !blocked_unpublish->isRoomConnected()) {
    throw std::runtime_error("track publication did not observe the shared voice Room");
  }
  if (client->pending(DeterministicFakeLiveKitPublicationClient::Operation::Connect) != 0) {
    throw std::runtime_error("track publication attempted to connect its own Room");
  }
  auto publish_future = std::async(std::launch::async, [&] {
    return blocked_publish->publishAudioTrack({}, livekit::TrackPublishOptions{});
  });
  client->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Publish, 1);
  requireNotReady(publish_future, "blocked publish completed before release");

  auto unpublish_future = std::async(std::launch::async, [&] {
    blocked_unpublish->unpublishTrack("publication-1");
    return true;
  });
  client->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, 1);
  requireNotReady(unpublish_future, "blocked unpublish completed before release");

  client->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish);
  requireReady(unpublish_future, "released unpublish did not finish");
  if (!unpublish_future.get()) {
    throw std::runtime_error("released unpublish returned false");
  }
  requireNotReady(publish_future, "unpublish release also unblocked publish");

  DeterministicFakeLiveKitPublicationClient::Release publish_release;
  publish_release.bool_result = true;
  publish_release.publication_sid = "published-audio";
  client->releaseNext(
    DeterministicFakeLiveKitPublicationClient::Operation::Publish,
    std::move(publish_release)
  );
  requireReady(publish_future, "released publish did not finish");
  if (publish_future.get() != "published-audio") {
    throw std::runtime_error("publish release lost its deterministic publication SID");
  }

  auto failing_client = std::make_shared<DeterministicFakeLiveKitPublicationClient>();
  failing_client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Connect, true);
  auto failing_future = std::async(std::launch::async, [&] {
    return failing_client->connectVoice(
      "failing", 1, "wss://example.invalid", "token", noop_post);
  });
  failing_client->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Connect, 1);
  DeterministicFakeLiveKitPublicationClient::Release failed_connect_release;
  failed_connect_release.bool_result = false;
  failing_client->releaseNext(
    DeterministicFakeLiveKitPublicationClient::Operation::Connect,
    std::move(failed_connect_release)
  );
  requireReady(failing_future, "released failing connect did not finish");
  if (failing_future.get()) {
    throw std::runtime_error("connect failure release returned true");
  }

  // The target runtime owns one voice Room. Track sessions reuse it and may
  // retire independently without disconnecting the shared participant.
  auto shared_client = std::make_shared<DeterministicFakeLiveKitPublicationClient>();
  if (!shared_client->connectVoice(
        "voice-op",
        1,
        "wss://example.invalid",
        "shared-token",
        noop_post
      )) {
    throw std::runtime_error("shared voice Room did not connect");
  }
  bool conflicting_duplicate_rejected = false;
  try {
    shared_client->connectVoice(
      "voice-op", 1, "wss://example.invalid", "other-token", noop_post);
  } catch (const std::exception&) {
    conflicting_duplicate_rejected = true;
  }
  if (!conflicting_duplicate_rejected) {
    throw std::runtime_error("duplicate voice epoch accepted another credential lease");
  }
  auto shared_microphone = shared_client->createMicrophonePublication("voice-op", 41);
  auto shared_screen = shared_client->createScreenPublication("voice-op", 93);
  if (!shared_microphone->isRoomConnected() || !shared_screen->isRoomConnected()) {
    throw std::runtime_error("track publication did not reuse shared voice Room");
  }
  auto stale_publication = shared_client->createCameraPublication("voice-op", 7);
  shared_microphone.reset();
  shared_screen.reset();
  if (!shared_client->isVoiceConnected()) {
    throw std::runtime_error("track retirement disconnected shared voice Room");
  }
  // Receive-side controls are properties of the existing Room lease. They
  // must not reconnect or retire the participant.
  shared_client->setVoiceDeafened(true);
  const auto output_epoch_a =
    shared_client->setVoiceOutputDevice(
      "communications-output",
      syrnike::desktop_native::media::AudioOutputDeviceIntent::UserConfiguration
    );
  if (!shared_client->isVoiceOutputEpochCurrent(output_epoch_a)) {
    throw std::runtime_error("committed output renderer epoch was not current");
  }
  const auto output_epoch_b = shared_client->setVoiceOutputDevice(
    "default",
    syrnike::desktop_native::media::AudioOutputDeviceIntent::UserConfiguration
  );
  if (shared_client->isVoiceOutputEpochCurrent(output_epoch_a) ||
      !shared_client->isVoiceOutputEpochCurrent(output_epoch_b)) {
    throw std::runtime_error("replaced output renderer epoch accepted a stale failure");
  }
  shared_client->setVoiceDeafened(false);
  if (!shared_client->isVoiceConnected()) {
    throw std::runtime_error("output/deafen update disconnected shared voice Room");
  }
  shared_client->disconnectVoice();
  if (!shared_client->connectVoice(
        "voice-recovered", 2, "wss://example.invalid", "replacement-token", noop_post)) {
    throw std::runtime_error("replacement voice Room did not connect");
  }
  if (stale_publication->isRoomConnected()) {
    throw std::runtime_error("old track publication observed the replacement voice Room");
  }
  bool stale_publish_rejected = false;
  try {
    stale_publication->publishVideoTrack({}, livekit::TrackPublishOptions{});
  } catch (const std::exception&) {
    stale_publish_rejected = true;
  }
  if (!stale_publish_rejected) {
    throw std::runtime_error("old track publication published into a replacement voice Room");
  }
  shared_client->disconnectVoice();
  for (int attempt = 0; attempt < 32; ++attempt) shared_client->disconnectVoice();
  if (shared_client->isVoiceConnected()) {
    throw std::runtime_error("explicit voice disconnect left shared Room connected");
  }

  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
