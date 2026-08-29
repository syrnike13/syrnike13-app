#include "remote_audio_operation_supervisor.hpp"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace syrnike::desktop_native::media {

RemoteAudioAttemptDomain::RemoteAudioAttemptDomain(
  CleanupSupervisor& cleanup_supervisor,
  std::size_t maximum_quarantined_attempts
) : cleanup_supervisor_(&cleanup_supervisor),
    maximum_quarantined_attempts_(maximum_quarantined_attempts) {
  if (maximum_quarantined_attempts_ == 0) {
    throw std::invalid_argument(
      "remote audio quarantine capacity must be positive"
    );
  }
}

RemoteAudioAttemptDomainSnapshot RemoteAudioAttemptDomain::snapshot()
    const noexcept {
  std::lock_guard lock(mutex_);
  return {
    .active_attempts = active_attempts_,
    .quarantined_attempts = quarantined_attempts_,
    .peak_owned_attempts = peak_owned_attempts_,
    .rejected_starts = rejected_starts_,
  };
}

bool RemoteAudioAttemptDomain::tryStart() noexcept {
  std::lock_guard lock(mutex_);
  if (active_attempts_ != 0 ||
      quarantined_attempts_ >= maximum_quarantined_attempts_) {
    ++rejected_starts_;
    return false;
  }
  active_attempts_ = 1;
  peak_owned_attempts_ = std::max(
    peak_owned_attempts_,
    active_attempts_ + quarantined_attempts_
  );
  return true;
}

void RemoteAudioAttemptDomain::completeActive() noexcept {
  std::lock_guard lock(mutex_);
  active_attempts_ = 0;
}

void RemoteAudioAttemptDomain::quarantineActive() noexcept {
  std::lock_guard lock(mutex_);
  active_attempts_ = 0;
  ++quarantined_attempts_;
  peak_owned_attempts_ = std::max(
    peak_owned_attempts_,
    active_attempts_ + quarantined_attempts_
  );
}

void RemoteAudioAttemptDomain::completeQuarantine() noexcept {
  std::lock_guard lock(mutex_);
  if (quarantined_attempts_ != 0) --quarantined_attempts_;
}

RemoteAudioOperationAttempt::Context::Context(
  RemoteAudioOperationAttempt& attempt,
  std::stop_token stop_token
) noexcept : attempt_(&attempt), stop_token_(stop_token) {}

void RemoteAudioOperationAttempt::Context::setStage(
  RemoteAudioExternalStage stage
) noexcept {
  attempt_->setStage(stage);
}

bool RemoteAudioOperationAttempt::Context::markReady() noexcept {
  return attempt_->markReady();
}

bool RemoteAudioOperationAttempt::Context::stopRequested() const noexcept {
  return stop_token_.stop_requested();
}

std::stop_token RemoteAudioOperationAttempt::Context::stopToken()
    const noexcept {
  return stop_token_;
}

std::shared_ptr<RemoteAudioOperationAttempt>
RemoteAudioOperationAttempt::start(
  std::shared_ptr<RemoteAudioAttemptDomain> domain,
  Operation operation
) {
  if (!domain || !operation) {
    throw std::invalid_argument("remote audio attempt requires domain and operation");
  }
  if (!domain->tryStart()) {
    throw AudioFailure(
      AudioFailureKind::OperationTimedOut,
      "remote audio operation capacity is exhausted",
      HRESULT_FROM_WIN32(ERROR_BUSY)
    );
  }
  const auto admitted_domain = domain;
  std::shared_ptr<RemoteAudioOperationAttempt> attempt;
  try {
    attempt = std::shared_ptr<RemoteAudioOperationAttempt>(
      new RemoteAudioOperationAttempt(std::move(domain), std::move(operation))
    );
    attempt->worker_ = std::jthread(
      [raw = attempt.get()](std::stop_token stop_token) {
        raw->run(stop_token);
      }
    );
  } catch (...) {
    admitted_domain->completeActive();
    throw;
  }
  return attempt;
}

RemoteAudioOperationAttempt::RemoteAudioOperationAttempt(
  std::shared_ptr<RemoteAudioAttemptDomain> domain,
  Operation operation
) : domain_(std::move(domain)),
    operation_(std::move(operation)),
    cleanup_job_(std::make_shared<CleanupJob>()) {}

RemoteAudioOperationAttempt::~RemoteAudioOperationAttempt() {
  if (!worker_.joinable()) return;
  worker_.request_stop();
  worker_.join();
}

