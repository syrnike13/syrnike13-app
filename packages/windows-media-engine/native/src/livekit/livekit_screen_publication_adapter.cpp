#include "livekit/livekit_screen_publication_adapter.hpp"
#include "testing/product_fault_gate.hpp"

#if defined(LIVEKIT_CPP_HAS_PREENCODED_VIDEO_SOURCE)

#include <exception>
#include <atomic>
#include <mutex>
#include <stdexcept>
#include <utility>

#include <livekit/livekit.h>

namespace syrnike::windows_media {
namespace {

screen::ScreenOperationResult failure(std::string code, std::string message,
                                      std::string stage,
                                      bool retryable = false) {
  return screen::ScreenOperationResult::fail(screen::ScreenPublicationFailure{
      std::move(code), std::move(message), std::move(stage), retryable, false});
}

void completeException(std::uint64_t generation,
                       screen::ScreenOperationCompletion completion,
                       const char* stage) noexcept {
  try {
    throw;
  } catch (const std::exception& error) {
    completion(generation,
               failure("screen_livekit_operation_failed", error.what(), stage,
                       true));
  } catch (...) {
    completion(generation,
               failure("screen_livekit_operation_failed",
                       "Unknown LiveKit screen publication failure", stage,
                       true));
  }
}

}  // namespace

struct LiveKitScreenPublicationAdapter::State {
  enum class Commit { pending, committed, cancelled };
  std::atomic<Commit> commit{Commit::pending};
  std::atomic_bool cancelled{false};
  explicit State(LiveKitScreenEncoderControls owned_controls)
      : controls(std::move(owned_controls)) {}

