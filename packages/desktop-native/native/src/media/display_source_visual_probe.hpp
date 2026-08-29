#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <utility>

#include "../common/cleanup_supervisor.hpp"

namespace syrnike::desktop_native::media {

inline constexpr auto kDisplaySourceVisualProbeDeadline =
    std::chrono::milliseconds(500);
inline constexpr auto kDisplaySourceVisualCancellationPoll =
    std::chrono::milliseconds(5);
inline constexpr std::size_t kDisplaySourceVisualProbeConcurrency = 4;
inline constexpr std::size_t kDisplaySourceVisualProbeOwnershipCapacity =
    kDisplaySourceVisualProbeConcurrency * 2;

class DisplaySourceVisualProbeAdmission final {
public:
  explicit DisplaySourceVisualProbeAdmission(std::size_t capacity)
      : capacity_(capacity) {}

  [[nodiscard]] bool tryAcquire() noexcept {
    auto active = active_.load(std::memory_order_acquire);
    while (active < capacity_) {
      if (active_.compare_exchange_weak(
              active, active + 1, std::memory_order_acq_rel)) {
        return true;
      }
    }
    return false;
  }

  void release() noexcept {
    active_.fetch_sub(1, std::memory_order_acq_rel);
  }

private:
  const std::size_t capacity_;
  std::atomic_size_t active_{0};
};

// Runs one potentially blocking Win32 visual probe outside the native query
// lane. CleanupSupervisor retains the worker state if a driver or shell call
// outlives the response deadline, while cancellation prevents later stages or
// a stale result from being committed. Admission is kept equal to the dedicated
// supervisor's worker count, so blocked probes cannot build a persistent backlog
// or consume the shared critical-cleanup supervisor. The supervisor keeps one
// additional ownership slot per worker for the brief handoff after admission is
// released and before completed-job bookkeeping retires the old owner.
template <typename Result> class DisplaySourceVisualProbeAttempt final {
public:
  using Worker =
      std::function<std::optional<Result>(const std::atomic_bool &cancelled)>;

  static std::shared_ptr<DisplaySourceVisualProbeAttempt>
  start(CleanupSupervisor &supervisor,
        DisplaySourceVisualProbeAdmission &admission, Worker worker) {
    if (!admission.tryAcquire()) {
      return {};
    }
    try {
      auto attempt = std::shared_ptr<DisplaySourceVisualProbeAttempt>(
          new DisplaySourceVisualProbeAttempt(admission, std::move(worker)));
      auto job = std::make_shared<CleanupJob>();
      if (!job->prepare(
              attempt, 0,
              [](void *context) {
                static_cast<DisplaySourceVisualProbeAttempt *>(context)->run();
              }) ||
          supervisor.submit(job) != CleanupSubmitResult::Accepted) {
        admission.release();
        return {};
      }
      return attempt;
    } catch (...) {
      admission.release();
      throw;
    }
  }

  DisplaySourceVisualProbeAttempt(const DisplaySourceVisualProbeAttempt &) =
      delete;
  DisplaySourceVisualProbeAttempt &
  operator=(const DisplaySourceVisualProbeAttempt &) = delete;

  template <typename IsCurrent>
  std::optional<Result>
  waitUntil(std::chrono::steady_clock::time_point deadline,
            IsCurrent &&is_current) {
    std::unique_lock lock(mutex_);
    while (!finished_) {
      if (!std::invoke(is_current) ||
          std::chrono::steady_clock::now() >= deadline) {
        cancelled_.store(true, std::memory_order_release);
        return std::nullopt;
      }
      changed_.wait_until(
          lock, (std::min)(deadline, std::chrono::steady_clock::now() +
                                         kDisplaySourceVisualCancellationPoll));
    }
    if (cancelled_.load(std::memory_order_acquire) ||
        !std::invoke(is_current)) {
      cancelled_.store(true, std::memory_order_release);
      return std::nullopt;
    }
    return std::move(result_);
  }

  void cancel() noexcept {
    cancelled_.store(true, std::memory_order_release);
    changed_.notify_all();
  }

private:
  explicit DisplaySourceVisualProbeAttempt(
      DisplaySourceVisualProbeAdmission &admission, Worker worker)
      : admission_(admission), worker_(std::move(worker)) {}

  void run() noexcept {
    std::optional<Result> result;
    try {
      if (!cancelled_.load(std::memory_order_acquire)) {
        result = worker_(cancelled_);
      }
    } catch (...) {
    }
    {
      std::lock_guard lock(mutex_);
      if (!cancelled_.load(std::memory_order_acquire)) {
        result_ = std::move(result);
      }
      worker_ = {};
      admission_.release();
      finished_ = true;
    }
    changed_.notify_all();
  }

  std::mutex mutex_;
  std::condition_variable changed_;
  std::atomic_bool cancelled_{false};
  DisplaySourceVisualProbeAdmission &admission_;
  Worker worker_;
  std::optional<Result> result_;
  bool finished_ = false;
};

} // namespace syrnike::desktop_native::media
