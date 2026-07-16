#pragma once

#include <memory>

#include "../common/bounded_queue.hpp"
#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"

namespace syrnike::desktop_native::hooks {

class HooksRuntime final {
 public:
  explicit HooksRuntime(EventSinkPtr sink);
  ~HooksRuntime();

  HooksRuntime(const HooksRuntime&) = delete;
  HooksRuntime& operator=(const HooksRuntime&) = delete;

  bool dispatch(HooksCommand command);
  void requestShutdown();
  void shutdownAndWait();

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::hooks
