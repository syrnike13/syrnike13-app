#include <livekit/livekit.h>

#include <chrono>
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <thread>

namespace {
const char* requiredEnvironment(const char* name) {
  const auto* value = std::getenv(name);
  if (!value || !*value) throw std::runtime_error("Missing probe environment");
  return value;
}

class PublicationObservation final : public livekit::RoomDelegate {
 public:
  void onTrackPublished(livekit::Room&, const livekit::TrackPublishedEvent& event) override {
    std::scoped_lock lock(mutex);
    ++events;
    if (!event.publication) ++null_publications;
    publication = event.publication;
    changed.notify_all();
  }
  std::mutex mutex;
  std::condition_variable changed;
  unsigned events = 0;
  unsigned null_publications = 0;
  std::shared_ptr<livekit::RemoteTrackPublication> publication;
  std::shared_ptr<livekit::Track> track;
  void onTrackSubscribed(livekit::Room&, const livekit::TrackSubscribedEvent& event) override {
    std::scoped_lock lock(mutex);
    track = event.track;
    changed.notify_all();
  }
};

bool receiveFrame(const std::shared_ptr<livekit::Track>& track,
                  const std::shared_ptr<livekit::VideoSource>& source) {
  auto stream = livekit::VideoStream::fromTrack(track, {1, livekit::VideoBufferType::BGRA});
  std::atomic<bool> decoded{false};
  std::thread reader([&] {
    livekit::VideoFrameEvent event;
    if (stream->read(event))
      decoded = event.frame.width() == 640 && event.frame.height() == 360 &&
                event.frame.type() == livekit::VideoBufferType::BGRA &&
                event.frame.dataSize() == 640 * 360 * 4;
  });
  try {
    auto frame = livekit::VideoFrame::create(640, 360, livekit::VideoBufferType::RGBA);
    std::fill(frame.data(), frame.data() + frame.dataSize(), 0x7f);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
    while (!decoded && std::chrono::steady_clock::now() < deadline) {
      livekit::VideoCaptureOptions options;
      options.timestamp_us = std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::steady_clock::now().time_since_epoch()).count();
      source->captureFrame(frame, options);
      std::this_thread::sleep_for(std::chrono::milliseconds(33));
    }
  } catch (...) {
    stream->close();
    reader.join();
    throw;
  }
  stream->close();
  reader.join();
  return decoded;
}
}

// An opt-in SDK contract probe, not a substitute for #122 renderer acceptance.
// The caller supplies disposable server credentials and a process deadline.
int main() try {
  livekit::initialize(livekit::LogLevel::Error);
  bool accepted = false;
  {
    PublicationObservation observation;
    livekit::Room receiver;
    livekit::Room publisher;
    receiver.setDelegate(&observation);
    livekit::RoomOptions options;
    options.auto_subscribe = false;
    options.connect_timeout = std::chrono::seconds(5);
    const auto* url = requiredEnvironment("LIVEKIT_URL");
    if (!receiver.connect(url, requiredEnvironment("LIVEKIT_OBSERVER_TOKEN"), options) ||
        !publisher.connect(url, requiredEnvironment("LIVEKIT_PUBLISHER_TOKEN"), options))
      throw std::runtime_error("Probe Room connect failed");
    auto participant = publisher.localParticipant().lock();
    if (!participant) throw std::runtime_error("Probe publisher missing");
    auto source = std::make_shared<livekit::VideoSource>(640, 360);
    auto track = livekit::LocalVideoTrack::createLocalVideoTrack("contract-probe", source);
    livekit::TrackPublishOptions publish_options;
    publish_options.source = livekit::TrackSource::SOURCE_CAMERA;
    publish_options.simulcast = false;
    participant->publishTrack(track, publish_options);
    std::shared_ptr<livekit::RemoteTrackPublication> publication;
    {
      std::unique_lock lock(observation.mutex);
      observation.changed.wait_for(lock, std::chrono::seconds(5),
          [&] { return observation.events != 0; });
      accepted = observation.events == 1 && observation.null_publications == 0 &&
                 observation.publication != nullptr;
      publication = observation.publication;
    }
    bool decoded = false;
    if (accepted) {
      accepted = track->publication() && publication->sid() == track->publication()->sid();
      publication->setSubscribed(true);
      std::shared_ptr<livekit::Track> remote_track;
      {
        std::unique_lock lock(observation.mutex);
        observation.changed.wait_for(lock, std::chrono::seconds(5),
            [&] { return observation.track != nullptr; });
        remote_track = observation.track;
      }
      if (remote_track && remote_track->sid() == publication->sid())
        decoded = receiveFrame(remote_track, source);
    }
    accepted = accepted && decoded;
    {
      std::scoped_lock lock(observation.mutex);
      std::cout << "{\"accepted\":" << (accepted ? "true" : "false")
                << ",\"publishedEvents\":" << observation.events
                << ",\"nullPublications\":" << observation.null_publications
                << ",\"autoSubscribe\":false,\"decodedFrame\":" << (decoded ? "true" : "false")
                << "}" << std::endl;
    }
    if (!publisher.disconnect() || !receiver.disconnect())
      throw std::runtime_error("Probe Room disconnect failed");
  }
  livekit::shutdown();
  return accepted ? 0 : 2;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
