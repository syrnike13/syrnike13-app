#include "cleanup_supervisor.hpp"

#include "diagnostic_log.hpp"

#include <algorithm>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

namespace syrnike::desktop_native {

CleanupJob::CleanupJob(CleanupStartProbe start_probe)
    : start_probe_(std::move(start_probe)) {}

bool CleanupJob::prepare(
    std::shared_ptr<void> owner,
    CleanupResourceKey resource_key,
    OwnerTask task,
    CompletionTask completion_task) noexcept {
  auto* context = owner.get();
  return prepare(
      std::move(owner),
      context,
      resource_key,
      task,
      completion_task);
}

bool CleanupJob::prepare(
    std::shared_ptr<void> owner,
    void* context,
    CleanupResourceKey resource_key,
    OwnerTask task,
    CompletionTask completion_task) noexcept {
  auto expected = State::Idle;
  if (!state_.compare_exchange_strong(
          expected,
          State::Preparing,
          std::memory_order_acq_rel)) {
    expected = State::Finished;
    if (!state_.compare_exchange_strong(
            expected,
            State::Preparing,
            std::memory_order_acq_rel)) {
      return false;
    }
  }
  owner_ = std::move(owner);
  context_ = context;
  resource_key_ = resource_key != 0
      ? resource_key
      : reinterpret_cast<CleanupResourceKey>(this);
  owner_task_ = task;
  completion_task_ = completion_task;
  next_.reset();
  state_.store(State::Prepared, std::memory_order_release);
  return true;
}

bool CleanupJob::prepareRaw(
    void* context,
    CleanupResourceKey resource_key,
    OwnerTask task) noexcept {
  return prepare({}, context, resource_key, task);
}

bool CleanupJob::finished() const noexcept {
  return state_.load(std::memory_order_acquire) == State::Finished;
}

bool CleanupJob::waitUntil(
    std::chrono::steady_clock::time_point deadline) const noexcept {
  std::unique_lock lock(finished_mutex_);
  finished_changed_.wait_until(lock, deadline, [&] { return finished(); });
  return finished();
}

void CleanupJob::run() noexcept {
  try {
    if (owner_task_) owner_task_(context_);
  } catch (...) {
  }
  try {
    if (completion_task_) completion_task_(context_);
  } catch (...) {
  }
  owner_.reset();
  context_ = nullptr;
  resource_key_ = 0;
  owner_task_ = nullptr;
  completion_task_ = nullptr;
}

class CleanupSupervisor::Implementation final {
 public:
  explicit Implementation(CleanupSupervisorConfig config)
      : config_(config) {
    if (config_.worker_limit == 0) {
      throw std::invalid_argument(
          "cleanup supervisor worker limit must be positive");
    }
    if (config_.admission_capacity < config_.worker_limit) {
      throw std::invalid_argument(
          "cleanup supervisor capacity must cover its workers");
    }
    workers_.reserve(config_.worker_limit);
    active_resource_keys_.reserve(config_.worker_limit);
    try {
      for (std::size_t index = 0; index < config_.worker_limit; ++index) {
        workers_.emplace_back([this] { runWorker(); });
      }
    } catch (...) {
      {
        std::lock_guard lock(mutex_);
        accepting_ = false;
        stopping_ = true;
      }
      changed_.notify_all();
      for (auto& worker : workers_) {
        if (worker.joinable()) worker.join();
      }
      throw;
    }
  }

  ~Implementation() {
    static_cast<void>(shutdown(std::chrono::steady_clock::time_point::max()));
  }

  CleanupSubmitResult submit(std::shared_ptr<CleanupJob> job) noexcept {
    if (!job) return CleanupSubmitResult::Invalid;
    std::lock_guard lock(mutex_);
    if (!accepting_) {
      ++closed_submissions_;
      return CleanupSubmitResult::Closed;
    }
    if (owned_jobs_ >= config_.admission_capacity) {
      ++saturated_submissions_;
      return CleanupSubmitResult::Saturated;
    }
    auto expected = CleanupJob::State::Prepared;
    if (!job->state_.compare_exchange_strong(
            expected,
            CleanupJob::State::Queued,
            std::memory_order_acq_rel)) {
      return CleanupSubmitResult::Invalid;
    }
    push(std::move(job));
    ++owned_jobs_;
    ++accepted_jobs_;
    peak_owned_jobs_ = (std::max)(peak_owned_jobs_, owned_jobs_);
    peak_backlog_jobs_ = (std::max)(peak_backlog_jobs_, backlog_jobs_);
    changed_.notify_one();
    return CleanupSubmitResult::Accepted;
  }

