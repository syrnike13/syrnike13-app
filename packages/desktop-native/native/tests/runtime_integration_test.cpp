#include <iostream>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include "common/event_sink.hpp"
#include "hooks/hooks_runtime.hpp"
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

  bool hasRuntimeError() const {
    std::lock_guard lock(mutex_);
    for (const auto& event : events_) {
      if (event.type == "runtimeError") return true;
    }
    return false;
  }

  bool waitForReply(
    const std::string& request_id,
    std::chrono::milliseconds timeout = std::chrono::seconds(2)
  ) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, timeout, [&] {
      for (const auto& event : events_) {
        if (event.type == "reply" && event.request_id == request_id) return true;
      }
      return false;
    });
  }

  bool waitForPreviewFailure() {
    std::unique_lock lock(mutex_);
    const auto found = [this] {
      for (const auto& event : events_) {
        if (event.type != "localScreenPreviewFailed") continue;
        return event.error &&
          event.error->code == "LOCAL_SCREEN_PREVIEW_FAILED" &&
          event.error->retryable && event.session_id == "screen-test" &&
          event.generation == 4;
      }
      return false;
    };
    return changed_.wait_for(lock, std::chrono::seconds(2), found);
  }

  std::size_t count(const std::string& type) const {
    std::lock_guard lock(mutex_);
    std::size_t result = 0;
    for (const auto& event : events_) {
      if (event.type == type) ++result;
    }
    return result;
  }

 private:
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::vector<syrnike::desktop_native::RuntimeEvent> events_;
};

}  // namespace

int main() try {
  auto media_sink = std::make_shared<CollectingSink>();
  {
    syrnike::desktop_native::media::MediaRuntime runtime(media_sink);
    syrnike::desktop_native::MediaCommand preview_failure;
    preview_failure.type = "__localScreenPreviewFailed";
    preview_failure.session_id = "screen-test";
    preview_failure.generation = 4;
    preview_failure.track_id = "local-screen:screen-test";
    preview_failure.video_source = "gpu_interop_unavailable";
    preview_failure.internal_message = "failed to create preview output view";
    preview_failure.diagnostic_hresult = -2147024809;
    if (!runtime.dispatch(std::move(preview_failure)) ||
        !media_sink->waitForPreviewFailure()) {
      throw std::runtime_error("local preview failure diagnostic was not emitted");
    }

    syrnike::desktop_native::MediaCommand screen_available;
    screen_available.type = "__remoteScreenPublicationAvailable";
    screen_available.track_id = "remote-screen-publication";
    screen_available.participant_identity = "remote-participant";
    if (!runtime.dispatch(std::move(screen_available))) {
      throw std::runtime_error("remote screen publication event was rejected");
    }

    syrnike::desktop_native::MediaCommand voice_barrier;
    voice_barrier.type = "configureRemoteAudio";
    voice_barrier.request_id = "remote-screen-voice-barrier";
    voice_barrier.has_revision = true;
    voice_barrier.revision = 1;
    if (!runtime.dispatch(std::move(voice_barrier)) ||
        !media_sink->waitForReply("remote-screen-voice-barrier")) {
      throw std::runtime_error("voice queue did not process remote screen publication event");
    }

    syrnike::desktop_native::MediaCommand stale_removed;
    stale_removed.type = "__remoteVideoTrackRemoved";
    stale_removed.session_id = "retired-voice-session";
    stale_removed.generation = 9;
    stale_removed.track_id = "stale-screen-track";
    stale_removed.video_source = "screen";
    if (!runtime.dispatch(std::move(stale_removed))) {
      throw std::runtime_error("stale remote video removal was rejected");
    }
    syrnike::desktop_native::MediaCommand stale_failed;
    stale_failed.type = "__remoteVideoFailed";
    stale_failed.session_id = "retired-voice-session";
    stale_failed.generation = 9;
    stale_failed.track_id = "stale-screen-track";
    stale_failed.video_source = "screen";
    if (!runtime.dispatch(std::move(stale_failed))) {
      throw std::runtime_error("stale remote video failure was rejected");
    }
    syrnike::desktop_native::MediaCommand stale_barrier;
    stale_barrier.type = "configureRemoteAudio";
    stale_barrier.request_id = "stale-remote-video-barrier";
    stale_barrier.has_revision = true;
    stale_barrier.revision = 2;
    if (!runtime.dispatch(std::move(stale_barrier)) ||
        !media_sink->waitForReply("stale-remote-video-barrier")) {
      throw std::runtime_error("voice queue did not process stale video lifecycle events");
    }
    if (media_sink->count("remoteVideoTrackRemoved") != 0 ||
        media_sink->count("remoteVideoFailed") != 0) {
      throw std::runtime_error("stale remote video lifecycle event escaped generation fence");
    }

    syrnike::desktop_native::MediaCommand screen_stalled;
    screen_stalled.type = "__screenRtpStalled";
    screen_stalled.session_id = "retired-screen-session";
    screen_stalled.generation = 9;
    if (!runtime.dispatch(std::move(screen_stalled))) {
      throw std::runtime_error("internal screen stall event was rejected");
    }
    syrnike::desktop_native::MediaCommand screen_barrier;
    screen_barrier.type = "probeScreenActor";
    screen_barrier.request_id = "screen-stall-barrier";
    if (!runtime.dispatch(std::move(screen_barrier)) ||
        !media_sink->waitForReply("screen-stall-barrier")) {
      throw std::runtime_error("screen queue did not process internal stall event");
    }
    runtime.requestShutdown();
    runtime.requestShutdown();
    runtime.shutdownAndWait();
    runtime.shutdownAndWait();
  }
  if (media_sink->hasRuntimeError()) {
    throw std::runtime_error("media runtime failed initialization or teardown");
  }

  auto hooks_sink = std::make_shared<CollectingSink>();
  {
    syrnike::desktop_native::hooks::HooksRuntime runtime(hooks_sink);
    runtime.requestShutdown();
    runtime.requestShutdown();
    runtime.shutdownAndWait();
    runtime.shutdownAndWait();
  }
  if (hooks_sink->hasRuntimeError()) {
    throw std::runtime_error("hooks runtime failed initialization or teardown");
  }
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
