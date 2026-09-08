#include "camera/camera_capture.hpp"

#include <windows.h>
#include <algorithm>
#include <stdexcept>

namespace syrnike::windows_media::camera {
namespace {
using Clock = std::chrono::steady_clock;
struct Event {
  HANDLE value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  Event() { if (!value) throw std::runtime_error("Camera event creation failed"); }
  ~Event() { CloseHandle(value); }
};
std::int64_t timestamp() noexcept {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
DWORD remaining(Clock::time_point deadline) noexcept {
  return static_cast<DWORD>((std::clamp)(std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count(),
      std::int64_t{0}, std::int64_t{5000}));
}
}  // namespace
struct CameraCapture::State {
  CameraEndpoint endpoint;
  CameraProfile requested;
  CameraReaderFactory factory;
  bool allow_downgrade = false;
  std::uint64_t generation = 0;
  std::shared_ptr<CameraFramePort> output = std::make_shared<CameraFramePort>();
  Event stop, ready, done;
  std::atomic<CameraCaptureState> status{CameraCaptureState::stopped};
  std::atomic<CameraFailure> failure{CameraFailure::none};
  std::atomic_bool thread_alive{false}, reader_alive{false}, downgraded{false}, closed{true};
  std::atomic_uint32_t width{0}, height{0}, fps{0};
  std::atomic_uint64_t frames{0}, stale{0}, maximum_copy_us{0};
  std::atomic<std::int64_t> platform_error{0};
  void fail(CameraFailure value) noexcept {
    auto expected = CameraFailure::none;
    failure.compare_exchange_strong(expected, value);
    status = CameraCaptureState::failed;
  }
};
CameraCapture::CameraCapture(CameraEndpoint endpoint, CameraProfile profile, std::uint64_t generation,
                             bool allow_downgrade, CameraReaderFactory factory)
    : state_(std::make_shared<State>()) {
  if (!generation || !validCameraProfile(profile) || !factory) throw std::invalid_argument("Invalid camera capture request");
  state_->endpoint = std::move(endpoint);
  state_->requested = profile;
  state_->generation = generation;
  state_->allow_downgrade = allow_downgrade;
  state_->factory = std::move(factory);
}
CameraCapture::~CameraCapture() {
  if (!stop(Clock::now() + std::chrono::seconds{5})) std::terminate();
}
CameraFailure CameraCapture::start() {
  if (owner_ != std::this_thread::get_id() || started_) return CameraFailure::invalid_state;
  started_ = true;
  state_->status = CameraCaptureState::starting;
  state_->output->selectGeneration(state_->generation);
  try { worker_ = std::thread([state = state_] { run(state); }); }
  catch (...) { state_->fail(CameraFailure::unavailable); return CameraFailure::unavailable; }
  if (WaitForSingleObject(state_->ready.value, 4000) != WAIT_OBJECT_0) {
    state_->fail(CameraFailure::start_timeout);
    state_->output->selectGeneration(0);
    SetEvent(state_->stop.value);
  }
  return state_->failure.load();
}
bool CameraCapture::stop(Clock::time_point deadline) noexcept {
  if (owner_ != std::this_thread::get_id()) return false;
  state_->output->selectGeneration(0);
  SetEvent(state_->stop.value);
  if (worker_.joinable()) {
    if (WaitForSingleObject(state_->done.value, remaining(deadline)) != WAIT_OBJECT_0) return false;
    worker_.join();
  }
  return state_->closed.load();
}
std::shared_ptr<CameraFramePort> CameraCapture::output() const noexcept { return state_->output; }
CameraCaptureStats CameraCapture::stats() const noexcept {
  return {state_->status.load(), state_->failure.load(), {state_->width.load(), state_->height.load(), state_->fps.load()},
          state_->downgraded.load(), state_->thread_alive.load(), state_->reader_alive.load(), state_->generation,
          state_->frames.load(), state_->stale.load(), state_->maximum_copy_us.load(), state_->platform_error.load(),
          state_->output->stats()};
}
void CameraCapture::run(const std::shared_ptr<State>& state) noexcept {
  state->thread_alive = true;
  std::unique_ptr<CameraReader> reader;
  try {
    std::vector<std::uint8_t> pixels(kMaximumCameraBytes);
    reader = state->factory();
    if (!reader) throw CameraFailure::unavailable;
    state->closed = false;
    state->reader_alive = true;
    const auto opened = reader->open(state->endpoint, state->requested, state->allow_downgrade);
    state->platform_error = opened.platform_error;
    if (opened.failure != CameraFailure::none) throw opened.failure;
    if (!cameraBgraBytes(opened.actual.width, opened.actual.height) || !opened.actual.fps || opened.actual.fps > 60)
      throw CameraFailure::unsupported_profile;
    state->width = opened.actual.width;
    state->height = opened.actual.height;
    state->fps = opened.actual.fps;
    state->downgraded = opened.downgraded;
    auto failure = reader->requestSample();
    if (failure != CameraFailure::none) throw failure;
    const HANDLE events[]{state->stop.value, static_cast<HANDLE>(reader->eventHandle())};
    if (!events[1]) throw CameraFailure::source_error;
    auto last_frame = Clock::now();
    std::int64_t previous_timestamp = 0;
    std::uint64_t sequence = 0;
    while (WaitForSingleObject(state->stop.value, 0) != WAIT_OBJECT_0) {
      if (Clock::now() - last_frame >= std::chrono::seconds{2}) throw CameraFailure::no_frames;
      const auto wake = WaitForMultipleObjects(2, events, FALSE, 100);
      if (wake == WAIT_OBJECT_0) break;
      if (wake == WAIT_TIMEOUT) {
        if (Clock::now() - last_frame >= std::chrono::seconds{2}) throw CameraFailure::no_frames;
        continue;
      }
      if (wake != WAIT_OBJECT_0 + 1) throw CameraFailure::source_error;
      auto completed = reader->takeCompleted();
      if (!completed) continue;
      if (completed->failure != CameraFailure::none) {
        state->platform_error = completed->platform_error;
        throw completed->failure;
      }
      if (completed->sample) {
        const auto began = Clock::now();
        if (!completed->sample->copyBgra(pixels)) throw CameraFailure::malformed_sample;
        completed->sample.reset();
        const auto now = timestamp();
        const auto copy_us = std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - began).count();
        state->maximum_copy_us = (std::max)(state->maximum_copy_us.load(), static_cast<std::uint64_t>(copy_us));
        if (completed->received_100ns <= previous_timestamp || completed->received_100ns > now ||
            now - completed->received_100ns > kMaximumCameraAge100ns) {
          ++state->stale;
        } else if (WaitForSingleObject(state->stop.value, 0) != WAIT_OBJECT_0) {
          previous_timestamp = completed->received_100ns;
          const CameraFrameMetadata metadata{state->generation, ++sequence, completed->received_100ns,
                                             opened.actual.width, opened.actual.height};
          (void)state->output->publish(metadata, pixels);
          ++state->frames;
          last_frame = Clock::now();
          if (sequence == 3) {
            auto starting = CameraCaptureState::starting;
            state->status.compare_exchange_strong(starting, CameraCaptureState::running);
            SetEvent(state->ready.value);
          }
        }
      }
      failure = reader->requestSample();
      if (failure != CameraFailure::none) throw failure;
    }
  } catch (CameraFailure failure) { state->fail(failure); }
  catch (...) { state->fail(CameraFailure::source_error); }
  state->output->selectGeneration(0);
  if (reader) {
    state->closed = reader->close(Clock::now() + std::chrono::seconds{2});
    if (!state->closed) state->fail(CameraFailure::flush_timeout);
    reader.reset();
  }
  state->reader_alive = false;
  state->thread_alive = false;
  if (state->failure == CameraFailure::none) state->status = CameraCaptureState::stopped;
  SetEvent(state->ready.value);
  SetEvent(state->done.value);
}
}  // namespace syrnike::windows_media::camera
