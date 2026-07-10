#include <chrono>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include "common/event_sink.hpp"
#include "media/livekit_publication_client.hpp"
#include "media/media_runtime.hpp"

namespace {

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

  bool waitReply(
    const std::string& request_id,
    std::chrono::milliseconds timeout = std::chrono::seconds(5)
  ) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] {
      for (const auto& event : events_) {
        if (event.type == "reply" && event.request_id == request_id) return true;
      }
      return false;
    });
  }

  bool hasReply(const std::string& request_id) {
    std::lock_guard lock(mutex_);
    for (const auto& event : events_) {
      if (event.type == "reply" && event.request_id == request_id) return true;
    }
    return false;
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  std::vector<syrnike::desktop_native::RuntimeEvent> events_;
};

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main() try {
  using syrnike::desktop_native::MediaCommand;
  using syrnike::desktop_native::media::DeterministicFakeLiveKitPublicationClient;
  using syrnike::desktop_native::media::MediaRuntime;

  auto sink = std::make_shared<CollectingSink>();
  auto livekit = std::make_shared<DeterministicFakeLiveKitPublicationClient>();
  livekit->setBlocked(DeterministicFakeLiveKitPublicationClient::Operation::Connect, true);

  MediaRuntime runtime(sink, livekit);

  MediaCommand connect;
  connect.type = "connectMicrophone";
  connect.request_id = "mic-connect";
  connect.session_id = "mic-session";
  connect.generation = 1;
  connect.livekit_url = "wss://livekit.example";
  connect.livekit_token = "token";
  connect.participant_identity = "user:desktop-native:microphone";
  connect.audio_bitrate = 64'000;
  connect.muted = false;
  require(runtime.dispatch(connect), "media runtime rejected microphone connect");

  livekit->waitUntilPending(
    DeterministicFakeLiveKitPublicationClient::Operation::Connect,
    1
  );

  MediaCommand mic_probe;
  mic_probe.type = "probeMicrophoneActor";
  mic_probe.request_id = "probe-microphone";
  require(runtime.dispatch(mic_probe), "media runtime rejected microphone probe");

  MediaCommand query_probe;
  query_probe.type = "probeQueryWorker";
  query_probe.request_id = "probe-query";
  require(runtime.dispatch(query_probe), "media runtime rejected query probe");

  require(
    sink->waitReply("probe-query", std::chrono::milliseconds(500)),
    "query probe did not reply independently"
  );
  require(
    sink->waitReply("probe-microphone", std::chrono::milliseconds(500)),
    "microphone probe did not reply while microphone connect was blocked"
  );

  require(
    !sink->hasReply("mic-connect"),
    "microphone connect completed before the blocked connect was released"
  );

  livekit->releaseNext(
    DeterministicFakeLiveKitPublicationClient::Operation::Connect
  );

  require(
    sink->waitReply("mic-connect", std::chrono::seconds(2)),
    "microphone connect did not complete after connect released"
  );

  runtime.requestShutdown();
  runtime.shutdownAndWait();
  runtime.shutdownAndWait();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
