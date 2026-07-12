#pragma once

#include <atomic>
#include <exception>
#include <utility>

#include "event_sink.hpp"

namespace syrnike::desktop_native {

class SequencedEmitter {
 public:
  explicit SequencedEmitter(EventSinkPtr sink) : sink_(std::move(sink)) {}

  bool emit(RuntimeEvent event) {
    event.sequence = next_sequence_.fetch_add(1, std::memory_order_relaxed);
    if (sink_ && sink_->emit(std::move(event))) return true;
    // Lifecycle and control events are not lossy. A saturated JS event seam
    // means the utility host can no longer report trustworthy state, so fail
    // closed and let Electron's supervisor restart the isolated host.
    std::terminate();
  }

  void close() {
    if (sink_) sink_->close();
  }

 private:
  EventSinkPtr sink_;
  std::atomic_uint64_t next_sequence_{1};
};

}  // namespace syrnike::desktop_native
