#pragma once

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <stop_token>
#include <string_view>
#include <thread>

#include "../common/cleanup_supervisor.hpp"
#include "audio_failure.hpp"

namespace syrnike::desktop_native::media {

enum class RemoteAudioExternalStage : std::uint8_t {
  EndpointProbe,
  EndpointResolve,
  Activate,
  Initialize,
  Start,
  Render,
  Stop,
};

enum class RemoteAudioAttemptWaitStatus : std::uint8_t {
  Ready,
  Failed,
  TimedOut,
};

enum class RemoteAudioAttemptRetireStatus : std::uint8_t {
  Stopped,
  Quarantined,
};

struct RemoteAudioAttemptWaitResult {
  RemoteAudioAttemptWaitStatus status = RemoteAudioAttemptWaitStatus::TimedOut;
  RemoteAudioExternalStage stage = RemoteAudioExternalStage::EndpointProbe;
  std::optional<AudioFailureInfo> failure;
};

struct RemoteAudioAttemptDomainSnapshot {
  std::size_t active_attempts = 0;
  std::size_t quarantined_attempts = 0;
  std::size_t peak_owned_attempts = 0;
  std::uint64_t rejected_starts = 0;
};

class RemoteAudioAttemptDomain final {
 public:
  explicit RemoteAudioAttemptDomain(
    CleanupSupervisor& cleanup_supervisor = CleanupSupervisor::instance(),
    std::size_t maximum_quarantined_attempts = 2
  );

  [[nodiscard]] RemoteAudioAttemptDomainSnapshot snapshot() const noexcept;

 private:
  bool tryStart() noexcept;
  void completeActive() noexcept;
  void quarantineActive() noexcept;
  void completeQuarantine() noexcept;

  CleanupSupervisor* cleanup_supervisor_;
  const std::size_t maximum_quarantined_attempts_;
  mutable std::mutex mutex_;
  std::size_t active_attempts_ = 0;
  std::size_t quarantined_attempts_ = 0;
  std::size_t peak_owned_attempts_ = 0;
  std::uint64_t rejected_starts_ = 0;

  friend class RemoteAudioOperationAttempt;
};

class RemoteAudioOperationAttempt final
    : public std::enable_shared_from_this<RemoteAudioOperationAttempt> {
 public:
  class Context final {
   public:
    void setStage(RemoteAudioExternalStage stage) noexcept;
    [[nodiscard]] bool markReady() noexcept;
    [[nodiscard]] bool stopRequested() const noexcept;
    [[nodiscard]] std::stop_token stopToken() const noexcept;

   private:
    Context(
      RemoteAudioOperationAttempt& attempt,
      std::stop_token stop_token
    ) noexcept;
    RemoteAudioOperationAttempt* attempt_;
    std::stop_token stop_token_;
    friend class RemoteAudioOperationAttempt;
  };

  using Operation = std::function<void(Context&)>;

  static std::shared_ptr<RemoteAudioOperationAttempt> start(
    std::shared_ptr<RemoteAudioAttemptDomain> domain,
    Operation operation
  );

  ~RemoteAudioOperationAttempt();
  RemoteAudioOperationAttempt(const RemoteAudioOperationAttempt&) = delete;
  RemoteAudioOperationAttempt& operator=(
    const RemoteAudioOperationAttempt&
  ) = delete;

  [[nodiscard]] RemoteAudioAttemptWaitResult waitUntilReady(
    std::chrono::steady_clock::time_point deadline
  ) noexcept;
  [[nodiscard]] RemoteAudioAttemptRetireStatus retire(
    std::chrono::steady_clock::time_point deadline
  ) noexcept;
  [[nodiscard]] RemoteAudioExternalStage stage() const noexcept;
  [[nodiscard]] std::optional<AudioFailureInfo> failure() const;
  [[nodiscard]] bool finished() const noexcept;

 private:
  RemoteAudioOperationAttempt(
    std::shared_ptr<RemoteAudioAttemptDomain> domain,
    Operation operation
  );

  void run(std::stop_token stop_token) noexcept;
  void setStage(RemoteAudioExternalStage stage) noexcept;
  bool markReady() noexcept;
  static void joinWorker(void* context) noexcept;
  static void completeQuarantine(void* context) noexcept;

  std::shared_ptr<RemoteAudioAttemptDomain> domain_;
  Operation operation_;
  std::shared_ptr<CleanupJob> cleanup_job_;
  mutable std::mutex state_mutex_;
  std::condition_variable state_changed_;
  bool accepting_events_ = true;
  bool ready_ = false;
  bool finished_ = false;
  std::optional<AudioFailureInfo> failure_;
  RemoteAudioExternalStage stage_ = RemoteAudioExternalStage::EndpointProbe;
  std::jthread worker_;
  std::mutex retire_mutex_;
  std::optional<RemoteAudioAttemptRetireStatus> retire_status_;
};

[[nodiscard]] std::string_view remoteAudioExternalStageName(
  RemoteAudioExternalStage stage
) noexcept;

}  // namespace syrnike::desktop_native::media
