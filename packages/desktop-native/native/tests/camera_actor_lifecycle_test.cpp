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
  result.livekit_url = "wss://example.invalid"; result.livekit_token = "token";
  result.width = 16; result.height = 16; result.fps = 30;
  return result;
}
}

int main() try {
  if (!livekit::initialize(livekit::LogLevel::Off)) return 1;
  auto sink = std::make_shared<Sink>();
  SequencedEmitter emitter(sink);
  auto client = std::make_shared<DeterministicFakeLiveKitPublicationClient>();
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

  // A publication blocked in the worker must not occupy the camera command lane.
  // Disconnect settles the original request immediately; a newer generation can
  // start before the stale SDK call returns.
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Connect, true);
  actor->connect(command(2, "blocked"));
  client->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Connect, 1);
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
  client->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Connect,
    {.bool_result = false});
  for (int i = 0; i < 200 &&
      client->pending(DeterministicFakeLiveKitPublicationClient::Operation::Connect) != 0; ++i) {
    std::this_thread::sleep_for(5ms);
  }
  client->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Connect, false);
  client->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Connect,
    {.bool_result = false});
  actor->connect(command(3, "replacement"));
  const auto replacement_reply = waitReply(sink, "replacement");
  if (replacement_reply.ok || !replacement_reply.error ||
      replacement_reply.error->code != "native_command_failed") {
    throw std::runtime_error("replacement camera attempt was not launched and settled");
  }

  actor->shutdown();
  actor.reset();
  livekit::shutdown();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  livekit::shutdown();
  return 1;
}
