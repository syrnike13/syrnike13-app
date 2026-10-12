#pragma once

#include <memory>
#include <utility>

#include "runtime_types.hpp"

namespace syrnike::desktop_native {

enum class EventLane {
  control,
  realtime,
};

inline EventLane eventLane(const RuntimeEvent& event) noexcept {
  return event.type == NativeEventType::Input
    ? EventLane::realtime
    : EventLane::control;
}

inline void discardEvent(RuntimeEvent& event) noexcept {
  auto on_drop = std::move(event.on_drop);
  if (!on_drop) return;
  try {
    on_drop();
  } catch (...) {
  }
}

class RuntimeEventResourceGuard final {
 public:
  explicit RuntimeEventResourceGuard(RuntimeEvent& event) noexcept
    : on_drop_(std::move(event.on_drop)) {
    event.on_drop = {};
  }

  RuntimeEventResourceGuard(const RuntimeEventResourceGuard&) = delete;
  RuntimeEventResourceGuard& operator=(const RuntimeEventResourceGuard&) = delete;

  ~RuntimeEventResourceGuard() { discard(); }

  void attach(RuntimeEvent& event) {
    if (on_drop_) event.on_drop = on_drop_;
  }

  void transfer() noexcept { on_drop_ = {}; }

  void discard() noexcept {
    auto on_drop = std::move(on_drop_);
    on_drop_ = {};
    if (!on_drop) return;
    try {
      on_drop();
    } catch (...) {
    }
  }

 private:
  std::function<void()> on_drop_;
};

class EventSink {
 public:
  virtual ~EventSink() = default;
  virtual bool emit(RuntimeEvent event) = 0;
  virtual void close() = 0;
};

using EventSinkPtr = std::shared_ptr<EventSink>;

}  // namespace syrnike::desktop_native
