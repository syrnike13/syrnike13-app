#pragma once

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
    // Keep producer delivery serialized so sequence assignment and sink
    // observation have the same order. close() deliberately does not take
    // this mutex: a sink may be blocked on its bounded queue and close must be
    // able to wake it.
    std::lock_guard emit_lock(emit_mutex_);
    EventSinkPtr sink;
    {
      std::lock_guard lock(mutex_);
      if (sink_) {
        event.sequence = next_sequence_++;
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
  std::mutex emit_mutex_;
  std::mutex mutex_;
  EventSinkPtr sink_;
  std::uint64_t next_sequence_ = 1;
};

}  // namespace syrnike::desktop_native
