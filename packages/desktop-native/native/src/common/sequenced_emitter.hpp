#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <utility>

#include "event_sink.hpp"

namespace syrnike::desktop_native {

class SequencedEmitter {
 public:
  explicit SequencedEmitter(EventSinkPtr sink) : sink_(std::move(sink)) {}

  bool emit(RuntimeEvent event) {
    std::lock_guard emit_lock(
      eventLane(event) == EventLane::realtime
        ? realtime_emit_mutex_
        : control_emit_mutex_
    );
    EventSinkPtr sink;
    {
      std::lock_guard lock(mutex_);
      if (sink_) {
        event.sequence = next_sequence_.fetch_add(1, std::memory_order_relaxed);
        sink = sink_;
      }
    }
    if (!sink) {
      discardEvent(event);
      return false;
    }
    RuntimeEventResourceGuard resource(event);
    try {
      resource.attach(event);
      if (sink->emit(std::move(event))) {
        resource.transfer();
        return true;
      }
    } catch (...) {
    }
    resource.discard();
    return false;
  }

  void close() noexcept {
    EventSinkPtr sink;
    {
      std::lock_guard lock(mutex_);
      sink = std::move(sink_);
    }
    if (!sink) return;
    try {
      sink->close();
    } catch (...) {
    }
  }

 private:
  std::mutex control_emit_mutex_;
  std::mutex realtime_emit_mutex_;
  std::mutex mutex_;
  EventSinkPtr sink_;
  std::atomic_uint64_t next_sequence_{1};
};

}  // namespace syrnike::desktop_native
