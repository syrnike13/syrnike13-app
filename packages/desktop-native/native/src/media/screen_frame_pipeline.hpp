#pragma once

#include <algorithm>
#include <atomic>
#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <thread>
#include <utility>

namespace syrnike::desktop_native::media {

enum class ScreenFrameSubmitReason {
  None,
  SourceUpdate,
  IdleRefresh,
};

// Capture adapters update visual state whenever the OS supplies it. The output
// clock samples that state independently: a newer revision is submitted once,
// while an idle refresh keeps static screen shares joinable without encoding
// the same desktop at the configured maximum frame rate.
class ScreenFrameCadence final {
 public:
  using Clock = std::chrono::steady_clock;
  using TimePoint = Clock::time_point;

  explicit ScreenFrameCadence(
      Clock::duration idle_refresh = std::chrono::seconds(1)) noexcept
      : idle_refresh_(idle_refresh) {}

  void reset() noexcept {
    last_submission_ = TimePoint{};
    source_revision_.store(0, std::memory_order_relaxed);
    submitted_revision_ = 0;
    submissions_.store(0, std::memory_order_relaxed);
    idle_refreshes_.store(0, std::memory_order_relaxed);
    coalesced_source_updates_.store(0, std::memory_order_relaxed);
    has_source_ = false;
  }

  void noteSourceUpdate() noexcept {
    const auto source_revision =
        source_revision_.load(std::memory_order_relaxed);
    if (has_source_ && source_revision != submitted_revision_) {
      coalesced_source_updates_.fetch_add(1, std::memory_order_relaxed);
    }
    has_source_ = true;
    source_revision_.store(source_revision + 1, std::memory_order_release);
  }

  [[nodiscard]] ScreenFrameSubmitReason decision(TimePoint now) const noexcept {
    if (!has_source_) return ScreenFrameSubmitReason::None;
    if (source_revision_.load(std::memory_order_acquire) !=
        submitted_revision_) {
      return ScreenFrameSubmitReason::SourceUpdate;
    }
    if (last_submission_ == TimePoint{} ||
        now - last_submission_ >= idle_refresh_) {
      return ScreenFrameSubmitReason::IdleRefresh;
    }
    return ScreenFrameSubmitReason::None;
  }

  void noteSubmitted(
      ScreenFrameSubmitReason reason,
      TimePoint now) noexcept {
    if (reason == ScreenFrameSubmitReason::None) return;
    submitted_revision_ = source_revision_.load(std::memory_order_acquire);
    last_submission_ = now;
    submissions_.fetch_add(1, std::memory_order_relaxed);
    if (reason == ScreenFrameSubmitReason::IdleRefresh) {
      idle_refreshes_.fetch_add(1, std::memory_order_relaxed);
    }
  }

  [[nodiscard]] std::uint64_t sourceRevision() const noexcept {
    return source_revision_.load(std::memory_order_acquire);
  }
  [[nodiscard]] std::uint64_t submissions() const noexcept {
    return submissions_.load(std::memory_order_relaxed);
  }
  [[nodiscard]] std::uint64_t idleRefreshes() const noexcept {
    return idle_refreshes_.load(std::memory_order_relaxed);
  }
  [[nodiscard]] std::uint64_t coalescedSourceUpdates() const noexcept {
    return coalesced_source_updates_.load(std::memory_order_relaxed);
  }

 private:
  Clock::duration idle_refresh_;
  TimePoint last_submission_{};
  std::atomic<std::uint64_t> source_revision_{0};
  std::uint64_t submitted_revision_ = 0;
  std::atomic<std::uint64_t> submissions_{0};
  std::atomic<std::uint64_t> idle_refreshes_{0};
  std::atomic<std::uint64_t> coalesced_source_updates_{0};
  bool has_source_ = false;
};

struct ScreenLatencyQuantiles {
  std::uint64_t p50_us = 0;
  std::uint64_t p95_us = 0;
  std::uint64_t max_us = 0;
};

struct ScreenPreviewWorkSnapshot {
  std::uint64_t requested = 0;
  std::uint64_t coalesced = 0;
  std::uint64_t disabled_drops = 0;
  std::uint64_t pending = 0;
};

// Process-local wakeup shared by every preview lane owned by one ScreenActor.
// Capture threads only increment the epoch and notify; they never take the
// worker mutex. The worker can therefore sleep indefinitely while preview is
// idle and use a short timed wait only while GPU/retirement work is pending.
class ScreenPreviewWorkSignal final {
 public:
  using Duration = std::chrono::steady_clock::duration;

  void notify() noexcept {
    epoch_.fetch_add(1, std::memory_order_release);
    epoch_.notify_one();
  }

  void stop() noexcept {
    stopped_.store(true, std::memory_order_release);
    epoch_.fetch_add(1, std::memory_order_release);
    epoch_.notify_all();
  }

  [[nodiscard]] std::uint64_t epoch() const noexcept {
    return epoch_.load(std::memory_order_acquire);
  }

