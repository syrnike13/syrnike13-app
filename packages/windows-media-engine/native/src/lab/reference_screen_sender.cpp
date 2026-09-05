#include "lab/reference_screen_sender.hpp"

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>

namespace syrnike::windows_media::lab {
namespace {

void appendBounded(std::vector<std::uint64_t>& samples,
                   std::uint64_t value) {
  if (samples.size() < kMaximumReferenceScreenTimingSamples)
    samples.push_back(value);
}

}  // namespace

struct ReferenceScreenSender::State {
  State(std::shared_ptr<livekit::Room> owned_room,
        std::shared_ptr<screen::ScreenFramePipeline> owned_pipeline,
        ReferenceScreenSenderOptions owned_options)
      : room(std::move(owned_room)),
        pipeline(std::move(owned_pipeline)),
        options(owned_options) {}

  mutable std::mutex mutex;
  std::condition_variable changed;
  std::shared_ptr<livekit::Room> room;
  std::shared_ptr<screen::ScreenFramePipeline> pipeline;
  ReferenceScreenSenderOptions options;
  std::shared_ptr<livekit::LocalParticipant> participant;
  std::shared_ptr<livekit::VideoSource> source;
  std::shared_ptr<livekit::LocalVideoTrack> track;
  std::optional<livekit::VideoFrame> output_frame;
  screen::CpuScreenConverter converter;
  ReferenceScreenSenderStats stats;
  std::optional<std::string> terminal_failure;
  bool started = false;
  bool running = false;
  bool stopped = false;
  std::thread worker;
};

ReferenceScreenSender::ReferenceScreenSender(
    std::shared_ptr<livekit::Room> room,
    std::shared_ptr<screen::ScreenFramePipeline> pipeline,
    ReferenceScreenSenderOptions options)
    : state_(std::make_shared<State>(std::move(room), std::move(pipeline),
                                     options)) {
  if (!state_->room || !state_->pipeline)
    throw std::invalid_argument(
        "ReferenceScreenSender requires Room and pipeline");
  if (options.width == 0 || options.height == 0 ||
      options.frames_per_second == 0 || options.frames_per_second > 60)
    throw std::invalid_argument("ReferenceScreenSender profile is invalid");
  state_->source = std::make_shared<livekit::VideoSource>(
      static_cast<int>(options.width), static_cast<int>(options.height));
  state_->track = livekit::LocalVideoTrack::createLocalVideoTrack(
      "screen-cpu-reference", state_->source);
  state_->output_frame.emplace(livekit::VideoFrame::create(
      static_cast<int>(options.width), static_cast<int>(options.height),
      livekit::VideoBufferType::BGRA));
  state_->stats.capture_age_ms.reserve(kMaximumReferenceScreenTimingSamples);
  state_->stats.readback_duration_us.reserve(
      kMaximumReferenceScreenTimingSamples);
  state_->stats.conversion_duration_us.reserve(
      kMaximumReferenceScreenTimingSamples);
  state_->stats.publish_duration_us.reserve(
      kMaximumReferenceScreenTimingSamples);
}

ReferenceScreenSender::~ReferenceScreenSender() {
  (void)stop(std::chrono::steady_clock::now() + std::chrono::seconds{5});
}

ReferenceScreenSenderStartResult ReferenceScreenSender::start() {
  std::lock_guard lock(state_->mutex);
  if (state_->started)
    return {false, "screen sender was already started"};
  if (state_->stopped && !state_->options.reusable_publication)
    return {false, "screen sender cannot restart after stop"};
  try {
    state_->participant = state_->room->localParticipant().lock();
    if (!state_->participant)
      return {false, "LiveKit local participant is unavailable"};
    livekit::TrackPublishOptions publish_options;
    publish_options.source = livekit::TrackSource::SOURCE_SCREENSHARE;
    publish_options.simulcast = false;
    // Match the fork's allowed 720p30 preset; the SDK's implicit 1.5 Mbps
    // default is rejected by the server's screen-share policy.
    publish_options.video_encoding = livekit::VideoEncodingOptions{
        3'000'000, static_cast<double>(screen::kCpuReferenceFramesPerSecond)};
    publish_options.frame_metadata_features =
        livekit::FrameMetadataFeatures{true, true, false};
    state_->participant->publishTrack(state_->track, publish_options);
    if (!state_->track->publication())
      return {false, "LiveKit screen publication is unavailable"};
    state_->started = true;
    state_->running = true;
    state_->stopped = false;
    state_->terminal_failure.reset();
    const auto worker_state = state_;
    state_->worker = std::thread([worker_state] { runWorker(worker_state); });
    return {};
  } catch (const std::exception& error) {
    state_->terminal_failure = error.what();
    return {false, error.what()};
  } catch (...) {
    state_->terminal_failure = "unknown LiveKit publication failure";
    return {false, *state_->terminal_failure};
  }
}

void ReferenceScreenSender::runWorker(
    const std::shared_ptr<State>& state) noexcept {
  const auto frame_interval = std::chrono::microseconds{
      1'000'000 / state->options.frames_per_second};
  auto next_frame = std::chrono::steady_clock::now();
  try {
    while (true) {
      {
        std::unique_lock lock(state->mutex);
        if (!state->running) break;
        if (std::chrono::steady_clock::now() < next_frame) {
          state->changed.wait_until(lock, next_frame,
                                    [&] { return !state->running; });
          if (!state->running) break;
        }
      }
      auto pending = state->pipeline->waitForFrame(std::chrono::milliseconds{50});
      if (!pending) continue;
      auto frame = std::move(*pending);
      if (state->pipeline->discardIfUnpublishable(frame)) continue;

      if (state->options.artificial_conversion_delay.count() > 0) {
        std::unique_lock lock(state->mutex);
        state->changed.wait_for(
            lock, state->options.artificial_conversion_delay,
            [&] { return !state->running; });
        if (!state->running) {
          frame.release();
          break;
        }
      }
      if (state->pipeline->discardIfUnpublishable(frame)) continue;

      auto& output = *state->output_frame;
      const auto converted = state->converter.convert(
          frame, std::span<std::uint8_t>(output.data(), output.dataSize()),
          state->options.width, state->options.height);
      if (state->pipeline->discardIfUnpublishable(frame)) continue;

      livekit::VideoCaptureOptions capture_options;
      capture_options.timestamp_us = static_cast<std::int64_t>(
          converted.captured_at_epoch_ms * 1000ULL);
      capture_options.rotation = livekit::VideoRotation::VIDEO_ROTATION_0;
      livekit::VideoFrameMetadata metadata;
      metadata.user_timestamp_us =
          converted.captured_at_epoch_ms * 1000ULL;
      metadata.frame_id =
          static_cast<std::uint32_t>(converted.source.sequence);
      capture_options.metadata = std::move(metadata);
      const auto publish_started = std::chrono::steady_clock::now();
      state->source->captureFrame(output, capture_options);
      const auto publish_finished = std::chrono::steady_clock::now();
      {
        std::lock_guard lock(state->mutex);
        if (state->stats.last_generation != 0 &&
            state->stats.last_generation != converted.source.generation) {
          ++state->stats.source_generation_transitions;
        }
        state->stats.last_generation = converted.source.generation;
        state->stats.last_sequence = converted.source.sequence;
        ++state->stats.published;
        appendBounded(state->stats.capture_age_ms,
                      converted.capture_age_before_readback_ms);
        appendBounded(state->stats.readback_duration_us,
                      converted.readback_duration_us);
        appendBounded(state->stats.conversion_duration_us,
                      converted.conversion_duration_us);
        appendBounded(
            state->stats.publish_duration_us,
            static_cast<std::uint64_t>(
                std::chrono::duration_cast<std::chrono::microseconds>(
                    publish_finished - publish_started)
                    .count()));
        state->stats.converter = state->converter.stats();
        state->changed.notify_all();
      }
      frame.release();
      next_frame = publish_finished + frame_interval;
    }
  } catch (const std::exception& error) {
    std::lock_guard lock(state->mutex);
    ++state->stats.publication_failures;
    state->terminal_failure = error.what();
    state->running = false;
    state->changed.notify_all();
  } catch (...) {
    std::lock_guard lock(state->mutex);
    ++state->stats.publication_failures;
    state->terminal_failure = "unknown screen sender failure";
    state->running = false;
    state->changed.notify_all();
  }
}

bool ReferenceScreenSender::waitForPublished(
    std::uint64_t count, std::chrono::steady_clock::time_point deadline) {
  std::unique_lock lock(state_->mutex);
  state_->changed.wait_until(lock, deadline, [this, count] {
    return state_->stats.published >= count || state_->terminal_failure ||
           !state_->running;
  });
  return state_->stats.published >= count;
}

ReferenceScreenSenderStopResult ReferenceScreenSender::stop(
    std::chrono::steady_clock::time_point deadline) noexcept {
  {
    std::lock_guard lock(state_->mutex);
    if (state_->stopped) return {};
    state_->running = false;
    state_->changed.notify_all();
  }
  const bool pipeline_stopped = state_->pipeline->stop(deadline);
  if (state_->worker.joinable()) state_->worker.join();

  std::string failure;
  bool unpublish_requested = false;
  try {
    if (state_->room->connectionState() !=
            livekit::ConnectionState::Disconnected &&
        state_->participant && state_->track &&
        state_->track->publication()) {
      state_->participant->unpublishTrack(state_->track->publication()->sid());
      unpublish_requested = true;
    }
  } catch (const std::exception& error) {
    if (state_->room->connectionState() !=
        livekit::ConnectionState::Disconnected) {
      failure = error.what();
    }
  } catch (...) {
    if (state_->room->connectionState() !=
        livekit::ConnectionState::Disconnected) {
      failure = "unknown LiveKit unpublish failure";
    }
  }
  if (failure.empty() && unpublish_requested &&
      state_->options.wait_for_unpublish) {
    try {
      state_->options.wait_for_unpublish(deadline);
    } catch (const std::exception& error) {
      failure = error.what();
    } catch (...) {
      failure = "unknown LiveKit unpublish acknowledgement failure";
    }
  }
  {
    std::lock_guard lock(state_->mutex);
    if (state_->options.reusable_publication) {
      state_->started = false;
    } else {
      state_->track.reset();
      state_->source.reset();
      state_->output_frame.reset();
      state_->participant.reset();
    }
    state_->stopped = true;
    if (!pipeline_stopped && failure.empty())
      failure = "screen pipeline stop deadline exceeded";
    if (!failure.empty() && !state_->terminal_failure)
      state_->terminal_failure = failure;
  }
  return {failure.empty(), std::move(failure)};
}

ReferenceScreenSenderStats ReferenceScreenSender::stats() const {
  std::lock_guard lock(state_->mutex);
  auto result = state_->stats;
  result.converter = state_->converter.stats();
  return result;
}

std::optional<std::string> ReferenceScreenSender::terminalFailure() const {
  std::lock_guard lock(state_->mutex);
  return state_->terminal_failure;
}

}  // namespace syrnike::windows_media::lab
