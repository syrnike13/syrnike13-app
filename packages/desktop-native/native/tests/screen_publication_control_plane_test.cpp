#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "common/event_sink.hpp"
#include "media/livekit_publication_client.hpp"
#include "media/media_runtime.hpp"

namespace {

using namespace std::chrono_literals;

class CollectingSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent event) override {
    {
      std::lock_guard lock(mutex_);
      events_.push_back(std::move(event));
    }
    changed_.notify_all();
    return true;
  }

  void close() override {}

  syrnike::desktop_native::RuntimeEvent waitReply(
    const std::string& request_id,
    std::chrono::milliseconds timeout = 2s
  ) {
    std::unique_lock lock(mutex_);
    const bool found = changed_.wait_for(lock, timeout, [&] {
      for (const auto& event : events_) {
        if (event.type == "reply" && event.request_id == request_id) return true;
      }
      return false;
    });
    if (!found) throw std::runtime_error("timed out waiting for runtime reply: " + request_id);
    for (const auto& event : events_) {
      if (event.type == "reply" && event.request_id == request_id) return event;
    }
    throw std::runtime_error("runtime reply disappeared");
  }

  syrnike::desktop_native::RuntimeEvent waitEvent(
    const std::string& type,
    const std::string& session_id,
    std::uint64_t generation,
    std::chrono::milliseconds timeout = 500ms
  ) {
    std::unique_lock lock(mutex_);
    const bool found = changed_.wait_for(lock, timeout, [&] {
      for (const auto& event : events_) {
        if (event.type == type && event.session_id == session_id &&
            event.generation == generation) {
          return true;
        }
      }
      return false;
    });
    if (!found) throw std::runtime_error("timed out waiting for runtime event: " + type);
    for (const auto& event : events_) {
      if (event.type == type && event.session_id == session_id &&
          event.generation == generation) {
        return event;
      }
    }
    throw std::runtime_error("runtime event disappeared");
  }

  std::size_t countSessionStarted(
    const std::string& session_id,
    std::uint64_t generation
  ) const {
    std::lock_guard lock(mutex_);
    std::size_t count = 0;
    for (const auto& event : events_) {
      if (event.type == "sessionStarted" && event.session_id == session_id &&
          event.generation == generation) {
        ++count;
      }
    }
    return count;
  }

 private:
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::vector<syrnike::desktop_native::RuntimeEvent> events_;
};

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

syrnike::desktop_native::MediaCommand screenCommand(
  std::string type,
  std::string request_id,
  std::string session_id,
  std::uint64_t generation
) {
  syrnike::desktop_native::MediaCommand command;
  command.type = std::move(type);
  command.request_id = std::move(request_id);
  command.session_id = std::move(session_id);
  command.generation = generation;
  command.livekit_url = "wss://livekit.example";
  command.livekit_token = "token";
  command.participant_identity = "user:desktop-native:screen";
  command.source_id = "screen:1";
  command.width = 1280;
  command.height = 720;
  command.fps = 30;
  command.bitrate = 2'500'000;
  command.audio_bitrate = 128'000;
  command.audio_requested = false;
  return command;
}

void requireProbe(
  syrnike::desktop_native::media::MediaRuntime& runtime,
  const std::shared_ptr<CollectingSink>& sink,
  const std::string& request_id
) {
  syrnike::desktop_native::MediaCommand probe;
  probe.type = "probeScreenActor";
  probe.request_id = request_id;
  require(runtime.dispatch(probe), "runtime rejected screen actor probe");
  require(
    sink->waitReply(request_id, 500ms).ok,
    "screen actor probe did not reply while LiveKit was blocked"
  );
}

}  // namespace

