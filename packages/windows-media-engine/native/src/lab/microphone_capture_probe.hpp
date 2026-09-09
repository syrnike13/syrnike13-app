#pragma once
#include "lab/heap_allocation_probe.hpp"
#include <atomic>

namespace syrnike::windows_media::lab {
// Only linked into the disposable capture benchmark. The control thread reads
// the result after joining capture; production has no probe or allocator hooks.
inline HeapAllocationProbe::Counts capture_heap_counts;
inline std::size_t capture_heap_imports = 0;
// Set before start(), read only by the capture worker, then inspected after join.
// Zero disables injection. This never simulates or changes Windows device state.
inline std::uint64_t capture_device_loss_after_frames = 0;
inline std::uint64_t capture_stop_client_after_frames = 0;
inline std::atomic_bool capture_fault_armed{true};
class CaptureAllocationProbe final {
 public:
  CaptureAllocationProbe() {
    capture_heap_imports = heap_.imports();
    heap_.begin();
  }
  ~CaptureAllocationProbe() { capture_heap_counts = heap_.end(); }
 private:
  HeapAllocationProbe heap_;
};
}  // namespace syrnike::windows_media::lab
