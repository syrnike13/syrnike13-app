#include "audio/screen_audio_owner.hpp"
#include <stdexcept>

namespace syrnike::windows_media::audio {
using Clock = std::chrono::steady_clock;
namespace {
bool sameIntent(const ScreenAudioIntent& a, const ScreenAudioIntent& b) noexcept {
  return a.mode == b.mode && a.target && b.target && a.target->pid() == b.target->pid() &&
         a.target->creationTime() == b.target->creationTime();
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
  stats_.desired_revision = revision;
  desired_ = std::move(intent);
  changed_.notify_all();
  return true;
}
ScreenAudioOwnerStats ScreenAudioOwner::stats() const noexcept {
  std::scoped_lock lock(mutex_);
  return stats_;
}
bool ScreenAudioOwner::stop(Clock::time_point deadline) noexcept {
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
  const auto drain = [&] {
    if (!session) return true;
    const bool stopped = session->stop(Clock::now() + std::chrono::seconds{6});
    const auto resources = session->stats();
    const auto failure = session->failure();
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
          if (!drain()) break;
          std::scoped_lock lock(mutex_);
          stats_.state = ScreenAudioState::failed;
          stats_.failure = failure;
          if (failure->utility_retirement_required) {
            stopping_ = true;
            break;
          }
        }
      }
      if (revision == processed) continue;
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
      if (!next) {
        processed = revision;
        continue;
      }
      session = factory_();
      if (!session) throw std::runtime_error("Audio session factory returned null");
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
          stats_.failure = failure;
          stats_.state = ScreenAudioState::failed;
        }
        continue;
      }
      {
        std::scoped_lock lock(mutex_);
        // Revalidate in the same critical section that commits running.
        if (stopping_ || revision != stats_.desired_revision) continue;
        active = next;
        processed = revision;
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
