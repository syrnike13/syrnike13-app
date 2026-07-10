#pragma once

#include <chrono>
#include <functional>
#include <memory>

#include "../common/bounded_queue.hpp"
#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"
#include "livekit_publication_client.hpp"

namespace syrnike::desktop_native::media {

class MediaRuntime final {
 public:
  using SteadyNow = std::function<std::chrono::steady_clock::time_point()>;

  explicit MediaRuntime(
    EventSinkPtr sink,
    std::shared_ptr<LiveKitPublicationClient> livekit_client = createRealLiveKitPublicationClient(),
    SteadyNow screen_now = {}
  );
  ~MediaRuntime();

  MediaRuntime(const MediaRuntime&) = delete;
  MediaRuntime& operator=(const MediaRuntime&) = delete;

  void waitUntilReady();
  bool dispatch(MediaCommand command);
  void requestShutdown();
  void shutdownAndWait();

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