  std::mutex mutex;
  LiveKitScreenEncoderControls controls;
  std::uint64_t generation = 0;
  bool stopping = false;
  std::shared_ptr<livekit::LocalParticipant> participant;
  std::shared_ptr<livekit::EncodedVideoSource> source;
  std::shared_ptr<livekit::LocalVideoTrack> track;
  std::optional<std::uint64_t> sender_bitrate_allocation;
};

OutgoingNetworkObservation LiveKitScreenPublicationAdapter::networkObservation() const noexcept {
  auto observation = transport_->networkSampler()->snapshot();
  std::scoped_lock lock(state_->mutex);
  if (state_->source && !state_->stopping)
    observation.sender_bitrate_allocation = state_->sender_bitrate_allocation;
  return observation;
}

LiveKitScreenPublicationAdapter::LiveKitScreenPublicationAdapter(
    std::shared_ptr<LiveKitRoomTransport> transport,
    LiveKitScreenEncoderControls controls)
    : transport_(std::move(transport)),
      state_(std::make_shared<State>(std::move(controls))) {
  if (!transport_)
    throw std::invalid_argument(
        "LiveKit screen publication adapter requires a transport");
}

LiveKitScreenPublicationAdapter::~LiveKitScreenPublicationAdapter() {
  std::scoped_lock lock(state_->mutex);
  state_->stopping = true;
}

void LiveKitScreenPublicationAdapter::cancel() noexcept {
  state_->cancelled = true;
  auto pending = State::Commit::pending;
  state_->commit.compare_exchange_strong(pending, State::Commit::cancelled);
}

void LiveKitScreenPublicationAdapter::startPublish(
    std::uint64_t generation, screen::ScreenTrackDescriptor descriptor,
    screen::ScreenOperationCompletion completion) {
  const auto state = state_;
  // The transport joins its lane before destruction; avoid a self-owning task.
  auto* const transport = transport_.get();
  auto queued_completion = completion;
  const bool queued = transport_->enqueueActiveRoomTask(
      [state, transport, generation, descriptor = std::move(descriptor),
       completion = std::move(queued_completion)](
          const std::shared_ptr<livekit::Room>& room) mutable {
        try {
          if (state->cancelled) {
            {
              std::scoped_lock lock(state->mutex);
              state->generation = generation;
            }
            return completion(generation, failure("screen_publish_cancelled",
                "Screen publication was cancelled", "screen_publish"));
          }
          if (!room)
            return completion(
                generation,
                failure("screen_livekit_room_unavailable",
                        "The active LiveKit Room is unavailable",
                        "screen_publish", true));
          const auto participant = room->localParticipant().lock();
          if (!participant)
            return completion(
                generation,
                failure("screen_livekit_participant_unavailable",
                        "The LiveKit local participant is unavailable",
                        "screen_publish", true));
          auto source = std::make_shared<livekit::EncodedVideoSource>(
              static_cast<int>(descriptor.width),
              static_cast<int>(descriptor.height));
          auto track = livekit::LocalVideoTrack::createLocalVideoTrack(
              descriptor.name, source);
          livekit::TrackPublishOptions options;
          options.source = livekit::TrackSource::SOURCE_SCREENSHARE;
          options.simulcast = false;
          options.video_encoding = livekit::VideoEncodingOptions{
              descriptor.bitrate,
              static_cast<double>(descriptor.frames_per_second)};
          options.video_codec = livekit::VideoCodec::H264;
          options.video_encoder = livekit::VideoEncoderBackend::PreEncoded;
          options.frame_metadata_features =
              livekit::FrameMetadataFeatures{true, true, false};
          testing::holdProductFault("sdk-screen-publish");
          participant->publishTrack(track, options);
          if (!track->publication())
            return completion(
                generation,
                failure("screen_livekit_publication_unavailable",
                        "LiveKit did not create the screen publication",
                        "screen_publish", true));
          bool stopping = false;
          {
            std::scoped_lock lock(state->mutex);
            stopping = state->stopping;
            if (!stopping) {
              state->generation = generation;
              state->participant = participant;
              state->source = std::move(source);
              state->sender_bitrate_allocation.reset();
              state->track = std::move(track);
            }
          }
          if (stopping) {
            if (track->publication()) {
              testing::holdProductFault("sdk-screen-unpublish");
              participant->unpublishTrack(track->publication()->sid());
            }
            return completion(
                generation,
                failure("screen_livekit_adapter_stopping",
                        "Screen publication adapter is stopping",
                        "screen_publish", true));
          }
          auto pending = State::Commit::pending;
          if (!state->commit.compare_exchange_strong(pending, State::Commit::committed)) {
            // Retain partially published resources for ordered unpublish.
            return completion(generation, failure("screen_publish_cancelled",
                "Screen publication was cancelled", "screen_publish"));
          }
          transport->setScreenFeedbackPoll(
              [weak_state = std::weak_ptr<State>(state), weak_room = std::weak_ptr<livekit::Room>(room),
               generation](const std::shared_ptr<livekit::Room>& active) {
                const auto current = weak_state.lock();
                if (!current || weak_room.lock() != active) return;
                std::shared_ptr<livekit::EncodedVideoSource> source;
                LiveKitScreenEncoderControls controls;
                {
                  std::scoped_lock lock(current->mutex);
                  if (current->stopping || current->cancelled || current->generation != generation) return;
                  source = current->source;
                  controls = current->controls;
                }
                if (!source) return;
                const bool keyframe = source->takeKeyFrameRequest();
                const auto allocation = source->takeBitrateRequest();
                {
                  std::scoped_lock lock(current->mutex);
                  if (current->stopping || current->cancelled || current->generation != generation) return;
                  if (allocation) current->sender_bitrate_allocation = allocation;
                }
                if (keyframe && controls.request_key_frame) controls.request_key_frame();
              });
          completion(generation, screen::ScreenOperationResult::success());
        } catch (...) {
          completeException(generation, std::move(completion),
                            "screen_publish");
        }
      });
  if (!queued)
    completion(generation,
               failure("screen_sdk_lane_backpressure",
                       "The bounded LiveKit SDK lane is occupied",
                       "screen_publish", true));
}

void LiveKitScreenPublicationAdapter::startSubmit(
    std::uint64_t generation, screen::EncodedScreenFrame frame,
    screen::ScreenOperationCompletion completion) {
  const auto state = state_;
  auto queued_completion = completion;
  const bool queued = transport_->enqueueActiveRoomTask(
      [state, generation, frame, completion = std::move(queued_completion)](
          const std::shared_ptr<livekit::Room>&) mutable {
        try {
          if (state->cancelled)
            return completion(generation, screen::ScreenOperationResult::success());
          std::shared_ptr<livekit::EncodedVideoSource> source;
          bool stale = false;
          {
            std::scoped_lock lock(state->mutex);
            stale = state->stopping || state->generation != generation ||
                    !state->source;
            if (!stale) {
              source = state->source;
            }
          }
          if (stale)
            return completion(
                generation,
                failure("screen_livekit_publication_stale",
                        "The encoded frame belongs to an inactive publication",
                        "screen_submit"));
          livekit::VideoFrameMetadata metadata;
          metadata.user_timestamp_us = frame.timestamp_us;
          metadata.frame_id = static_cast<std::uint32_t>(frame.sequence);
          const bool accepted = source->captureFrame(livekit::EncodedVideoFrame{
              frame.data, frame.size, static_cast<std::int64_t>(frame.timestamp_us),
              frame.key_frame, std::move(metadata)});
          if (!accepted)
            return completion(
                generation,
                failure("screen_livekit_encoded_frame_rejected",
                        "LiveKit rejected the encoded H.264 access unit",
                        "screen_submit", true));
          completion(generation, screen::ScreenOperationResult::success());
        } catch (...) {
          completeException(generation, std::move(completion),
                            "screen_submit");
        }
      });
  if (!queued)
    completion(generation,
               failure("screen_sdk_lane_backpressure",
                       "The bounded LiveKit SDK lane is occupied",
                       "screen_submit", true));
}

void LiveKitScreenPublicationAdapter::startUnpublish(
    std::uint64_t generation, screen::ScreenOperationCompletion completion) {
  const auto state = state_;
  auto queued_completion = completion;
  const bool queued = transport_->enqueueActiveRoomTask(
      [state, generation, completion = std::move(queued_completion)](
          const std::shared_ptr<livekit::Room>& room) mutable {
        try {
          std::shared_ptr<livekit::LocalParticipant> participant;
          std::shared_ptr<livekit::LocalVideoTrack> track;
          bool stale = false;
          {
            std::scoped_lock lock(state->mutex);
            stale = state->generation != generation;
            if (!stale) {
              participant = std::move(state->participant);
              track = std::move(state->track);
              state->source.reset();
              state->generation = 0;
            }
          }
          if (stale)
            return completion(
                generation,
                failure("screen_livekit_publication_stale",
                        "The unpublish command belongs to an inactive publication",
                        "screen_unpublish"));
          // A disconnected Room has already lost its publications. Local SDK
          // references still drain here, but there is no remote track to remove.
          if (room && room->connectionState() != livekit::ConnectionState::Disconnected &&
              participant && track && track->publication()) {
            testing::holdProductFault("sdk-screen-unpublish");
            participant->unpublishTrack(track->publication()->sid());
          }
          completion(generation, screen::ScreenOperationResult::success());
        } catch (...) {
          // Disconnect can race the check above while unpublish is in flight.
          // Its synchronous completion still releases the local SDK references.
          if (!room || room->connectionState() == livekit::ConnectionState::Disconnected)
            return completion(generation, screen::ScreenOperationResult::success());
          completeException(generation, std::move(completion),
                            "screen_unpublish");
        }
      });
  if (!queued)
    completion(generation,
               failure("screen_sdk_lane_backpressure",
                       "The bounded LiveKit SDK lane is occupied",
                       "screen_unpublish", true));
}

}  // namespace syrnike::windows_media

#endif