  [[nodiscard]] bool waitForChange(
      std::uint64_t observed_epoch,
      std::optional<Duration> maximum_wait = std::nullopt) noexcept {
    if (maximum_wait) {
      if (stopped_.load(std::memory_order_acquire) ||
          epoch_.load(std::memory_order_acquire) != observed_epoch) {
        return !stopped_.load(std::memory_order_acquire);
      }
      std::this_thread::sleep_for(*maximum_wait);
      return !stopped_.load(std::memory_order_acquire);
    }
    while (!stopped_.load(std::memory_order_acquire) &&
           epoch_.load(std::memory_order_acquire) == observed_epoch) {
      epoch_.wait(observed_epoch, std::memory_order_acquire);
    }
    return !stopped_.load(std::memory_order_acquire);
  }

 private:
  std::atomic<std::uint64_t> epoch_{0};
  std::atomic_bool stopped_{false};
};

// A single-slot notification lane for optional preview work. The capture
// thread only replaces the pending revision and never waits for the preview
// worker; a blocked resize/import/delivery therefore coalesces intermediate
// frames and resumes from the newest captured revision.
class ScreenPreviewWorkLane final {
 public:
  explicit ScreenPreviewWorkLane(
      std::shared_ptr<ScreenPreviewWorkSignal> signal = {}) noexcept
      : signal_(std::move(signal)) {}

  void setEnabled(bool enabled) noexcept {
    enabled_.store(enabled, std::memory_order_release);
    if (!enabled) pending_.store(0, std::memory_order_release);
    notifyWorker();
  }

  [[nodiscard]] bool request(std::uint64_t revision) noexcept {
    if (revision == 0 || !enabled_.load(std::memory_order_acquire)) {
      disabled_drops_.fetch_add(1, std::memory_order_relaxed);
      return false;
    }
    requested_.fetch_add(1, std::memory_order_relaxed);
    const auto previous = pending_.exchange(revision, std::memory_order_acq_rel);
    if (previous != 0) {
      coalesced_.fetch_add(1, std::memory_order_relaxed);
    }
    if (previous == 0) notifyWorker();
    return true;
  }

  [[nodiscard]] std::optional<std::uint64_t> takeLatest() noexcept {
    const auto revision = pending_.exchange(0, std::memory_order_acq_rel);
    if (revision == 0) return std::nullopt;
    return revision;
  }

  [[nodiscard]] ScreenPreviewWorkSnapshot snapshot() const noexcept {
    return {
        requested_.load(std::memory_order_relaxed),
        coalesced_.load(std::memory_order_relaxed),
        disabled_drops_.load(std::memory_order_relaxed),
        pending_.load(std::memory_order_acquire),
    };
  }

 private:
  void notifyWorker() noexcept {
    if (signal_) signal_->notify();
  }

  std::shared_ptr<ScreenPreviewWorkSignal> signal_;
  std::atomic_bool enabled_{false};
  std::atomic<std::uint64_t> pending_{0};
  std::atomic<std::uint64_t> requested_{0};
  std::atomic<std::uint64_t> coalesced_{0};
  std::atomic<std::uint64_t> disabled_drops_{0};
};

class ScreenTelemetryCadence final {
 public:
  using Clock = std::chrono::steady_clock;
  using TimePoint = Clock::time_point;

  explicit ScreenTelemetryCadence(
      Clock::duration interval = std::chrono::seconds(1)) noexcept
      : interval_(interval) {}

  [[nodiscard]] bool shouldSample(TimePoint now) noexcept {
    if (next_sample_ == TimePoint{}) {
      next_sample_ = now + interval_;
      return true;
    }
    if (now < next_sample_) return false;
    const auto missed = (now - next_sample_) / interval_;
    next_sample_ += interval_ * (missed + 1);
    return true;
  }

 private:
  Clock::duration interval_;
  TimePoint next_sample_{};
};

template <std::size_t Capacity>
class ScreenLatencyWindow final {
 public:
  static_assert(Capacity > 0);

  void record(std::uint64_t value_us) noexcept {
    samples_[next_].store(value_us, std::memory_order_release);
    next_ = (next_ + 1) % Capacity;
    const auto size = size_.load(std::memory_order_relaxed);
    if (size < Capacity) size_.store(size + 1, std::memory_order_release);
  }

  [[nodiscard]] ScreenLatencyQuantiles snapshot() const noexcept {
    const auto size = size_.load(std::memory_order_acquire);
    if (size == 0) return {};
    std::array<std::uint64_t, Capacity> sorted{};
    for (std::size_t index = 0; index < size; ++index) {
      sorted[index] = samples_[index].load(std::memory_order_acquire);
    }
    std::sort(sorted.begin(), sorted.begin() + size);
    const auto percentile = [&](std::size_t numerator) {
      const auto rank = (size * numerator + 99) / 100;
      return sorted[std::max<std::size_t>(1, rank) - 1];
    };
    return {percentile(50), percentile(95), sorted[size - 1]};
  }

  [[nodiscard]] std::size_t size() const noexcept {
    return size_.load(std::memory_order_acquire);
  }

 private:
  std::array<std::atomic<std::uint64_t>, Capacity> samples_{};
  std::size_t next_ = 0;
  std::atomic<std::size_t> size_{0};
};

}  // namespace syrnike::desktop_native::media
