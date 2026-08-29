#include <algorithm>
#include <iostream>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "common/cleanup_supervisor.hpp"
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
      if (event.type == syrnike::desktop_native::NativeEventType::RuntimeError &&
          event.request_id != "stale-remote-video-demand") {
        return true;
      }
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
        if (event.type == syrnike::desktop_native::NativeEventType::Reply && event.request_id == request_id) return true;
      }
      return false;
    });
  }

  std::optional<syrnike::desktop_native::RuntimeEvent> replyFor(
    const std::string& request_id
  ) const {
    std::lock_guard lock(mutex_);
    for (const auto& event : events_) {
      if (event.type == syrnike::desktop_native::NativeEventType::Reply && event.request_id == request_id) return event;
    }
    return std::nullopt;
  }

  bool waitForPreviewFailure() {
    std::unique_lock lock(mutex_);
    const auto found = [this] {
      for (const auto& event : events_) {
        if (event.type != syrnike::desktop_native::NativeEventType::LocalScreenPreviewFailed) continue;
        return event.error &&
          event.error->code == "LOCAL_SCREEN_PREVIEW_FAILED" &&
          event.error->retryable && event.session_id == "screen-test" &&
          event.generation == 4;
      }
      return false;
    };
    return changed_.wait_for(lock, std::chrono::seconds(2), found);
  }

  bool waitForRuntimeErrorStage(const std::string& stage) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, std::chrono::seconds(2), [&] {
      for (const auto& event : events_) {
        if (
          event.type == syrnike::desktop_native::NativeEventType::RuntimeError &&
          event.error &&
          event.error->stage == stage
        ) {
          return true;
        }
      }
      return false;
    });
  }

  bool consumeRuntimeErrorStage(const std::string& stage) {
    std::lock_guard lock(mutex_);
    const auto found = std::find_if(events_.begin(), events_.end(), [&](const auto& event) {
      return event.type == syrnike::desktop_native::NativeEventType::RuntimeError && event.error &&
        event.error->stage == stage;
    });
    if (found == events_.end()) return false;
    events_.erase(found);
    return true;
  }

  bool hasReplyFor(const std::string& request_id) const {
    std::lock_guard lock(mutex_);
    for (const auto& event : events_) {
      if (event.type == syrnike::desktop_native::NativeEventType::Reply && event.request_id == request_id) return true;
    }
    return false;
  }

  std::size_t count(
    syrnike::desktop_native::NativeEventType type
  ) const {
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
  bool unsupported_internal_rejected = false;
  const auto cleanup_before =
    syrnike::desktop_native::CleanupSupervisor::instance().snapshot();
  {
    syrnike::desktop_native::media::MediaRuntime runtime(media_sink);
    syrnike::desktop_native::MediaCommand preview_failure;
    preview_failure.type = syrnike::desktop_native::NativeCommandType::LocalScreenPreviewFailed;
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

    syrnike::desktop_native::MediaCommand unsupported_internal;
    unsupported_internal.type =
      syrnike::desktop_native::NativeCommandType::Count;
    unsupported_internal.request_id = "unsupported-internal-command";
    const auto unsupported_dispatched =
      runtime.dispatch(std::move(unsupported_internal));
    const auto unsupported_replied = media_sink->waitForReply(
      "unsupported-internal-command"
    );
    const auto unsupported_reply = media_sink->replyFor(
      "unsupported-internal-command"
    );
    unsupported_internal_rejected = unsupported_dispatched &&
      unsupported_replied && unsupported_reply && !unsupported_reply->ok &&
      unsupported_reply->error &&
      unsupported_reply->error->code == "unsupported_command";

    syrnike::desktop_native::MediaCommand screen_available;
    screen_available.type = syrnike::desktop_native::NativeCommandType::RemoteVideoPublicationAvailable;
    screen_available.session_id = "voice-barrier-session";
    screen_available.generation = 1;
    screen_available.track_id = "remote-screen-publication";
    screen_available.participant_identity = "remote-participant";
    screen_available.video_source = "screen";
    if (!runtime.dispatch(std::move(screen_available))) {
      throw std::runtime_error("remote screen publication event was rejected");
    }

    syrnike::desktop_native::MediaCommand voice_barrier;
    voice_barrier.type = syrnike::desktop_native::NativeCommandType::DisconnectVoice;
    voice_barrier.request_id = "remote-screen-voice-barrier";
    voice_barrier.session_id = "voice-barrier-session";
    voice_barrier.generation = 1;
    if (!runtime.dispatch(std::move(voice_barrier)) ||
        !media_sink->waitForReply("remote-screen-voice-barrier")) {
      throw std::runtime_error("voice queue did not process remote screen publication event");
    }
    const auto voice_barrier_reply = media_sink->replyFor(
      "remote-screen-voice-barrier"
    );
    if (!voice_barrier_reply || !voice_barrier_reply->ok ||
        voice_barrier_reply->error) {
      throw std::runtime_error(
        "voice queue barrier did not complete successfully"
      );
    }

    syrnike::desktop_native::MediaCommand stale_removed;
    stale_removed.type = syrnike::desktop_native::NativeCommandType::RemoteVideoTrackRemoved;
    stale_removed.session_id = "retired-voice-session";
    stale_removed.generation = 9;
    stale_removed.track_id = "stale-screen-track";
    stale_removed.video_source = "screen";
    if (!runtime.dispatch(std::move(stale_removed))) {
      throw std::runtime_error("stale remote video removal was rejected");
    }
    syrnike::desktop_native::MediaCommand stale_failed;
    stale_failed.type = syrnike::desktop_native::NativeCommandType::RemoteVideoFailed;
    stale_failed.session_id = "retired-voice-session";
    stale_failed.generation = 9;
    stale_failed.track_id = "stale-screen-track";
    stale_failed.video_source = "screen";
    if (!runtime.dispatch(std::move(stale_failed))) {
      throw std::runtime_error("stale remote video failure was rejected");
    }
    syrnike::desktop_native::MediaCommand stale_barrier;
    stale_barrier.type = syrnike::desktop_native::NativeCommandType::DisconnectVoice;
    stale_barrier.request_id = "stale-remote-video-barrier";
    stale_barrier.session_id = "retired-voice-session";
    stale_barrier.generation = 10;
    if (!runtime.dispatch(std::move(stale_barrier)) ||
        !media_sink->waitForReply("stale-remote-video-barrier")) {
      throw std::runtime_error("voice queue did not process stale video lifecycle events");
    }
    const auto stale_barrier_reply = media_sink->replyFor(
      "stale-remote-video-barrier"
    );
    if (!stale_barrier_reply || !stale_barrier_reply->ok ||
        stale_barrier_reply->error) {
      throw std::runtime_error(
        "stale video lifecycle barrier did not complete successfully"
      );
    }
    if (media_sink->count(
          syrnike::desktop_native::NativeEventType::RemoteVideoTrackRemoved) != 0 ||
        media_sink->count(
          syrnike::desktop_native::NativeEventType::RemoteVideoFailed) != 0) {
      throw std::runtime_error("stale remote video lifecycle event escaped generation fence");
    }

    syrnike::desktop_native::MediaCommand stale_demand;
    stale_demand.type = syrnike::desktop_native::NativeCommandType::SetRemoteVideoDemand;
    stale_demand.request_id = "stale-remote-video-demand";
    stale_demand.session_id = "retired-voice-session";
    stale_demand.generation = 9;
    stale_demand.track_id = "stale-screen-track";
    stale_demand.demanded = true;
    if (!runtime.dispatch(std::move(stale_demand)) ||
        !media_sink->waitForReply("stale-remote-video-demand")) {
      throw std::runtime_error("stale remote video demand did not receive a reply");
    }
    const auto stale_demand_reply = media_sink->replyFor("stale-remote-video-demand");
    if (!stale_demand_reply || !stale_demand_reply->error ||
        stale_demand_reply->error->code != "stale_generation") {
      throw std::runtime_error("stale remote video demand escaped generation fence");
    }

    runtime.requestShutdown();
    runtime.requestShutdown();
    runtime.shutdownAndWait();
    runtime.shutdownAndWait();
  }
  auto cleanup_after =
    syrnike::desktop_native::CleanupSupervisor::instance().snapshot();
  const auto cleanup_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while ((cleanup_after.owned_jobs != cleanup_before.owned_jobs ||
          cleanup_after.active_jobs != cleanup_before.active_jobs ||
          cleanup_after.backlog_jobs != cleanup_before.backlog_jobs) &&
         std::chrono::steady_clock::now() < cleanup_deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    cleanup_after =
      syrnike::desktop_native::CleanupSupervisor::instance().snapshot();
  }
  if (cleanup_after.owned_jobs != cleanup_before.owned_jobs ||
      cleanup_after.active_jobs != cleanup_before.active_jobs ||
      cleanup_after.backlog_jobs != cleanup_before.backlog_jobs) {
    throw std::runtime_error(
      "media runtime cleanup did not drain after orderly shutdown"
    );
  }
  if (!unsupported_internal_rejected) {
    throw std::runtime_error(
      "typed dispatch did not reject an undeclared internal command"
    );
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