  CleanupSupervisorSnapshot snapshot() const noexcept {
    std::lock_guard lock(mutex_);
    CleanupSupervisorSnapshot result;
    result.worker_limit = config_.worker_limit;
    result.admission_capacity = config_.admission_capacity;
    result.worker_threads = workers_.size() - exited_workers_;
    result.worker_handles = static_cast<std::size_t>(std::count_if(
        workers_.begin(), workers_.end(), [](const std::thread& worker) {
          return worker.joinable();
        }));
    result.active_jobs = active_jobs_;
    result.backlog_jobs = backlog_jobs_;
    result.owned_jobs = owned_jobs_;
    result.peak_active_jobs = peak_active_jobs_;
    result.peak_backlog_jobs = peak_backlog_jobs_;
    result.peak_owned_jobs = peak_owned_jobs_;
    result.accepted_jobs = accepted_jobs_;
    result.completed_jobs = completed_jobs_;
    result.saturated_submissions = saturated_submissions_;
    result.closed_submissions = closed_submissions_;
    result.start_failures = start_failures_;
    return result;
  }

  CleanupShutdownReport shutdown(
      std::chrono::steady_clock::time_point deadline) noexcept {
    {
      std::lock_guard lock(mutex_);
      accepting_ = false;
      stopping_ = true;
    }
    changed_.notify_all();

    bool finished = false;
    {
      std::unique_lock lock(mutex_);
      finished_changed_.wait_until(lock, deadline, [&] {
        return exited_workers_ == workers_.size();
      });
      finished = exited_workers_ == workers_.size();
    }
    if (finished) {
      for (auto& worker : workers_) {
        if (worker.joinable()) worker.join();
      }
    }

    std::lock_guard lock(mutex_);
    CleanupShutdownReport report;
    report.finished = finished;
    report.unfinished_jobs = owned_jobs_;
    report.active_jobs = active_jobs_;
    report.backlog_jobs = backlog_jobs_;
    report.worker_threads = workers_.size() - exited_workers_;
    report.worker_handles = static_cast<std::size_t>(std::count_if(
        workers_.begin(), workers_.end(), [](const std::thread& worker) {
          return worker.joinable();
        }));
    return report;
  }

 private:
  void push(std::shared_ptr<CleanupJob> job) noexcept {
    job->next_.reset();
    if (tail_) {
      tail_->next_ = job;
    } else {
      head_ = job;
    }
    tail_ = job.get();
    ++backlog_jobs_;
  }

  [[nodiscard]] bool resourceActive(
      CleanupResourceKey resource_key) const noexcept {
    return std::find(
               active_resource_keys_.begin(),
               active_resource_keys_.end(),
               resource_key) != active_resource_keys_.end();
  }

  [[nodiscard]] bool hasRunnableJob() const noexcept {
    auto job = head_;
    while (job) {
      if (!resourceActive(job->resource_key_)) return true;
      job = job->next_;
    }
    return false;
  }

  std::shared_ptr<CleanupJob> popRunnable() noexcept {
    auto* link = &head_;
    CleanupJob* previous = nullptr;
    while (*link) {
      if (!resourceActive((*link)->resource_key_)) {
        auto job = std::move(*link);
        *link = std::move(job->next_);
        job->next_.reset();
        --backlog_jobs_;
        if (tail_ == job.get()) tail_ = previous;
        return job;
      }
      previous = link->get();
      link = &((*link)->next_);
    }
    return {};
  }

