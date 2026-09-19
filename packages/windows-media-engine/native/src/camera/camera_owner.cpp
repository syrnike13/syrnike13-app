#include "camera/camera_owner.hpp"

#include <charconv>
#include <stdexcept>

namespace syrnike::windows_media::camera {
namespace {
using Clock = std::chrono::steady_clock;
bool publishes(const CameraIntent& intent, std::optional<std::uint64_t> room) {
  return intent.state == CameraIntentState::on && intent.publication && room.has_value();
}
bool previews(const CameraIntent& intent) {
  return intent.state == CameraIntentState::on && intent.preview_renderer_id.has_value();
}
std::optional<CameraDeviceId> deviceId(const CameraIntent& intent) {
  if (!intent.device_id) return {};
  CameraDeviceId id = 0;
  const auto& text = *intent.device_id;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), id);
  if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() || id == 0)
    throw std::invalid_argument("Camera device ID is not a catalog identity");
  return id;
}
CameraProfile profile(const CameraIntent& intent) {
  switch (intent.profile) {
    case CameraIntentProfile::hd720p30: return {1280, 720, 30};
    case CameraIntentProfile::hd1080p30: return {1920, 1080, 30};
  }
  throw std::invalid_argument("Unsupported camera profile");
}
}  // namespace

CameraOwner::CameraOwner(std::shared_ptr<LiveKitRoomTransport> transport, capture::ThumbnailAdmission& admission)
    : transport_(std::move(transport)), admission_(admission) {
  if (!transport_) throw std::invalid_argument("Camera transport missing");
  worker_ = std::thread([this] { run(); });
}
CameraOwner::~CameraOwner() {
  stop();
}
void CameraOwner::stop() {
  std::lock_guard join_lock(join_mutex_);
  beginStop();
  {
    std::unique_lock lock(mutex_);
    if (!changed_.wait_for(lock, kShutdownDeadline, [&] { return done_; })) std::terminate();
  }
  if (worker_.joinable()) worker_.join();
}
void CameraOwner::apply(std::uint64_t revision, const CameraIntent& intent,
                        std::optional<std::uint64_t> room_generation) {
  std::lock_guard lock(mutex_);
  if (stopping_ || done_ || revision < desired_.revision) return;
  const bool needed = publishes(intent, room_generation) || previews(intent);
  const bool was_needed = publishes(desired_.intent, desired_.room_generation) || previews(desired_.intent);
  if (needed != was_needed || intent.device_id != desired_.intent.device_id ||
      intent.profile != desired_.intent.profile || intent.retry_revision != desired_.intent.retry_revision) {
    capture_cancellation_.request_stop();
    capture_cancellation_ = std::stop_source{};
  }
  auto publication_epoch = desired_.publication_epoch;
  if (publishes(desired_.intent, desired_.room_generation) &&
      (!publishes(intent, room_generation) || desired_.room_generation != room_generation)) {
    ++publication_epoch;
    if (publication_) publication_->cancel();
  }
  desired_ = {revision, publication_epoch, intent, room_generation};
  if (publishes(intent, room_generation) || previews(intent)) snapshot_.stopped = false;
  if (publishes(intent, room_generation)) snapshot_.publication_stopped = false;
  changed_.notify_one();
}
void CameraOwner::beginStop() {
  std::lock_guard lock(mutex_);
  stopping_ = true;
  capture_cancellation_.request_stop();
  if (publication_) publication_->cancel();
  changed_.notify_one();
}
CameraOwnerSnapshot CameraOwner::snapshot() const {
  std::lock_guard lock(mutex_);
  return snapshot_;
}
CameraDeviceSnapshot CameraOwner::devices() const {
  std::lock_guard lock(mutex_);
  return devices_;
}
std::optional<CameraPreviewLease> CameraOwner::takePreview(const std::string& renderer_id) {
  {
    std::lock_guard lock(mutex_);
    if (stopping_ || !previews(desired_.intent) || desired_.intent.preview_renderer_id != renderer_id)
      return {};
  }
  std::lock_guard lock(preview_mutex_);
  if (!preview_ || preview_renderer_ != renderer_id) return {};
  return preview_->take();
}

