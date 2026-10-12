#include "video/remote_video_track.hpp"
#include "video/frame_signal.hpp"
#include "video/hardware_video_decoder.hpp"

namespace syrnike::windows_media::video {
namespace {
std::int64_t nowUs() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}
}  // namespace
RemoteVideoTrack::RemoteVideoTrack(std::string participant,
                                   std::string track_name, std::string publication_id)
    : participant_(std::move(participant)),
      track_name_(std::move(track_name)),
      publication_id_(std::move(publication_id)),
      worker_([this] { run(); }) {}
RemoteVideoTrack::~RemoteVideoTrack() { stop(); }
void RemoteVideoTrack::beginStop() {
  {
    std::scoped_lock lock(mutex_);
    stopping_ = true;
    ++revision_;
  }
  changed_.notify_all();
}
void RemoteVideoTrack::stop() {
  std::lock_guard join_lock(join_mutex_);
  beginStop();
  {
    std::unique_lock lock(mutex_);
    if (!changed_.wait_for(lock, kShutdownDeadline, [&] { return done_; })) std::terminate();
  }
  if (worker_.joinable()) worker_.join();
}
void RemoteVideoTrack::demand(bool enabled) {
  std::scoped_lock lock(mutex_);
  if (enabled_ != enabled) {
    enabled_ = enabled;
    ++revision_;
    changed_.notify_all();
  }
}
void RemoteVideoTrack::onTrackPublished(
    livekit::Room& room, const livekit::TrackPublishedEvent& event) {
  sdk_connected_ =
      room.connectionState() == livekit::ConnectionState::Connected;
  if (!event.publication || !event.participant ||
      event.participant->identity() != participant_ ||
      (publication_id_.empty() ? event.publication->name() != track_name_ : event.publication->sid() != publication_id_) ||
      event.publication->kind() != livekit::TrackKind::KIND_VIDEO)
    return;
  std::scoped_lock lock(mutex_);
  publication_ = event.publication;
  track_.reset();
  ++revision_;
  changed_.notify_all();
}
void RemoteVideoTrack::onConnectionStateChanged(
    livekit::Room&, const livekit::ConnectionStateChangedEvent& event) {
  sdk_connected_ = event.state == livekit::ConnectionState::Connected;
  if (event.state == livekit::ConnectionState::Reconnecting) ++sdk_reconnects_;
}
void RemoteVideoTrack::onTrackUnpublished(
    livekit::Room&, const livekit::TrackUnpublishedEvent& event) {
  std::scoped_lock lock(mutex_);
  if (publication_ != event.publication) return;
  publication_.reset();
  track_.reset();
  ++revision_;
  changed_.notify_all();
}
void RemoteVideoTrack::onTrackSubscribed(
    livekit::Room&, const livekit::TrackSubscribedEvent& event) {
  std::scoped_lock lock(mutex_);
  if (publication_ != event.publication || !enabled_) return;
  if (track_ != event.track) ++revision_;
  track_ = event.track;
  changed_.notify_all();
}
void RemoteVideoTrack::onTrackUnsubscribed(
    livekit::Room&, const livekit::TrackUnsubscribedEvent& event) {
  std::scoped_lock lock(mutex_);
  if (track_ != event.track) return;
  track_.reset();
  ++revision_;
  changed_.notify_all();
}
void RemoteVideoTrack::onParticipantDisconnected(
    livekit::Room&, const livekit::ParticipantDisconnectedEvent& event) {
  if (!event.participant || event.participant->identity() != participant_)
    return;
  std::scoped_lock lock(mutex_);
  publication_.reset();
  track_.reset();
  ++revision_;
  changed_.notify_all();
}
std::optional<TextureLease> RemoteVideoTrack::takeFrame() {
  std::optional<TextureLease> result;
  bool stale = false;
  {
    std::scoped_lock lock(mutex_);
    result = std::exchange(output_, {});
    stale = output_revision_ != revision_;
  }
  if (result && stale) {
    SharedTexturePool::processPool().release(result->generation,
                                             result->sequence, result->slot);
    return {};
  }
  return result;
}
bool RemoteVideoTrack::acceptDecoded(std::uint64_t revision,
                                     livekit::VideoFrameEvent event) {
  std::scoped_lock lock(mutex_);
  if (stopping_ || !enabled_ || revision_ != revision) {
    ++stale_decoded_;
    return false;
  }
  if (newest_) ++superseded_before_upload_;
  newest_ = std::move(event);
  newest_ingress_us_ = nowUs();
  changed_.notify_all();
  return true;
}
bool RemoteVideoTrack::hasPendingWork(std::uint64_t active_revision) const {
  return stopping_ || newest_.has_value() || revision_ != active_revision;
}
void RemoteVideoTrack::recordUploadDuration(std::uint64_t duration_us) {
  // Only the upload worker writes these lifetime counters. Include failed
  // attempts: pool contention can fail after spending time on GPU work.
  maximum_upload_us_ = (std::max)(maximum_upload_us_.load(), duration_us);
  total_upload_us_ += duration_us;
  if (duration_us > 33000) ++slow_uploads_;
}
void RemoteVideoTrack::run() noexcept {
  auto& pool = SharedTexturePool::processPool();
  std::uint64_t active_revision = 0;
  std::uint64_t generation = 0;
  std::uint32_t width = 0, height = 0;
  std::int64_t last_timestamp = 0;
  std::shared_ptr<livekit::RemoteTrackPublication> subscribed;
  std::shared_ptr<livekit::Track> reading;
  std::shared_ptr<livekit::VideoStream> stream;
  std::thread reader;
  const auto stop_reader = [&] {
    if (stream) stream->close();
    if (reader.joinable()) reader.join();
    stream.reset();
    reading.reset();
  };
  const auto discard_output = [&] {
    std::optional<TextureLease> lease;
    {
      std::scoped_lock lock(mutex_);
      lease = std::exchange(output_, {});
      newest_.reset();
    }
    if (lease) pool.release(lease->generation, lease->sequence, lease->slot);
  };
  try {
    generation = pool.beginGeneration();
    generation_ = generation;
    while (true) {
      std::shared_ptr<livekit::RemoteTrackPublication> requested;
      std::shared_ptr<livekit::RemoteTrackPublication> known_publication;
      std::shared_ptr<livekit::Track> track;
      std::uint64_t revision;
      std::optional<livekit::VideoFrameEvent> frame;
      std::int64_t ingress_us = 0;
      {
        std::unique_lock lock(mutex_);
        // No polling: control changes notify, and failed_ is only read by callers.
        changed_.wait(lock, [&] { return hasPendingWork(active_revision); });
        if (stopping_) break;
        revision = revision_;
        known_publication = publication_;
        if (enabled_) {
          requested = publication_;
          track = track_;
        }
        frame = std::exchange(newest_, {});
        ingress_us = newest_ingress_us_;
      }
      if (revision != active_revision) {
        stop_reader();
        discard_output();
        pool.retire(generation);
        generation = pool.beginGeneration();
        generation_ = generation;
        width = height = 0;
        last_timestamp = 0;
        frame.reset();
        if (subscribed && subscribed == known_publication &&
            subscribed != requested)
          subscribed->setSubscribed(false);
        subscribed.reset();
        active_revision = revision;
      }
      if (requested && !subscribed) {
        requested->setSubscribed(true);
        subscribed = requested;
      }
      if (track && track != reading) {
        stop_reader();
        reading = track;
        // H.264 arrives decoded on the GPU; other codecs and the software
        // fallback arrive as BGRA.
        stream = livekit::VideoStream::fromTrack(
            track, {1, livekit::VideoBufferType::BGRA, true});
        ++reader_starts_;
        reader = std::thread([this, stream, revision] {
          try {
            livekit::VideoFrameEvent event;
            while (stream->read(event)) {
              ++decoded_;
              if (event.frame.width() <= 0 || event.frame.height() <= 0 ||
                  event.frame.width() > 3840 || event.frame.height() > 2160 ||
                  (event.frame.type() != livekit::VideoBufferType::BGRA &&
                   event.frame.type() != livekit::VideoBufferType::External))
                continue;
              (void)acceptDecoded(revision, std::move(event));
            }
          } catch (...) {
            failed_ = true;
          }
          ++reader_ends_;
        });
      }
      if (!frame || revision != revision_) continue;
      if (nowUs() - ingress_us > 250000) {
        ++expired_;
        continue;
      }
      if (frame->timestamp_us <= 0) ++source_timestamp_unusable_;
      // The SDK's decoded frame timestamp can be zero or use a remote clock.
      // Presentation freshness is measured against our local steady clock.
      const auto timestamp_us = (std::max)(ingress_us, last_timestamp + 1);
      const auto frame_width = static_cast<std::uint32_t>(frame->frame.width());
      const auto frame_height =
          static_cast<std::uint32_t>(frame->frame.height());
      if (frame_width != width || frame_height != height) {
        discard_output();
        pool.retire(generation);
        generation = pool.beginGeneration();
        generation_ = generation;
        width = frame_width;
        height = frame_height;
      }
      last_timestamp = timestamp_us;
      const auto* decoded = frame->frame.type() == livekit::VideoBufferType::External
          ? static_cast<const std::shared_ptr<DecodedVideoFrame>*>(frame->frame.externalFrame())
          : nullptr;
      const auto upload_started_us = nowUs();
      auto lease = decoded
          ? pool.upload(generation, width, height, timestamp_us, (*decoded)->texture.Get(),
                        ingress_us)
          : pool.upload(generation, width, height, timestamp_us,
                        {frame->frame.data(), frame->frame.dataSize()}, ingress_us);
      recordUploadDuration(static_cast<std::uint64_t>(nowUs() - upload_started_us));
      const bool gpu = decoded != nullptr;
      frame.reset();  // returns the decoder texture
      if (!lease) {
        ++upload_failed_;
        continue;
      }
      ++uploaded_;
      if (gpu) ++gpu_uploaded_;
      lease->publication_id = requested ? requested->sid() : "";
      lease->participant_identity = participant_;
      std::optional<TextureLease> previous;
      bool published = false;
      {
        std::scoped_lock lock(mutex_);
        if (revision_ != revision)
          previous = lease;
        else {
          previous = std::exchange(output_, lease);
          if (previous) ++superseded_unsent_;
          output_revision_ = revision;
          published = true;
        }
      }
      if (previous)
        pool.release(previous->generation, previous->sequence, previous->slot);
      if (published) signalFrameAvailable();
    }
  } catch (...) {
    failed_ = true;
  }
  try {
    stop_reader();
  } catch (...) {
    std::terminate();
  }
  discard_output();
  pool.retire(generation);
  generation_ = pool.generation();
  // Teardown belongs on this owner lane; Room remains alive in the transport.
  try {
    if (subscribed) subscribed->setSubscribed(false);
  } catch (...) {
    failed_ = true;
  }
  {
    std::lock_guard lock(mutex_);
    done_ = true;
  }
  changed_.notify_all();
}
void RemoteVideoTrack::seedPublication(std::shared_ptr<livekit::RemoteTrackPublication> publication,
                                      std::shared_ptr<livekit::Track> track) {
  if (!publication || publication->kind() != livekit::TrackKind::KIND_VIDEO ||
      (publication_id_.empty() ? publication->name() != track_name_ : publication->sid() != publication_id_)) return;
  std::lock_guard lock(mutex_);
  if (stopping_) return;
  if (publication_ == publication && track_ == track) return;
  publication_ = std::move(publication);
  track_ = std::move(track);
  ++revision_;
  changed_.notify_all();
}
}  // namespace syrnike::windows_media::video
