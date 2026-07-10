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

  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Connect, true);
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Disconnect, true);

  auto blocked_connect = client->createMicrophoneSession("mic", 1, noop_post);
  auto blocked_disconnect = client->createScreenSession("screen", 9, noop_post);
  auto connect_future = std::async(std::launch::async, [&] {
    return blocked_connect->connect("wss://example.invalid", "token", livekit::RoomOptions{});
  });
  client->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Connect, 1);
  requireNotReady(connect_future, "blocked connect completed before release");

  auto disconnect_future = std::async(std::launch::async, [&] {
    blocked_disconnect->disconnect();
    return true;
  });
  client->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Disconnect, 1);
  requireNotReady(disconnect_future, "blocked disconnect completed before release");

  client->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Disconnect);
  requireReady(disconnect_future, "released disconnect did not finish");
  if (!disconnect_future.get()) {
    throw std::runtime_error("released disconnect returned false");
  }
  requireNotReady(connect_future, "disconnect release also unblocked connect");

  client->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Connect);
  requireReady(connect_future, "released connect did not finish");
  if (!connect_future.get()) {
    throw std::runtime_error("released connect returned false");
  }

  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Publish, true);
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, true);

  auto blocked_publish = client->createMicrophoneSession("mic", 2, noop_post);
  auto blocked_unpublish = client->createScreenSession("screen", 10, noop_post);
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

  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Connect, true);
  auto failing_connect = client->createMicrophoneSession("mic", 3, noop_post);
  auto failing_future = std::async(std::launch::async, [&] {
    return failing_connect->connect("wss://example.invalid", "token", livekit::RoomOptions{});
  });
  client->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Connect, 1);
  DeterministicFakeLiveKitPublicationClient::Release failed_connect_release;
  failed_connect_release.bool_result = false;
  client->releaseNext(
    DeterministicFakeLiveKitPublicationClient::Operation::Connect,
    std::move(failed_connect_release)
  );
  requireReady(failing_future, "released failing connect did not finish");
  if (failing_future.get()) {
    throw std::runtime_error("connect failure release returned true");
  }

  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
