#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <utility>
#include <vector>

#include "screen_gpu_capture.hpp"

namespace syrnike::desktop_native::media {

struct ScreenPreviewReleaseDetach {
  std::shared_ptr<ScreenGpuCapturer> capturer;
  bool active = false;
};

// Completes the renderer fence before detaching a retired backend. Detach owns
// the registry transaction; retire must transfer the returned owner to a
// cleanup lane before returning. The local snapshot is cleared first, so an
// immediately-started cleanup job cannot leave the last backend owner on the
// control caller's stack.
template <typename Detach, typename Retire>
void releaseScreenPreviewFrameWithRetirement(
    std::shared_ptr<ScreenGpuCapturer> capturer,
    std::uint64_t sequence,
    Detach&& detach,
    Retire&& retire) {
  if (!capturer) return;
  capturer->releasePreviewFrame(sequence);
  if (capturer->previewFramesInFlight() != 0) return;

  auto detached = detach(capturer);
  if (detached.active) return;
  if (detached.capturer) {
    capturer.reset();
  } else {
    // A concurrent reaper may already have removed the registry entry. Keep
    // this snapshot on the cleanup lane as a guard until its owner job exits.
    detached.capturer = std::move(capturer);
  }
  retire(std::move(detached.capturer));
}

// Owns the small set of screen backends whose encoder or renderer fences have
// outlived an active-backend replacement. Backend callbacks always run without
// the lane mutex: encoder release routing can therefore snapshot the retained
// owners even when a retired preview device call is stalled.
class ScreenGpuRetirementLane final {
 public:
  static constexpr std::size_t kCapacity = 4;

  struct Snapshot {
    std::array<std::shared_ptr<ScreenGpuCapturer>, kCapacity> capturers;
    std::size_t size = 0;
  };

  class Plan final {
   public:
    Plan(const Plan&) = delete;
    Plan& operator=(const Plan&) = delete;
    Plan& operator=(Plan&&) = delete;

    Plan(Plan&& other) noexcept
        : entries_(std::move(other.entries_)),
          size_(other.size_),
          restore_demand_(other.restore_demand_),
          committed_(other.committed_) {
      other.size_ = 0;
      other.committed_ = true;
    }

    ~Plan() { restoreIfUncommitted(); }

   private:
    friend class ScreenGpuRetirementLane;

    struct Entry {
      std::shared_ptr<ScreenGpuCapturer> capturer;
      ScreenFrameFlowStats final_stats;
      bool retirement_safe = false;
    };

    explicit Plan(ScreenPreviewDemand restore_demand) noexcept
        : restore_demand_(restore_demand) {}

    void restoreIfUncommitted() noexcept {
      if (committed_) return;
      for (std::size_t index = 0; index < size_; ++index) {
        if (!entries_[index].capturer) continue;
        try {
          entries_[index].capturer->setPreviewDemand(restore_demand_);
        } catch (...) {
        }
      }
    }

    std::array<Entry, kCapacity> entries_;
    std::size_t size_ = 0;
    ScreenPreviewDemand restore_demand_;
    bool committed_ = false;
  };

  [[nodiscard]] bool canRetire(
      const std::vector<std::shared_ptr<ScreenGpuCapturer>>& candidates) const
      noexcept {
    std::array<std::shared_ptr<ScreenGpuCapturer>, kCapacity> existing;
    std::size_t existing_size = 0;
    {
      std::lock_guard lock(mutex_);
      for (const auto& entry : entries_) {
        if (entry.capturer) existing[existing_size++] = entry.capturer;
      }
    }

    std::array<std::shared_ptr<ScreenGpuCapturer>, kCapacity> unique;
    std::size_t unique_size = 0;
    std::size_t required = 0;
    for (const auto& candidate : candidates) {
      if (!candidate || contains(existing, existing_size, candidate) ||
          contains(unique, unique_size, candidate)) {
        continue;
      }
      if (unique_size == kCapacity) return false;
      unique[unique_size++] = candidate;
      if (!candidate->retirementSafe()) ++required;
    }
    return required <= kCapacity - std::min(existing_size, kCapacity);
  }

