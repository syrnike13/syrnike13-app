#pragma once

#include <cstddef>
#include <memory>
#include <string>

#include "../common/bounded_queue.hpp"
#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"

namespace syrnike::desktop_native::hooks {

namespace detail {

using ProcessPathAssign = void(*)(
  std::wstring& destination,
  const wchar_t* source,
  std::size_t size
);

// Takes ownership of process_handle even if querying or assigning the path
// fails. The assign seam keeps the exceptional cleanup path deterministic.
std::wstring processPathFromOwnedHandle(
  void* process_handle,
  ProcessPathAssign assign = nullptr
);

}  // namespace detail

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
