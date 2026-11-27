#include "audio/screen_audio_owner.hpp"
#include <algorithm>
#include <stdexcept>

namespace syrnike::windows_media::audio {
using Clock = std::chrono::steady_clock;
namespace {
bool sameIntent(const ScreenAudioIntent& a, const ScreenAudioIntent& b) noexcept {
  return a.mode == b.mode && a.room_generation == b.room_generation && a.bitrate == b.bitrate &&
         a.target && b.target && a.target->pid() == b.target->pid() &&
         a.target->creationTime() == b.target->creationTime();
}
// A game that switches the display mode can take the audio endpoint with it.
// These failures belong to the device, not the intent, and a new capture for
// the same intent normally succeeds once the endpoint is back.
bool recoverable(const ScreenAudioFailure& failure) noexcept {
  if (failure.utility_retirement_required) return false;
  switch (failure.code) {
    case ScreenAudioFailureCode::device_lost:
    case ScreenAudioFailureCode::capture_failed:
    case ScreenAudioFailureCode::activation_failed:
    case ScreenAudioFailureCode::format_unavailable:
      return true;
    default:
      return false;
  }
}
constexpr unsigned kMaximumRecoveries = 5;
// A capture that ran this long proves the device is back; the budget refills.
constexpr auto kRecoveryReset = std::chrono::seconds{10};
Clock::duration recoveryDelay(unsigned attempt) noexcept {
  return std::chrono::milliseconds{500} * (1U << (std::min)(attempt, 3U));
}
}  // namespace
ScreenAudioOwner::ScreenAudioOwner(Factory factory) : factory_(std::move(factory)) {
  if (!factory_) throw std::invalid_argument("Audio session factory required");
  worker_ = std::thread([this] { run(); });
}
ScreenAudioOwner::~ScreenAudioOwner() {
  if (!stop(Clock::now() + std::chrono::seconds{25})) std::terminate();
}
bool ScreenAudioOwner::applyDesired(std::uint64_t revision,
                                    std::optional<ScreenAudioIntent> intent) {
  std::scoped_lock lock(mutex_);
  if (stopping_ || revision <= stats_.desired_revision || (intent && !intent->target)) return false;
  if (session_ && (!intent || !desired_ || !sameIntent(*intent, *desired_))) session_->cancel();
  stats_.desired_revision = revision;
  desired_ = std::move(intent);
  changed_.notify_all();
  return true;
}
void ScreenAudioOwner::beginStop() {
  std::lock_guard lock(mutex_);
  stopping_ = true;
  if (session_) session_->cancel();
  changed_.notify_all();
}
ScreenAudioOwnerStats ScreenAudioOwner::stats() const noexcept {
  std::scoped_lock lock(mutex_);
  return stats_;
}
bool ScreenAudioOwner::stop(Clock::time_point deadline) noexcept {
  beginStop();
  std::unique_lock lock(mutex_);
  stopping_ = true;
  changed_.notify_all();
  if (!changed_.wait_until(lock, deadline, [this] { return done_; })) {
    stats_.state = ScreenAudioState::failed;
    stats_.failure = ScreenAudioFailure{ScreenAudioFailureCode::stop_timeout, E_PENDING, true};
    return false;
  }
  // Keep join serialized with concurrent stop calls. done_ is set by the
  // worker's final critical section, so joining here cannot block its cleanup.
  if (worker_.joinable()) worker_.join();
  return true;
}
void ScreenAudioOwner::run() noexcept {
  std::unique_ptr<ScreenAudioSession> session;
  std::optional<ScreenAudioIntent> active;
  std::uint64_t processed = 0;
  // Automatic restart of the processed intent after a device failure.
  std::optional<Clock::time_point> restart_at;
  Clock::time_point running_since{};
  unsigned recoveries = 0;
  // Caller holds mutex_. False leaves the failure to an explicit revision.
  const auto scheduleRecovery = [&](const ScreenAudioFailure& failure) {
    // A cancelled session is a replaced intent, not a capture failure.
    if (failure.code != ScreenAudioFailureCode::cancelled) stats_.last_failure = failure;
    if (!recoverable(failure) || recoveries >= kMaximumRecoveries) return false;
    restart_at = Clock::now() + recoveryDelay(recoveries++);
    ++stats_.recoveries;
    stats_.failure.reset();
    stats_.state = ScreenAudioState::starting;
    return true;
  };
  const auto drain = [&] {
    if (!session) return true;
    const bool stopped = session->stop(Clock::now() + std::chrono::seconds{6});
    const auto resources = session->stats();
    const auto failure = session->failure();
    {
      std::lock_guard lock(mutex_);
      session_ = nullptr;
    }
    session.reset();
    active.reset();
    std::scoped_lock lock(mutex_);
    stats_.active_revision = 0;
    stats_.session = resources;
    if (!stopped) {
      stopping_ = true;
      stats_.state = ScreenAudioState::failed;
      stats_.failure = failure.value_or(
          ScreenAudioFailure{ScreenAudioFailureCode::stop_timeout, E_PENDING, true});
      stats_.failure->utility_retirement_required = true;
    }
    return stopped;
  };
  try {
    for (;;) {
      std::optional<ScreenAudioIntent> next;
      std::uint64_t revision;
      {
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, std::chrono::milliseconds{10},
                          [&] { return stopping_ || stats_.desired_revision != processed; });
        if (stopping_) break;
        revision = stats_.desired_revision;
        next = desired_;
      }
      if (session) {
        const auto resources = session->stats();
        {
          std::scoped_lock lock(mutex_);
          stats_.session = resources;
        }
        if (const auto failure = session->failure()) {
          if (Clock::now() - running_since >= kRecoveryReset) recoveries = 0;
          if (!drain()) break;
          std::scoped_lock lock(mutex_);
          if (failure->utility_retirement_required) {
            stats_.state = ScreenAudioState::failed;
            stats_.failure = failure;
            stopping_ = true;
            break;
          }
          if (!scheduleRecovery(*failure)) {
            stats_.state = ScreenAudioState::failed;
            stats_.failure = failure;
          }
        }
      }
      const bool recover = !session && restart_at && Clock::now() >= *restart_at;
      if (revision == processed && !recover) continue;
      if (session && next && active && sameIntent(*next, *active)) {
        std::scoped_lock lock(mutex_);
        if (revision == stats_.desired_revision) {
          processed = revision;
          stats_.active_revision = revision;
        }
        continue;
      }
      {
        std::scoped_lock lock(mutex_);
        stats_.state = ScreenAudioState::stopping;
      }
      if (!drain()) break;
      {
        std::scoped_lock lock(mutex_);
        if (stopping_) break;
        revision = stats_.desired_revision;
        next = desired_;
        stats_.failure.reset();
        stats_.state = next ? ScreenAudioState::starting : ScreenAudioState::stopped;
      }
      // A new revision is a new intent with a full recovery budget.
      if (!recover || revision != processed) recoveries = 0;
      restart_at.reset();
      if (!next) {
        processed = revision;
        continue;
      }
      session = factory_();
      if (!session) throw std::runtime_error("Audio session factory returned null");
      {
        std::lock_guard lock(mutex_);
        session_ = session.get();
        if (stopping_ || revision != stats_.desired_revision) session_->cancel();
      }
      const auto failure = session->start(*next);
      bool superseded;
      {
        std::scoped_lock lock(mutex_);
        superseded = stopping_ || revision != stats_.desired_revision;
      }
      if (failure || superseded) {
        if (!drain()) break;
        std::scoped_lock lock(mutex_);
        if (failure && failure->utility_retirement_required) {
          stats_.failure = failure;
          stats_.state = ScreenAudioState::failed;
          stopping_ = true;
          break;
        }
        if (!superseded) {
          processed = revision;
          if (!failure || !scheduleRecovery(*failure)) {
            stats_.failure = failure;
            stats_.state = ScreenAudioState::failed;
          }
        }
        continue;
      }
      {
        std::scoped_lock lock(mutex_);
        // Revalidate in the same critical section that commits running.
        if (stopping_ || revision != stats_.desired_revision) continue;
        active = next;
        processed = revision;
        running_since = Clock::now();
        stats_.active_revision = revision;
        stats_.state = ScreenAudioState::running;
      }
    }
  } catch (...) {
    std::scoped_lock lock(mutex_);
    stats_.failure = ScreenAudioFailure{ScreenAudioFailureCode::publication_failed, E_FAIL};
    stats_.state = ScreenAudioState::failed;
  }
  (void)drain();
  std::scoped_lock lock(mutex_);
  stopping_ = true;
  done_ = true;
  if (!stats_.failure) stats_.state = ScreenAudioState::stopped;
  changed_.notify_all();
}
}  // namespace syrnike::windows_media::audio
