#include "screen/production_screen_pipeline.hpp"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace syrnike::windows_media::screen {
namespace {

std::chrono::milliseconds remaining(
    std::chrono::steady_clock::time_point deadline) noexcept {
  const auto now = std::chrono::steady_clock::now();
  if (deadline <= now) return std::chrono::milliseconds::zero();
  return std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
}

ScreenPublicationFailure encoderFailure(const HardwareH264Failure& failure) {
  return {failure.code, failure.message, failure.stage, false,
          failure.utility_epoch_retirement_required};
}

}  // namespace

ProductionScreenPipeline::ProductionScreenPipeline(
    std::shared_ptr<capture::D3d11DeviceOwner> device_owner,
    std::shared_ptr<ScreenFramePipeline> capture_pipeline,
    ScreenVideoProfile profile,
    ScreenPublicationAdapterFactory adapter_factory,
    ScreenPublicationDeadlines publication_deadlines, bool lab_frame_marker)
    : device_owner_(std::move(device_owner)),
      capture_pipeline_(std::move(capture_pipeline)),
      profile_(profile),
      adapter_factory_(std::move(adapter_factory)),
      publication_deadlines_(publication_deadlines),
      lab_frame_marker_(lab_frame_marker) {
  if (!capture_pipeline_ || !adapter_factory_)
    throw std::invalid_argument(
        "Production screen pipeline requires capture and adapter factory");
  createGeneration(profile);
}

void ProductionScreenPipeline::createGeneration(ScreenVideoProfile profile) {
  auto converter = std::make_unique<GpuScreenConverter>(device_owner_, profile, lab_frame_marker_);
  auto encoder = std::make_shared<HardwareH264Encoder>(device_owner_, profile);
  auto intents = std::make_shared<std::atomic_uint64_t>(1);
  const std::weak_ptr weak_intents(intents);
  auto adapter = adapter_factory_([weak_intents] {
    if (const auto active = weak_intents.lock()) active->fetch_add(1);
  });
  if (!adapter)
    throw std::invalid_argument(
        "Production screen adapter factory returned no adapter");
  auto sender = std::make_unique<ProductionScreenSender>(adapter, publication_deadlines_);
  std::scoped_lock lock(mutex_);
  converter_ = std::move(converter);
  encoder_ = std::move(encoder);
  adapter_ = std::move(adapter);
  sender_ = std::move(sender);
  keyframe_intents_ = std::move(intents);
  keyframes_.begin(stats_.profile_generation);
  profile_ = profile;
  stats_.adapter_luid = device_owner_->adapterLuid();
  stats_.memory.conversion_texture_bytes = converter_->stats().texture_bytes;
  stats_.memory.encoded_output_bytes = encoder_->stats().output_pool_bytes;
}

ProductionScreenPipeline::~ProductionScreenPipeline() {
  (void)stop(std::chrono::steady_clock::now() + std::chrono::seconds(2));
  if (worker_.joinable()) std::terminate();
}

ScreenStartResult ProductionScreenPipeline::start(
    std::string track_name, std::chrono::milliseconds deadline) {
  {
    std::scoped_lock lock(mutex_);
    if (state_ != ProductionScreenPipelineState::idle) {
      return {false, generation_,
              ScreenPublicationFailure{
                  "screen_pipeline_invalid_state",
                  "Production screen pipeline is already active",
                  "screen_pipeline_start"}};
    }
    state_ = ProductionScreenPipelineState::starting;
    failure_.reset();
    published_ = false;
    stop_requested_ = false;
    last_encoder_timestamp_us_ = 0;
    track_name_ = std::move(track_name);
  }
  const auto started = startGeneration(deadline);
  if (started.ok) worker_ = std::thread([this] { run(); });
  return started;
}

ScreenStartResult ProductionScreenPipeline::startGeneration(std::chrono::milliseconds deadline) {
  if (const auto failure = encoder_->start(deadline)) {
    std::scoped_lock lock(mutex_);
    failure_ = encoderFailure(*failure);
    state_ = ProductionScreenPipelineState::failed;
    return {false, generation_, failure_};
  }
  {
    std::scoped_lock lock(mutex_);
    stats_.encoder_implementation = encoder_->transformName();
  }
  auto started = sender_->start(ScreenTrackDescriptor{
      track_name_, profile_.width, profile_.height,
      profile_.frames_per_second, profile_.bitrate});
  if (!started.ok) {
    (void)encoder_->stop(deadline);
    std::scoped_lock lock(mutex_);
    failure_ = started.failure;
    state_ = ProductionScreenPipelineState::failed;
    return started;
  }
  {
    std::scoped_lock lock(mutex_);
    generation_ = started.generation;
  }
  owns_preview_ = LocalScreenPreview::processPreview().beginPublication(started.generation);
  return started;
}

