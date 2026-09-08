#include "audio/output_owner.hpp"

#include <charconv>
#include <stdexcept>

namespace syrnike::windows_media::audio {
namespace {
using Clock = std::chrono::steady_clock;
AudioDeviceIntent outputDevice(const OutputIntent& intent) {
  AudioDeviceIntent result{AudioDirection::output, {}};
  if (!intent.device_id) return result;
  AudioDeviceId id = 0;
  const auto& text = *intent.device_id;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), id);
  if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() || id == 0)
    throw std::invalid_argument("Output device ID is not a catalog identity");
  result.explicit_id = id;
  return result;
}
EngineFailure outputFailure() {
  return {"output_device_failed", "Output device transaction failed", "output", true};
}
}  // namespace
OutputOwner::OutputOwner(AudioDeviceRegistry& devices, RemoteAudioMixerWorker& mixer,
                         RemoteAudioTracks& tracks)
    : devices_(devices), mixer_(mixer), tracks_(tracks), worker_([this] { run(); }) {}
OutputOwner::~OutputOwner() {
  stop();
}
void OutputOwner::stop() {
  std::lock_guard join_lock(join_mutex_);
  beginStop();
  {
    std::unique_lock lock(mutex_);
    if (!changed_.wait_for(lock, kShutdownDeadline, [&] { return done_; })) std::terminate();
  }
  if (worker_.joinable()) worker_.join();
}
void OutputOwner::apply(std::uint64_t revision, const OutputIntent& intent, bool connected,
                        std::uint64_t device_revision) {
  std::lock_guard lock(mutex_);
  if (stopping_ || done_ || revision < desired_.revision) return;
  desired_ = {revision, device_revision, intent, connected};
  if (intent.state == OutputIntentState::on && connected) snapshot_.stopped = false;
  changed_.notify_one();
}
void OutputOwner::beginStop() {
  std::lock_guard lock(mutex_);
  stopping_ = true;
  changed_.notify_one();
}
OutputOwnerSnapshot OutputOwner::snapshot() const {
  std::lock_guard lock(mutex_);
  return snapshot_;
}
void OutputOwner::run() noexcept {
  std::unique_ptr<RemoteAudioOutput> output;
  Desired applied;
  std::optional<EngineFailure> problem;
  bool mix_failed = false;
  const auto stopOutput = [&] {
    if (output && !output->stop(Clock::now() + kShutdownDeadline)) std::terminate();
    output.reset();
  };
  try {
    for (;;) {
      Desired desired;
      {
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, std::chrono::milliseconds(20), [&] {
          return stopping_ || desired_.revision != applied.revision ||
              desired_.device_revision != applied.device_revision ||
              desired_.room_connected != applied.room_connected;
        });
        if (stopping_) break;
        desired = desired_;
      }
      const bool needed = desired.intent.state == OutputIntentState::on && desired.room_connected;
      const bool retry = desired.intent.state != applied.intent.state ||
          desired.room_connected != applied.room_connected || desired.intent.device_id != applied.intent.device_id ||
          desired.intent.retry_revision != applied.intent.retry_revision ||
          desired.device_revision != applied.device_revision;
      const bool select = needed && (retry || (!output && !problem));
      if (!needed) {
        if (output) tracks_.setDeafened(true);
        stopOutput();
        problem.reset();
        mix_failed = false;
      } else {
        if (desired.intent != applied.intent || !applied.room_connected) {
          mix_failed = !tracks_.configureMix(desired.intent);
        }
        if (select) {
          {
            std::lock_guard lock(mutex_);
            snapshot_.path = {desired.revision, MediaPathState::Starting};
          }
          try {
            if (!output) output = std::make_unique<RemoteAudioOutput>(mixer_);
            if (!output->setDeafened(desired.intent.deafened) ||
                output->selectOutput(devices_, outputDevice(desired.intent)) != RemoteOutputFailure::none)
              problem = outputFailure();
            else
              problem.reset();
          } catch (...) { problem = outputFailure(); }
        } else if (output) {
          if (desired.intent.deafened != applied.intent.deafened &&
              !output->setDeafened(desired.intent.deafened)) problem = outputFailure();
          // Reconcile has its own finite recovery budget. Never call selection
          // merely because a mute/volume or unrelated media revision changed.
          const auto status = output->stats();
          if (status.state != RemoteOutputState::running) {
            if (output->reconcile(devices_, desired.device_revision) != RemoteOutputFailure::none)
              problem = outputFailure();
            else
              problem.reset();
          }
        }
      }
      OutputOwnerSnapshot current;
      current.output = output ? output->stats() : RemoteOutputStats{};
      current.echo = output ? output->echoReference() : nullptr;
      current.stopped = !output;
      current.path.revision = desired.revision;
      const auto audio = tracks_.stats();
      if (mix_failed) problem = EngineFailure{"output_mix_failed", "Output mix settings were rejected", "output", true};
      if (audio.failed) problem = EngineFailure{"output_reader_failed", "Remote audio reader failed", "output", true};
      const bool healthy = output && current.output.state == RemoteOutputState::running && !audio.failed && !mix_failed;
      current.path.failure = problem;
      current.path.warning = problem.has_value() && healthy;
      current.path.state = !needed ? MediaPathState::Off : healthy ?
          desired.intent.deafened ? MediaPathState::Muted : MediaPathState::Running :
          problem ? MediaPathState::Failed : MediaPathState::Starting;
      {
        std::lock_guard lock(mutex_);
        snapshot_ = std::move(current);
      }
      applied = std::move(desired);
    }
  } catch (...) {
    problem = EngineFailure{"output_owner_failed", "Output control owner failed", "output", false};
  }
  stopOutput();
  {
    std::lock_guard lock(mutex_);
    snapshot_ = {};
    if (problem) snapshot_.path = {applied.revision, MediaPathState::Failed, problem};
    done_ = true;
  }
  changed_.notify_all();
}
}  // namespace syrnike::windows_media::audio