  void runWorker() noexcept {
    for (;;) {
      std::shared_ptr<CleanupJob> job;
      CleanupResourceKey resource_key = 0;
      {
        std::unique_lock lock(mutex_);
        changed_.wait(lock, [&] {
          return hasRunnableJob() || (stopping_ && head_ == nullptr);
        });
        if (!head_) {
          if (!stopping_) continue;
          ++exited_workers_;
          finished_changed_.notify_all();
          return;
        }
        job = popRunnable();
        if (!job) continue;
        resource_key = job->resource_key_;
        active_resource_keys_.push_back(resource_key);
        job->state_.store(
            CleanupJob::State::Running, std::memory_order_release);
        ++active_jobs_;
        peak_active_jobs_ = (std::max)(peak_active_jobs_, active_jobs_);
      }

      constexpr std::size_t maximum_start_probe_failures = 4;
      for (std::size_t failure = 0;; ++failure) {
        try {
          if (job->start_probe_) job->start_probe_();
          break;
        } catch (...) {
          {
            std::lock_guard lock(mutex_);
            ++start_failures_;
          }
          // The fixed worker is already live, so this fault-injection probe
          // cannot veto cleanup forever. Retry with a bounded backoff, then
          // use the live worker directly to preserve shutdown liveness.
          if (failure + 1 >= maximum_start_probe_failures) break;
          std::this_thread::sleep_for(
              std::chrono::milliseconds(1U << failure));
        }
      }

      job->run();

      {
        std::lock_guard lock(mutex_);
        const auto active_key = std::find(
            active_resource_keys_.begin(),
            active_resource_keys_.end(),
            resource_key);
        if (active_key != active_resource_keys_.end()) {
          active_resource_keys_.erase(active_key);
        }
        --active_jobs_;
        --owned_jobs_;
        ++completed_jobs_;
        job->state_.store(
            CleanupJob::State::Finished, std::memory_order_release);
      }
      job->finished_changed_.notify_all();
      changed_.notify_all();
      finished_changed_.notify_all();
    }
  }