void ProductionScreenPipeline::handleEvent(
    ScreenPublicationEvent event) noexcept {
  std::scoped_lock lock(mutex_);
  if (event.generation != generation_) return;
  if (event.kind == ScreenPublicationEventKind::Published) {
    published_ = true;
    const bool superseded = stats_.adaptive_enabled && attempt_revision_ != stats_.desired_revision;
    if (!stop_requested_ && !failure_ && !superseded) {
      state_ = ProductionScreenPipelineState::running;
      stats_.applied_revision = attempt_revision_;
      stats_.reconfiguring = false;
    }
  } else if (event.kind == ScreenPublicationEventKind::SlotReleased &&
             event.slot < submitted_slots_.size()) {
    if (submitted_slots_[event.slot]) {
      const auto frame = submitted_slots_[event.slot]->frame();
      if (event.release_reason == ScreenSlotReleaseReason::Consumed)
        keyframes_.progress(stats_.profile_generation, frame.sequence, frame.keyframe);
      else if (event.release_reason == ScreenSlotReleaseReason::Superseded)
        keyframe_intents_->fetch_add(1);
    }
    submitted_slots_[event.slot].reset();
    ++stats_.slot_releases;
  } else if (event.kind == ScreenPublicationEventKind::Unpublished) {
    published_ = false;
  } else if (event.kind == ScreenPublicationEventKind::TerminalFailure) {
    failure_ = std::move(event.failure);
    state_ = ProductionScreenPipelineState::failed;
    stop_requested_ = true;
  }
}

