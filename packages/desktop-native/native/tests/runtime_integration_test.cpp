#include <iostream>
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
    std::lock_guard lock(mutex_);
    events_.push_back(std::move(event));
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

 private:
  mutable std::mutex mutex_;
  std::vector<syrnike::desktop_native::RuntimeEvent> events_;
};

}  // namespace

int main() try {
  auto media_sink = std::make_shared<CollectingSink>();
  {
    syrnike::desktop_native::media::MediaRuntime runtime(media_sink);
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
