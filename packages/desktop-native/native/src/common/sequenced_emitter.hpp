#pragma once

#include <atomic>
#include <cstdint>
#include <exception>
#include <mutex>
#include <utility>

#include "event_sink.hpp"

namespace syrnike::desktop_native {

class SequencedEmitter {
 public:
  explicit SequencedEmitter(EventSinkPtr sink) : sink_(std::move(sink)) {}

  bool emit(RuntimeEvent event) {
    // Ordering is a lane-local contract. A lossless control producer may wait
    // for bounded capacity, but that wait must never stall capture, media, or
    // Windows hook ingress on an unrelated lane.
    const auto lane = eventLane(event);
    std::lock_guard emit_lock(laneMutex(lane));
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
      // Event sinks are a fault-containment boundary. An exception must never
      // be reclassified by the calling actor as a media/capture failure.
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
    // EventSink::close may wait for a JS callback that synchronously dispatches
    // back into this emitter. The emitter is already observably closed, so the
    // callback sees a fast rejection instead of deadlocking on mutex_.
    if (sink) {
      try {
        sink->close();
      } catch (...) {
      }
    }
  }

 private:
  std::mutex& laneMutex(EventLane lane) noexcept {
    switch (lane) {
      case EventLane::control:
        return control_emit_mutex_;
      case EventLane::media:
        return media_emit_mutex_;
      case EventLane::telemetry:
        return telemetry_emit_mutex_;
      case EventLane::realtime:
        return realtime_emit_mutex_;
    }
    return control_emit_mutex_;
  }

  std::mutex control_emit_mutex_;
  std::mutex media_emit_mutex_;
  std::mutex telemetry_emit_mutex_;
  std::mutex realtime_emit_mutex_;
  std::mutex mutex_;
  EventSinkPtr sink_;
  std::atomic_uint64_t next_sequence_{1};
};

}  // namespace syrnike::desktop_native