void ProductionScreenPipeline::run() noexcept {
  try {
    while (true) {
      while (auto event = sender_->waitForEvent(std::chrono::milliseconds{0}))
        handleEvent(std::move(*event));
      bool stop = false;
      bool published = false;
      {
        std::scoped_lock lock(mutex_);
        stop = stop_requested_;
        published = published_;
        if (!stop && stats_.reconfiguring && std::chrono::steady_clock::now() >= profile_deadline_) {
          failure_ = ScreenPublicationFailure{"screen_profile_transition_deadline",
              "Profile drain, encoder start and publication exceeded the shared deadline", "screen_reconfigure", true};
          state_ = ProductionScreenPipelineState::failed;
          stop_requested_ = stop = true;
        }
      }
      if (stop) break;
      if (const auto failure = encoder_->failure()) {
        std::scoped_lock lock(mutex_);
        failure_ = encoderFailure(*failure);
        state_ = ProductionScreenPipelineState::failed;
        stop_requested_ = true;
        break;
      }
      if (!published) {
        std::this_thread::sleep_for(std::chrono::milliseconds{1});
        continue;
      }
      runAdaptiveControl();
      {
        std::scoped_lock lock(mutex_);
        if (stop_requested_ || !published_) continue;
      }
      const auto frame_interval_us =
          static_cast<std::int64_t>(1'000'000 / profile_.frames_per_second);

      while (sender_->stats().video_depth < kScreenPublicationVideoCapacity) {
        auto output = encoder_->takeEncoded();
        if (!output) break;
        const auto slot = output->slot();
        const auto view = output->frame();
        const auto publish_age_us = static_cast<std::uint64_t>((std::max)(
            screenSteadyTimestamp100ns() / 10 - view.timestamp_us, std::int64_t{0}));
        {
          std::scoped_lock lock(mutex_);
          stats_.publish_age_last_us = publish_age_us;
        }
        if (publish_age_us > 150'000) {
          output->release();
          keyframe_intents_->fetch_add(1);
          std::scoped_lock lock(mutex_);
          ++stats_.stale_encoded_drops;
          continue;
        }
        const auto result = sender_->submit(EncodedScreenFrame{
            generation_, slot, view.sequence,
            static_cast<std::uint64_t>((std::max)(view.timestamp_us,
                                                  std::int64_t{1})),
            view.keyframe,
            reinterpret_cast<const std::uint8_t*>(view.bytes.data()),
            view.bytes.size()});
        if (result == ScreenSubmitResult::Accepted) {
          std::scoped_lock lock(mutex_);
          submitted_slots_[slot] = std::move(*output);
        } else {
          std::scoped_lock lock(mutex_);
          ++stats_.publication_rejections;
          throw std::runtime_error("Encoded frame rejected by publication");
        }
      }

      auto capture = capture_pipeline_->waitForFrame(
          std::chrono::milliseconds{2});
      if (!capture) continue;
      const auto metadata = capture->metadata();
      // Fence leases acquired before drain but submitted after restart.
      if (metadata.capture_timestamp_100ns < minimum_capture_timestamp_100ns_) {
        capture->release();
        continue;
      }
      const auto capture_age_100ns =
          (std::max)(screenSteadyTimestamp100ns() -
                         metadata.capture_timestamp_100ns,
                     std::int64_t{0});
      const auto capture_age_us =
          static_cast<std::uint64_t>(capture_age_100ns / 10);
      {
        std::scoped_lock lock(mutex_);
        ++stats_.capture_frames;
        stats_.capture_age_last_us = capture_age_us;
        stats_.capture_age_max_us =
            (std::max)(stats_.capture_age_max_us, capture_age_us);
        stats_.memory.capture_texture_bytes =
            static_cast<std::uint64_t>(capture::kMaximumMonitorFrames) *
            metadata.width * metadata.height * 4ULL;
      }
      const auto timestamp_us = metadata.capture_timestamp_100ns / 10;
      if (last_encoder_timestamp_us_ != 0 &&
          timestamp_us - last_encoder_timestamp_us_ < frame_interval_us) {
        capture->release();
        std::scoped_lock lock(mutex_);
        ++stats_.frame_rate_drops;
        continue;
      }
      const auto d3d = capture->d3d11View();
      if (!d3d) {
        capture->release();
        std::scoped_lock lock(mutex_);
        ++stats_.missing_gpu_frames;
        continue;
      }
      auto converted = converter_->convert(*d3d, metadata);
      if (!converted) {
        std::scoped_lock lock(mutex_);
        ++stats_.conversion_drops;
        continue;
      }
      if (!encoder_->submit(std::move(*converted), timestamp_us,
                            frame_interval_us)) {
        std::scoped_lock lock(mutex_);
        ++stats_.encoder_rejections;
        continue;
      }
      last_encoder_timestamp_us_ = timestamp_us;
      if (owns_preview_) LocalScreenPreview::processPreview().offer(*d3d, metadata);
      capture->release();
    }
  } catch (const std::exception& error) {
    std::scoped_lock lock(mutex_);
    const auto removed_reason = device_owner_->removedReason();
    const bool device_lost = removed_reason == DXGI_ERROR_DEVICE_REMOVED ||
                             removed_reason == DXGI_ERROR_DEVICE_RESET ||
                             removed_reason == DXGI_ERROR_DEVICE_HUNG;
    if (!failure_) failure_ = ScreenPublicationFailure{
        device_lost ? "screen_d3d11_device_lost"
                    : "screen_pipeline_worker_failed",
        error.what(), device_lost ? "screen_gpu_device" : "screen_pipeline",
        false, device_lost};
    state_ = ProductionScreenPipelineState::failed;
    stop_requested_ = true;
  } catch (...) {
    std::scoped_lock lock(mutex_);
    if (!failure_) failure_ = ScreenPublicationFailure{
        "screen_pipeline_worker_failed",
        "Unknown production screen pipeline failure", "screen_pipeline"};
    state_ = ProductionScreenPipelineState::failed;
    stop_requested_ = true;
  }
  if (owns_preview_) LocalScreenPreview::processPreview().stopPublication();
  (void)capture_pipeline_->stop(std::chrono::steady_clock::now());
  if (sender_) (void)sender_->stop(generation_);
  {
    std::scoped_lock lock(mutex_);
    worker_done_ = true;
    worker_changed_.notify_all();
  }
}

ScreenCommandResult ProductionScreenPipeline::stop(
    std::chrono::steady_clock::time_point deadline) noexcept {
  {
    std::scoped_lock lock(mutex_);
    if (state_ == ProductionScreenPipelineState::idle ||
        (state_ == ProductionScreenPipelineState::stopped && worker_done_))
      return {true, std::nullopt};
    if (state_ != ProductionScreenPipelineState::failed)
      state_ = ProductionScreenPipelineState::stopping;
    stop_requested_ = true;
  }
  const bool capture_stopped = capture_pipeline_->stop(deadline);
  if (worker_.joinable()) {
    std::unique_lock lock(mutex_);
    if (!worker_changed_.wait_until(lock, deadline, [this] { return worker_done_; })) {
      failure_ = ScreenPublicationFailure{
          "screen_pipeline_worker_stop_timeout",
          "GPU worker requires utility epoch retirement", "screen_pipeline_stop",
          true, true};
      state_ = ProductionScreenPipelineState::failed;
      return {false, failure_};
    }
    lock.unlock();
    worker_.join();
  }
  return drainGeneration(deadline, capture_stopped);
}