void CameraOwner::run() noexcept {
  std::unique_ptr<CameraDeviceRegistry> registry;
  std::unique_ptr<CameraPipeline> pipeline;
  std::unique_ptr<CameraPreview> preview;
  std::shared_ptr<CameraPublication> publication;
  std::optional<std::uint64_t> publication_room;
  std::uint64_t publication_epoch = 0;
  Desired applied;
  bool selection_pending = false;
  std::uint64_t device_revision = 0;
  std::optional<EngineFailure> problem, preview_problem;
  const auto stopPublication = [&] {
    if (publication && !publication->stop(Clock::now() + kShutdownDeadline)) std::terminate();
    {
      std::lock_guard lock(mutex_);
      publication_.reset();
    }
    publication.reset();
    publication_room.reset();
  };
  const auto stopPreview = [&] {
    {
      std::lock_guard lock(preview_mutex_);
      preview_ = nullptr;
      preview_renderer_.reset();
    }
    if (preview && !preview->stop(Clock::now() + kShutdownDeadline)) std::terminate();
    preview.reset();
  };
  const auto stopPipeline = [&] {
    stopPublication();
    stopPreview();
    if (pipeline && !pipeline->stop(Clock::now() + kShutdownDeadline)) std::terminate();
    pipeline.reset();
  };
  try {
    registry = std::make_unique<CameraDeviceRegistry>(makeWindowsCameraDeviceEnumerator());
    auto catalog = registry->refresh();
    for (;;) {
      Desired desired;
      std::stop_token cancellation;
      {
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, std::chrono::milliseconds(20), [&] {
          return stopping_ || desired_.revision != applied.revision ||
              desired_.room_generation != applied.room_generation;
        });
        if (stopping_) break;
        desired = desired_;
        cancellation = capture_cancellation_.get_token();
      }
      if (registry->changed()) catalog = registry->refresh();
      const bool devices_changed = catalog.revision != device_revision;
      const auto previous_problem = problem;
      const auto previous_preview_problem = preview_problem;
      const bool retry = selection_pending || desired.intent.state != applied.intent.state ||
          desired.intent.device_id != applied.intent.device_id || desired.intent.profile != applied.intent.profile ||
          desired.intent.retry_revision != applied.intent.retry_revision || devices_changed;
      const bool changed = selection_pending || desired.intent != applied.intent ||
          desired.room_generation != applied.room_generation || devices_changed;
      const bool publish = publishes(desired.intent, desired.room_generation);
      const bool show_preview = previews(desired.intent);
      if (!pipeline && (publish || show_preview) && admission_.thumbnailActive()) {
        std::unique_lock lock(mutex_);
        snapshot_.path = {desired.revision, MediaPathState::Starting};
        snapshot_.preview_path = {desired.revision, show_preview ? MediaPathState::Starting : MediaPathState::Off};
        changed_.wait_for(lock, std::chrono::milliseconds(5));
        continue;
      }
      if (publication && (!publish || publication_room != desired.room_generation ||
          publication_epoch != desired.publication_epoch)) stopPublication();
      if (preview && (!show_preview || desired.intent.preview_renderer_id != applied.intent.preview_renderer_id))
        stopPreview();
      if (preview && preview_problem && desired.intent.retry_revision != applied.intent.retry_revision)
        stopPreview();
      if (retry) problem.reset();
      if ((desired.room_generation != applied.room_generation || desired.publication_epoch != applied.publication_epoch) && problem &&
          (problem->code == "camera_publish_failed" || problem->code == "camera_sender_failed"))
        problem.reset();
      if (retry || desired.intent.preview_renderer_id != applied.intent.preview_renderer_id) preview_problem.reset();
      if (!publish && !show_preview) {
        stopPipeline();
        problem.reset();
        preview_problem.reset();
      } else if (changed) {
        try {
          const auto check = [](CameraFailure failure) {
            if (failure != CameraFailure::none) throw failure;
          };
          if (!pipeline) pipeline = std::make_unique<CameraPipeline>();
          // Failed candidate selection retains the previous healthy capture.
          // Only relevant input/retry/catalog changes reopen that candidate.
          if (!problem || retry)
            check(pipeline->selectDevice(*registry, deviceId(desired.intent), profile(desired.intent), false, cancellation));
        } catch (CameraFailure) {
          problem = EngineFailure{"camera_input_failed", "Camera input transaction failed", "camera", true};
        } catch (...) {
          problem = EngineFailure{"camera_unavailable", "Camera settings could not be applied", "camera", true};
        }
        // Demand changes still apply to a healthy rollback capture when the
        // requested candidate failed. They do not spend another input retry.
        if (pipeline && (!problem || pipeline->stats().capture.state == CameraCaptureState::running) &&
            pipeline->setDemand(publish, show_preview, cancellation) != CameraFailure::none && !problem)
          problem = EngineFailure{"camera_input_failed", "Camera demand could not be applied", "camera", true};
      }
      if (cancellation.stop_requested()) {
        problem = previous_problem;
        preview_problem = previous_preview_problem;
        selection_pending = true;
        continue;
      }
      // Capture opening can block. Never install a publication for a Room or
      // demand which was superseded while that transaction was in progress.
      if (pipeline && pipeline->stats().capture.state == CameraCaptureState::running) {
        bool current_demand = false;
        {
          std::lock_guard lock(mutex_);
          current_demand = !stopping_ && desired_.intent == desired.intent &&
              desired_.room_generation == desired.room_generation && desired_.publication_epoch == desired.publication_epoch;
          if (current_demand && publish && !publication && !problem) {
            publication = std::make_shared<CameraPublication>(transport_, pipeline->publication(), pipeline->stats().capture.actual);
            publication_ = publication;
            publication_room = desired.room_generation;
            publication_epoch = desired.publication_epoch;
          }
        }
        if (publication && !publication->stats().published && publication->start() != CameraPublicationFailure::none) {
          stopPublication();
          problem = EngineFailure{"camera_publish_failed", "Camera publication failed", "camera", true};
        }
        if (current_demand && show_preview && !preview && !preview_problem) {
          try {
            preview = std::make_unique<CameraPreview>(pipeline->preview());
            std::lock_guard lock(preview_mutex_);
            preview_ = preview.get();
            preview_renderer_ = desired.intent.preview_renderer_id;
          } catch (...) {
            preview_problem = EngineFailure{"camera_preview_failed", "Camera preview could not start", "cameraPreview", true};
          }
        }
      }
      CameraOwnerSnapshot current;
      current.pipeline = pipeline ? pipeline->stats() : CameraPipelineStats{};
      current.publication = publication ? publication->stats() : CameraPublicationStats{};
      current.preview = preview ? preview->stats() : CameraPreviewStats{};
      if (current.publication.failure != CameraPublicationFailure::none) {
        problem = EngineFailure{"camera_sender_failed", "Camera publication stopped progressing", "camera", true};
        stopPublication();
      }
      if (current.pipeline.capture.state == CameraCaptureState::failed) {
        problem = EngineFailure{"camera_capture_failed", "Camera capture stopped progressing", "camera", true};
        stopPublication();
      }
      if (current.preview.failure != CameraPreviewFailure::none)
        preview_problem = EngineFailure{"camera_preview_failed", "Camera preview stopped progressing", "cameraPreview", true};
      const bool capturing = current.pipeline.capture.state == CameraCaptureState::running;
      const bool healthy = capturing && (!publish || (publication && current.publication.published));
      current.path = {desired.revision, !publish && !show_preview ?
          (desired.intent.state == CameraIntentState::on && desired.intent.publication ? MediaPathState::Starting : MediaPathState::Off) :
          problem && !healthy ? MediaPathState::Failed : healthy ? MediaPathState::Running : MediaPathState::Starting,
          problem, problem.has_value() && healthy};
      current.preview_path = {desired.revision, !show_preview ? MediaPathState::Off :
          preview_problem || (problem && !capturing) ? MediaPathState::Failed :
          preview && current.preview.submitted ? MediaPathState::Running : MediaPathState::Starting,
          preview_problem ? preview_problem : problem};
      current.publication_stopped = !publication;
      if (!publication) current.publication.published = false;
      current.stopped = !pipeline && !preview && !publication;
      {
        std::lock_guard lock(mutex_);
        if (cancellation.stop_requested()) {
          problem = previous_problem;
          preview_problem = previous_preview_problem;
          selection_pending = true;
          continue;
        }
        // Preserve admission flags for a newer desired slot until it is applied.
        if (desired_.intent != desired.intent || desired_.room_generation != desired.room_generation) {
          if (publishes(desired_.intent, desired_.room_generation)) current.publication_stopped = false;
          if (publishes(desired_.intent, desired_.room_generation) || previews(desired_.intent)) current.stopped = false;
        }
        snapshot_ = std::move(current);
        devices_ = catalog;
      }
      selection_pending = false;
      applied = std::move(desired);
      device_revision = catalog.revision;
    }
  } catch (...) {
    problem = EngineFailure{"camera_owner_failed", "Camera control owner failed", "camera", false};
  }
  stopPipeline();
  registry.reset();
  {
    std::lock_guard lock(mutex_);
    snapshot_ = {};
    if (problem) snapshot_.path = {applied.revision, MediaPathState::Failed, problem};
    done_ = true;
  }
  changed_.notify_all();
}
}  // namespace syrnike::windows_media::camera
