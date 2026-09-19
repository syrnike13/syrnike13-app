#include "screen/screen_owner.hpp"

#include "capture/selecting_monitor_capture.hpp"
#include "capture/wgc_window_capture.hpp"
#include "capture/window_capture.hpp"
#include "sources/win32_source_enumerator.hpp"
#include "testing/product_fault_gate.hpp"

#include <algorithm>
#include <stdexcept>

namespace syrnike::windows_media::screen {
namespace {
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
bool publishes(const ScreenIntent& intent, std::optional<std::uint64_t> room) {
  return intent.state == ScreenIntentState::on && room.has_value();
}
bool videoChanged(const ScreenIntent& left, const ScreenIntent& right) {
  return left.state != right.state || left.source_id != right.source_id ||
      left.width != right.width || left.height != right.height || left.fps != right.fps ||
      left.bitrate != right.bitrate || left.retry_revision != right.retry_revision;
}
std::size_t preset(const ScreenIntent& intent) {
  for (std::size_t index = 0; index < kAdaptiveScreenProfiles.size(); ++index) {
    const auto& value = kAdaptiveScreenProfiles[index];
    if (intent.width == value.width && intent.height == value.height &&
        intent.fps == value.fps && intent.bitrate == value.target_bitrate)
      return index;
  }
  throw std::invalid_argument("Screen dimensions, FPS and bitrate must match a supported fixed preset");
}
EngineFailure pathFailure(const ScreenPublicationFailure& failure) {
  return {failure.code, failure.message, "screen", failure.retryable};
}
}  // namespace

ScreenOwner::ScreenOwner(std::shared_ptr<LiveKitRoomTransport> transport, capture::ThumbnailAdmission& admission)
    : transport_(std::move(transport)), admission_(admission) {
  if (!transport_) throw std::invalid_argument("Screen transport missing");
  worker_ = std::thread([this] { run(); });
}
ScreenOwner::~ScreenOwner() {
  stop();
}
void ScreenOwner::stop() {
  std::lock_guard join_lock(join_mutex_);
  beginStop();
  {
    std::unique_lock lock(mutex_);
    if (!changed_.wait_for(lock, kShutdownDeadline, [&] { return done_; })) std::terminate();
  }
  if (worker_.joinable()) worker_.join();
}
void ScreenOwner::apply(std::uint64_t revision, const ScreenIntent& intent,
                        std::optional<std::uint64_t> room_generation) {
  std::lock_guard lock(mutex_);
  if (stopping_ || done_ || revision < desired_.revision) return;
  auto epoch = desired_.publication_epoch;
  if (publishes(desired_.intent, desired_.room_generation) &&
      (!publishes(intent, room_generation) || desired_.room_generation != room_generation)) {
    ++epoch;
    if (pipeline_) pipeline_->requestStop();
    if (adapter_) adapter_->cancel();
  }
  desired_ = {revision, epoch, intent, room_generation};
  if (publishes(intent, room_generation)) {
    snapshot_.stopped = false;
    snapshot_.publication_stopped = false;
  }
  changed_.notify_one();
}
void ScreenOwner::beginStop() {
  std::lock_guard lock(mutex_);
  stopping_ = true;
  if (pipeline_) pipeline_->requestStop();
  if (adapter_) adapter_->cancel();
  changed_.notify_one();
}
ScreenOwnerSnapshot ScreenOwner::snapshot() const {
  std::lock_guard lock(mutex_);
  return snapshot_;
}
void ScreenOwner::querySources(std::uint64_t revision, sources::EnumerationOptions options) {
  std::lock_guard lock(mutex_);
  if (stopping_ || done_ || revision <= query_revision_) return;
  query_revision_ = revision;
  query_options_ = options;
  changed_.notify_one();
}
ScreenSourcesSnapshot ScreenOwner::sources() const {
  std::lock_guard lock(mutex_);
  return sources_;
}
std::shared_ptr<sources::SourceRegistry> ScreenOwner::sourceRegistry() const {
  std::lock_guard lock(mutex_);
  return registry_;
}
std::optional<PreviewFrame> ScreenOwner::takePreview(const std::string& renderer_id) {
  {
    std::lock_guard lock(mutex_);
    if (stopping_ || desired_.intent.state != ScreenIntentState::on ||
        desired_.intent.preview_renderer_id != renderer_id || active_preview_renderer_ != renderer_id) return {};
  }
  auto frame = LocalScreenPreview::processPreview().takeFrame();
  if (!frame) return {};
  bool current;
  {
    std::lock_guard lock(mutex_);
    current = !stopping_ && desired_.intent.state == ScreenIntentState::on &&
        desired_.intent.preview_renderer_id == renderer_id && active_preview_renderer_ == renderer_id;
  }
  if (current) return frame;
  (void)LocalScreenPreview::processPreview().release(frame->generation, frame->sequence, frame->slot);
  return {};
}
bool ScreenOwner::releasePreview(std::uint64_t generation, std::uint64_t sequence, std::uint32_t slot) {
  return LocalScreenPreview::processPreview().release(generation, sequence, slot);
}

void ScreenOwner::run() noexcept {
  std::shared_ptr<sources::SourceRegistry> registry;
  std::unique_ptr<capture::MonitorCapture> monitor;
  std::unique_ptr<capture::WindowCapture> window;
  std::shared_ptr<ScreenFramePipeline> frames;
  std::shared_ptr<ProductionScreenPipeline> pipeline;
  std::shared_ptr<LiveKitScreenPublicationAdapter> adapter;
  std::optional<SelectedScreenSource> selected;
  std::optional<SelectedScreenSource> desired_source;
  std::optional<EngineFailure> audio_target_failure;
  Desired applied, active;
  std::optional<EngineFailure> problem;
  std::uint64_t queried = 0, preview_revision = 0;
  std::optional<std::string> preview_renderer;
  const auto stopPipeline = [&] {
    if (pipeline) pipeline->requestStop();
    if (adapter) adapter->cancel();
    if (pipeline && !pipeline->stop(Clock::now() + kShutdownDeadline).ok) std::terminate();
    if (monitor && !monitor->stop(kShutdownDeadline).ok) std::terminate();
    if (window && !window->stop(kShutdownDeadline).ok) std::terminate();
    if (frames && !frames->stop(Clock::now() + kShutdownDeadline)) std::terminate();
    {
      std::lock_guard lock(mutex_);
      pipeline_.reset();
      adapter_.reset();
    }
    pipeline.reset();
    adapter.reset();
    monitor.reset();
    window.reset();
    frames.reset();
    selected.reset();
  };
  try {
    registry = std::make_shared<sources::SourceRegistry>(sources::createWin32SourceEnumerator());
    {
      auto initial = registry->enumerate();
      std::lock_guard lock(mutex_);
      sources_.enumeration = std::move(initial);
      registry_ = registry;
    }
    preview_revision = LocalScreenPreview::processPreview().stats().revision;
    for (;;) {
      Desired desired;
      std::uint64_t query_revision;
      sources::EnumerationOptions query_options;
      {
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, pipeline ? 2ms : 20ms, [&] {
          return stopping_ || desired_.revision != applied.revision ||
              desired_.publication_epoch != applied.publication_epoch ||
              desired_.room_generation != applied.room_generation || query_revision_ != queried;
        });
        if (stopping_) break;
        desired = desired_;
        query_revision = query_revision_;
        query_options = query_options_;
      }
      if (query_revision != queried) {
        auto enumeration = registry->enumerate(query_options);
        std::lock_guard lock(mutex_);
        sources_ = {query_revision, std::move(enumeration)};
        queried = query_revision;
      }
      const bool publish = publishes(desired.intent, desired.room_generation);
      if (!pipeline && publish && admission_.thumbnailActive()) {
        std::unique_lock lock(mutex_);
        snapshot_.path = {desired.revision, MediaPathState::Starting};
        snapshot_.preview_path = {desired.revision, desired.intent.preview_renderer_id ? MediaPathState::Starting : MediaPathState::Off};
        changed_.wait_for(lock, 5ms);
        continue;
      }
      const bool retry = videoChanged(desired.intent, applied.intent) ||
          desired.room_generation != applied.room_generation || desired.publication_epoch != applied.publication_epoch;
      if (retry) problem.reset();
      if (desired.intent.state != applied.intent.state ||
          desired.intent.source_id != applied.intent.source_id ||
          desired.intent.retry_revision != applied.intent.retry_revision ||
          desired.intent.audio_retry_revision != applied.intent.audio_retry_revision) {
        desired_source.reset();
        audio_target_failure.reset();
        if (desired.intent.state == ScreenIntentState::on) {
          try {
            const auto resolved = registry->resolve(desired.intent.source_id);
            if (resolved.status != sources::ResolveStatus::Available || !resolved.kind)
              throw EngineFailure{"screen_source_unavailable", "Select a current screen source", "screen", false};
            desired_source = SelectedScreenSource{desired.intent.source_id, *resolved.kind};
            if (*resolved.kind == sources::SourceKind::Window)
              desired_source->audio_target = audio::AudioProcessIdentity::fromWindow(*registry, desired.intent.source_id);
          } catch (const EngineFailure& failure) {
            audio_target_failure = failure;
          } catch (const std::exception& error) {
            audio_target_failure = EngineFailure{"screen_audio_target_unavailable", error.what(), "screenAudio", true};
          }
        }
      }
      const auto renderer = desired.intent.state == ScreenIntentState::on
          ? desired.intent.preview_renderer_id : std::nullopt;
      if (renderer != preview_renderer) {
        // A new renderer retires the prior lease epoch even if both demand on.
        if (preview_renderer) (void)LocalScreenPreview::processPreview().demand(++preview_revision, false);
        if (renderer) (void)LocalScreenPreview::processPreview().demand(++preview_revision, true);
        preview_renderer = renderer;
        std::lock_guard lock(mutex_);
        active_preview_renderer_ = renderer;
      }
      if (pipeline && (!publish || active.room_generation != desired.room_generation ||
          active.publication_epoch != desired.publication_epoch)) stopPipeline();
      if (!publish) {
        stopPipeline();
        problem.reset();
      } else if ((!pipeline || videoChanged(active.intent, desired.intent)) && retry) {
        bool replacing = false;
        try {
          // Validate a replacement before retiring the healthy publication.
          const auto selected_preset = preset(desired.intent);
          const auto resolved = registry->resolve(desired.intent.source_id);
          if (resolved.status != sources::ResolveStatus::Available || !resolved.kind)
            throw EngineFailure{"screen_source_unavailable", "Select a current screen source", "screen", false};
          SelectedScreenSource target{desired.intent.source_id, *resolved.kind};
          std::optional<sources::MonitorTargetToken> monitor_target;
          if (*resolved.kind == sources::SourceKind::Window) {
            if (desired_source) target.audio_target = desired_source->audio_target;
          }
          else {
            monitor_target = registry->resolveMonitorTarget(desired.intent.source_id).target;
            if (!monitor_target) throw std::runtime_error("Selected monitor source is unavailable");
          }
          stopPipeline();
          replacing = true;
          frames = std::make_shared<ScreenFramePipeline>();
          capture::CaptureStartResult started;
          if (*resolved.kind == sources::SourceKind::Monitor) {
            capture::SelectingMonitorOptions options;
            // Reach the selected platform boundary deterministically in fault builds.
            // Normal builds never read the test configuration.
            if (testing::productFaultSelected("dxgi-acquire-frame"))
              options.forced = capture::CaptureBackendKind::dxgi;
            else if (testing::productFaultSelected("wgc-monitor-frame-pool") ||
                     testing::productFaultSelected("wgc-monitor-start"))
              options.forced = capture::CaptureBackendKind::wgc;
            options.resolve_target = [monitor_target] { return monitor_target; };
            monitor = std::make_unique<capture::MonitorCapture>(*registry, desired.intent.source_id,
                capture::createSelectingMonitorCaptureBackend(std::move(options)));
            started = monitor->start();
          } else {
            window = std::make_unique<capture::WindowCapture>(*registry, desired.intent.source_id,
                capture::createWgcWindowCaptureBackend());
            started = window->start();
          }
          if (!started.ok) throw std::runtime_error(started.failure ? started.failure->message : "Screen capture failed to start");
          bool current;
          {
            std::lock_guard lock(mutex_);
            current = !stopping_ && !videoChanged(desired_.intent, desired.intent) &&
                desired_.room_generation == desired.room_generation && desired_.publication_epoch == desired.publication_epoch;
          }
          if (current) {
            const auto& p = kAdaptiveScreenProfiles[selected_preset];
            pipeline = std::make_shared<ProductionScreenPipeline>(capture::processD3d11Device(false), frames,
                ScreenVideoProfile{p.width, p.height, p.fps, p.target_bitrate},
                [this, &adapter](std::function<void()> keyframe) {
                  adapter = std::make_shared<LiveKitScreenPublicationAdapter>(transport_,
                      LiveKitScreenEncoderControls{std::move(keyframe)});
                  return adapter;
                });
            if (!pipeline->enableAdaptiveQuality(1U << selected_preset, selected_preset))
              throw std::runtime_error("Selected screen preset could not be admitted");
            {
              std::lock_guard lock(mutex_);
              current = !stopping_ && !videoChanged(desired_.intent, desired.intent) &&
                  desired_.room_generation == desired.room_generation && desired_.publication_epoch == desired.publication_epoch;
              if (current) {
                pipeline_ = pipeline;
                adapter_ = adapter;
              }
            }
            if (current) {
              const auto publication = pipeline->start("screen", 5s);
              if (!publication.ok) throw std::runtime_error(publication.failure ? publication.failure->message : "Screen publication failed");
              selected = std::move(target);
              active = desired;
            }
          }
          if (!current) stopPipeline();
        } catch (const EngineFailure& failure) {
          if (replacing) stopPipeline();
          problem = failure;
        } catch (const std::invalid_argument& error) {
          if (replacing) stopPipeline();
          problem = EngineFailure{"screen_preset_unsupported", error.what(), "screen", true};
        } catch (const std::exception& error) {
          if (replacing) stopPipeline();
          problem = EngineFailure{"screen_start_failed", error.what(), "screen", true};
        }
      }
      if (pipeline) {
        auto frame = monitor ? monitor->waitForFrame(0ms) : window->waitForFrame(0ms);
        if (frame) (void)frames->submit(std::move(*frame));
        if (window) {
          for (std::size_t count = 0; count < capture::kMaximumWindowEvents; ++count)
            if (!window->waitForEvent(0ms)) break;
        }
        const auto capture_failure = monitor ? monitor->terminalFailure() : window->terminalFailure();
        if (capture_failure)
          problem = EngineFailure{capture_failure->code, capture_failure->message, "screen", true};
        if (const auto failure = pipeline->failure()) problem = pathFailure(*failure);
        if (pipeline->state() == ProductionScreenPipelineState::failed || capture_failure) stopPipeline();
      }
      ScreenOwnerSnapshot current;
      if (pipeline) current.pipeline = pipeline->stats();
      else current.pipeline.preview = LocalScreenPreview::processPreview().stats();
      const bool running = pipeline && pipeline->state() == ProductionScreenPipelineState::running;
      current.path = {desired.revision, desired.intent.state == ScreenIntentState::off ? MediaPathState::Off :
          problem && !running ? MediaPathState::Failed : running ? MediaPathState::Running : MediaPathState::Starting,
          problem, problem.has_value() && running};
      if (current.pipeline.quality_warning) current.path.warning = true;
      const auto& preview = current.pipeline.preview;
      current.preview_path = {desired.revision, !renderer ? MediaPathState::Off :
          preview.state == PreviewState::degraded ? MediaPathState::Failed :
          preview.state == PreviewState::running ? MediaPathState::Running : MediaPathState::Starting};
      if (preview.state == PreviewState::degraded)
        current.preview_path.failure = EngineFailure{"screen_preview_failed", "Local screen preview is degraded", "screenPreview", true};
      current.selected_source = selected;
      current.desired_source = desired_source;
      current.audio_target_failure = audio_target_failure;
      current.publication_stopped = !pipeline && !monitor && !window && !frames;
      current.stopped = current.publication_stopped;
      {
        std::lock_guard lock(mutex_);
        if (publishes(desired_.intent, desired_.room_generation) &&
            (videoChanged(desired_.intent, desired.intent) || desired_.room_generation != desired.room_generation ||
             desired_.publication_epoch != desired.publication_epoch)) {
          current.stopped = false;
          current.publication_stopped = false;
        }
        snapshot_ = std::move(current);
      }
      applied = std::move(desired);
    }
  } catch (...) {
    problem = EngineFailure{"screen_owner_failed", "Screen control owner failed", "screen", false};
  }
  (void)LocalScreenPreview::processPreview().demand(++preview_revision, false);
  stopPipeline();
  registry.reset();
  {
    std::lock_guard lock(mutex_);
    snapshot_ = {};
    registry_.reset();
    if (problem) snapshot_.path = {applied.revision, MediaPathState::Failed, problem};
    done_ = true;
  }
  changed_.notify_all();
}
}  // namespace syrnike::windows_media::screen
