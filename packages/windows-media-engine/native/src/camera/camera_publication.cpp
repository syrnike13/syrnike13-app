#include "camera/camera_publication.hpp"

#include <windows.h>
#include <algorithm>
#include <cstring>
#include <stdexcept>

namespace syrnike::windows_media::camera {
namespace {
using Clock = std::chrono::steady_clock;
struct Event {
  HANDLE value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  Event() { if (!value) throw std::runtime_error("Camera publication event creation failed"); }
  ~Event() { CloseHandle(value); }
};
DWORD remaining(Clock::time_point deadline) noexcept {
  return static_cast<DWORD>((std::clamp)(std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count(),
      std::int64_t{0}, std::int64_t{6000}));
}
std::int64_t timestamp() noexcept {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
}  // namespace
struct CameraPublication::State {
  enum class Commit { pending, committed, cancelled };
  std::shared_ptr<LiveKitRoomTransport> transport;
  std::shared_ptr<CameraFramePort> input;
  CameraProfile initial;
  Event stop, ready, done, unpublished;
  std::atomic_bool stopping{false}, published{false};
  std::atomic<Commit> commit{Commit::pending};
  std::atomic<CameraPublicationFailure> failure{CameraPublicationFailure::none};
  std::atomic_uint64_t commits{0}, submitted{0}, generation{0}, stale{0}, maximum_age_us{0};
  std::atomic_uint32_t width{0}, height{0};
  std::shared_ptr<livekit::LocalParticipant> participant;
  std::shared_ptr<livekit::LocalVideoTrack> track;
  std::shared_ptr<livekit::VideoSource> source;
  void fail(CameraPublicationFailure value) noexcept {
    auto expected = CameraPublicationFailure::none;
    failure.compare_exchange_strong(expected, value);
  }
  void cancel() noexcept {
    stopping = true;
    auto pending = Commit::pending;
    commit.compare_exchange_strong(pending, Commit::cancelled);
    SetEvent(stop.value);
  }
  bool enqueue(LiveKitRoomTransport::ActiveRoomTask task, Clock::time_point deadline) {
    do {
      if (transport->enqueueActiveRoomTask(task)) return true;
      std::this_thread::sleep_for(std::chrono::milliseconds{5});
    } while (Clock::now() < deadline);
    return false;
  }
};
CameraPublication::CameraPublication(std::shared_ptr<LiveKitRoomTransport> transport,
                                     std::shared_ptr<CameraFramePort> input, CameraProfile initial)
    : state_(std::make_shared<State>()) {
  if (!transport || !input || !cameraBgraBytes(initial.width, initial.height))
    throw std::invalid_argument("Camera publication input is invalid");
  state_->transport = std::move(transport);
  state_->input = std::move(input);
  state_->initial = initial;
}
CameraPublication::~CameraPublication() { if (!stop(Clock::now() + std::chrono::seconds{6})) std::terminate(); }
CameraPublicationFailure CameraPublication::start() {
  if (owner_ != std::this_thread::get_id() || started_ || state_->stopping) return CameraPublicationFailure::invalid_state;
  started_ = true;
  try { worker_ = std::thread([state = state_] { run(state); }); }
  catch (...) {
    state_->fail(CameraPublicationFailure::publish_failed);
    SetEvent(state_->unpublished.value);
    return state_->failure.load();
  }
  if (WaitForSingleObject(state_->ready.value, 6000) != WAIT_OBJECT_0) {
    state_->cancel();
    state_->fail(CameraPublicationFailure::timeout);
  }
  return state_->failure.load();
}
bool CameraPublication::stop(Clock::time_point deadline) noexcept {
  if (owner_ != std::this_thread::get_id()) return false;
  state_->cancel();
  if (!worker_.joinable()) return !started_ || WaitForSingleObject(state_->unpublished.value, 0) == WAIT_OBJECT_0;
  if (WaitForSingleObject(state_->done.value, remaining(deadline)) != WAIT_OBJECT_0) return false;
  worker_.join();
  return WaitForSingleObject(state_->unpublished.value, 0) == WAIT_OBJECT_0;
}
CameraPublicationStats CameraPublication::stats() const noexcept {
  return {state_->failure.load(), state_->published.load(), state_->commits.load(), state_->submitted.load(),
          state_->generation.load(), state_->stale.load(), state_->maximum_age_us.load(), state_->width.load(), state_->height.load()};
}
void CameraPublication::run(const std::shared_ptr<State>& state) noexcept {
  try {
    const auto deadline = Clock::now() + std::chrono::seconds{5};
    if (!state->enqueue([state](const std::shared_ptr<livekit::Room>& room) {
      try {
        if (state->stopping) { SetEvent(state->ready.value); return; }
        state->participant = room ? room->localParticipant().lock() : nullptr;
        if (!state->participant) throw std::runtime_error("Camera Room unavailable");
        state->source = std::make_shared<livekit::VideoSource>(static_cast<int>(state->initial.width), static_cast<int>(state->initial.height));
        state->track = livekit::LocalVideoTrack::createLocalVideoTrack("camera", state->source);
        livekit::TrackPublishOptions options;
        options.source = livekit::TrackSource::SOURCE_CAMERA;
        options.simulcast = false;
        options.video_codec = livekit::VideoCodec::VP8;
        options.video_encoding = livekit::VideoEncodingOptions{3'000'000, 30};
        state->participant->publishTrack(state->track, options);
        if (!state->track->publication()) throw std::runtime_error("Camera publication missing");
        auto pending = State::Commit::pending;
        if (state->commit.compare_exchange_strong(pending, State::Commit::committed)) {
          state->published = true;
          ++state->commits;
        }
      } catch (...) { state->fail(CameraPublicationFailure::publish_failed); }
      SetEvent(state->ready.value);
    }, deadline)) throw CameraPublicationFailure::timeout;
    if (WaitForSingleObject(state->ready.value, remaining(deadline)) != WAIT_OBJECT_0)
      throw CameraPublicationFailure::timeout;
    if (state->failure != CameraPublicationFailure::none) throw state->failure.load();
    if (!state->published) throw CameraPublicationFailure::publish_failed;
    std::vector<std::uint8_t> pixels(kMaximumCameraBytes);
    auto frame = livekit::VideoFrame::create(static_cast<int>(state->initial.width), static_cast<int>(state->initial.height), livekit::VideoBufferType::BGRA);
    while (!state->stopping) {
      if (WaitForSingleObject(state->stop.value, 5) == WAIT_OBJECT_0) break;
      CameraFrameMetadata metadata;
      if (!state->input->take(metadata, pixels, timestamp())) continue;
      if (frame.width() != static_cast<int>(metadata.width) || frame.height() != static_cast<int>(metadata.height))
        frame = livekit::VideoFrame::create(static_cast<int>(metadata.width), static_cast<int>(metadata.height), livekit::VideoBufferType::BGRA);
      std::memcpy(frame.data(), pixels.data(), cameraBgraBytes(metadata.width, metadata.height));
      const auto now = timestamp();
      if (state->input->generation() != metadata.generation || now < metadata.captured_100ns ||
          now - metadata.captured_100ns > kMaximumCameraAge100ns) { ++state->stale; continue; }
      const auto age = static_cast<std::uint64_t>((now - metadata.captured_100ns) / 10);
      state->maximum_age_us = (std::max)(state->maximum_age_us.load(), age);
      state->source->captureFrame(frame, metadata.captured_100ns / 10);
      state->generation = metadata.generation;
      state->width = metadata.width;
      state->height = metadata.height;
      ++state->submitted;
    }
  } catch (CameraPublicationFailure failure) { state->fail(failure); }
  catch (...) { state->fail(CameraPublicationFailure::send_failed); }
  state->cancel();
  SetEvent(state->ready.value);
  try {
    const auto deadline = Clock::now() + std::chrono::seconds{5};
    if (!state->enqueue([state](const std::shared_ptr<livekit::Room>&) {
      try {
        if (state->track && state->track->publication() && state->participant)
          state->participant->unpublishTrack(state->track->publication()->sid());
        state->track.reset();
        state->source.reset();
        state->participant.reset();
        state->published = false;
        SetEvent(state->unpublished.value);
      } catch (...) { state->fail(CameraPublicationFailure::publish_failed); }
    }, deadline) || WaitForSingleObject(state->unpublished.value, remaining(deadline)) != WAIT_OBJECT_0)
      state->fail(CameraPublicationFailure::timeout);
  } catch (...) { state->fail(CameraPublicationFailure::timeout); }
  SetEvent(state->done.value);
}
}  // namespace syrnike::windows_media::camera