int main() try {
  using syrnike::desktop_native::media::DeterministicFakeLiveKitPublicationClient;
  using syrnike::desktop_native::media::MediaRuntime;

  auto sink = std::make_shared<CollectingSink>();
  auto livekit = std::make_shared<DeterministicFakeLiveKitPublicationClient>();
  const auto clock_origin = std::chrono::steady_clock::now();
  std::atomic<std::int64_t> clock_offset_ms{0};
  MediaRuntime runtime(sink, livekit, [&] {
    return clock_origin + std::chrono::milliseconds(clock_offset_ms.load());
  });

  livekit->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Connect, true);
  const auto prepare_a = screenCommand("connectScreen", "prepare-a", "screen-a", 1);
  require(runtime.dispatch(prepare_a), "runtime rejected blocked screen connect");
  livekit->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Connect, 1);
  requireProbe(runtime, sink, "probe-connect");

  const auto supersede_a = screenCommand("connectScreen", "supersede-a", "screen-a", 2);
  require(runtime.dispatch(supersede_a), "runtime rejected bounded screen supersession");
  const auto supersede_reply = sink->waitReply("supersede-a", 500ms);
  require(!supersede_reply.ok, "second screen attempt unexpectedly started in parallel");
  require(
    supersede_reply.error && supersede_reply.error->code == "actor_busy",
    "healthy bounded screen contention did not fail fast as actor_busy"
  );
  require(
    livekit->pending(DeterministicFakeLiveKitPublicationClient::Operation::Connect) == 1,
    "screen actor spawned a second LiveKit connect worker"
  );

  clock_offset_ms.store(21'000);
  const auto overdue_a = screenCommand("connectScreen", "overdue-a", "screen-a", 3);
  require(runtime.dispatch(overdue_a), "runtime rejected overdue screen attempt check");
  const auto overdue_reply = sink->waitReply("overdue-a", 500ms);
  require(!overdue_reply.ok, "overdue screen attempt unexpectedly started in parallel");
  require(
    overdue_reply.error && overdue_reply.error->code == "actor_unresponsive",
    "lost screen attempt capacity did not fail as actor_unresponsive"
  );

  syrnike::desktop_native::MediaCommand overdue_probe;
  overdue_probe.type = "probeScreenActor";
  overdue_probe.request_id = "probe-overdue";
  require(runtime.dispatch(overdue_probe), "runtime rejected overdue screen actor probe");
  const auto overdue_probe_reply = sink->waitReply("probe-overdue", 500ms);
  require(
    !overdue_probe_reply.ok && overdue_probe_reply.error &&
      overdue_probe_reply.error->code == "actor_unresponsive",
    "overdue screen actor probe did not expose lost capacity"
  );

  auto cancel_a = screenCommand("disconnectScreen", "cancel-a", "screen-a", 4);
  require(runtime.dispatch(cancel_a), "runtime rejected screen cancel during blocked connect");
  require(
    sink->waitReply("cancel-a", 500ms).ok,
    "screen disconnect did not reply while connect was blocked"
  );
  livekit->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Connect);
  const auto reply_a = sink->waitReply("prepare-a");
  require(!reply_a.ok, "superseded screen connect resolved as success");
  require(
    reply_a.error && reply_a.error->code == "stale_generation",
    "superseded screen connect did not fail as stale_generation"
  );

  livekit->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Connect, false);
  const auto prepare_b = screenCommand("connectScreen", "prepare-b", "screen-b", 5);
  require(runtime.dispatch(prepare_b), "runtime rejected screen prepare");
  require(sink->waitReply("prepare-b").ok, "screen prepare failed");

  livekit->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Publish, true);
  const auto start_b = screenCommand("startScreenCapture", "start-b", "screen-b", 5);
  require(runtime.dispatch(start_b), "runtime rejected blocked screen publish");
  try {
    livekit->waitUntilPending(
      DeterministicFakeLiveKitPublicationClient::Operation::Publish,
      1
    );
  } catch (const std::exception&) {
    const auto early_reply = sink->waitReply("start-b", 10ms);
    throw std::runtime_error(
      "screen publish failed before reaching LiveKit: " +
      (early_reply.error ? early_reply.error->message : std::string("unknown error"))
    );
  }
  requireProbe(runtime, sink, "probe-publish");

  auto cancel_b = screenCommand("disconnectScreen", "cancel-b", "screen-b", 6);
  require(runtime.dispatch(cancel_b), "runtime rejected screen cancel during blocked publish");
  require(
    sink->waitReply("cancel-b", 500ms).ok,
    "screen disconnect did not reply while publish was blocked"
  );

  livekit->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, true);
  livekit->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Disconnect, true);
  DeterministicFakeLiveKitPublicationClient::Release published;
  published.publication_sid = "screen-video-exact";
  livekit->releaseNext(
    DeterministicFakeLiveKitPublicationClient::Operation::Publish,
    std::move(published)
  );
  livekit->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, 1);
  requireProbe(runtime, sink, "probe-unpublish");

  livekit->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish);
  livekit->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Disconnect, 1);
  requireProbe(runtime, sink, "probe-disconnect");
  livekit->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Disconnect);

  const auto reply_b = sink->waitReply("start-b");
  require(!reply_b.ok, "superseded screen publish resolved as success");
  require(
    reply_b.error && reply_b.error->code == "stale_generation",
    "superseded screen publish did not fail as stale_generation"
  );
  require(
    sink->countSessionStarted("screen-b", 5) == 0,
    "stale screen publication completion promoted an obsolete generation"
  );
  const auto unpublished_sids = livekit->unpublishedPublicationSids();
  require(
    unpublished_sids.size() == 1 && unpublished_sids.front() == "screen-video-exact",
    "screen rollback did not unpublish the exact acknowledged publication SID"
  );

  livekit->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Publish, false);
  livekit->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Unpublish, false);
  livekit->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Disconnect, false);
  const auto prepare_c = screenCommand("connectScreen", "prepare-c", "screen-c", 7);
  require(runtime.dispatch(prepare_c), "runtime rejected terminal-semantics prepare");
  require(sink->waitReply("prepare-c").ok, "terminal-semantics prepare failed");

  livekit->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Disconnect, true);
  syrnike::desktop_native::MediaCommand terminal;
  terminal.type = "__screenTerminal";
  terminal.session_id = "screen-c";
  terminal.generation = 7;
  terminal.internal_message = "livekit_disconnected:network";
  require(runtime.dispatch(terminal), "runtime rejected screen terminal event");
  livekit->waitUntilPending(DeterministicFakeLiveKitPublicationClient::Operation::Disconnect, 1);
  const auto ended = sink->waitEvent("screenCaptureEnded", "screen-c", 7);
  require(ended.reason == "runtime_error", "terminal disconnect lost screen ended semantics");
  require(
    ended.detail == "livekit_disconnected:network",
    "terminal disconnect lost its typed detail"
  );
  const auto stopped = sink->waitEvent("sessionStopped", "screen-c", 7);
  require(
    stopped.reason == "livekit_disconnected:network",
    "terminal disconnect lost sessionStopped semantics"
  );
  requireProbe(runtime, sink, "probe-terminal-retire");
  livekit->releaseNext(DeterministicFakeLiveKitPublicationClient::Operation::Disconnect);

  runtime.requestShutdown();
  runtime.shutdownAndWait();
  runtime.shutdownAndWait();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