ScreenCommandResult ProductionScreenPipeline::drainGeneration(
    std::chrono::steady_clock::time_point deadline, bool capture_stopped) noexcept {
  const auto generation = generation_;
  if (!encoder_ || !sender_) {
    const auto existing_failure = failure();
    return {capture_stopped && !existing_failure, existing_failure};
  }
  const bool encoder_stopped = encoder_->stop(remaining(deadline));
  // Stop can arrive between encoding and sender admission. These final queued
  // outputs were never borrowed by LiveKit; return them before reporting drain.
  if (encoder_stopped) {
    while (auto unsubmitted = encoder_->takeEncoded()) unsubmitted->release();
  }

  auto sender_stop = sender_->stop(generation);
  bool publication_stopped = sender_->state() == ScreenPublicationState::Idle;
  while (!publication_stopped && std::chrono::steady_clock::now() < deadline) {
    if (auto event = sender_->waitForEvent(
            (std::min)(remaining(deadline), std::chrono::milliseconds{10}))) {
      handleEvent(std::move(*event));
    }
    publication_stopped = sender_->state() == ScreenPublicationState::Idle;
    if (sender_->state() == ScreenPublicationState::Failed) break;
  }
  // Idle can be visible before the consumer has read the final release events.
  while (auto event = sender_->waitForEvent(std::chrono::milliseconds{0}))
    handleEvent(std::move(*event));
  const bool slots_released = std::all_of(
      submitted_slots_.begin(), submitted_slots_.end(),
      [](const auto& slot) { return !slot.has_value(); });
  const bool stopped = capture_stopped && encoder_stopped && sender_stop.ok &&
                       publication_stopped && slots_released;
  {
    std::scoped_lock lock(mutex_);
    stats_.capture = capture_pipeline_->stats();
    stats_.converter = converter_ ? converter_->stats() : GpuScreenConverterStats{};
    stats_.encoder = encoder_->stats();
    stats_.sender = sender_->stats();
    stats_.memory.conversion_texture_bytes = stats_.converter.texture_bytes;
    stats_.memory.encoded_output_bytes = stats_.encoder.output_pool_bytes;
    stats_.memory.total_bytes = stats_.memory.capture_texture_bytes +
                                stats_.memory.conversion_texture_bytes +
                                stats_.memory.encoded_output_bytes;
    if (stopped) {
      state_ = stats_.reconfiguring && !stop_requested_
          ? ProductionScreenPipelineState::starting : ProductionScreenPipelineState::stopped;
    } else if (!failure_) {
      failure_ = ScreenPublicationFailure{
          "screen_pipeline_stop_incomplete",
          slots_released
              ? "Production screen pipeline did not stop before its deadline"
              : "An in-flight SDK frame still requires utility epoch retirement",
          "screen_pipeline_stop", true, !slots_released};
      state_ = ProductionScreenPipelineState::failed;
    }
    if (!stopped && failure_) {
      state_ = ProductionScreenPipelineState::failed;
      const auto encoder_failure = encoder_->failure();
      failure_->utility_epoch_retirement_required |= !slots_released ||
          !capture_stopped || (encoder_failure &&
              encoder_failure->utility_epoch_retirement_required);
    }
  }
  return stopped ? ScreenCommandResult{true, std::nullopt}
                 : ScreenCommandResult{false, failure()};
}

ProductionScreenPipelineState ProductionScreenPipeline::state() const noexcept {
  std::scoped_lock lock(mutex_);
  return state_;
}

ProductionScreenPipelineStats ProductionScreenPipeline::stats() const noexcept {
  std::scoped_lock lock(mutex_);
  auto result = stats_;
  result.network = adapter_ ? adapter_->networkObservation() : OutgoingNetworkObservation{};
  result.preview = LocalScreenPreview::processPreview().stats();
  result.capture = capture_pipeline_->stats();
  result.converter = converter_ ? converter_->stats() : GpuScreenConverterStats{};
  result.encoder = encoder_ ? encoder_->stats() : HardwareH264EncoderStats{};
  result.sender = sender_ ? sender_->stats() : ProductionScreenSenderStats{};
  result.total_publication_consumed = retired_publication_consumed_ + result.sender.consumed;
  result.memory.conversion_texture_bytes = result.converter.texture_bytes;
  result.memory.encoded_output_bytes = encoder_ ? result.encoder.output_pool_bytes : 0;
  result.memory.total_bytes = result.memory.capture_texture_bytes +
                              result.memory.conversion_texture_bytes +
                              result.memory.encoded_output_bytes;
  return result;
}

std::optional<ScreenPublicationFailure> ProductionScreenPipeline::failure()
    const {
  std::scoped_lock lock(mutex_);
  return failure_;
}

}  // namespace syrnike::windows_media::screen
