#include <chrono>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include "common/event_sink.hpp"
#include "hooks/hooks_runtime.hpp"

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

  syrnike::desktop_native::RuntimeEvent waitReply(const std::string& request_id) {
    std::unique_lock lock(mutex_);
    const bool found = changed_.wait_for(lock, std::chrono::seconds(5), [&] {
      for (const auto& event : events_) {
        if (event.type == "reply" && event.request_id == request_id) return true;
      }
      return false;
    });
    if (!found) throw std::runtime_error("hooks runtime reply timed out");
    for (const auto& event : events_) {
      if (event.type == "reply" && event.request_id == request_id) return event;
    }
    throw std::runtime_error("hooks runtime reply disappeared");
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  std::vector<syrnike::desktop_native::RuntimeEvent> events_;
};

}  // namespace

int main() try {
  using syrnike::desktop_native::HooksCommand;
  using syrnike::desktop_native::hooks::HooksRuntime;

  auto sink = std::make_shared<CollectingSink>();
  HooksRuntime runtime(sink);
  for (int cycle = 0; cycle < 5; ++cycle) {
    const auto start_id = "start-" + std::to_string(cycle);
    if (!runtime.dispatch(HooksCommand{"startHotkeys", start_id})) {
      throw std::runtime_error("hooks runtime rejected a start command");
    }
    const auto started = sink->waitReply(start_id);
    if (!started.ok && (!started.error || started.error->code != "hook_install_failed")) {
      throw std::runtime_error("hooks runtime returned an untyped installation failure");
    }

    const auto stop_id = "stop-" + std::to_string(cycle);
    if (!runtime.dispatch(HooksCommand{"stopHotkeys", stop_id})) {
      throw std::runtime_error("hooks runtime rejected a stop command");
    }
    if (!sink->waitReply(stop_id).ok) {
      throw std::runtime_error("hooks runtime failed an idempotent stop");
    }

    const auto overlay_start_id = "overlay-start-" + std::to_string(cycle);
    if (!runtime.dispatch(HooksCommand{"startOverlay", overlay_start_id}) ||
        !sink->waitReply(overlay_start_id).ok) {
      throw std::runtime_error("overlay actor failed to start");
    }
    const auto probe_id = "probe-" + std::to_string(cycle);
    if (!runtime.dispatch(HooksCommand{"probeHooksRuntime", probe_id}) ||
        !sink->waitReply(probe_id).ok) {
      throw std::runtime_error("hooks runtime probe failed");
    }
    const auto overlay_stop_id = "overlay-stop-" + std::to_string(cycle);
    if (!runtime.dispatch(HooksCommand{"stopOverlay", overlay_stop_id}) ||
        !sink->waitReply(overlay_stop_id).ok) {
      throw std::runtime_error("overlay actor failed to stop");
    }
  }

  if (!runtime.dispatch(HooksCommand{"shutdown", "shutdown"})) {
    throw std::runtime_error("hooks runtime rejected shutdown");
  }
  if (!sink->waitReply("shutdown").ok) {
    throw std::runtime_error("hooks runtime failed shutdown");
  }
  runtime.shutdownAndWait();
  runtime.shutdownAndWait();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
