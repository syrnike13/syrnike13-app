#include "camera/camera_pipeline.hpp"

#include <windows.h>
#include <algorithm>
#include <stdexcept>

namespace syrnike::windows_media::camera {
namespace {
using Clock = std::chrono::steady_clock;
struct Event {
  HANDLE value;
  explicit Event(bool manual = false) : value(CreateEventW(nullptr, manual, FALSE, nullptr)) {
    if (!value) throw std::runtime_error("Camera pipeline event creation failed");
  }
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
struct CameraPipeline::State {
  struct Command { CameraFramePort* input = nullptr; std::uint64_t generation = 0; bool publication = false, preview = false; } command;
  Event changed, acknowledged, ready{true}, done{true}, stop{true};
  std::atomic_uint64_t posted{0}, applied{0}, forwarded{0};
  std::atomic_bool failed{false};
  std::shared_ptr<CameraFramePort> publication = std::make_shared<CameraFramePort>();
  std::shared_ptr<CameraFramePort> preview = std::make_shared<CameraFramePort>();
};
CameraPipeline::CameraPipeline(CameraReaderFactory factory) : factory_(std::move(factory)), state_(std::make_shared<State>()) {
  if (!factory_) throw std::invalid_argument("Camera reader factory is required");
  worker_ = std::thread([state = state_] { run(state); });
  if (WaitForSingleObject(state_->ready.value, 2000) != WAIT_OBJECT_0 || state_->failed) stats_.retired = true;
}
CameraPipeline::~CameraPipeline() { if (!stop(Clock::now() + std::chrono::seconds{5})) std::terminate(); }
bool CameraPipeline::onOwner() const noexcept { return owner_ == std::this_thread::get_id() && !stats_.retired; }
bool CameraPipeline::bind(CameraFramePort* input, std::uint64_t generation, bool publication, bool preview) {
  if (!onOwner()) return false;
  state_->command = {input, generation, publication, preview};
  const auto revision = ++command_revision_;
  state_->posted.store(revision, std::memory_order_release);
  SetEvent(state_->changed.value);
  const HANDLE events[]{state_->acknowledged.value, state_->done.value};
  const auto deadline = Clock::now() + std::chrono::seconds{1};
  while (state_->applied.load(std::memory_order_acquire) != revision) {
    if (WaitForMultipleObjects(2, events, FALSE, remaining(deadline)) != WAIT_OBJECT_0) {
      stats_.retired = true;
      stats_.failure = CameraFailure::stop_timeout;
      return false;
    }
  }
  return true;
}
CameraFailure CameraPipeline::openCandidate(const CameraEndpoint& endpoint, CameraProfile profile, bool allow_downgrade,
                                          std::stop_token cancellation) {
  if (cancellation.stop_requested()) return CameraFailure::cancelled;
  candidate_ = std::make_unique<CameraCapture>(endpoint, profile, ++next_generation_, allow_downgrade, factory_);
  ++stats_.opened;
  const auto failure = candidate_->start(cancellation);
  if (failure != CameraFailure::none || cancellation.stop_requested()) {
    ++stats_.rollbacks;
    if (!candidate_->stop(Clock::now() + std::chrono::seconds{5})) {
      stats_.retired = true;
      return stats_.failure = CameraFailure::stop_timeout;
    }
    candidate_.reset();
    return stats_.failure = cancellation.stop_requested() ? CameraFailure::cancelled : failure;
  }
  // Readiness and cancellation are checked before admitting the candidate to
  // the serialized forwarding commit. Later intent is the next transaction.
  if (!bind(candidate_->output().get(), next_generation_, stats_.publication_demand, stats_.preview_demand))
    return stats_.failure = CameraFailure::stop_timeout;
  if (active_ && !active_->stop(Clock::now() + std::chrono::seconds{5})) {
    stats_.retired = true;
    return stats_.failure = CameraFailure::stop_timeout;
  }
  active_ = std::move(candidate_);
  selected_ = endpoint;
  profile_ = profile;
  allow_downgrade_ = allow_downgrade;
  ++stats_.commits;
  return stats_.failure = CameraFailure::none;
}
CameraFailure CameraPipeline::selectDevice(CameraDeviceRegistry& registry, std::optional<CameraDeviceId> id,
                                           CameraProfile profile, bool allow_downgrade, std::stop_token cancellation) {
  if (!onOwner() || !validCameraProfile(profile)) return CameraFailure::invalid_state;
  if (cancellation.stop_requested()) return CameraFailure::cancelled;
  const auto endpoint = registry.resolve(id);
  if (!endpoint) return CameraFailure::unavailable;
  if (!stats_.publication_demand && !stats_.preview_demand) {
    selected_ = endpoint;
    intent_ = id;
    profile_ = profile;
    allow_downgrade_ = allow_downgrade;
    return stats_.failure = CameraFailure::none;
  }
  if (active_ && selected_ && selected_->symbolic_link == endpoint->symbolic_link && profile_ == profile &&
      active_->stats().state == CameraCaptureState::running && (allow_downgrade || !active_->stats().downgraded)) {
    intent_ = id;
    allow_downgrade_ = allow_downgrade;
    return stats_.failure = CameraFailure::none;
  }
  const auto failure = openCandidate(*endpoint, profile, allow_downgrade, cancellation);
  if (failure == CameraFailure::none) intent_ = id;
  return failure;
}
CameraFailure CameraPipeline::closeActive() {
  if (!bind(nullptr, 0, stats_.publication_demand, stats_.preview_demand)) return CameraFailure::stop_timeout;
  if (active_ && !active_->stop(Clock::now() + std::chrono::seconds{5})) {
    stats_.retired = true;
    return CameraFailure::stop_timeout;
  }
  active_.reset();
  return CameraFailure::none;
}
CameraFailure CameraPipeline::setDemand(bool publication, bool preview, std::stop_token cancellation) {
  if (!onOwner()) return CameraFailure::invalid_state;
  if (cancellation.stop_requested()) return CameraFailure::cancelled;
  if ((publication || preview) && !selected_) return CameraFailure::unavailable;
  const bool old_publication = stats_.publication_demand, old_preview = stats_.preview_demand;
  stats_.publication_demand = publication;
  stats_.preview_demand = preview;
  if (!publication && !preview) return stats_.failure = closeActive();
  if (!active_) {
    const auto failure = openCandidate(*selected_, profile_, allow_downgrade_, cancellation);
    if (failure != CameraFailure::none) { stats_.publication_demand = old_publication; stats_.preview_demand = old_preview; }
    return failure;
  }
  if (!bind(active_->output().get(), active_->stats().generation, publication, preview)) return CameraFailure::stop_timeout;
  return CameraFailure::none;
}
CameraFailure CameraPipeline::reconcile(CameraDeviceRegistry& registry, std::uint64_t revision, std::stop_token cancellation) {
  if (!onOwner()) return CameraFailure::invalid_state;
  if (cancellation.stop_requested()) return CameraFailure::cancelled;
  const bool changed = revision != registry_revision_;
  registry_revision_ = revision;
  const auto endpoint = registry.resolve(intent_);
  const auto capture_failure = active_ ? active_->stats().failure : CameraFailure::none;
  if (!endpoint || capture_failure != CameraFailure::none) {
    if (active_ && closeActive() != CameraFailure::none) return stats_.failure = CameraFailure::stop_timeout;
    return stats_.failure = capture_failure != CameraFailure::none ? capture_failure : CameraFailure::device_removed;
  }
  if (changed && (stats_.publication_demand || stats_.preview_demand) &&
      (!active_ || !selected_ || selected_->symbolic_link != endpoint->symbolic_link))
    return openCandidate(*endpoint, profile_, allow_downgrade_, cancellation);
  return stats_.failure;
}
bool CameraPipeline::stop(Clock::time_point deadline) noexcept {
  if (owner_ != std::this_thread::get_id()) return false;
  stats_.retired = true;
  state_->publication->selectGeneration(0);
  state_->preview->selectGeneration(0);
  SetEvent(state_->stop.value);
  if (worker_.joinable()) {
    if (WaitForSingleObject(state_->done.value, remaining(deadline)) != WAIT_OBJECT_0) return false;
    worker_.join();
  }
  if (candidate_ && !candidate_->stop(deadline)) return false;
  if (active_ && !active_->stop(deadline)) return false;
  candidate_.reset();
  active_.reset();
  return true;
}
CameraPipelineStats CameraPipeline::stats() const noexcept {
  if (owner_ != std::this_thread::get_id()) return {CameraFailure::invalid_state};
  auto result = stats_;
  if (state_->failed) result.failure = CameraFailure::source_error;
  result.active = static_cast<bool>(active_);
  result.candidate = static_cast<bool>(candidate_);
  if (active_) result.capture = active_->stats();
  result.forwarded = state_->forwarded.load();
  result.publication = state_->publication->stats();
  result.preview = state_->preview->stats();
  return result;
}
std::shared_ptr<CameraFramePort> CameraPipeline::publication() const noexcept { return state_->publication; }
std::shared_ptr<CameraFramePort> CameraPipeline::preview() const noexcept { return state_->preview; }
void CameraPipeline::run(const std::shared_ptr<State>& state) noexcept {
  try {
    std::vector<std::uint8_t> pixels(kMaximumCameraBytes);
    State::Command active;
    const HANDLE events[]{state->stop.value, state->changed.value};
    SetEvent(state->ready.value);
    while (true) {
      const auto wake = WaitForMultipleObjects(2, events, FALSE, 5);
      if (wake == WAIT_OBJECT_0) break;
      if (wake == WAIT_OBJECT_0 + 1) {
        const auto revision = state->posted.load(std::memory_order_acquire);
        active = state->command;
        state->publication->selectGeneration(active.publication ? active.generation : 0);
        state->preview->selectGeneration(active.preview ? active.generation : 0);
        state->applied.store(revision, std::memory_order_release);
        SetEvent(state->acknowledged.value);
      } else if (wake != WAIT_TIMEOUT) throw std::runtime_error("Camera forwarding wait failed");
      CameraFrameMetadata metadata;
      if (!active.input || !active.input->take(metadata, pixels, timestamp()) || metadata.generation != active.generation) continue;
      // Publication always precedes the optional lossy preview projection.
      if (active.publication) (void)state->publication->publish(metadata, pixels);
      if (active.preview) (void)state->preview->publish(metadata, pixels);
      ++state->forwarded;
    }
  } catch (...) { state->failed = true; }
  state->publication->selectGeneration(0);
  state->preview->selectGeneration(0);
  SetEvent(state->ready.value);
  SetEvent(state->done.value);
}
}  // namespace syrnike::windows_media::camera
