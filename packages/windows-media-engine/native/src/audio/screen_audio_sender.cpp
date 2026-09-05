#include "audio/screen_audio_sender.hpp"
#include <algorithm>
#include <stdexcept>
#include <system_error>

namespace syrnike::windows_media::audio {
namespace {
using Clock = std::chrono::steady_clock;
std::int64_t now100ns() noexcept {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
             Clock::now().time_since_epoch())
      .count();
}
}  // namespace
struct ScreenAudioSender::State {
  std::mutex mutex;
  std::condition_variable changed;
  bool stop = false, ready = false, done = false, unpublished = false;
  ScreenAudioSenderStats stats;
  std::optional<ScreenAudioFailure> failure;
  std::shared_ptr<livekit::LocalParticipant> participant;
  std::shared_ptr<livekit::LocalAudioTrack> track;
  std::shared_ptr<livekit::AudioSource> source;
};
ScreenAudioSender::ScreenAudioSender(std::shared_ptr<LiveKitRoomTransport> transport,
                                     std::shared_ptr<PcmQueue> queue, PacketObserver observer)
    : transport_(std::move(transport)),
      queue_(std::move(queue)),
      packet_observer_(std::move(observer)) {
  if (!transport_ || !queue_)
    throw std::invalid_argument("Screen audio sender needs Room and PCM ports");
}
ScreenAudioSender::~ScreenAudioSender() {
  (void)stop(Clock::now() + std::chrono::seconds{6});
  if (worker_.joinable()) std::terminate();
}
std::optional<ScreenAudioFailure> ScreenAudioSender::start(std::uint64_t generation) {
  std::scoped_lock owner_lock(mutex_);
  if (!generation) return ScreenAudioFailure{ScreenAudioFailureCode::invalid_state};
  if (worker_.joinable()) return ScreenAudioFailure{ScreenAudioFailureCode::invalid_state};
  if (state_) {
    std::scoped_lock lock(state_->mutex);
    if (state_->failure && state_->failure->utility_retirement_required) return state_->failure;
  }
  state_ = std::make_shared<State>();
  state_->stats.generation = generation;
  try {
    worker_ = std::thread([this, state = state_] { run(state); });
  } catch (...) {
    state_->done = state_->unpublished = true;
    state_->failure = ScreenAudioFailure{ScreenAudioFailureCode::publication_failed, E_OUTOFMEMORY};
    return state_->failure;
  }
  std::unique_lock lock(state_->mutex);
  if (!state_->changed.wait_for(lock, std::chrono::seconds{6},
                                [&] { return state_->ready || state_->done; })) {
    state_->stop = true;
    state_->failure =
        ScreenAudioFailure{ScreenAudioFailureCode::publication_timeout, E_PENDING, true};
    state_->changed.notify_all();
  }
  return state_->failure;
}
bool ScreenAudioSender::enqueue(const std::shared_ptr<State>& state,
                                LiveKitRoomTransport::ActiveRoomTask task,
                                Clock::time_point deadline) {
  while (Clock::now() < deadline) {
    if (transport_->enqueueActiveRoomTask(task)) return true;
    std::unique_lock lock(state->mutex);
    state->changed.wait_for(lock, std::chrono::milliseconds{5});
  }
  return false;
}
void ScreenAudioSender::run(const std::shared_ptr<State>& state) noexcept {
  const auto fail = [&](ScreenAudioFailure failure) {
    std::scoped_lock lock(state->mutex);
    if (!state->failure) state->failure = failure;
    state->changed.notify_all();
  };
  try {
    const auto deadline = Clock::now() + std::chrono::seconds{5};
    if (!enqueue(
            state,
            [state](const std::shared_ptr<livekit::Room>& room) {
              try {
                {
                  std::scoped_lock lock(state->mutex);
                  if (state->stop) {
                    state->ready = true;
                    state->changed.notify_all();
                    return;
                  }
                }
                const auto participant = room ? room->localParticipant().lock() : nullptr;
                if (!participant) throw std::runtime_error("Screen audio Room unavailable");
                // Keep the RTP audio clock advancing with silence during ingress gaps.
                // The SDK's fixed 10 ms queue has a hard two-packet storage bound; the
                // unbuffered path stops its clock when this worker is stalled.
                auto source =
                    std::make_shared<livekit::AudioSource>(kAudioRate, kAudioChannels, 10);
                auto track =
                    livekit::LocalAudioTrack::createLocalAudioTrack("screen-audio", source);
                livekit::TrackPublishOptions options;
                options.source = livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO;
                options.simulcast = false;
                options.dtx = false;
                participant->publishTrack(track, options);
                if (!track->publication())
                  throw std::runtime_error("Screen audio publication missing");
                bool stopped;
                {
                  std::scoped_lock lock(state->mutex);
                  stopped = state->stop;
                }
                if (stopped) participant->unpublishTrack(track->publication()->sid());
                {
                  std::scoped_lock lock(state->mutex);
                  if (!stopped) {
                    state->participant = participant;
                    state->source = source;
                    state->track = track;
                    state->stats.published = true;
                  }
                  state->ready = true;
                  state->changed.notify_all();
                }
              } catch (...) {
                std::scoped_lock lock(state->mutex);
                if (!state->failure)
                  state->failure = ScreenAudioFailure{ScreenAudioFailureCode::publication_failed, E_FAIL};
                state->ready = true;
                state->changed.notify_all();
              }
            },
            deadline))
      throw ScreenAudioFailure{ScreenAudioFailureCode::publication_timeout, E_PENDING};
    std::shared_ptr<livekit::AudioSource> source;
    {
      std::unique_lock lock(state->mutex);
      if (!state->changed.wait_until(lock, deadline, [&] { return state->ready; })) {
        state->stop = true;
        throw ScreenAudioFailure{ScreenAudioFailureCode::publication_timeout, E_PENDING, true};
      }
      if (state->failure) throw *state->failure;
      source = state->source;
    }
    auto frame = livekit::AudioFrame::create(kAudioRate, kAudioChannels, kAudioPacketFrames);
    auto last_submit = Clock::now();
    for (;;) {
      {
        std::scoped_lock lock(state->mutex);
        if (state->stop || !source) break;
      }
      if (queue_->stopped()) break;
      if (Clock::now() - last_submit > std::chrono::milliseconds{100})
        queue_->discardBacklogExceptLatest();
      auto packet = queue_->take(now100ns());
      if (!packet) {
        queue_->wait(std::chrono::milliseconds{10});
        continue;
      }
      if (packet->generation != state->stats.generation) continue;
      if (packet_observer_) packet_observer_(*packet);
      // Recheck at the SDK boundary: a preempted worker must not submit a
      // packet which was fresh only when it left the queue.
      const auto age = now100ns() - packet->capture_timestamp_100ns;
      if (age < 0 || age > kAudioMaximumAge100ns) continue;
      std::copy(packet->samples.begin(), packet->samples.end(), frame.data().begin());
      try {
        source->captureFrame(frame, 100);
        last_submit = Clock::now();
      } catch (const std::system_error& error) {
        throw ScreenAudioFailure{error.code() == std::errc::timed_out
                                     ? ScreenAudioFailureCode::publication_timeout
                                     : ScreenAudioFailureCode::publication_failed,
                                 E_FAIL, true};
      }
      std::scoped_lock lock(state->mutex);
      ++state->stats.submitted;
      if (packet->discontinuity) ++state->stats.discontinuities;
      state->stats.last_capture_timestamp_100ns = packet->capture_timestamp_100ns;
      state->stats.maximum_submit_age_us =
          (std::max)(state->stats.maximum_submit_age_us,
                     static_cast<std::uint64_t>(
                         (std::max)(std::int64_t{0}, now100ns() - packet->capture_timestamp_100ns) /
                         10));
    }
  } catch (const ScreenAudioFailure& failure) {
    fail(failure);
  } catch (...) {
    fail({ScreenAudioFailureCode::publication_failed, E_FAIL});
  }
  queue_->stop();
  {
    std::scoped_lock lock(state->mutex);
    state->stop = true;
  }
  const auto deadline = Clock::now() + std::chrono::seconds{5};
  try {
    if (!enqueue(
            state,
            [state](const std::shared_ptr<livekit::Room>&) {
              try {
                if (state->source) state->source->clearQueue();
                if (state->track && state->track->publication() && state->participant)
                  state->participant->unpublishTrack(state->track->publication()->sid());
              } catch (...) {
                std::scoped_lock lock(state->mutex);
                state->failure =
                    ScreenAudioFailure{ScreenAudioFailureCode::publication_failed, E_FAIL, true};
              }
              std::scoped_lock lock(state->mutex);
              state->track.reset();
              state->source.reset();
              state->participant.reset();
              state->stats.published = false;
              state->unpublished = true;
              state->changed.notify_all();
            },
            deadline))
      throw ScreenAudioFailure{ScreenAudioFailureCode::publication_timeout, E_PENDING, true};
    std::unique_lock lock(state->mutex);
    if (!state->changed.wait_until(lock, deadline, [&] { return state->unpublished; })) {
      lock.unlock();
      fail({ScreenAudioFailureCode::publication_timeout, E_PENDING, true});
    }
  } catch (...) {
    fail({ScreenAudioFailureCode::publication_failed, E_FAIL, true});
  }
  std::scoped_lock lock(state->mutex);
  state->done = true;
  state->changed.notify_all();
}
bool ScreenAudioSender::stop(Clock::time_point deadline) noexcept {
  std::unique_lock owner_lock(mutex_);
  if (!state_) return true;
  const auto state = state_;
  {
    std::scoped_lock lock(state->mutex);
    state->stop = true;
    state->changed.notify_all();
  }
  queue_->stop();
  std::unique_lock lock(state->mutex);
  if (!state->changed.wait_until(lock, deadline, [&] { return state->done; })) return false;
  const bool unpublished =
      state->unpublished && !(state->failure && state->failure->utility_retirement_required);
  lock.unlock();
  if (worker_.joinable()) worker_.join();
  return unpublished;
}
ScreenAudioSenderStats ScreenAudioSender::stats() const noexcept {
  std::scoped_lock owner_lock(mutex_);
  if (!state_) return {};
  std::scoped_lock lock(state_->mutex);
  return state_->stats;
}
std::optional<ScreenAudioFailure> ScreenAudioSender::failure() const noexcept {
  std::scoped_lock owner_lock(mutex_);
  if (!state_) return {};
  std::scoped_lock lock(state_->mutex);
  return state_->failure;
}
}  // namespace syrnike::windows_media::audio
