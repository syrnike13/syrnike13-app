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
#include <thread>

#ifdef _WIN32
#include <windows.h>
#endif

#include <livekit/ffi_handle.h>
#include <livekit/track.h>

#include "media/remote_video_bridge.hpp"
#include "media/renderer_texture_lease_registry.hpp"

namespace {

using syrnike::desktop_native::MediaCommand;
using syrnike::desktop_native::media::RemoteVideoBridge;
using syrnike::desktop_native::media::RendererTextureLeaseFence;
using syrnike::desktop_native::media::releaseRendererTextureLease;
using syrnike::desktop_native::media::rendererTextureLeaseStats;

constexpr std::int64_t expected_timestamp_us = 42;
constexpr std::uint64_t expected_source_timestamp_us = 4'242;
constexpr std::uint32_t expected_source_frame_id = 73;
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
      event.metadata = livekit::VideoFrameMetadata{};
      event.metadata->user_timestamp_us = expected_source_timestamp_us;
      event.metadata->frame_id = expected_source_frame_id;
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
  std::uint64_t delivered_sequence = 0;
  std::uint64_t delivered_source_timestamp_us = 0;
  std::uint32_t delivered_source_frame_id = 0;
  const auto started_at = std::chrono::steady_clock::now();
  {
    RemoteVideoBridge bridge(
      GetCurrentProcessId(),
      [&](MediaCommand command) {
        if (command.type != syrnike::desktop_native::NativeCommandType::RemoteVideoFrame) return true;
        {
          std::lock_guard lock(frame_mutex);
          ++frame_callbacks;
          delivered_timestamp_us =
            static_cast<std::int64_t>(command.timestamp_us);
          delivered_sequence = command.frame_sequence;
          delivered_source_timestamp_us = command.source_timestamp_us;
          delivered_source_frame_id = command.source_frame_id;
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
    bridge.updateIdentity("static-frame", 1);
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
    if (delivered_source_timestamp_us != expected_source_timestamp_us ||
        delivered_source_frame_id != expected_source_frame_id) {
      throw std::runtime_error(
        "remote video metadata identity did not survive the GPU upload pool");
    }
    std::this_thread::sleep_until(
      started_at + std::chrono::seconds(6)
    );
    bridge.removeTrack("static-frame-track", false);
  }
  const auto elapsed_ms =
    std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started_at
    ).count();
  const auto retained = rendererTextureLeaseStats();
  if (retained.outstanding_leases != 1 ||
      retained.outstanding_generations != 1) {
    throw std::runtime_error(
      "remote bridge destruction released an unfenced renderer allocation"
    );
  }
  const RendererTextureLeaseFence fence{
    syrnike::desktop_native::NativeCommandType::RemoteVideoFrame, "static-frame", 1, "static-frame-track"
  };
  if (releaseRendererTextureLease(
        RendererTextureLeaseFence{
          syrnike::desktop_native::NativeCommandType::RemoteVideoFrame, "static-frame", 0, "static-frame-track"
        },
        delivered_sequence) ||
      releaseRendererTextureLease(
        RendererTextureLeaseFence{
          syrnike::desktop_native::NativeCommandType::RemoteVideoFrame, "static-frame", 1, "wrong-track"
        },
        delivered_sequence) ||
      !releaseRendererTextureLease(fence, delivered_sequence) ||
      releaseRendererTextureLease(fence, delivered_sequence)) {
    throw std::runtime_error(
      "remote renderer fence acknowledgement was not exact and idempotent"
    );
  }
  const auto released = rendererTextureLeaseStats();
  if (released.outstanding_leases != 0 ||
      released.outstanding_generations != 0) {
    throw std::runtime_error(
      "remote renderer fence did not return lease counts to baseline"
    );
  }
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
