#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>

#ifdef _WIN32
#include <windows.h>
#endif

#include <livekit/ffi_handle.h>
#include <livekit/track.h>

#include "media/remote_video_bridge.hpp"

namespace {

using syrnike::desktop_native::MediaCommand;
using syrnike::desktop_native::media::RemoteVideoBridge;

constexpr std::int64_t expected_timestamp_us = 42;
constexpr auto gpu_integration_timeout = std::chrono::seconds(10);

class FakeVideoTrack final : public livekit::Track {
 public:
  FakeVideoTrack()
    : livekit::Track(
        livekit::FfiHandle{},
        "static-video",
        "static-video",
        livekit::TrackKind::KIND_VIDEO,
        livekit::StreamState::STATE_ACTIVE,
        false,
        true
      ) {
    setPublicationFields(
      livekit::TrackSource::SOURCE_CAMERA,
      false,
      64,
      64,
      std::string("video/test")
    );
  }
};

class SingleFrameThenBlockReader final : public RemoteVideoBridge::StreamReader {
 public:
  bool read(livekit::VideoFrameEvent& event) override {
    std::unique_lock lock(mutex_);
    if (!frame_sent_) {
      frame_sent_ = true;
      lock.unlock();
      event.frame = livekit::VideoFrame::create(
        64,
        64,
        livekit::VideoBufferType::BGRA
      );
      std::fill(
        event.frame.data(),
        event.frame.data() + event.frame.dataSize(),
        std::uint8_t{0x5a}
      );
      event.timestamp_us = expected_timestamp_us;
      event.rotation = livekit::VideoRotation::VIDEO_ROTATION_0;
      return true;
    }
    changed_.wait(lock, [&] { return closed_; });
    return false;
  }

  void close() override {
    {
      std::lock_guard lock(mutex_);
      closed_ = true;
    }
    changed_.notify_all();
  }

  bool frameSent() const {
    std::lock_guard lock(mutex_);
    return frame_sent_;
  }

 private:
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  bool frame_sent_ = false;
  bool closed_ = false;
};

}  // namespace

int main() try {
#ifdef _WIN32
  auto track = std::make_shared<FakeVideoTrack>();
  auto reader = std::make_shared<SingleFrameThenBlockReader>();
  std::mutex frame_mutex;
  std::condition_variable frame_changed;
  std::uint64_t frame_callbacks = 0;
  std::int64_t delivered_timestamp_us = -1;
  RemoteVideoBridge* bridge_pointer = nullptr;
  RemoteVideoBridge bridge(
    GetCurrentProcessId(),
    [&](MediaCommand command) {
      if (command.type != "__remoteVideoFrame") return true;
      bridge_pointer->release(command.track_id, command.frame_sequence);
      {
        std::lock_guard lock(frame_mutex);
        ++frame_callbacks;
        delivered_timestamp_us =
          static_cast<std::int64_t>(command.timestamp_us);
      }
      frame_changed.notify_all();
      return true;
    },
    {},
    {},
    {},
    [reader](const std::shared_ptr<livekit::Track>&) {
      return reader;
    }
  );
  bridge_pointer = &bridge;
  bridge.updateIdentity("static-frame", 1);

  const auto started_at = std::chrono::steady_clock::now();
  bridge.addTrack(
    track,
    "participant",
    livekit::TrackSource::SOURCE_CAMERA,
    "static-frame-track"
  );
  {
    std::unique_lock lock(frame_mutex);
    if (!frame_changed.wait_for(
          lock,
          gpu_integration_timeout,
          [&] {
            return delivered_timestamp_us == expected_timestamp_us;
          })) {
      const auto elapsed_ms =
        std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started_at
        ).count();
      std::ostringstream message;
      message
        << "remote video GPU pump did not publish a lone static frame"
        << "; elapsed_ms=" << elapsed_ms
        << "; reader_frame_sent=" << reader->frameSent()
        << "; frame_callbacks=" << frame_callbacks
        << "; delivered_timestamp_us=" << delivered_timestamp_us;
      throw std::runtime_error(message.str());
    }
  }
  const auto elapsed_ms =
    std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started_at
    ).count();
  bridge.removeTrack("static-frame-track", false);
  std::cout
    << "remote video lone static frame published"
    << "; elapsed_ms=" << elapsed_ms
    << "; frame_callbacks=" << frame_callbacks
    << '\n';
#endif
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