RemoteAudioAttemptWaitResult RemoteAudioOperationAttempt::waitUntilReady(
  std::chrono::steady_clock::time_point deadline
) noexcept {
  std::unique_lock lock(state_mutex_);
  state_changed_.wait_until(lock, deadline, [this] {
    return ready_ || failure_.has_value() || finished_;
  });
  return {
    .status = ready_
      ? RemoteAudioAttemptWaitStatus::Ready
      : ((failure_ || finished_)
          ? RemoteAudioAttemptWaitStatus::Failed
          : RemoteAudioAttemptWaitStatus::TimedOut),
    .stage = stage_,
    .failure = failure_,
  };
}

RemoteAudioAttemptRetireStatus RemoteAudioOperationAttempt::retire(
  std::chrono::steady_clock::time_point deadline
) noexcept {
  std::lock_guard retire_lock(retire_mutex_);
  if (retire_status_) return *retire_status_;
  {
    std::lock_guard lock(state_mutex_);
    accepting_events_ = false;
  }
  worker_.request_stop();
  {
    std::unique_lock lock(state_mutex_);
    state_changed_.wait_until(lock, deadline, [this] { return finished_; });
    if (finished_) {
      lock.unlock();
      joinWorker(this);
      domain_->completeActive();
      retire_status_ = RemoteAudioAttemptRetireStatus::Stopped;
      return *retire_status_;
    }
  }

  domain_->quarantineActive();
  static_cast<void>(cleanup_job_->prepare(
    shared_from_this(),
    this,
    reinterpret_cast<CleanupResourceKey>(this),
    joinWorker,
    completeQuarantine
  ));
  domain_->cleanup_supervisor_->submitOrEscalate(
    cleanup_job_,
    "remote_audio_operation"
  );
  retire_status_ = RemoteAudioAttemptRetireStatus::Quarantined;
  return *retire_status_;
}

RemoteAudioExternalStage RemoteAudioOperationAttempt::stage() const noexcept {
  std::lock_guard lock(state_mutex_);
  return stage_;
}

std::optional<AudioFailureInfo> RemoteAudioOperationAttempt::failure() const {
  std::lock_guard lock(state_mutex_);
  return failure_;
}

bool RemoteAudioOperationAttempt::finished() const noexcept {
  std::lock_guard lock(state_mutex_);
  return finished_;
}

void RemoteAudioOperationAttempt::run(std::stop_token stop_token) noexcept {
  Context context(*this, stop_token);
  try {
    operation_(context);
  } catch (const std::exception& error) {
    std::lock_guard lock(state_mutex_);
    if (accepting_events_) failure_ = describeAudioFailure(error);
  } catch (...) {
    std::lock_guard lock(state_mutex_);
    if (accepting_events_) {
      failure_ = AudioFailureInfo{
        AudioFailureKind::Unknown,
        "audio_unknown",
        "unknown remote audio operation failure",
        S_OK,
        false,
      };
    }
  }
  {
    std::lock_guard lock(state_mutex_);
    finished_ = true;
  }
  state_changed_.notify_all();
}

void RemoteAudioOperationAttempt::setStage(
  RemoteAudioExternalStage stage
) noexcept {
  std::lock_guard lock(state_mutex_);
  stage_ = stage;
}

bool RemoteAudioOperationAttempt::markReady() noexcept {
  {
    std::lock_guard lock(state_mutex_);
    if (!accepting_events_ || ready_ || failure_) return false;
    ready_ = true;
  }
  state_changed_.notify_all();
  return true;
}

void RemoteAudioOperationAttempt::joinWorker(void* context) noexcept {
  auto* attempt = static_cast<RemoteAudioOperationAttempt*>(context);
  if (attempt->worker_.joinable() &&
      attempt->worker_.get_id() != std::this_thread::get_id()) {
    attempt->worker_.join();
  }
}

void RemoteAudioOperationAttempt::completeQuarantine(void* context) noexcept {
  auto* attempt = static_cast<RemoteAudioOperationAttempt*>(context);
  attempt->domain_->completeQuarantine();
}

std::string_view remoteAudioExternalStageName(
  RemoteAudioExternalStage stage
) noexcept {
  switch (stage) {
    case RemoteAudioExternalStage::EndpointProbe:
      return "endpoint_probe";
    case RemoteAudioExternalStage::EndpointResolve:
      return "endpoint_resolve";
    case RemoteAudioExternalStage::Activate:
      return "activate";
    case RemoteAudioExternalStage::Initialize:
      return "initialize";
    case RemoteAudioExternalStage::Start:
      return "start";
    case RemoteAudioExternalStage::Render:
      return "render";
    case RemoteAudioExternalStage::Stop:
      return "stop";
  }
  return "unknown";
}

}  // namespace syrnike::desktop_native::media
