#include "screen/production_screen_pipeline.hpp"

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace syrnike::windows_media::screen {
namespace {

std::chrono::milliseconds remaining(std::chrono::steady_clock::time_point deadline) noexcept {
  const auto now = std::chrono::steady_clock::now();
  if (deadline <= now) return std::chrono::milliseconds::zero();
  return std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
}

// A resized window settles this long before the stream changes size; while it
// is dragged, frames are letterboxed into the current size.
constexpr auto kOutputResizeSettle = std::chrono::milliseconds{500};

// A static screen is re-encoded this often, so a viewer who joins (or loses a
// packet) while nothing moves still gets a keyframe without waiting for motion.
constexpr std::int64_t kStaticRepeatIntervalUs = 250'000;

std::uint32_t alignedSide(double value, std::uint32_t limit) noexcept {
  if (value + 0.5 >= limit) return limit;
  return (std::max)(static_cast<std::uint32_t>(value) & ~7U, 64U);
}

ScreenPublicationFailure encoderFailure(const HardwareH264Failure& failure) {
  return {failure.code, failure.message, failure.stage, false,
          failure.utility_epoch_retirement_required};
}

}  // namespace

ScreenVideoProfile fitScreenOutput(ScreenVideoProfile box, std::uint32_t width,
                                   std::uint32_t height) noexcept {
  if (width < 2 || height < 2 || !box.width || !box.height) return box;
  const double fit = (std::min)(static_cast<double>(box.width) / width,
                                static_cast<double>(box.height) / height);
  const double longest = (std::max)(width, height);
  const double scale = (std::min)(fit, (std::max)(1.0, 320.0 / longest));
  box.width = alignedSide(width * scale, box.width);
  box.height = alignedSide(height * scale, box.height);
  return box;
}

ProductionScreenPipeline::ProductionScreenPipeline(
    std::shared_ptr<capture::D3d11DeviceOwner> device_owner,
    std::shared_ptr<ScreenFramePipeline> capture_pipeline, ScreenVideoProfile profile,
    ScreenPublicationAdapterFactory adapter_factory,
    ScreenPublicationDeadlines publication_deadlines, bool lab_frame_marker)
    : device_owner_(std::move(device_owner)),
      capture_pipeline_(std::move(capture_pipeline)),
      profile_(profile),
      adapter_factory_(std::move(adapter_factory)),
      publication_deadlines_(publication_deadlines),
      lab_frame_marker_(lab_frame_marker) {
  if (!capture_pipeline_ || !adapter_factory_)
    throw std::invalid_argument("Production screen pipeline requires capture and adapter factory");
  createGeneration(profile);
}

void ProductionScreenPipeline::createGeneration(ScreenVideoProfile profile) {
  const auto output = fitScreenOutput(profile, source_width_, source_height_);
  auto converter = std::make_unique<GpuScreenConverter>(device_owner_, output, lab_frame_marker_);
  auto encoder = std::make_shared<HardwareH264Encoder>(device_owner_, output);
  auto intents = std::make_shared<std::atomic_uint64_t>(1);
  const std::weak_ptr weak_intents(intents);
  auto adapter = adapter_factory_([weak_intents] {
    if (const auto active = weak_intents.lock()) active->fetch_add(1);
  });
  if (!adapter)
    throw std::invalid_argument("Production screen adapter factory returned no adapter");
  auto sender = std::make_unique<ProductionScreenSender>(adapter, publication_deadlines_);
  std::scoped_lock lock(mutex_);
  converter_ = std::move(converter);
  encoder_ = std::move(encoder);
  adapter_ = std::move(adapter);
  sender_ = std::move(sender);
  keyframe_intents_ = std::move(intents);
  keyframes_.begin(stats_.profile_generation);
  encoded_continuity_ = {};
  profile_ = profile;
  output_ = output;
  pending_output_.reset();
  stats_.adapter_luid = device_owner_->adapterLuid();
  stats_.memory.conversion_texture_bytes = converter_->stats().texture_bytes;
  stats_.memory.encoded_output_bytes = encoder_->stats().output_pool_bytes;
}

void ProductionScreenPipeline::setInitialSourceSize(std::uint32_t width, std::uint32_t height) {
  {
    std::scoped_lock lock(mutex_);
    if (state_ != ProductionScreenPipelineState::idle) return;
  }
  source_width_ = width;
  source_height_ = height;
  const auto output = fitScreenOutput(profile_, width, height);
  if (output.width == output_.width && output.height == output_.height) return;
  auto converter = std::make_unique<GpuScreenConverter>(device_owner_, output, lab_frame_marker_);
  auto encoder = std::make_shared<HardwareH264Encoder>(device_owner_, output);
  std::scoped_lock lock(mutex_);
  converter_ = std::move(converter);
  encoder_ = std::move(encoder);
  output_ = output;
  stats_.memory.conversion_texture_bytes = converter_->stats().texture_bytes;
}

ProductionScreenPipeline::~ProductionScreenPipeline() {
  (void)stop(std::chrono::steady_clock::now() + std::chrono::seconds(2));
  if (worker_.joinable()) std::terminate();
}

void ProductionScreenPipeline::requestStop() noexcept { cancellation_requested_ = true; }

ScreenStartResult ProductionScreenPipeline::start(std::string track_name,
                                                  std::chrono::milliseconds deadline) {
  {
    std::scoped_lock lock(mutex_);
    if (state_ != ProductionScreenPipelineState::idle) {
      return {false, generation_,
              ScreenPublicationFailure{"screen_pipeline_invalid_state",
                                       "Production screen pipeline is already active",
                                       "screen_pipeline_start"}};
    }
    state_ = ProductionScreenPipelineState::starting;
    failure_.reset();
    published_ = false;
    stop_requested_ = false;
    cadence_.reset();
    track_name_ = std::move(track_name);
  }
  const auto started = startGeneration(deadline);
  if (!started.ok) return started;
  requestStartBitrate();
  worker_ = std::thread([this] { run(); });
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
    stats_.bitrate = encoder_->bitrateUpdate();
    stats_.target_bitrate = profile_.bitrate;
    stats_.quality_warning = false;
  }
  auto started = sender_->start(ScreenTrackDescriptor{
      track_name_, output_.width, output_.height, profile_.frames_per_second, profile_.bitrate});
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

void ProductionScreenPipeline::handleEvent(ScreenPublicationEvent event) noexcept {
  std::scoped_lock lock(mutex_);
  if (event.generation != generation_) return;
  if (event.kind == ScreenPublicationEventKind::Published) {
    published_ = true;
    const bool superseded = stats_.adaptive_enabled && attempt_revision_ != stats_.desired_revision;
    if (!stop_requested_ && !cancellation_requested_ && !failure_ && !superseded) {
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
    stats_.quality_warning = false;
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
        stop = stop_requested_ || cancellation_requested_;
        published = published_;
        if (!stop && stats_.reconfiguring &&
            std::chrono::steady_clock::now() >= profile_deadline_) {
          failure_ = ScreenPublicationFailure{
              "screen_profile_transition_deadline",
              "Profile drain, encoder start and publication exceeded the shared deadline",
              "screen_reconfigure", true};
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
        if (stop_requested_ || cancellation_requested_ || !published_) continue;
      }
      const auto frame_interval_us =
          static_cast<std::int64_t>(1'000'000 / profile_.frames_per_second);
      // Below the preset floor the policy admits fewer frames; each keeps the
      // nominal duration the encoder's per-frame budget is configured for.
      const auto admission_interval_us =
          screenAdmissionIntervalUs(admitted_fps_, profile_.frames_per_second);

      while (sender_->stats().video_depth < kScreenPublicationVideoCapacity) {
        auto output = encoder_->takeEncoded();
        if (!output) break;
        const auto slot = output->slot();
        const auto view = output->frame();
        const auto publish_age_us = static_cast<std::uint64_t>(
            (std::max)(screenSteadyTimestamp100ns() / 10 - view.timestamp_us, std::int64_t{0}));
        {
          std::scoped_lock lock(mutex_);
          stats_.publish_age_last_us = publish_age_us;
        }
        const auto admission = encoded_continuity_.admit(view.keyframe, publish_age_us);
        if (admission != EncodedFrameAdmission::publish) {
          output->release();
          if (admission == EncodedFrameAdmission::stale) keyframe_intents_->fetch_add(1);
          std::scoped_lock lock(mutex_);
          if (admission == EncodedFrameAdmission::stale)
            ++stats_.stale_encoded_drops;
          else
            ++stats_.dependent_encoded_drops;
          continue;
        }
        const auto result = sender_->submit(EncodedScreenFrame{
            generation_, slot, view.sequence,
            static_cast<std::uint64_t>((std::max)(view.timestamp_us, std::int64_t{1})),
            view.keyframe, reinterpret_cast<const std::uint8_t*>(view.bytes.data()),
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

      auto capture = capture_pipeline_->waitForFrame(std::chrono::milliseconds{2});
      if (!capture) {
        repeatLastFrame();
        continue;
      }
      const auto metadata = capture->metadata();
      // Fence leases acquired before drain but submitted after restart.
      if (metadata.capture_timestamp_100ns < minimum_capture_timestamp_100ns_) {
        capture->release();
        continue;
      }
      const auto capture_age_100ns =
          (std::max)(screenSteadyTimestamp100ns() - metadata.capture_timestamp_100ns,
                     std::int64_t{0});
      const auto capture_age_us = static_cast<std::uint64_t>(capture_age_100ns / 10);
      {
        std::scoped_lock lock(mutex_);
        ++stats_.capture_frames;
        stats_.capture_age_last_us = capture_age_us;
        stats_.capture_age_max_us = (std::max)(stats_.capture_age_max_us, capture_age_us);
        stats_.memory.capture_texture_bytes =
            static_cast<std::uint64_t>(capture::kMaximumMonitorFrames) * metadata.width *
            metadata.height * 4ULL;
      }
      followSourceSize(metadata.width, metadata.height);
      const auto timestamp_us = metadata.capture_timestamp_100ns / 10;
      const auto d3d = capture->d3d11View();
      if (!d3d) {
        capture->release();
        std::scoped_lock lock(mutex_);
        ++stats_.missing_gpu_frames;
        continue;
      }
      if (owns_preview_) LocalScreenPreview::processPreview().offer(*d3d, metadata);
      const auto now_ms = static_cast<std::uint64_t>(
          std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::steady_clock::now().time_since_epoch()).count());
      if (adapter_ && screenPacketQueueBackpressured(adapter_->networkObservation(), now_ms)) {
        capture->release();
        std::scoped_lock lock(mutex_);
        ++stats_.network_backpressure_drops;
        continue;
      }
      if (!cadence_.due(timestamp_us, admission_interval_us)) {
        capture->release();
        std::scoped_lock lock(mutex_);
        ++stats_.frame_rate_drops;
        continue;
      }
      auto converted = converter_->convert(*d3d, metadata);
      if (!converted) {
        std::scoped_lock lock(mutex_);
        ++stats_.conversion_drops;
        continue;
      }
      if (!encoder_->submit(std::move(*converted), timestamp_us, frame_interval_us)) {
        std::scoped_lock lock(mutex_);
        ++stats_.encoder_rejections;
        continue;
      }
      cadence_.accepted(timestamp_us, admission_interval_us);
      last_submit_us_ = timestamp_us;
      keepForRepeat(*d3d, metadata);
      capture->release();
    }
  } catch (const std::exception& error) {
    std::scoped_lock lock(mutex_);
    const auto removed_reason = device_owner_->removedReason();
    const bool device_lost = removed_reason == DXGI_ERROR_DEVICE_REMOVED ||
                             removed_reason == DXGI_ERROR_DEVICE_RESET ||
                             removed_reason == DXGI_ERROR_DEVICE_HUNG;
    if (!failure_)
      failure_ = ScreenPublicationFailure{
          device_lost ? "screen_d3d11_device_lost" : "screen_pipeline_worker_failed", error.what(),
          device_lost ? "screen_gpu_device" : "screen_pipeline", false, device_lost};
    state_ = ProductionScreenPipelineState::failed;
    stop_requested_ = true;
  } catch (...) {
    std::scoped_lock lock(mutex_);
    if (!failure_)
      failure_ =
          ScreenPublicationFailure{"screen_pipeline_worker_failed",
                                   "Unknown production screen pipeline failure", "screen_pipeline"};
    state_ = ProductionScreenPipelineState::failed;
    stop_requested_ = true;
  }
  repeat_texture_.Reset();
  if (owns_preview_) LocalScreenPreview::processPreview().stopPublication();
  (void)capture_pipeline_->stop(std::chrono::steady_clock::now());
  if (sender_) (void)sender_->stop(generation_);
  {
    std::scoped_lock lock(mutex_);
    worker_done_ = true;
    worker_changed_.notify_all();
  }
}

void ProductionScreenPipeline::followSourceSize(std::uint32_t width, std::uint32_t height) {
  source_width_ = width;
  source_height_ = height;
  const auto wanted = fitScreenOutput(profile_, width, height);
  if (wanted.width == output_.width && wanted.height == output_.height) {
    pending_output_.reset();
    return;
  }
  const auto now = std::chrono::steady_clock::now();
  if (!pending_output_ || pending_output_->width != wanted.width ||
      pending_output_->height != wanted.height) {
    pending_output_ = wanted;
    pending_output_since_ = now;
    return;
  }
  if (now - pending_output_since_ < kOutputResizeSettle) return;
  if (resizeOutput(wanted)) pending_output_.reset();
}

// Replaces the converter and encoder on the same publication. The H.264
// stream changes size on its next (key) frame; viewers keep their track.
bool ProductionScreenPipeline::resizeOutput(ScreenVideoProfile output) {
  // Encoded slot indices are reused by the next encoder: wait until the SDK
  // has returned every borrowed access unit of this one.
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds{500};
  const auto borrowed = [this] {
    return std::any_of(submitted_slots_.begin(), submitted_slots_.end(),
                       [](const auto& slot) { return slot.has_value(); });
  };
  while (borrowed() && std::chrono::steady_clock::now() < deadline) {
    if (auto event = sender_->waitForEvent(std::chrono::milliseconds{5}))
      handleEvent(std::move(*event));
  }
  if (borrowed()) return false;
  auto converter = std::make_unique<GpuScreenConverter>(device_owner_, output, lab_frame_marker_);
  auto encoder = std::make_shared<HardwareH264Encoder>(device_owner_, output);
  if (const auto failure = encoder->start(std::chrono::milliseconds{3000}))
    throw std::runtime_error(failure->message);
  if (!encoder_->stop(std::chrono::milliseconds{500}))
    throw std::runtime_error("Screen encoder did not drain before a resize");
  while (auto unsubmitted = encoder_->takeEncoded()) unsubmitted->release();
  std::shared_ptr<HardwareH264Encoder> old_encoder;
  {
    std::scoped_lock lock(mutex_);
    old_encoder = std::exchange(encoder_, std::move(encoder));
    converter_ = std::move(converter);
    output_ = output;
    stats_.memory.conversion_texture_bytes = converter_->stats().texture_bytes;
    keyframes_.begin(stats_.profile_generation);
    encoded_continuity_ = {};
    cadence_.reset();
    ++stats_.output_resizes;
  }
  previous_policy_stats_.reset();
  // The new encoder starts at the preset bitrate; keep the adapted one.
  bitrate_completed_ = bitrate_command_;
  if (stats_.target_bitrate && stats_.target_bitrate != profile_.bitrate &&
      encoder_->requestBitrate(bitrate_command_ + 1, stats_.target_bitrate))
    ++bitrate_command_;
  // A frame rate waiting for the old encoder's confirmation now pairs with the
  // command re-issued to the new one, or applies with its preset bitrate.
  if (pending_fps_) {
    if (bitrate_command_ != bitrate_completed_) {
      pending_fps_->revision = bitrate_command_;
    } else {
      admitted_fps_ = pending_fps_->frame_rate;
      pending_fps_.reset();
      std::scoped_lock lock(mutex_);
      stats_.admitted_fps = admitted_fps_;
    }
  }
  return true;
}

void ProductionScreenPipeline::keepForRepeat(const capture::D3d11FrameView& frame,
                                             const capture::FrameMetadata& metadata) {
  D3D11_TEXTURE2D_DESC source{};
  frame.texture->GetDesc(&source);
  if (!repeat_texture_ || repeat_metadata_.width != metadata.width ||
      repeat_metadata_.height != metadata.height) {
    repeat_texture_.Reset();
    D3D11_TEXTURE2D_DESC description{};
    description.Width = metadata.width;
    description.Height = metadata.height;
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = source.Format;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_DEFAULT;
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    if (FAILED(device_owner_->device()->CreateTexture2D(&description, nullptr, &repeat_texture_)))
      return;
  }
  const D3D11_BOX box{0, 0, 0, metadata.width, metadata.height, 1};
  std::lock_guard context_lock(device_owner_->contextMutex());
  device_owner_->context()->CopySubresourceRegion(repeat_texture_.Get(), 0, 0, 0, 0, frame.texture,
                                                  0, &box);
  repeat_metadata_ = metadata;
}

void ProductionScreenPipeline::setPaused(bool paused) {
  if (paused_.exchange(paused) == paused) return;
  std::shared_ptr<ScreenPublicationAdapter> adapter;
  {
    std::scoped_lock lock(mutex_);
    adapter = adapter_;
    // A viewer who joined during the pause has no picture yet.
    if (!paused && keyframe_intents_) keyframe_intents_->fetch_add(1);
  }
  if (adapter) adapter->setPaused(paused);
}

void ProductionScreenPipeline::repeatLastFrame() {
  if (!repeat_texture_ || paused_.load()) return;
  const auto now_us = screenSteadyTimestamp100ns() / 10;
  if (now_us - last_submit_us_ < kStaticRepeatIntervalUs) return;
  const auto now_ms = static_cast<std::uint64_t>(now_us / 1000);
  if (adapter_ && screenPacketQueueBackpressured(adapter_->networkObservation(), now_ms)) return;
  const auto frame_interval_us = static_cast<std::int64_t>(1'000'000 / profile_.frames_per_second);
  auto metadata = repeat_metadata_;
  metadata.capture_timestamp_100ns = now_us * 10;
  auto converted = converter_->convert({device_owner_, repeat_texture_.Get()}, metadata);
  if (!converted || !encoder_->submit(std::move(*converted), now_us, frame_interval_us)) return;
  cadence_.accepted(now_us, frame_interval_us);
  last_submit_us_ = now_us;
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
    stats_.quality_warning = false;
  }
  const bool capture_stopped = capture_pipeline_->stop(deadline);
  if (worker_.joinable()) {
    std::unique_lock lock(mutex_);
    if (!worker_changed_.wait_until(lock, deadline, [this] { return worker_done_; })) {
      failure_ = ScreenPublicationFailure{"screen_pipeline_worker_stop_timeout",
                                          "GPU worker requires utility epoch retirement",
                                          "screen_pipeline_stop", true, true};
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
    if (auto event =
            sender_->waitForEvent((std::min)(remaining(deadline), std::chrono::milliseconds{10}))) {
      handleEvent(std::move(*event));
    }
    publication_stopped = sender_->state() == ScreenPublicationState::Idle;
    if (sender_->state() == ScreenPublicationState::Failed) {
      // A submit can complete with an error while stop is waiting. Drain its
      // publication after the slot returns, but never bypass a timed-out call.
      sender_stop = sender_->stop(generation);
      if (!sender_stop.ok) break;
    }
  }
  // Idle can be visible before the consumer has read the final release events.
  while (auto event = sender_->waitForEvent(std::chrono::milliseconds{0}))
    handleEvent(std::move(*event));
  const bool slots_released = std::all_of(submitted_slots_.begin(), submitted_slots_.end(),
                                          [](const auto& slot) { return !slot.has_value(); });
  const bool stopped =
      capture_stopped && encoder_stopped && sender_stop.ok && publication_stopped && slots_released;
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
      state_ = stats_.reconfiguring && !stop_requested_ ? ProductionScreenPipelineState::starting
                                                        : ProductionScreenPipelineState::stopped;
    } else if (!failure_) {
      failure_ = ScreenPublicationFailure{
          "screen_pipeline_stop_incomplete",
          slots_released ? "Production screen pipeline did not stop before its deadline"
                         : "An in-flight SDK frame still requires utility epoch retirement",
          "screen_pipeline_stop", true, !slots_released};
      state_ = ProductionScreenPipelineState::failed;
    }
    if (!stopped && failure_) {
      state_ = ProductionScreenPipelineState::failed;
      const auto encoder_failure = encoder_->failure();
      failure_->utility_epoch_retirement_required |=
          !slots_released || !capture_stopped ||
          (encoder_failure && encoder_failure->utility_epoch_retirement_required);
    }
  }
  return stopped ? ScreenCommandResult{true, std::nullopt} : ScreenCommandResult{false, failure()};
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

std::optional<ScreenPublicationFailure> ProductionScreenPipeline::failure() const {
  std::scoped_lock lock(mutex_);
  return failure_;
}

}  // namespace syrnike::windows_media::screen
