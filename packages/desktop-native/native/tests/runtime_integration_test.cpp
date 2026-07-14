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