  CleanupSupervisorConfig config_;
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::condition_variable finished_changed_;
  std::vector<std::thread> workers_;
  std::vector<CleanupResourceKey> active_resource_keys_;
  std::shared_ptr<CleanupJob> head_;
  CleanupJob* tail_ = nullptr;
  std::size_t active_jobs_ = 0;
  std::size_t backlog_jobs_ = 0;
  std::size_t owned_jobs_ = 0;
  std::size_t peak_active_jobs_ = 0;
  std::size_t peak_backlog_jobs_ = 0;
  std::size_t peak_owned_jobs_ = 0;
  std::size_t exited_workers_ = 0;
  std::uint64_t accepted_jobs_ = 0;
  std::uint64_t completed_jobs_ = 0;
  std::uint64_t saturated_submissions_ = 0;
  std::uint64_t closed_submissions_ = 0;
  std::uint64_t start_failures_ = 0;
  bool accepting_ = true;
  bool stopping_ = false;
};

CleanupSupervisor::CleanupSupervisor(CleanupSupervisorConfig config)
    : implementation_(std::make_unique<Implementation>(config)) {}

CleanupSupervisor::~CleanupSupervisor() = default;

CleanupSupervisor& CleanupSupervisor::instance() {
  static auto* supervisor = new CleanupSupervisor();
  return *supervisor;
}

CleanupSubmitResult CleanupSupervisor::submit(
    std::shared_ptr<CleanupJob> job) noexcept {
  const auto result = implementation_->submit(std::move(job));
  const auto state = snapshot();
  const char* outcome = "invalid";
  if (result == CleanupSubmitResult::Accepted) outcome = "accepted";
  if (result == CleanupSubmitResult::Saturated) outcome = "saturated";
  if (result == CleanupSubmitResult::Closed) outcome = "closed";
  diagnostics::DiagnosticLog::instance().write(
      "native_cleanup_state",
      {
          {"outcome", outcome},
          {"workerLimit", static_cast<std::uint64_t>(state.worker_limit)},
          {"admissionCapacity",
           static_cast<std::uint64_t>(state.admission_capacity)},
          {"workerThreads",
           static_cast<std::uint64_t>(state.worker_threads)},
          {"workerHandles",
           static_cast<std::uint64_t>(state.worker_handles)},
          {"activeJobs", static_cast<std::uint64_t>(state.active_jobs)},
          {"backlogJobs", static_cast<std::uint64_t>(state.backlog_jobs)},
          {"ownedJobs", static_cast<std::uint64_t>(state.owned_jobs)},
          {"acceptedJobs", state.accepted_jobs},
          {"completedJobs", state.completed_jobs},
          {"saturatedSubmissions", state.saturated_submissions},
          {"closedSubmissions", state.closed_submissions},
          {"startFailures", state.start_failures},
      });
  return result;
}

void CleanupSupervisor::submitOrEscalate(
    std::shared_ptr<CleanupJob> job,
    std::string_view owner) noexcept {
  const auto result = submit(job);
  const char* outcome = "invalid";
  if (result == CleanupSubmitResult::Accepted) outcome = "accepted";
  if (result == CleanupSubmitResult::Saturated) outcome = "saturated";
  if (result == CleanupSubmitResult::Closed) outcome = "closed";
  diagnostics::DiagnosticLog::instance().write(
      "native_cleanup_submission",
      {{"owner", owner}, {"outcome", outcome}});
  if (result == CleanupSubmitResult::Accepted) return;
  const auto state = snapshot();
  const char* reason = outcome;
  diagnostics::DiagnosticLog::instance().write(
      "native_cleanup_admission_failed",
      {
          {"owner", owner},
          {"reason", reason},
          {"workerLimit", static_cast<std::uint64_t>(state.worker_limit)},
          {"admissionCapacity",
           static_cast<std::uint64_t>(state.admission_capacity)},
          {"activeJobs", static_cast<std::uint64_t>(state.active_jobs)},
          {"backlogJobs", static_cast<std::uint64_t>(state.backlog_jobs)},
          {"ownedJobs", static_cast<std::uint64_t>(state.owned_jobs)},
      });
  std::terminate();
}

CleanupSupervisorSnapshot CleanupSupervisor::snapshot() const noexcept {
  return implementation_->snapshot();
}

CleanupShutdownReport CleanupSupervisor::shutdown(
    std::chrono::steady_clock::time_point deadline) noexcept {
  const auto started_at = std::chrono::steady_clock::now();
  const auto deadline_budget_ms = std::chrono::duration_cast<
      std::chrono::milliseconds>(deadline - started_at).count();
  const auto report = implementation_->shutdown(deadline);
  const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started_at).count();
  diagnostics::DiagnosticLog::instance().write(
      "native_cleanup_shutdown",
      {
          {"outcome", report.finished ? "finished" : "deadline"},
          {"deadlineBudgetMs", static_cast<std::uint64_t>(
             (std::max<std::int64_t>)(0, deadline_budget_ms))},
          {"elapsedMs", static_cast<std::uint64_t>(
             (std::max<std::int64_t>)(0, elapsed_ms))},
          {"unfinishedJobs",
           static_cast<std::uint64_t>(report.unfinished_jobs)},
          {"activeJobs", static_cast<std::uint64_t>(report.active_jobs)},
          {"backlogJobs", static_cast<std::uint64_t>(report.backlog_jobs)},
          {"workerThreads",
           static_cast<std::uint64_t>(report.worker_threads)},
          {"workerHandles",
           static_cast<std::uint64_t>(report.worker_handles)},
          {"detachedThreads",
           static_cast<std::uint64_t>(report.detached_threads)},
      });
  return report;
}

CleanupStartProbe failFirstCleanupStartProbe(bool enabled) {
  if (!enabled) return {};
  auto failed = std::make_shared<std::atomic_bool>(false);
  return [failed] {
    if (!failed->exchange(true)) {
      throw std::runtime_error("injected cleanup start failure");
    }
  };
}

void runCleanupEnqueueProbe(const CleanupEnqueueProbe& probe) noexcept {
  if (!probe) return;
  try {
    probe();
    return;
  } catch (...) {
  }
  try {
    probe();
  } catch (...) {
  }
}

}  // namespace syrnike::desktop_native
