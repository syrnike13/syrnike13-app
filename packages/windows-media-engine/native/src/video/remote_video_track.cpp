#include "video/remote_video_track.hpp"

namespace syrnike::windows_media::video {
namespace {
std::int64_t nowUs() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}
}  // namespace
RemoteVideoTrack::RemoteVideoTrack(std::string participant,
                                   std::string track_name)
    : participant_(std::move(participant)),
      track_name_(std::move(track_name)),
      worker_([this] { run(); }) {}
RemoteVideoTrack::~RemoteVideoTrack() { stop(); }
void RemoteVideoTrack::stop() {
  {
    std::scoped_lock lock(mutex_);
    stopping_ = true;
    ++revision_;
  }
  changed_.notify_all();
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
    livekit::Room&, const livekit::TrackPublishedEvent& event) {
  if (!event.publication || !event.participant ||
      event.participant->identity() != participant_ ||
      event.publication->name() != track_name_ ||
      event.publication->kind() != livekit::TrackKind::KIND_VIDEO)
    return;
  std::scoped_lock lock(mutex_);
  publication_ = event.publication;
  track_.reset();
  ++revision_;
  changed_.notify_all();
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
  if (stopping_ || !enabled_ || revision_ != revision) return false;
  newest_ = std::move(event);
  newest_ingress_us_ = nowUs();
  changed_.notify_all();
  return true;
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
        changed_.wait_for(lock, std::chrono::milliseconds(16));
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
        stream = livekit::VideoStream::fromTrack(
            track, {1, livekit::VideoBufferType::BGRA});
        reader = std::thread([this, stream, revision] {
          try {
            livekit::VideoFrameEvent event;
            while (stream->read(event)) {
              ++decoded_;
              if (event.frame.width() <= 0 || event.frame.height() <= 0 ||
                  event.frame.width() > 3840 || event.frame.height() > 2160 ||
                  event.frame.type() != livekit::VideoBufferType::BGRA)
                continue;
              (void)acceptDecoded(revision, std::move(event));
            }
          } catch (...) {
            failed_ = true;
          }
        });
      }
      if (!frame || revision != revision_ ||
          frame->timestamp_us <= last_timestamp ||
          nowUs() - ingress_us > 250000)
        continue;
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
      last_timestamp = frame->timestamp_us;
      auto lease = pool.upload(generation, width, height, frame->timestamp_us,
                               {frame->frame.data(), frame->frame.dataSize()},
                               ingress_us);
      if (!lease) continue;
      lease->publication_id = requested ? requested->sid() : "";
      lease->participant_identity = participant_;
      std::optional<TextureLease> previous;
      {
        std::scoped_lock lock(mutex_);
        if (revision_ != revision)
          previous = lease;
        else {
          previous = std::exchange(output_, lease);
          output_revision_ = revision;
        }
      }
      if (previous)
        pool.release(previous->generation, previous->sequence, previous->slot);
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
}
}  // namespace syrnike::windows_media::video
