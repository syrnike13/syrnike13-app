#include "audio/remote_audio_output.hpp"

#include <stdexcept>
#ifdef WINDOWS_MEDIA_REMOTE_AUDIO_PROBE
#include "lab/remote_audio_probe.hpp"
#endif

namespace syrnike::windows_media::audio {
namespace {
using Clock = std::chrono::steady_clock;
Clock::time_point retryNow() noexcept {
#ifdef WINDOWS_MEDIA_REMOTE_AUDIO_PROBE
  const auto injected = lab::output_retry_time_ms.load();
  if (injected >= 0) return Clock::time_point(std::chrono::milliseconds(injected));
#endif
  return Clock::now();
}
std::int64_t timestamp() noexcept {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
}  // namespace
RemoteAudioOutput::RemoteAudioOutput(RemoteAudioMixerWorker& mixer) : mixer_(mixer) {}
RemoteAudioOutput::~RemoteAudioOutput() {
  if (!stop(Clock::now() + std::chrono::seconds(5))) std::terminate();
}
bool RemoteAudioOutput::onOwner() const noexcept {
  return owner_ == std::this_thread::get_id() && !stats_.retired;
}
RemoteOutputFailure RemoteAudioOutput::selectEndpoint(const AudioEndpoint& endpoint) {
  if (selected_ && selected_->endpoint_id == endpoint.endpoint_id && active_ &&
      active_->stats().state == WasapiOutputState::running) return RemoteOutputFailure::none;
  stats_.state = active_ ? RemoteOutputState::recovering : RemoteOutputState::starting;
  candidate_ = std::make_unique<WasapiOutput>();
  ++stats_.candidates;
  stats_.candidate_failure = candidate_->start(endpoint, ++epoch_);
  if (stats_.candidate_failure != WasapiOutputFailure::none) {
    if (!candidate_->stop(Clock::now() + std::chrono::seconds(5))) {
      stats_.retired = true;
      return RemoteOutputFailure::stop_timeout;
    }
    candidate_.reset();
    stats_.state = active_ && active_->stats().state == WasapiOutputState::running ?
        RemoteOutputState::running : RemoteOutputState::failed;
    return RemoteOutputFailure::candidate_failed;
  }
  if (!candidate_->setDeafened(deafened_)) {
    if (!candidate_->stop(Clock::now() + std::chrono::seconds(5))) {
      stats_.retired = true;
      return RemoteOutputFailure::stop_timeout;
    }
    candidate_.reset();
    stats_.state = active_ && active_->stats().state == WasapiOutputState::running ?
        RemoteOutputState::running : RemoteOutputState::failed;
    return RemoteOutputFailure::candidate_failed;
  }
  const auto minimum = timestamp();
  if (!mixer_.bindOutput(candidate_->input(), minimum)) {
    stats_.retired = true;
    (void)candidate_->stop(Clock::now() + std::chrono::seconds(5));
    return RemoteOutputFailure::mixer_failed;
  }
  if (!candidate_->commit(minimum)) {
    const bool old_running = active_ && active_->stats().state == WasapiOutputState::running;
    const bool restored = mixer_.bindOutput(old_running ? active_->input() : nullptr, timestamp());
    const bool stopped = candidate_->stop(Clock::now() + std::chrono::seconds(5));
    if (!restored || !stopped) {
      stats_.retired = true;
      return !stopped ? RemoteOutputFailure::stop_timeout : RemoteOutputFailure::mixer_failed;
    }
    candidate_.reset();
    stats_.state = old_running ? RemoteOutputState::running : RemoteOutputState::failed;
    return RemoteOutputFailure::candidate_failed;
  }
  // The candidate already proved consumption and now owns the mixer epoch.
  // Old output remains alive until this point, then Reset removes its padding.
  if (active_ && !active_->stop(Clock::now() + std::chrono::seconds(5))) {
    stats_.retired = true;
    (void)candidate_->stop(Clock::now() + std::chrono::seconds(5));
    return RemoteOutputFailure::stop_timeout;
  }
  active_ = std::move(candidate_);
  selected_ = endpoint;
  stats_.state = RemoteOutputState::running;
  ++stats_.commits;
  return RemoteOutputFailure::none;
}
RemoteOutputFailure RemoteAudioOutput::selectOutput(AudioDeviceRegistry& registry, AudioDeviceIntent intent) {
  if (!onOwner() || intent.direction != AudioDirection::output) return RemoteOutputFailure::invalid_state;
  stats_.recovery_attempts = 0;
  retry_after_ = {};
  const auto endpoint = registry.resolve(intent);
  if (!endpoint) return RemoteOutputFailure::unavailable;
  const auto result = selectEndpoint(*endpoint);
  if (result == RemoteOutputFailure::none) intent_ = intent;
  return result;
}
RemoteOutputFailure RemoteAudioOutput::reconcile(AudioDeviceRegistry& registry, std::uint64_t revision) {
  if (!onOwner()) return RemoteOutputFailure::invalid_state;
  if (revision != registry_revision_) {
    registry_revision_ = revision;
    stats_.recovery_attempts = 0;
    retry_after_ = {};
  }
  const auto endpoint = registry.resolve(intent_);
  if (!endpoint) return RemoteOutputFailure::unavailable;
  if (selected_ && selected_->endpoint_id == endpoint->endpoint_id && active_ &&
      active_->stats().state == WasapiOutputState::running) return RemoteOutputFailure::none;
  if (stats_.recovery_attempts >= 3 || retryNow() < retry_after_) return RemoteOutputFailure::candidate_failed;
  ++stats_.recovery_attempts;
  retry_after_ = retryNow() + std::chrono::seconds(1);
  return selectEndpoint(*endpoint);
}
bool RemoteAudioOutput::setDeafened(bool value) {
  if (!onOwner()) return false;
  deafened_ = value;
  return !active_ || active_->setDeafened(value);
}
bool RemoteAudioOutput::stop(Clock::time_point deadline) noexcept {
  if (owner_ != std::this_thread::get_id()) return false;
  stats_.retired = true;
  // Mixer commands retain the port values even on timeout. A retired mixer
  // cannot leave a dangling device/event pointer: it only owns PCM projections.
  const bool unbound = mixer_.retired() || mixer_.bindOutput({}, 0);
  const bool candidate_stopped = !candidate_ || candidate_->stop(deadline);
  const bool active_stopped = !active_ || active_->stop(deadline);
  if (!candidate_stopped || !active_stopped) return false;
  candidate_.reset();
  active_.reset();
  stats_.state = RemoteOutputState::stopped;
  return unbound || mixer_.retired();
}
RemoteOutputStats RemoteAudioOutput::stats() {
  if (owner_ != std::this_thread::get_id()) throw std::logic_error("Output control owner mismatch");
  stats_.active = active_ ? active_->stats() : WasapiOutputStats{};
  if (stats_.retired && stats_.state != RemoteOutputState::stopped) stats_.state = RemoteOutputState::failed;
  else if (active_ && stats_.active.state == WasapiOutputState::failed) stats_.state = RemoteOutputState::failed;
  return stats_;
}
std::shared_ptr<RenderedEchoReference> RemoteAudioOutput::echoReference() const {
  if (!onOwner() || !active_) return {};
  return active_->echoReference();
}
}  // namespace syrnike::windows_media::audio
