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

  bool waitTrackFailure(
    const std::string& track_id,
    std::chrono::milliseconds timeout = std::chrono::seconds(2)
  ) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] {
      for (const auto& event : events_) {
        if (event.type == "runtimeError" && event.track_id == track_id &&
            event.status.empty() && event.kind.empty() && event.error &&
            event.error->code == "audio_output_stream_start_failed") {
          return true;
        }
      }
      return false;
    });
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
  connect.type = "connectVoice";
  connect.request_id = "voice-connect";
  connect.session_id = "voice-session";
  connect.generation = 1;
  connect.livekit_url = "wss://livekit.example";
  connect.livekit_token = "token";
  require(runtime.dispatch(connect), "media runtime rejected voice connect");

  livekit->waitUntilPending(
    DeterministicFakeLiveKitPublicationClient::Operation::Connect,
    1
  );

  MediaCommand screen_probe;
  screen_probe.type = "probeScreenActor";
  screen_probe.request_id = "probe-screen";
  require(runtime.dispatch(screen_probe), "media runtime rejected screen probe");

  MediaCommand query_probe;
  query_probe.type = "probeQueryWorker";
  query_probe.request_id = "probe-query";
  require(runtime.dispatch(query_probe), "media runtime rejected query probe");

  require(
    sink->waitReply("probe-query", std::chrono::milliseconds(500)),
    "query probe did not reply independently"
  );
  require(
    sink->waitReply("probe-screen", std::chrono::milliseconds(500)),
    "screen probe did not reply while screen connect was blocked"
  );

  require(
    !sink->hasReply("voice-connect"),
    "voice connect completed before the blocked connect was released"
  );

  livekit->releaseNext(
    DeterministicFakeLiveKitPublicationClient::Operation::Connect
  );

  require(
    sink->waitReply("voice-connect", std::chrono::seconds(2)),
    "voice connect did not complete after connect released"
  );

  MediaCommand disconnect;
  disconnect.type = "disconnectVoice";
  disconnect.request_id = "voice-disconnect";
  disconnect.session_id = "voice-session";
  disconnect.generation = 2;
  require(runtime.dispatch(disconnect), "media runtime rejected voice disconnect");
  require(
    sink->waitReply("voice-disconnect", std::chrono::seconds(2)),
    "voice disconnect did not retire the previous generation"
  );

  MediaCommand track_failure;
  track_failure.type = "__voiceRemoteAudioTrackFailed";
  track_failure.session_id = "voice-session";
  track_failure.generation = 2;
  track_failure.track_id = "failed-audio-track";
  track_failure.video_source = "audio_output_stream_start_failed";
  track_failure.internal_message = "injected track worker failure";
  require(runtime.dispatch(std::move(track_failure)),
    "media runtime rejected track-scoped audio failure");
  require(sink->waitTrackFailure("failed-audio-track"),
    "remote audio track failure terminalized the global output lane");

  std::mutex release_mutex;
  std::condition_variable released;
  bool stale_frame_released = false;
  MediaCommand stale_frame;
  stale_frame.type = "__remoteVideoFrame";
  stale_frame.session_id = "voice-session";
  stale_frame.generation = 1;
  stale_frame.track_id = "stale-track";
  stale_frame.frame_sequence = 44;
  stale_frame.on_drop = [&] {
    {
      std::lock_guard lock(release_mutex);
      stale_frame_released = true;
    }
    released.notify_all();
  };
  require(runtime.dispatch(std::move(stale_frame)), "media runtime rejected stale frame cleanup");
  {
    std::unique_lock lock(release_mutex);
    require(
      released.wait_for(lock, std::chrono::seconds(1), [&] { return stale_frame_released; }),
      "stale-generation frame was not released by its owning actor worker"
    );
  }

  runtime.requestShutdown();
  runtime.shutdownAndWait();
  runtime.shutdownAndWait();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
