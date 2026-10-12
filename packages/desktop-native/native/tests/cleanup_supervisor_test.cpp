#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdio>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "../src/common/cleanup_supervisor.hpp"

namespace {

using namespace std::chrono_literals;
using syrnike::desktop_native::CleanupJob;
using syrnike::desktop_native::CleanupResourceKey;
using syrnike::desktop_native::CleanupSubmitResult;
using syrnike::desktop_native::CleanupSupervisor;
using syrnike::desktop_native::CleanupSupervisorConfig;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

struct BlockingCleanupState {
  std::mutex mutex;
  std::condition_variable changed;
  std::size_t active = 0;
  std::size_t peak_active = 0;
  std::size_t completed = 0;
  bool release = false;
};

void runBlockedCleanup(void* context) noexcept {
  auto* state = static_cast<BlockingCleanupState*>(context);
  std::unique_lock lock(state->mutex);
  ++state->active;
  state->peak_active = (std::max)(state->peak_active, state->active);
  state->changed.notify_all();
  state->changed.wait(lock, [&] { return state->release; });
  --state->active;
  ++state->completed;
  state->changed.notify_all();
}

void configuredWorkerBudgetBoundsBlockedCleanup() {
  constexpr std::size_t worker_limit = 4;
  constexpr std::size_t job_count = 64;
  CleanupSupervisor supervisor(CleanupSupervisorConfig{
      .worker_limit = worker_limit,
      .admission_capacity = job_count,
  });
  auto state = std::make_shared<BlockingCleanupState>();
  std::vector<std::shared_ptr<CleanupJob>> jobs;
  jobs.reserve(job_count);

  for (std::size_t index = 0; index < job_count; ++index) {
    auto job = std::make_shared<CleanupJob>();
    job->prepare(state, index + 1, &runBlockedCleanup);
    require(
        supervisor.submit(job) == CleanupSubmitResult::Accepted,
        "cleanup supervisor rejected work within its ownership budget");
    jobs.push_back(std::move(job));
  }
  std::atomic_uint64_t rejected_runs{0};
  auto rejected = std::make_shared<CleanupJob>();
  rejected->prepare(
      std::shared_ptr<void>(&rejected_runs, [](void*) {}),
      job_count + 1,
      [](void* context) noexcept {
        static_cast<std::atomic_uint64_t*>(context)->fetch_add(1);
      });
  require(
      supervisor.submit(rejected) == CleanupSubmitResult::Saturated &&
          rejected_runs.load() == 0,
      "saturated cleanup submission was not rejected explicitly");

  {
    std::unique_lock lock(state->mutex);
    require(
        state->changed.wait_for(lock, 2s, [&] {
          return state->active == worker_limit;
        }),
        "cleanup supervisor did not use its configured worker budget");
    require(
        state->peak_active == worker_limit,
        "blocked cleanup exceeded the configured worker budget");
  }
  const auto blocked = supervisor.snapshot();
  require(
      blocked.worker_threads == worker_limit &&
          blocked.worker_handles == worker_limit &&
          blocked.admission_capacity == job_count &&
          blocked.active_jobs == worker_limit &&
          blocked.backlog_jobs == job_count - worker_limit &&
          blocked.owned_jobs == job_count &&
          blocked.peak_owned_jobs <= blocked.admission_capacity &&
          blocked.peak_backlog_jobs <= blocked.admission_capacity,
      "cleanup supervisor telemetry did not describe active ownership");
  require(
      blocked.saturated_submissions == 1,
      "cleanup supervisor did not report saturation");

  {
    std::lock_guard lock(state->mutex);
    state->release = true;
  }
  state->changed.notify_all();
  {
    std::unique_lock lock(state->mutex);
    require(
        state->changed.wait_for(lock, 2s, [&] {
          return state->completed == job_count;
        }),
        "accepted cleanup jobs did not complete exactly once");
  }
  const auto report = supervisor.shutdown(
      std::chrono::steady_clock::now() + 1s);
  require(
      report.finished && report.unfinished_jobs == 0 &&
          report.detached_threads == 0,
      "drained cleanup supervisor did not join its fixed workers");
}

struct OrderedCleanupState {
  std::mutex mutex;
  std::condition_variable changed;
  std::vector<int> same_resource_order;
  bool first_started = false;
  bool release_first = false;
  bool independent_finished = false;
};

void runFirstOrderedCleanup(void* context) noexcept {
  auto* state = static_cast<OrderedCleanupState*>(context);
  std::unique_lock lock(state->mutex);
  state->first_started = true;
  state->changed.notify_all();
  state->changed.wait(lock, [&] { return state->release_first; });
  state->same_resource_order.push_back(1);
  state->changed.notify_all();
}

void runSecondOrderedCleanup(void* context) noexcept {
  auto* state = static_cast<OrderedCleanupState*>(context);
  std::lock_guard lock(state->mutex);
  state->same_resource_order.push_back(2);
  state->changed.notify_all();
}

void runIndependentCleanup(void* context) noexcept {
  auto* state = static_cast<OrderedCleanupState*>(context);
  std::lock_guard lock(state->mutex);
  state->independent_finished = true;
  state->changed.notify_all();
}

void resourceOrderingDoesNotBlockIndependentCleanup() {
  CleanupSupervisor supervisor(CleanupSupervisorConfig{
      .worker_limit = 2,
      .admission_capacity = 4,
  });
  auto state = std::make_shared<OrderedCleanupState>();
  auto first = std::make_shared<CleanupJob>();
  auto second = std::make_shared<CleanupJob>();
  auto independent = std::make_shared<CleanupJob>();
  constexpr CleanupResourceKey ordered_resource = 11;
  first->prepare(state, ordered_resource, &runFirstOrderedCleanup);
  second->prepare(state, ordered_resource, &runSecondOrderedCleanup);
  independent->prepare(state, 22, &runIndependentCleanup);
  require(
      supervisor.submit(first) == CleanupSubmitResult::Accepted,
      "first ordered cleanup was rejected");
  {
    std::unique_lock lock(state->mutex);
    require(
        state->changed.wait_for(lock, 1s, [&] {
          return state->first_started;
        }),
        "first ordered cleanup did not start");
  }
  require(
      supervisor.submit(second) == CleanupSubmitResult::Accepted &&
          supervisor.submit(independent) == CleanupSubmitResult::Accepted,
      "ordered cleanup scenario exceeded its ownership budget");
  bool ran_out_of_order = false;
  {
    std::unique_lock lock(state->mutex);
    require(
        state->changed.wait_for(lock, 1s, [&] {
          return state->independent_finished;
        }),
        "an independent resource did not make bounded cleanup progress");
    ran_out_of_order = !state->same_resource_order.empty();
    state->release_first = true;
  }
  state->changed.notify_all();
  {
    std::unique_lock lock(state->mutex);
    require(
        state->changed.wait_for(lock, 1s, [&] {
          return state->same_resource_order.size() == 2;
        }),
        "ordered cleanup did not drain after its first job completed");
    require(
        !ran_out_of_order,
        "cleanup for one native resource ran out of order");
    require(
        state->same_resource_order[0] == 1 &&
            state->same_resource_order[1] == 2,
        "cleanup jobs did not preserve native-resource order");
  }
  require(
      supervisor.shutdown(std::chrono::steady_clock::now() + 1s).finished,
      "ordered cleanup supervisor did not shut down");
}

void failedJobStartRetriesWithoutDuplicatingCleanup() {
  std::atomic_uint64_t starts{0};
  std::atomic_uint64_t runs{0};
  CleanupSupervisor supervisor(CleanupSupervisorConfig{
      .worker_limit = 1,
      .admission_capacity = 2,
  });
  auto job = std::make_shared<CleanupJob>([&] {
    if (starts.fetch_add(1) == 0) {
      throw std::runtime_error("injected cleanup start failure");
    }
  });
  job->prepare(
      std::shared_ptr<void>(&runs, [](void*) {}),
      33,
      [](void* context) noexcept {
        static_cast<std::atomic_uint64_t*>(context)->fetch_add(1);
      });
  require(
      supervisor.submit(job) == CleanupSubmitResult::Accepted,
      "cleanup start retry scenario was rejected");
  require(
      job->waitUntil(std::chrono::steady_clock::now() + 1s),
      "cleanup did not retry after a start failure");
  const auto snapshot = supervisor.snapshot();
  require(
      starts.load() == 2 && runs.load() == 1 &&
          snapshot.start_failures == 1 && snapshot.completed_jobs == 1,
      "cleanup start retry lost or duplicated ownership");
  require(
      supervisor.shutdown(std::chrono::steady_clock::now() + 1s).finished,
      "cleanup start retry supervisor did not shut down");
}

void permanentStartProbeFailureCannotStarveCleanup() {
  std::atomic_uint64_t starts{0};
  std::atomic_uint64_t runs{0};
  CleanupSupervisor supervisor(CleanupSupervisorConfig{
      .worker_limit = 1,
      .admission_capacity = 1,
  });
  auto job = std::make_shared<CleanupJob>([&] {
    starts.fetch_add(1);
    throw std::runtime_error("permanent injected cleanup start failure");
  });
  require(
      job->prepare(
          std::shared_ptr<void>(&runs, [](void*) {}),
          35,
          [](void* context) noexcept {
            static_cast<std::atomic_uint64_t*>(context)->fetch_add(1);
          }),
      "permanent start failure cleanup was not prepared");
  require(
      supervisor.submit(job) == CleanupSubmitResult::Accepted,
      "permanent start failure cleanup was rejected");
  require(
      job->waitUntil(std::chrono::steady_clock::now() + 1s),
      "a permanent start probe failure starved cleanup");
  const auto snapshot = supervisor.snapshot();
  require(
      starts.load() > 0 && starts.load() <= 16 && runs.load() == 1 &&
          snapshot.start_failures == starts.load(),
      "permanent start probe failure was not bounded or lost cleanup");
  require(
      supervisor.shutdown(std::chrono::steady_clock::now() + 1s).finished,
      "permanent start probe failure prevented shutdown");
}

void jobCanOnlyBePreparedAgainAfterFinishing() {
  std::atomic_uint64_t runs{0};
  auto owner = std::shared_ptr<void>(&runs, [](void*) {});
  auto job = std::make_shared<CleanupJob>();
  CleanupSupervisor supervisor(CleanupSupervisorConfig{
      .worker_limit = 1,
      .admission_capacity = 2,
  });
  require(
      job->prepare(owner, 36, [](void* context) noexcept {
        static_cast<std::atomic_uint64_t*>(context)->fetch_add(1);
      }),
      "new cleanup job was not prepared");
  require(
      !job->prepare(owner, 36, [](void* context) noexcept {
        static_cast<std::atomic_uint64_t*>(context)->fetch_add(10);
      }),
      "cleanup job was overwritten before it finished");
  require(
      supervisor.submit(job) == CleanupSubmitResult::Accepted &&
          job->waitUntil(std::chrono::steady_clock::now() + 1s) &&
          runs.load() == 1,
      "initial cleanup job did not retain its prepared task");
  require(
      job->prepare(owner, 36, [](void* context) noexcept {
        static_cast<std::atomic_uint64_t*>(context)->fetch_add(10);
      }),
      "finished cleanup job could not be prepared again");
  require(
      supervisor.submit(job) == CleanupSubmitResult::Accepted &&
          job->waitUntil(std::chrono::steady_clock::now() + 1s) &&
          runs.load() == 11,
      "re-prepared cleanup job did not run exactly once");
  require(
      supervisor.shutdown(std::chrono::steady_clock::now() + 1s).finished,
      "re-prepared cleanup supervisor did not shut down");
}

struct RetryOrderState {
  std::mutex mutex;
  std::condition_variable changed;
  bool first_probe_entered = false;
  bool release_first_probe = false;
  std::vector<int> order;
};

void runRetryOrderFirst(void* context) noexcept {
  auto* state = static_cast<RetryOrderState*>(context);
  std::lock_guard lock(state->mutex);
  state->order.push_back(1);
  state->changed.notify_all();
}

void runRetryOrderSecond(void* context) noexcept {
  auto* state = static_cast<RetryOrderState*>(context);
  std::lock_guard lock(state->mutex);
  state->order.push_back(2);
  state->changed.notify_all();
}

void failedStartPreservesResourceOrder() {
  CleanupSupervisor supervisor(CleanupSupervisorConfig{
      .worker_limit = 1,
      .admission_capacity = 2,
  });
  auto state = std::make_shared<RetryOrderState>();
  std::atomic_uint64_t probes{0};
  auto first = std::make_shared<CleanupJob>([&] {
    if (probes.fetch_add(1) != 0) return;
    std::unique_lock lock(state->mutex);
    state->first_probe_entered = true;
    state->changed.notify_all();
    state->changed.wait(lock, [&] { return state->release_first_probe; });
    throw std::runtime_error("injected ordered cleanup start failure");
  });
  auto second = std::make_shared<CleanupJob>();
  constexpr CleanupResourceKey resource = 34;
  first->prepare(state, resource, &runRetryOrderFirst);
  second->prepare(state, resource, &runRetryOrderSecond);
  require(
      supervisor.submit(first) == CleanupSubmitResult::Accepted,
      "ordered retry first cleanup was rejected");
  {
    std::unique_lock lock(state->mutex);
    require(
        state->changed.wait_for(lock, 1s, [&] {
          return state->first_probe_entered;
        }),
        "ordered retry probe did not start");
  }
  require(
      supervisor.submit(second) == CleanupSubmitResult::Accepted,
      "ordered retry second cleanup was rejected");
  {
    std::lock_guard lock(state->mutex);
    state->release_first_probe = true;
  }
  state->changed.notify_all();
  {
    std::unique_lock lock(state->mutex);
    require(
        state->changed.wait_for(lock, 1s, [&] {
          return state->order.size() == 2;
        }),
        "ordered retry cleanups did not finish");
    require(
        state->order[0] == 1 && state->order[1] == 2,
        "a failed start reordered cleanup for one native resource");
  }
  require(
      supervisor.shutdown(std::chrono::steady_clock::now() + 1s).finished,
      "ordered retry supervisor did not shut down");
}

void shutdownReportsOneDeadlineWithoutDetachingWorkers() {
  CleanupSupervisor supervisor(CleanupSupervisorConfig{
      .worker_limit = 2,
      .admission_capacity = 3,
  });
  auto state = std::make_shared<BlockingCleanupState>();
  std::vector<std::shared_ptr<CleanupJob>> jobs;
  for (CleanupResourceKey key = 41; key <= 43; ++key) {
    auto job = std::make_shared<CleanupJob>();
    job->prepare(state, key, &runBlockedCleanup);
    require(
        supervisor.submit(job) == CleanupSubmitResult::Accepted,
        "shutdown deadline scenario exceeded its ownership budget");
    jobs.push_back(std::move(job));
  }
  {
    std::unique_lock lock(state->mutex);
    require(
        state->changed.wait_for(lock, 1s, [&] {
          return state->active == 2;
        }),
        "shutdown deadline scenario did not occupy both workers");
  }

  const auto shutdown_started = std::chrono::steady_clock::now();
  const auto timed_out = supervisor.shutdown(shutdown_started + 25ms);
  require(
      std::chrono::steady_clock::now() - shutdown_started < 250ms &&
          !timed_out.finished && timed_out.unfinished_jobs == 3 &&
          timed_out.active_jobs == 2 && timed_out.backlog_jobs == 1 &&
          timed_out.worker_threads == 2 && timed_out.worker_handles == 2 &&
          timed_out.detached_threads == 0,
      "cleanup shutdown did not report one bounded deadline");
  const auto after_deadline = supervisor.snapshot();
  require(
      after_deadline.worker_threads == 2 &&
          after_deadline.worker_handles == 2 &&
          after_deadline.owned_jobs == 3,
      "cleanup shutdown lost unfinished ownership after its deadline");

  {
    std::lock_guard lock(state->mutex);
    state->release = true;
  }
  state->changed.notify_all();
  {
    std::unique_lock lock(state->mutex);
    require(
        state->changed.wait_for(lock, 1s, [&] {
          return state->completed == 3;
        }),
        "cleanup ownership did not drain after the deadline blocker cleared");
  }
  const auto drained = supervisor.shutdown(
      std::chrono::steady_clock::now() + 1s);
  require(
      drained.finished && drained.unfinished_jobs == 0 &&
          drained.worker_threads == 0 && drained.worker_handles == 0 &&
          drained.detached_threads == 0,
      "cleanup shutdown did not join every fixed worker handle");
}

void runCountedCleanup(void* context) noexcept {
  static_cast<std::atomic_uint64_t*>(context)->fetch_add(
      1,
      std::memory_order_release);
}

void drainingSnapshotPreservesLateCleanupAdmission() {
  CleanupSupervisor supervisor(CleanupSupervisorConfig{
      .worker_limit = 1,
      .admission_capacity = 2,
  });
  auto completed = std::make_shared<std::atomic_uint64_t>(0);
  auto submit_counted = [&](CleanupResourceKey resource) {
    auto job = std::make_shared<CleanupJob>();
    job->prepare(completed, resource, &runCountedCleanup);
    return supervisor.submit(std::move(job));
  };

  require(
      submit_counted(51) == CleanupSubmitResult::Accepted,
      "snapshot-drain setup cleanup was rejected");
  const auto drain_deadline = std::chrono::steady_clock::now() + 1s;
  while (std::chrono::steady_clock::now() < drain_deadline) {
    const auto snapshot = supervisor.snapshot();
    if (snapshot.owned_jobs == 0 && snapshot.active_jobs == 0 &&
        snapshot.backlog_jobs == 0) {
      break;
    }
    std::this_thread::sleep_for(1ms);
  }
  const auto drained = supervisor.snapshot();
  require(
      drained.owned_jobs == 0 && drained.active_jobs == 0 &&
          drained.backlog_jobs == 0 && completed->load(std::memory_order_acquire) == 1,
      "snapshot polling did not observe complete cleanup ownership drain");
  require(
      submit_counted(52) == CleanupSubmitResult::Accepted,
      "snapshot polling closed admission for a later cleanup owner");
  const auto late_deadline = std::chrono::steady_clock::now() + 1s;
  while (completed->load(std::memory_order_acquire) != 2 &&
         std::chrono::steady_clock::now() < late_deadline) {
    std::this_thread::sleep_for(1ms);
  }
  require(
      completed->load(std::memory_order_acquire) == 2,
      "late cleanup did not run after a non-closing snapshot drain");
  require(
      supervisor.shutdown(std::chrono::steady_clock::now() + 1s).finished,
      "snapshot-drain supervisor did not shut down at test teardown");
}

void shutdownClosesLateCleanupAdmission() {
  CleanupSupervisor supervisor(CleanupSupervisorConfig{
      .worker_limit = 1,
      .admission_capacity = 1,
  });
  require(
      supervisor.shutdown(std::chrono::steady_clock::now() + 1s).finished,
      "empty cleanup supervisor did not shut down");
  auto completed = std::make_shared<std::atomic_uint64_t>(0);
  auto late = std::make_shared<CleanupJob>();
  late->prepare(completed, 61, &runCountedCleanup);
  require(
      supervisor.submit(std::move(late)) == CleanupSubmitResult::Closed &&
          completed->load(std::memory_order_acquire) == 0,
      "shutdown did not reproduce closed late-cleanup admission");
}

}  // namespace

int main() try {
  configuredWorkerBudgetBoundsBlockedCleanup();
  resourceOrderingDoesNotBlockIndependentCleanup();
  failedJobStartRetriesWithoutDuplicatingCleanup();
  permanentStartProbeFailureCannotStarveCleanup();
  jobCanOnlyBePreparedAgainAfterFinishing();
  failedStartPreservesResourceOrder();
  shutdownReportsOneDeadlineWithoutDetachingWorkers();
  drainingSnapshotPreservesLateCleanupAdmission();
  shutdownClosesLateCleanupAdmission();
  return 0;
} catch (const std::exception& error) {
  std::fprintf(stderr, "%s\n", error.what());
  return 1;
}
