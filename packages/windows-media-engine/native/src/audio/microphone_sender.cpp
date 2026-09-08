#include "audio/microphone_sender.hpp"
#include <windows.h>
#include <algorithm>
#include <stdexcept>
#include <system_error>

namespace syrnike::windows_media::audio {
namespace {
using Clock = std::chrono::steady_clock;
struct Event {
  HANDLE value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  Event() { if (!value) throw std::runtime_error("Microphone publication event creation failed"); }
  ~Event() { CloseHandle(value); }
};
DWORD remaining(Clock::time_point deadline) noexcept {
  return static_cast<DWORD>((std::clamp)(
      std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count(),
      std::int64_t{0}, std::int64_t{6000}));
}
std::int64_t timestamp() noexcept {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
}  // namespace
struct MicrophoneSender::State {
  enum class CommitState { pending, committed, cancelled };
  std::shared_ptr<LiveKitRoomTransport> transport;
  std::shared_ptr<MicrophonePcmPort> pcm;
  HANDLE frame_event = nullptr;
  Event stop, ready, done, unpublished;
  std::atomic<bool> stopped{false}, published{false};
  std::atomic<CommitState> commit{CommitState::pending};
  std::atomic<MicrophonePublicationFailure> failure{MicrophonePublicationFailure::none};
  std::atomic<std::uint64_t> submitted{0}, rejected_stale{0}, device_generation{0}, commits{0};
  std::atomic<std::uint64_t> latest_frame_age_us{0}, maximum_frame_age_us{0};
  std::atomic<std::uint64_t> maximum_callback_wait_us{0};
  // Room lane creates these before ready, and destroys them after the sender
  // has stopped submitting and enqueued cleanup. Events/queue establish order.
  std::shared_ptr<livekit::LocalParticipant> participant;
  std::shared_ptr<livekit::LocalAudioTrack> track;
  std::shared_ptr<livekit::AudioSource> source;
  void fail(MicrophonePublicationFailure value) noexcept {
    auto expected = MicrophonePublicationFailure::none;
    failure.compare_exchange_strong(expected, value);
  }
  void cancel() noexcept {
    stopped.store(true);
    auto pending = CommitState::pending;
    commit.compare_exchange_strong(pending, CommitState::cancelled);
    SetEvent(stop.value);
  }
  bool enqueue(LiveKitRoomTransport::ActiveRoomTask task, Clock::time_point deadline) {
    do {
      if (transport->enqueueActiveRoomTask(task)) return true;
      // Control/publication worker only. The realtime DSP never enters this lane.
      std::this_thread::sleep_for(std::chrono::milliseconds{5});
    } while (Clock::now() < deadline);
    return false;
  }
};
MicrophoneSender::MicrophoneSender(std::shared_ptr<LiveKitRoomTransport> transport,
                                   std::shared_ptr<MicrophonePcmPort> pcm, void* frame_event)
    : state_(std::make_shared<State>()) {
  if (!transport || !pcm || !frame_event) throw std::invalid_argument("Microphone publication ports missing");
  state_->transport = std::move(transport);
  state_->pcm = std::move(pcm);
  state_->frame_event = frame_event;
}
MicrophoneSender::~MicrophoneSender() {
  if (!stop(Clock::now() + std::chrono::seconds{6})) std::terminate();
}
MicrophonePublicationFailure MicrophoneSender::start() {
  if (owner_ != std::this_thread::get_id() || started_ || state_->stopped.load())
    return MicrophonePublicationFailure::invalid_state;
  started_ = true;
  try { worker_ = std::thread([state = state_] { run(state); }); }
  catch (...) {
    state_->fail(MicrophonePublicationFailure::unavailable);
    SetEvent(state_->unpublished.value);
    return state_->failure.load();
  }
  if (WaitForSingleObject(state_->ready.value, 6000) != WAIT_OBJECT_0) {
    state_->cancel();
    state_->fail(MicrophonePublicationFailure::timeout);
  }
  const auto failure = state_->failure.load();
  if (failure != MicrophonePublicationFailure::none) return failure;
  return state_->published.load() ? MicrophonePublicationFailure::none : MicrophonePublicationFailure::publish_failed;
}
void MicrophoneSender::cancel() noexcept { state_->cancel(); }
bool MicrophoneSender::stop(Clock::time_point deadline) noexcept {
  if (owner_ != std::this_thread::get_id()) return false;
  state_->cancel();
  if (!worker_.joinable()) return !started_ || WaitForSingleObject(state_->unpublished.value, 0) == WAIT_OBJECT_0;
  if (WaitForSingleObject(state_->done.value, remaining(deadline)) != WAIT_OBJECT_0) return false;
  worker_.join();
  // Timed-out Room work can still hold this state, so a done worker alone is
  // not evidence that cleanup finished. The utility must retire in that case.
  return WaitForSingleObject(state_->unpublished.value, 0) == WAIT_OBJECT_0;
}
MicrophoneSenderStats MicrophoneSender::stats() const noexcept {
  return {state_->published.load(), state_->failure.load(), state_->submitted.load(),
          state_->rejected_stale.load(), state_->device_generation.load(), state_->commits.load(),
          state_->latest_frame_age_us.load(), state_->maximum_frame_age_us.load(), state_->pcm->pendingFrames(),
          state_->maximum_callback_wait_us.load()};
}
void MicrophoneSender::run(const std::shared_ptr<State>& state) noexcept {
  try {
    const auto deadline = Clock::now() + std::chrono::seconds{5};
    if (!state->enqueue([state](const std::shared_ptr<livekit::Room>& room) {
      try {
        if (state->stopped.load()) { SetEvent(state->ready.value); return; }
        const auto participant = room ? room->localParticipant().lock() : nullptr;
        if (!participant) throw std::runtime_error("Microphone Room unavailable");
        auto source = std::make_shared<livekit::AudioSource>(kMicrophoneRate, 1, 10);
        auto track = livekit::LocalAudioTrack::createLocalAudioTrack("microphone", source);
        // Retain the candidate before publish: even a partially successful
        // publish or a late completion is handled by the ordered cleanup task.
        state->participant = participant;
        state->source = source;
        state->track = track;
        livekit::TrackPublishOptions options;
        options.source = livekit::TrackSource::SOURCE_MICROPHONE;
        options.simulcast = false;
        options.dtx = false;
        participant->publishTrack(track, options);
        if (!track->publication()) throw std::runtime_error("Microphone publication missing");
        auto pending = State::CommitState::pending;
        if (state->commit.compare_exchange_strong(pending, State::CommitState::committed)) {
          state->commits.fetch_add(1);
          state->published.store(true);
        }
      } catch (...) { state->fail(MicrophonePublicationFailure::publish_failed); }
      SetEvent(state->ready.value);
    }, deadline)) throw MicrophonePublicationFailure::timeout;
    if (WaitForSingleObject(state->ready.value, remaining(deadline)) != WAIT_OBJECT_0)
      throw MicrophonePublicationFailure::timeout;
    if (state->failure.load() != MicrophonePublicationFailure::none) throw state->failure.load();
    if (!state->published.load()) throw MicrophonePublicationFailure::publish_failed;
    auto frame = livekit::AudioFrame::create(kMicrophoneRate, 1, kMicrophoneFrameSamples);
    const HANDLE events[]{state->stop.value, state->frame_event};
    while (!state->stopped.load()) {
      const auto result = WaitForMultipleObjects(2, events, FALSE, 100);
      if (result == WAIT_OBJECT_0) break;
      if (result == WAIT_TIMEOUT) continue;
      if (result != WAIT_OBJECT_0 + 1) throw MicrophonePublicationFailure::send_failed;
      auto input = state->pcm->take();
      if (!input) continue;
      const auto now = timestamp();
      if (input->timestamp_100ns > 0 && now >= input->timestamp_100ns) {
        const auto age_us = static_cast<std::uint64_t>((now - input->timestamp_100ns) / 10);
        state->latest_frame_age_us.store(age_us, std::memory_order_relaxed);
        state->maximum_frame_age_us.store((std::max)(state->maximum_frame_age_us.load(std::memory_order_relaxed), age_us),
                                          std::memory_order_relaxed);
      }
      if (input->timestamp_100ns <= 0 || now < input->timestamp_100ns ||
          now - input->timestamp_100ns > kMicrophoneMaximumAge100ns) {
        state->rejected_stale.fetch_add(1);
        continue;
      }
      std::copy(input->samples.begin(), input->samples.end(), frame.data().begin());
      // A new input generation deliberately uses the same source/publication.
      // The SDK owns a bounded 10 ms clocked queue and a finite completion wait.
      const auto submitted_at = Clock::now();
      state->source->captureFrame(frame, 500);
      const auto callback_wait_us = static_cast<std::uint64_t>(
          std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - submitted_at).count());
      state->maximum_callback_wait_us.store((std::max)(state->maximum_callback_wait_us.load(), callback_wait_us));
      state->device_generation.store(input->generation);
      state->submitted.fetch_add(1);
    }
  } catch (MicrophonePublicationFailure failure) { state->fail(failure); }
  catch (const std::system_error& error) {
    state->fail(error.code() == std::errc::timed_out ? MicrophonePublicationFailure::timeout :
                                                   MicrophonePublicationFailure::send_failed);
  } catch (...) { state->fail(MicrophonePublicationFailure::send_failed); }
  state->cancel();
  SetEvent(state->ready.value);
  try {
    const auto deadline = Clock::now() + std::chrono::seconds{5};
    if (!state->enqueue([state](const std::shared_ptr<livekit::Room>&) {
      try {
        if (state->source) state->source->clearQueue();
        if (state->track && state->track->publication() && state->participant)
          state->participant->unpublishTrack(state->track->publication()->sid());
      } catch (...) { state->fail(MicrophonePublicationFailure::publish_failed); }
      // A disconnected Room can reject clear/unpublish. It must not prevent
      // local SDK objects from being released or leave shutdown waiting forever.
      state->track.reset();
      state->source.reset();
      state->participant.reset();
      state->published.store(false);
      SetEvent(state->unpublished.value);
    }, deadline) || WaitForSingleObject(state->unpublished.value, remaining(deadline)) != WAIT_OBJECT_0)
      state->fail(MicrophonePublicationFailure::timeout);
  } catch (...) { state->fail(MicrophonePublicationFailure::timeout); }
  SetEvent(state->done.value);
}
}  // namespace syrnike::windows_media::audio
