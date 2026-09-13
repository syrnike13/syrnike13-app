#include "core/windows_media_runtime.hpp"
#include "audio/livekit_screen_audio_session.hpp"

namespace syrnike::windows_media {
namespace {
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
bool sameAudio(const std::optional<audio::ScreenAudioIntent>& left,
               const std::optional<audio::ScreenAudioIntent>& right) {
  if (!left || !right) return !left && !right;
  return left->mode == right->mode && left->room_generation == right->room_generation &&
      left->bitrate == right->bitrate && left->target == right->target;
}
EngineFailure audioFailure(const audio::ScreenAudioFailure& failure) {
  using Code = audio::ScreenAudioFailureCode;
  const char* code = "screen_audio_failed";
  switch (failure.code) {
    case Code::unsupported: code = "screen_audio_unsupported"; break;
    case Code::invalid_target: code = "screen_audio_invalid_target"; break;
    case Code::target_exited: code = "screen_audio_target_exited"; break;
    case Code::activation_failed: code = "screen_audio_activation_failed"; break;
    case Code::activation_timeout: code = "screen_audio_activation_timeout"; break;
    case Code::device_lost: code = "screen_audio_device_lost"; break;
    case Code::format_unavailable: code = "screen_audio_format_unavailable"; break;
    case Code::capture_failed: code = "screen_audio_capture_failed"; break;
    case Code::stop_timeout: code = "screen_audio_stop_timeout"; break;
    case Code::invalid_state: code = "screen_audio_invalid_state"; break;
    case Code::publication_failed: code = "screen_audio_publication_failed"; break;
    case Code::publication_timeout: code = "screen_audio_publication_timeout"; break;
    case Code::cancelled: code = "screen_audio_cancelled"; break;
  }
  return {code, "Screen audio could not complete the requested operation", "screenAudio",
          !failure.utility_retirement_required};
}
}  // namespace

WindowsMediaRuntime::WindowsMediaRuntime()
    : mixer_(std::make_shared<audio::RemoteAudioMixerWorker>()),
      audio_(std::make_shared<audio::RemoteAudioTracks>(*mixer_)),
      video_(std::make_shared<video::RemoteVideoOwner>()),
      observer_(std::make_shared<ProductRoomObserver>(mixer_, audio_, video_)),
      transport_(std::make_shared<LiveKitRoomTransport>(observer_)),
      microphone_(catalog_.registry(), transport_),
      output_(catalog_.registry(), *mixer_, *audio_),
      camera_(transport_, thumbnail_admission_), screen_(transport_, thumbnail_admission_),
      thumbnails_(screen_, thumbnail_admission_),
      screen_audio_([transport = transport_] {
        return std::make_unique<audio::LiveKitScreenAudioSession>(transport);
      }), frames_(camera_, screen_, *video_) {
  // Leave room for camera preview and one bounded thumbnail job inside the
  // shared 8 MiB optional partition. This never changes the published preset.
  (void)screen::LocalScreenPreview::processPreview().configureSize(960, 540);
  snapshot_.stopped = false;
  worker_ = std::thread([this] { run(); });
}
WindowsMediaRuntime::~WindowsMediaRuntime() {
  beginStop();
  {
    std::unique_lock lock(mutex_);
    if (!changed_.wait_for(lock, kShutdownDeadline, [&] { return done_; })) std::terminate();
  }
  if (worker_.joinable()) worker_.join();
}
void WindowsMediaRuntime::apply(const EngineDesiredState& desired, std::optional<std::uint64_t> room) {
  std::lock_guard lock(mutex_);
  if (stopping_ || desired.revision < desired_.revision || (desired == desired_ && room == room_generation_)) return;
  // Deliver every revocation before replacing the slot, including off/on that
  // coalesces before the coordinator wakes. Publication actors fence commits.
  if (desired.camera.state == CameraIntentState::on || desired.screen.state == ScreenIntentState::on)
    thumbnail_admission_.requestPublication();
  microphone_.apply(desired.revision, desired.microphone, room, device_revision_, output_.snapshot().echo);
  output_.apply(desired.revision, desired.output, room.has_value(), device_revision_);
  camera_.apply(desired.revision, desired.camera, room);
  screen_.apply(desired.revision, desired.screen, room);
  video_->apply(desired.revision, desired.remote_video_demand, room.has_value());
  audio_->setScreenDemand(desired.remote_video_demand);
  frames_.apply(desired, room.has_value());
  if (room != room_generation_ || desired.screen.state == ScreenIntentState::off ||
      desired.screen.audio_mode == ScreenIntentAudioMode::none ||
      desired.screen.source_id != desired_.screen.source_id ||
      desired.screen.audio_mode != desired_.screen.audio_mode ||
      desired.screen.audio_bitrate != desired_.screen.audio_bitrate) {
    screen_audio_.applyDesired(++audio_revision_, {});
    audio_intent_.reset();
  }
  desired_ = desired;
  room_generation_ = room;
  snapshot_.publications_stopped = false;
  changed_.notify_one();
}
void WindowsMediaRuntime::beginStop() {
  std::lock_guard lock(mutex_);
  if (stopping_) return;
  stopping_ = true;
  snapshot_.publications_stopped = false;
  frames_.beginStop();
  thumbnails_.beginStop();
  microphone_.beginStop();
  camera_.beginStop();
  screen_.beginStop();
  screen_audio_.beginStop();
  output_.beginStop();
  audio_->beginStop();
  video_->beginStop();
  changed_.notify_all();
}
MediaRuntimeSnapshot WindowsMediaRuntime::snapshot() const {
  std::lock_guard lock(mutex_);
  return snapshot_;
}
void WindowsMediaRuntime::updateScreenAudio(const screen::ScreenOwnerSnapshot& screen) {
  // Preview and renderer revisions do not revoke process audio. Wait for the
  // screen owner to resolve the current revision instead of treating its older
  // snapshot as a missing target. Actual source/Room revocations happen in apply.
  if (room_generation_ && desired_.screen.state == ScreenIntentState::on &&
      desired_.screen.audio_mode == ScreenIntentAudioMode::process &&
      screen.path.revision != desired_.revision) return;
  std::optional<audio::ScreenAudioIntent> next;
  audio_target_failure_.reset();
  if (room_generation_ && desired_.screen.state == ScreenIntentState::on &&
      desired_.screen.audio_mode != ScreenIntentAudioMode::none) {
    std::shared_ptr<audio::AudioProcessIdentity> target;
    const bool system = desired_.screen.audio_mode == ScreenIntentAudioMode::system;
    if (system) {
      target = client_process_;
      if (!target) audio_target_failure_ = EngineFailure{"screen_audio_invalid_target",
          "Client process identity is unavailable", "screenAudio", false};
    } else if (screen.path.revision == desired_.revision) {
      // Preserve audio for a healthy video rollback; otherwise use the resolved
      // requested source even when capture or publication failed.
      const auto& source = screen.path.state == MediaPathState::Running && screen.selected_source
          ? screen.selected_source : screen.desired_source;
      if (source) target = source->audio_target;
      if (!target) audio_target_failure_ = screen.audio_target_failure.value_or(EngineFailure{
          "screen_audio_invalid_target", "Process audio requires an available window source", "screenAudio", true});
    }
    if (target) next = audio::ScreenAudioIntent{
        system ? audio::ScreenAudioMode::system_exclude_client : audio::ScreenAudioMode::include_process_tree,
        std::move(target), *room_generation_, static_cast<std::uint32_t>(desired_.screen.audio_bitrate)};
  }
  if (!sameAudio(next, audio_intent_) || audio_retry_revision_ != desired_.screen.audio_retry_revision) {
    screen_audio_.applyDesired(++audio_revision_, next);
    audio_intent_ = std::move(next);
    audio_retry_revision_ = desired_.screen.audio_retry_revision;
  }
}
void WindowsMediaRuntime::run() noexcept {
  try {
    client_process_ = audio::AudioProcessIdentity::parent();
    std::shared_ptr<audio::EchoReferencePort> echo;
    for (;;) {
      std::unique_lock lock(mutex_);
      changed_.wait_for(lock, 10ms);
      if (stopping_) break;
      const auto devices = catalog_.snapshot();
      const auto output = output_.snapshot();
      if (device_revision_ != devices.revision || echo != output.echo) {
        device_revision_ = devices.revision;
        echo = output.echo;
        microphone_.apply(desired_.revision, desired_.microphone, room_generation_, device_revision_, echo);
        output_.apply(desired_.revision, desired_.output, room_generation_.has_value(), device_revision_);
      }
      const auto microphone = microphone_.snapshot();
      const auto camera = camera_.snapshot();
      const auto screen = screen_.snapshot();
      if (desired_.camera.state == CameraIntentState::off && desired_.screen.state == ScreenIntentState::off &&
          camera.stopped && screen.stopped) thumbnail_admission_.publicationDrained();
      const auto video = video_->snapshot();
      if (!desired_.remote_video_demand.empty()) snapshot_.remote_video_metrics = video.metrics;
      else snapshot_.remote_video_metrics.reset();
      updateScreenAudio(screen);
      const auto audio = screen_audio_.stats();
      if (audio.failure && audio.failure->utility_retirement_required)
        snapshot_.failure = EngineFailure{"screen_audio_requires_restart",
            "Screen audio SDK work exceeded its completion deadline", "screenAudio", true};
      if (audio.state == audio::ScreenAudioState::running || audio.state == audio::ScreenAudioState::failed) {
        const auto& metrics = audio.session;
        snapshot_.screen_audio_metrics = std::array<DiagnosticMetric, 12>{{
            {"captured", static_cast<double>(metrics.captured)},
            {"submitted", static_cast<double>(metrics.submitted)},
            {"silent", static_cast<double>(metrics.silent_packets)},
            {"invalid_timestamps", static_cast<double>(metrics.invalid_timestamps)},
            {"stale", static_cast<double>(metrics.stale_packets)},
            {"superseded", static_cast<double>(metrics.superseded_packets)},
            {"queue_depth", static_cast<double>(metrics.queue_depth)},
            {"maximum_submit_age_us", static_cast<double>(metrics.maximum_submit_age_us)},
            {"peak_sample", static_cast<double>(metrics.peak_sample)},
            {"client_process_id", static_cast<double>(client_process_ ? client_process_->pid() : 0)},
            {"producer_process_id", static_cast<double>(GetCurrentProcessId())},
            {"maximum_callback_wait_us", static_cast<double>(metrics.maximum_callback_wait_us)},
        }};
      } else snapshot_.screen_audio_metrics.reset();
      const bool wants_audio = desired_.screen.state == ScreenIntentState::on &&
          desired_.screen.audio_mode != ScreenIntentAudioMode::none;
      MediaPathSnapshot audio_path{desired_.revision, !wants_audio ? MediaPathState::Off :
          audio_target_failure_ ? MediaPathState::Failed :
          audio.state == audio::ScreenAudioState::running ? MediaPathState::Running :
          audio.state == audio::ScreenAudioState::failed ? MediaPathState::Failed : MediaPathState::Starting};
      if (wants_audio) {
        audio_path.failure = audio_target_failure_;
        if (!audio_path.failure && audio.state == audio::ScreenAudioState::failed && audio.failure)
          audio_path.failure = audioFailure(*audio.failure);
      }
      if (desired_.camera.state == CameraIntentState::on) {
        snapshot_.camera_metrics = std::array<DiagnosticMetric, 13>{{
          {"capture_frames", static_cast<double>(camera.pipeline.capture.frames)},
          {"capture_stale", static_cast<double>(camera.pipeline.capture.stale)},
          {"capture_failure", static_cast<double>(camera.pipeline.capture.failure)},
          {"forwarded", static_cast<double>(camera.pipeline.forwarded)},
          {"preview_accepted", static_cast<double>(camera.pipeline.preview.accepted)},
          {"preview_submitted", static_cast<double>(camera.preview.submitted)},
          {"preview_delivered", static_cast<double>(camera.preview.delivered)},
          {"preview_dropped", static_cast<double>(camera.preview.dropped)},
          {"preview_outstanding", static_cast<double>(camera.preview.outstanding)},
          {"preview_quarantined", static_cast<double>(camera.preview.quarantined)},
          {"preview_failure", static_cast<double>(camera.preview.failure)},
          {"publication_submitted", static_cast<double>(camera.publication.submitted)},
          {"publication_failure", static_cast<double>(camera.publication.failure)},
        }};
      } else snapshot_.camera_metrics.reset();
      if (desired_.microphone.state == MicrophoneIntentState::on) {
        snapshot_.microphone_metrics = std::array<DiagnosticMetric, 7>{{
          {"published", microphone.sender.published ? 1.0 : 0.0},
          {"submitted", static_cast<double>(microphone.sender.submitted)},
          {"failure", static_cast<double>(microphone.sender.failure)},
          {"rejected_stale", static_cast<double>(microphone.sender.rejected_stale)},
          {"maximum_frame_age_us", static_cast<double>(microphone.sender.maximum_frame_age_us)},
          {"maximum_callback_wait_us", static_cast<double>(microphone.sender.maximum_callback_wait_us)},
          {"pending_frames", static_cast<double>(microphone.sender.pending_frames)},
        }};
      } else snapshot_.microphone_metrics.reset();
      snapshot_.paths = {microphone.path, camera.path, screen.path, output.path,
                         audio_path, screen.preview_path, camera.preview_path, video.path};
      const bool audio_stopped = !audio_intent_ &&
          (audio.state == audio::ScreenAudioState::idle || audio.state == audio::ScreenAudioState::stopped) &&
          audio.desired_revision == audio_revision_;
      snapshot_.publications_stopped = microphone.publication_stopped && camera.publication_stopped &&
          screen.publication_stopped && audio_stopped;
    }
  } catch (...) {
    // A broken coordinator cannot acknowledge publication teardown or accept
    // further intent. The supervised utility process contains this fatal fault.
    std::terminate();
  }
  microphone_.stop();
  thumbnails_.stop();
  camera_.stop();
  screen_.stop();
  if (!screen_audio_.stop(Clock::now() + kShutdownDeadline)) std::terminate();
  output_.stop();
  audio_->stop();
  video_->stop();
  frames_.stop();
  if (!mixer_->stop(Clock::now() + kShutdownDeadline)) std::terminate();
  {
    std::lock_guard lock(mutex_);
    snapshot_ = {};
    for (auto& path : snapshot_.paths) path.revision = desired_.revision;
    done_ = true;
  }
  changed_.notify_all();
}
}  // namespace syrnike::windows_media
