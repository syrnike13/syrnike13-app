#pragma once

#include <memory>

#include "runtime_types.hpp"

namespace syrnike::desktop_native {

class EventSink {
 public:
  virtual ~EventSink() = default;
  virtual bool emit(RuntimeEvent event) = 0;
  virtual void close() = 0;
};

using EventSinkPtr = std::shared_ptr<EventSink>;

}  // namespace syrnike::desktop_native
