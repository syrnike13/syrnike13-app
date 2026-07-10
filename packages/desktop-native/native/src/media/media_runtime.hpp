#pragma once

#include <memory>

#include "../common/bounded_queue.hpp"
#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"

namespace syrnike::desktop_native::media {

class MediaRuntime final {
 public:
  explicit MediaRuntime(EventSinkPtr sink);
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
