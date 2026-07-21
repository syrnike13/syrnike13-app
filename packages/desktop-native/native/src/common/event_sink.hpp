#pragma once

#include <cstddef>
#include <functional>
#include <memory>
#include <utility>
#include <vector>

#include "runtime_types.hpp"

namespace syrnike::desktop_native {

enum class EventLane {
  control,
  media,
  telemetry,
};

inline EventLane eventLane(const RuntimeEvent& event) noexcept {
  if (
    event.type == "remoteVideoFrame" ||
    event.type == "localScreenPreviewFrame" ||
    event.type == "localCameraPreviewFrame" ||
    event.type == "activeSpeakers"
  ) {
    return EventLane::media;
  }
  if (event.type == "stats" || event.type == "microphoneMetrics") {
    return EventLane::telemetry;
  }
  return EventLane::control;
}

inline void discardEvent(RuntimeEvent& event) noexcept {
  if (!event.on_drop) return;
  try {
    event.on_drop();
  } catch (...) {
    // Resource release is best effort and must never turn a lossy media event
    // into a utility-host failure.
  }
  event.on_drop = {};
}

// Keeps a fallback copy of a native-resource release while an event is moved
// through allocation-prone queues. The destination receives a callable copy;
// transfer() disarms the fallback only after that destination owns the event.
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
      // Resource cleanup on a lossy lane must not escape into an actor.
    }
  }

 private:
  std::function<void()> on_drop_;
};

inline void discardEventBatch(
  std::vector<std::unique_ptr<RuntimeEvent>>& events,
  std::size_t first = 0
) noexcept {
  for (auto index = first; index < events.size(); ++index) {
    if (events[index]) discardEvent(*events[index]);
  }
}

template <typename Deliver>
inline bool transferEventToConsumer(
  RuntimeEvent& event,
  Deliver&& deliver
) noexcept {
  try {
    std::forward<Deliver>(deliver)(event);
    // The consumer now owns the resource represented by the event. Clearing
    // the fallback makes the ownership transfer explicit and prevents a later
    // cleanup path from releasing a successfully delivered handle.
    event.on_drop = {};
    return true;
  } catch (...) {
    discardEvent(event);
    return false;
  }
}

template <typename Deliver>
inline bool transferEventBatchToConsumer(
  std::vector<std::unique_ptr<RuntimeEvent>>& events,
  Deliver&& deliver
) noexcept {
  for (std::size_t index = 0; index < events.size(); ++index) {
    if (!events[index]) continue;
    if (transferEventToConsumer(*events[index], deliver)) continue;
    discardEventBatch(events, index + 1);
    return false;
  }
  return true;
}

class EventSink {
 public:
  virtual ~EventSink() = default;
  virtual bool emit(RuntimeEvent event) = 0;
  virtual void close() = 0;
};

using EventSinkPtr = std::shared_ptr<EventSink>;

}  // namespace syrnike::desktop_native
