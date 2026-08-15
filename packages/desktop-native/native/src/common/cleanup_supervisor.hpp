#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string_view>

namespace syrnike::desktop_native {

using CleanupResourceKey = std::uintptr_t;
using CleanupStartProbe = std::function<void()>;
using CleanupEnqueueProbe = std::function<void()>;

enum class CleanupSubmitResult {
  Accepted,
  Saturated,
  Closed,
  Invalid,
};

struct CleanupSupervisorConfig {
  std::size_t worker_limit = 4;
  std::size_t admission_capacity = 64;
};

struct CleanupSupervisorSnapshot {
  std::size_t worker_limit = 0;
  std::size_t admission_capacity = 0;
  std::size_t worker_threads = 0;
  std::size_t worker_handles = 0;
  std::size_t active_jobs = 0;
  std::size_t backlog_jobs = 0;
  std::size_t owned_jobs = 0;
  std::size_t peak_active_jobs = 0;
  std::size_t peak_backlog_jobs = 0;
  std::size_t peak_owned_jobs = 0;
  std::uint64_t accepted_jobs = 0;
  std::uint64_t completed_jobs = 0;
  std::uint64_t saturated_submissions = 0;
  std::uint64_t closed_submissions = 0;
  std::uint64_t start_failures = 0;
};

struct CleanupShutdownReport {
  bool finished = false;
  std::size_t unfinished_jobs = 0;
  std::size_t active_jobs = 0;
  std::size_t backlog_jobs = 0;
  std::size_t worker_threads = 0;
  std::size_t worker_handles = 0;
  std::size_t detached_threads = 0;
};

class CleanupJob final {
 public:
  using OwnerTask = void (*)(void*);
  using CompletionTask = void (*)(void*);

  explicit CleanupJob(CleanupStartProbe start_probe = {});

  bool prepare(
      std::shared_ptr<void> owner,
      CleanupResourceKey resource_key,
      OwnerTask task,
      CompletionTask completion_task = nullptr) noexcept;
  bool prepare(
      std::shared_ptr<void> owner,
      void* context,
      CleanupResourceKey resource_key,
      OwnerTask task,
      CompletionTask completion_task = nullptr) noexcept;
  bool prepareRaw(
      void* context,
      CleanupResourceKey resource_key,
      OwnerTask task) noexcept;

  [[nodiscard]] bool finished() const noexcept;
  [[nodiscard]] bool waitUntil(
      std::chrono::steady_clock::time_point deadline) const noexcept;

 private:
  enum class State : std::uint8_t {
    Idle,
    Preparing,
    Prepared,
    Queued,
    Running,
    Finished,
  };

  void run() noexcept;

  mutable std::mutex finished_mutex_;
  mutable std::condition_variable finished_changed_;
  std::atomic<State> state_{State::Idle};
  std::shared_ptr<void> owner_;
  void* context_ = nullptr;
  CleanupResourceKey resource_key_ = 0;
  OwnerTask owner_task_ = nullptr;
  CompletionTask completion_task_ = nullptr;
  CleanupStartProbe start_probe_;
  std::shared_ptr<CleanupJob> next_;

  friend class CleanupSupervisor;
};

class CleanupSupervisor final {
 public:
  explicit CleanupSupervisor(CleanupSupervisorConfig config = {});
  ~CleanupSupervisor();

  CleanupSupervisor(const CleanupSupervisor&) = delete;
  CleanupSupervisor& operator=(const CleanupSupervisor&) = delete;

  static CleanupSupervisor& instance();

  [[nodiscard]] CleanupSubmitResult submit(
      std::shared_ptr<CleanupJob> job) noexcept;
  void submitOrEscalate(
      std::shared_ptr<CleanupJob> job,
      std::string_view owner) noexcept;
  [[nodiscard]] CleanupSupervisorSnapshot snapshot() const noexcept;
  [[nodiscard]] CleanupShutdownReport shutdown(
      std::chrono::steady_clock::time_point deadline) noexcept;

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

[[nodiscard]] CleanupStartProbe failFirstCleanupStartProbe(bool enabled);
void runCleanupEnqueueProbe(const CleanupEnqueueProbe& probe) noexcept;

}  // namespace syrnike::desktop_native