  // Detach optional work synchronously before the backend becomes retired.
  // GpuPreviewPool drops pending/ready allocations here but deliberately keeps
  // renderer-delivered slots occupied until their exact fence release.
  [[nodiscard]] Plan prepare(
      const std::vector<std::shared_ptr<ScreenGpuCapturer>>& candidates,
      ScreenPreviewDemand restore_demand) const {
    Plan plan(restore_demand);
    for (const auto& candidate : candidates) {
      if (!candidate || containsPlan(plan, candidate)) continue;
      if (plan.size_ == kCapacity) {
        throw std::runtime_error(
            "screen backend retirement plan exceeded fixed capacity");
      }
      auto& entry = plan.entries_[plan.size_++];
      entry.capturer = candidate;
      candidate->setPreviewDemand({});
      entry.retirement_safe = candidate->retirementSafe();
      if (entry.retirement_safe) {
        entry.final_stats = candidate->frameFlowStats();
      }
    }
    return plan;
  }

  // Commit contains no backend callbacks and is safe to compose with the
  // wrapper's active-generation swap. A failed capacity check leaves Plan
  // uncommitted, so its destructor restores the former demand.
  [[nodiscard]] bool commit(Plan& plan) noexcept {
    std::lock_guard lock(mutex_);
    std::size_t required = 0;
    for (std::size_t index = 0; index < plan.size_; ++index) {
      const auto& candidate = plan.entries_[index];
      if (!candidate.capturer || candidate.retirement_safe ||
          containsLocked(candidate.capturer)) {
        continue;
      }
      ++required;
    }
    if (required > kCapacity - std::min(size_, kCapacity)) return false;

    for (std::size_t index = 0; index < plan.size_; ++index) {
      auto& candidate = plan.entries_[index];
      if (!candidate.capturer || containsLocked(candidate.capturer)) continue;
      if (candidate.retirement_safe) {
        mergeCounters(completed_stats_, candidate.final_stats);
        continue;
      }
      for (auto& entry : entries_) {
        if (entry.capturer) continue;
        entry.id = ++next_id_;
        entry.capturer = candidate.capturer;
        ++size_;
        break;
      }
    }
    plan.committed_ = true;
    return true;
  }

  void poll() noexcept {
    std::array<RetiredEntry, kCapacity> work;
    {
      std::lock_guard lock(mutex_);
      work = entries_;
    }

    std::array<bool, kCapacity> completed{};
    std::array<ScreenFrameFlowStats, kCapacity> final_stats{};
    for (std::size_t index = 0; index < work.size(); ++index) {
      const auto& entry = work[index];
      if (!entry.capturer) continue;
      entry.capturer->pollRetirement();
      completed[index] = entry.capturer->retirementSafe();
      if (completed[index]) {
        final_stats[index] = entry.capturer->frameFlowStats();
      }
    }

    std::array<std::shared_ptr<ScreenGpuCapturer>, kCapacity>
        release_outside_lock;
    {
      std::lock_guard lock(mutex_);
      std::size_t release_count = 0;
      for (std::size_t work_index = 0; work_index < work.size(); ++work_index) {
        if (!completed[work_index]) continue;
        for (auto& entry : entries_) {
          if (entry.id != work[work_index].id ||
              entry.capturer != work[work_index].capturer) {
            continue;
          }
          mergeCounters(completed_stats_, final_stats[work_index]);
          release_outside_lock[release_count++] =
              std::move(entry.capturer);
          entry = {};
          --size_;
          break;
        }
      }
    }
  }

  [[nodiscard]] Snapshot snapshot() const noexcept {
    Snapshot result;
    std::lock_guard lock(mutex_);
    for (const auto& entry : entries_) {
      if (entry.capturer) result.capturers[result.size++] = entry.capturer;
    }
    return result;
  }

