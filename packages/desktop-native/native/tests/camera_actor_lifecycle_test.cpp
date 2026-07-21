#include <livekit/livekit.h>

#include <atomic>
#include <chrono>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

#include "common/event_sink.hpp"
#include "media/camera_actor.hpp"

namespace {
using namespace std::chrono_literals;
using namespace syrnike::desktop_native;
using namespace syrnike::desktop_native::media;

class Sink final : public EventSink {
 public:
  bool emit(RuntimeEvent event) override { std::lock_guard lock(mutex); events.push_back(std::move(event)); return true; }
  void close() override {}
  std::mutex mutex;
  std::vector<RuntimeEvent> events;
};

RuntimeEvent waitReply(const std::shared_ptr<Sink>& sink, const std::string& request_id) {
  for (int i = 0; i < 1000; ++i) {
    {
      std::lock_guard lock(sink->mutex);
      for (const auto& event : sink->events) {
        if (event.type == "reply" && event.request_id == request_id) return event;
      }
    }
    std::this_thread::sleep_for(5ms);
  }
  throw std::runtime_error("timed out waiting for camera reply");
}

class Capture final : public CameraCapture {
 public:
  explicit Capture(bool fail) : fail_(fail) {}
  bool read(CameraFrame& frame, const std::atomic_bool& running) override {
    if (fail_) throw std::runtime_error("fake camera failure");
    std::this_thread::sleep_for(2ms);
    if (!running.load()) return false;
    frame.width = 16; frame.height = 16; frame.bgra.assign(16 * 16 * 4, 0);
    return true;
  }
 private: bool fail_;
};

class Factory final : public CameraCaptureFactory {
 public:
  std::unique_ptr<CameraCapture> create(const std::string&, std::uint32_t,
      std::uint32_t, int) override { return std::make_unique<Capture>(fail.load()); }
  std::atomic_bool fail{false};
};

MediaCommand command(std::uint64_t generation, std::string request_id = "request") {
  MediaCommand result;
  result.type = "connectCamera"; result.request_id = std::move(request_id);
  result.session_id = "voice"; result.generation = generation;
  result.participant_identity = "user:native-camera";
  result.width = 16; result.height = 16; result.fps = 30;
  return result;
}
}

int main() try {
  if (!livekit::initialize(livekit::LogLevel::Off)) return 1;
  auto sink = std::make_shared<Sink>();
  SequencedEmitter emitter(sink);
  auto client = std::make_shared<DeterministicFakeLiveKitPublicationClient>();
  client->setVoiceSessionForTest("voice");
  auto factory = std::make_shared<Factory>();
  std::mutex posted_mutex;
  std::vector<MediaCommand> posted;
  std::atomic_uint64_t current{1};
  auto actor = std::make_unique<CameraActor>(emitter, [&](MediaCommand value) {
    std::lock_guard lock(posted_mutex); posted.push_back(std::move(value)); return true;
  }, [&](const std::string&, std::uint64_t generation) { return generation == current.load(); },
    client, factory);

  current.store(2);
  bool stale = false;
  try { actor->connect(command(1)); } catch (const std::exception&) { stale = true; }
  if (!stale) throw std::runtime_error("stale camera generation was accepted");

  MediaCommand probe;
  probe.type = "probeCameraActor";
  probe.request_id = "probe-available";
  if (actor->probe(probe).state != "available") {
    throw std::runtime_error("idle camera actor did not report available capacity");
  }

  // A publication blocked in the worker must not occupy the camera command lane.
  // Disconnect settles the original request immediately; a newer generation can
  // start before the stale SDK call returns.
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Publish, true);
  actor->connect(command(2, "blocked"));
  client->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Publish, 1);
  probe.request_id = "probe-busy";
  if (actor->probe(probe).state != "busy") {
    throw std::runtime_error("pending camera publication did not report busy capacity");
  }
  current.store(3);
  auto cancel = command(2, "cancel"); cancel.type = "disconnectCamera";
  const auto started = std::chrono::steady_clock::now();
  actor->disconnect(cancel);
  if (std::chrono::steady_clock::now() - started > 250ms) {
    throw std::runtime_error("disconnect blocked behind camera publication");
  }
  const auto blocked_reply = waitReply(sink, "blocked");
  if (blocked_reply.ok || !blocked_reply.error ||
      blocked_reply.error->code != "stale_generation") {
    throw std::runtime_error("cancelled camera connect did not receive typed reply");
  }
  client->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Publish,
    {.publication_sid = {}});
  for (int i = 0; i < 200 &&
      client->pending(DeterministicFakeLiveKitPublicationClient::Operation::Publish) != 0; ++i) {
    std::this_thread::sleep_for(5ms);
  }
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Publish, false);
  actor->connect(command(3, "replacement"));
  const auto replacement_reply = waitReply(sink, "replacement");
  if (!replacement_reply.ok) {
    throw std::runtime_error("replacement camera attempt was not launched and settled");
  }

  current.store(4);
  actor->connect(command(4, "preview"));
  const auto preview_reply = waitReply(sink, "preview");
  if (!preview_reply.ok || client->localCameraPreviewStartCount() != 2) {
    throw std::runtime_error("camera publication did not start its local preview");
  }
  auto disconnect = command(4, "disconnect-preview");
  disconnect.type = "disconnectCamera";
  actor->disconnect(disconnect);
  if (client->localCameraPreviewStopCount() != 2) {
    throw std::runtime_error("camera disconnect did not stop its local preview");
  }

  // Cleanup failures are secondary: a stale attempt still settles with its
  // original typed result even when the SDK throws while unpublishing it.
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Publish, true);
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, true);
  current.store(5);
  actor->connect(command(5, "cleanup-throws"));
  client->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Publish, 1);
  current.store(6);
  client->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Publish,
    {.publication_sid = "cleanup-publication"});
  client->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, 1);
  client->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish,
    {.error_message = "injected unpublish cleanup failure"});
  const auto cleanup_reply = waitReply(sink, "cleanup-throws");
  if (cleanup_reply.ok || !cleanup_reply.error ||
      cleanup_reply.error->code != "stale_generation") {
    throw std::runtime_error("camera cleanup exception suppressed the original failure");
  }
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Publish, false);
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, false);

  actor->shutdown();
  actor.reset();
  livekit::shutdown();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  livekit::shutdown();
  return 1;
}
