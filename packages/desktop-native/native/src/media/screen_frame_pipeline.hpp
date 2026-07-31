#pragma once

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>

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

  void reset() noexcept { *this = ScreenFrameCadence(idle_refresh_); }

  void noteSourceUpdate() noexcept {
    if (has_source_ && source_revision_ != submitted_revision_) {
      ++coalesced_source_updates_;
    }
    has_source_ = true;
    ++source_revision_;
  }

  [[nodiscard]] ScreenFrameSubmitReason decision(TimePoint now) const noexcept {
    if (!has_source_) return ScreenFrameSubmitReason::None;
    if (source_revision_ != submitted_revision_) {
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
    submitted_revision_ = source_revision_;
    last_submission_ = now;
    ++submissions_;
    if (reason == ScreenFrameSubmitReason::IdleRefresh) ++idle_refreshes_;
  }

  [[nodiscard]] std::uint64_t sourceRevision() const noexcept {
    return source_revision_;
  }
  [[nodiscard]] std::uint64_t submissions() const noexcept {
    return submissions_;
  }
  [[nodiscard]] std::uint64_t idleRefreshes() const noexcept {
    return idle_refreshes_;
  }
  [[nodiscard]] std::uint64_t coalescedSourceUpdates() const noexcept {
    return coalesced_source_updates_;
  }

 private:
  Clock::duration idle_refresh_;
  TimePoint last_submission_{};
  std::uint64_t source_revision_ = 0;
  std::uint64_t submitted_revision_ = 0;
  std::uint64_t submissions_ = 0;
  std::uint64_t idle_refreshes_ = 0;
  std::uint64_t coalesced_source_updates_ = 0;
  bool has_source_ = false;
};

struct ScreenLatencyQuantiles {
  std::uint64_t p50_us = 0;
  std::uint64_t p95_us = 0;
  std::uint64_t max_us = 0;
};

template <std::size_t Capacity>
class ScreenLatencyWindow final {
 public:
  static_assert(Capacity > 0);

  void record(std::uint64_t value_us) noexcept {
    samples_[next_] = value_us;
    next_ = (next_ + 1) % Capacity;
    size_ = std::min<std::size_t>(size_ + 1, Capacity);
  }

  [[nodiscard]] ScreenLatencyQuantiles snapshot() const noexcept {
    if (size_ == 0) return {};
    auto sorted = samples_;
    std::sort(sorted.begin(), sorted.begin() + size_);
    const auto percentile = [&](std::size_t numerator) {
      const auto rank = (size_ * numerator + 99) / 100;
      return sorted[std::max<std::size_t>(1, rank) - 1];
    };
    return {percentile(50), percentile(95), sorted[size_ - 1]};
  }

  [[nodiscard]] std::size_t size() const noexcept { return size_; }

 private:
  std::array<std::uint64_t, Capacity> samples_{};
  std::size_t next_ = 0;
  std::size_t size_ = 0;
};

}  // namespace syrnike::desktop_native::media