  [[nodiscard]] ScreenFrameFlowStats completedStats() const noexcept {
    std::lock_guard lock(mutex_);
    return completed_stats_;
  }

  [[nodiscard]] std::size_t size() const noexcept {
    std::lock_guard lock(mutex_);
    return size_;
  }

  // A renderer-delivered preview frame can only progress when Electron posts
  // its authoritative fence release. Polling that state at 250 Hz cannot make
  // it safe, so the actor sleeps until the release notification. GPU/encoder
  // retirement without a renderer lease still receives bounded timed polls.
  [[nodiscard]] bool pollPending() const noexcept {
    const auto work = snapshot();
    for (std::size_t index = 0; index < work.size; ++index) {
      const auto& capturer = work.capturers[index];
      if (capturer && capturer->previewFramesInFlight() == 0 &&
          !capturer->retirementSafe()) {
        return true;
      }
    }
    return false;
  }

 private:
  struct RetiredEntry {
    std::uint64_t id = 0;
    std::shared_ptr<ScreenGpuCapturer> capturer;
  };

  static bool contains(
      const std::array<std::shared_ptr<ScreenGpuCapturer>, kCapacity>& values,
      std::size_t size,
      const std::shared_ptr<ScreenGpuCapturer>& candidate) noexcept {
    return std::find(values.begin(), values.begin() + size, candidate) !=
        values.begin() + size;
  }

  static bool containsPlan(
      const Plan& plan,
      const std::shared_ptr<ScreenGpuCapturer>& candidate) noexcept {
    for (std::size_t index = 0; index < plan.size_; ++index) {
      if (plan.entries_[index].capturer == candidate) return true;
    }
    return false;
  }

  bool containsLocked(
      const std::shared_ptr<ScreenGpuCapturer>& candidate) const noexcept {
    return std::any_of(entries_.begin(), entries_.end(), [&](const auto& entry) {
      return entry.capturer == candidate;
    });
  }

  static void mergeCounters(
      ScreenFrameFlowStats& destination,
      const ScreenFrameFlowStats& source) noexcept {
    destination.gpu_submissions += source.gpu_submissions;
    destination.encoder_backpressure_ticks += source.encoder_backpressure_ticks;
    destination.superseded_ready_frames += source.superseded_ready_frames;
    destination.gpu_slot_timeouts += source.gpu_slot_timeouts;
    destination.gpu_slots_recovered += source.gpu_slots_recovered;
    destination.gpu_frames_dropped_stale += source.gpu_frames_dropped_stale;
    destination.gpu_pool_rollovers += source.gpu_pool_rollovers;
    destination.gpu_rollovers_blocked += source.gpu_rollovers_blocked;
    destination.preview_bridge_submissions += source.preview_bridge_submissions;
    destination.preview_bridge_acquires += source.preview_bridge_acquires;
    destination.preview_bridge_timeouts += source.preview_bridge_timeouts;
    destination.preview_bridge_slots_recovered +=
        source.preview_bridge_slots_recovered;
    destination.preview_gpu_submissions += source.preview_gpu_submissions;
    destination.preview_frames_completed += source.preview_frames_completed;
    destination.preview_slot_timeouts += source.preview_slot_timeouts;
    destination.preview_frames_dropped_stale +=
        source.preview_frames_dropped_stale;
    destination.preview_device_resets += source.preview_device_resets;
    destination.gpu_completion_max_us = std::max(
        destination.gpu_completion_max_us, source.gpu_completion_max_us);
  }

  mutable std::mutex mutex_;
  std::array<RetiredEntry, kCapacity> entries_;
  std::size_t size_ = 0;
  std::uint64_t next_id_ = 0;
  ScreenFrameFlowStats completed_stats_;
};

}  // namespace syrnike::desktop_native::media
