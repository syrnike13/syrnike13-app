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
    std::lock_guard lock(mutex_);
    event.sequence = next_sequence_++;
    RuntimeEventResourceGuard resource(event);
    try {
      resource.attach(event);
      if (sink_ && sink_->emit(std::move(event))) {
        resource.transfer();
        return true;
      }
    } catch (...) {
      // Event sinks are a fault-containment boundary. An exception must never
      // be reclassified by the calling actor as a media/capture failure.
    }
    resource.discard();
    // Lifecycle and control events are not lossy. A saturated JS event seam
    // means the utility host can no longer report trustworthy state, so fail
    // closed and let Electron's supervisor restart the isolated host.
    std::terminate();
  }

  void close() {
    std::lock_guard lock(mutex_);
    if (sink_) sink_->close();
  }

 private:
  std::mutex mutex_;
  EventSinkPtr sink_;
  std::uint64_t next_sequence_ = 1;
};

}  // namespace syrnike::desktop_native
