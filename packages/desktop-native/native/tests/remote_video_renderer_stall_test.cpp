#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

#include <livekit/ffi_handle.h>
#include <livekit/track.h>

#include "media/remote_video_bridge.hpp"
#include "media/renderer_texture_lease_registry.hpp"

namespace {

using namespace std::chrono_literals;
using syrnike::desktop_native::MediaCommand;
using syrnike::desktop_native::NativeCommandType;
using syrnike::desktop_native::media::RemoteVideoBridge;
using syrnike::desktop_native::media::RemoteVideoRendererFlowState;
using syrnike::desktop_native::media::RendererTextureLeaseFence;
using syrnike::desktop_native::media::releaseRendererTextureLease;
using syrnike::desktop_native::media::rendererTextureLeaseStats;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

template <typename Predicate>
bool waitUntil(Predicate predicate, std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (!predicate() && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(1ms);
  }
  return predicate();
}

class FakeVideoTrack final : public livekit::Track {
 public:
  FakeVideoTrack()
      : livekit::Track(
            livekit::FfiHandle{},
            "renderer-stall-video",
            "renderer-stall-video",
            livekit::TrackKind::KIND_VIDEO,
            livekit::StreamState::STATE_ACTIVE,
            false,
            true) {
    setPublicationFields(
        livekit::TrackSource::SOURCE_CAMERA,
        false,
        64,
        64,
        std::string("video/test"));
  }
};

struct ReaderCounters {
  std::atomic_uint64_t reads{0};
  std::atomic_uint64_t closes{0};
  std::atomic_uint64_t factories{0};
  std::atomic_uint64_t reader_frame_index{0};
  std::atomic_bool exercise_rollovers{false};
  std::atomic_int64_t next_timestamp_us{1'000};
};

class CadencedReader final : public RemoteVideoBridge::StreamReader {
 public:
  explicit CadencedReader(std::shared_ptr<ReaderCounters> counters)
      : counters_(std::move(counters)) {}

  bool read(livekit::VideoFrameEvent& event) override {
    {
      std::unique_lock lock(mutex_);
      if (changed_.wait_for(lock, 4ms, [&] { return closed_; })) return false;
    }
    const auto reader_frame_index =
        counters_->reader_frame_index.fetch_add(1) + 1;
    const auto dimension = !counters_->exercise_rollovers.load()
        ? 64
        : reader_frame_index == 1 ? 64
        : 80;
    event.frame = livekit::VideoFrame::create(
        dimension, dimension, livekit::VideoBufferType::BGRA);
    const auto value = counters_->reads.fetch_add(1) + 1;
    std::fill(
        event.frame.data(),
        event.frame.data() + event.frame.dataSize(),
        static_cast<std::uint8_t>(value & 0xff));
    event.timestamp_us = counters_->next_timestamp_us.fetch_add(1'000);
    event.rotation = livekit::VideoRotation::VIDEO_ROTATION_0;
    return true;
  }

  void close() override {
    {
      std::lock_guard lock(mutex_);
      if (closed_) return;
      closed_ = true;
      counters_->closes.fetch_add(1);
    }
    changed_.notify_all();
  }

 private:
  std::shared_ptr<ReaderCounters> counters_;
  std::mutex mutex_;
  std::condition_variable changed_;
  bool closed_ = false;
};

}  // namespace

int main() try {
#ifdef _WIN32
  const auto baseline = rendererTextureLeaseStats();
  {
    auto timely_counters = std::make_shared<ReaderCounters>();
    auto timely_track = std::make_shared<FakeVideoTrack>();
    std::atomic_uint64_t timely_frames{0};
    const RendererTextureLeaseFence timely_fence{
        NativeCommandType::RemoteVideoFrame,
        "renderer-flowing",
        4,
        "renderer-flowing-track"};
    RemoteVideoBridge timely_bridge(
        GetCurrentProcessId(),
        [&](MediaCommand command) {
          if (command.type != NativeCommandType::RemoteVideoFrame) return true;
          timely_frames.fetch_add(1, std::memory_order_relaxed);
          return releaseRendererTextureLease(
              timely_fence, command.frame_sequence);
        },
        {},
        {},
        {},
        [timely_counters](const std::shared_ptr<livekit::Track>&) {
          timely_counters->factories.fetch_add(1, std::memory_order_relaxed);
          return std::make_shared<CadencedReader>(timely_counters);
        });
    timely_bridge.updateIdentity("renderer-flowing", 4);
    timely_bridge.addTrack(
        timely_track,
        "participant",
        livekit::TrackSource::SOURCE_CAMERA,
        "renderer-flowing-track");
    require(
        waitUntil(
            [&] { return timely_frames.load(std::memory_order_relaxed) >= 100; },
            10s),
        "timely renderer fences did not sustain ordinary presentation");
    require(
        timely_counters->factories.load(std::memory_order_relaxed) == 1 &&
            timely_counters->closes.load(std::memory_order_relaxed) == 0,
        "timely renderer fences churned the LiveKit video stream");
    timely_bridge.removeTrack("renderer-flowing-track", false);
  }
  require(
      waitUntil(
          [&] {
            const auto stats = rendererTextureLeaseStats();
            return stats.outstanding_leases == baseline.outstanding_leases &&
                stats.outstanding_generations ==
                    baseline.outstanding_generations;
          },
          2s),
      "flowing renderer generation did not return to baseline");

  auto counters = std::make_shared<ReaderCounters>();
  auto track = std::make_shared<FakeVideoTrack>();
  std::mutex frames_mutex;
  std::vector<std::pair<std::uint64_t, std::uint64_t>> frames;

  RemoteVideoBridge bridge(
      GetCurrentProcessId(),
      [&](MediaCommand command) {
        if (command.type == NativeCommandType::RemoteVideoFrame) {
          std::lock_guard lock(frames_mutex);
          frames.emplace_back(command.frame_sequence, command.timestamp_us);
        }
        return true;
      },
      {},
      {},
      {},
      [counters](const std::shared_ptr<livekit::Track>&) {
        counters->factories.fetch_add(1);
        return std::make_shared<CadencedReader>(counters);
      });
  bridge.updateIdentity("renderer-stall", 9);
  bridge.addTrack(
      track,
      "participant",
      livekit::TrackSource::SOURCE_CAMERA,
      "renderer-stall-track");

  require(
      waitUntil(
          [&] {
            const auto snapshot = bridge.trackSnapshot("renderer-stall-track");
            return snapshot &&
                snapshot->renderer_flow ==
                    RemoteVideoRendererFlowState::FenceBlocked &&
                snapshot->gpu_pump_quiescent;
          },
          10s),
      "three held renderer leases did not quiesce the remote video worker");
  const auto stalled = bridge.trackSnapshot("renderer-stall-track");
  require(stalled.has_value(), "stalled remote video worker disappeared");
  require(
      stalled->frames_published == 3,
      "renderer generation published past its three-lease boundary");
  const auto stalled_reads = stalled->frames_read;
  const auto stalled_wakeups = stalled->gpu_pump_wakeups;
  std::this_thread::sleep_for(100ms);
  const auto still_stalled = bridge.trackSnapshot("renderer-stall-track");
  require(
      still_stalled && still_stalled->frames_read == stalled_reads &&
          still_stalled->gpu_pump_wakeups == stalled_wakeups,
      "renderer fence stall left decoded reads or timed GPU wakeups active");

  std::uint64_t released_sequence = 0;
  std::uint64_t stalled_timestamp = 0;
  {
    std::lock_guard lock(frames_mutex);
    require(frames.size() == 3, "stalled frame ledger was not exact");
    released_sequence = frames.front().first;
    stalled_timestamp = frames.back().second;
  }
  const RendererTextureLeaseFence fence{
      NativeCommandType::RemoteVideoFrame,
      "renderer-stall",
      9,
      "renderer-stall-track"};
  require(
      releaseRendererTextureLease(fence, released_sequence),
      "late renderer fence did not release its exact native lease");
  require(
      waitUntil(
          [&] {
            std::lock_guard lock(frames_mutex);
            return frames.size() >= 4 && frames.back().second > stalled_timestamp;
          },
          10s),
      "late renderer fence did not resume with a fresh capture timestamp");
  require(
      counters->factories.load() >= 2,
      "renderer release did not reopen a fresh local video stream");

  bridge.removeTrack("renderer-stall-track", false);
  std::vector<std::uint64_t> retained_sequences;
  {
    std::lock_guard lock(frames_mutex);
    retained_sequences.reserve(frames.size());
    for (const auto& [sequence, _] : frames) {
      if (sequence != released_sequence) retained_sequences.push_back(sequence);
    }
  }
  for (const auto sequence : retained_sequences) {
    require(
        releaseRendererTextureLease(fence, sequence),
        "final renderer fence did not release its native lease");
  }
  require(
      waitUntil(
          [&] {
            const auto stats = rendererTextureLeaseStats();
            return stats.outstanding_leases == baseline.outstanding_leases &&
                stats.outstanding_generations ==
                    baseline.outstanding_generations;
          },
          2s),
      "remote video renderer leases did not return to baseline");

  {
    std::lock_guard lock(frames_mutex);
    frames.clear();
  }
  counters->reader_frame_index.store(0);
  counters->exercise_rollovers.store(true);
  bridge.addTrack(
      track,
      "participant",
      livekit::TrackSource::SOURCE_CAMERA,
      "demand-removed-track");
  require(
      waitUntil(
          [&] {
            const auto snapshot = bridge.trackSnapshot("demand-removed-track");
            return snapshot &&
                snapshot->renderer_flow ==
                    RemoteVideoRendererFlowState::FenceBlocked &&
                snapshot->gpu_pump_quiescent &&
                snapshot->gpu_pool_rollovers >= 1;
          },
          10s),
      "bounded rollover did not settle into the demand-removal fence stall");
  const auto removal_started = std::chrono::steady_clock::now();
  bridge.removeTrack("demand-removed-track", false);
  require(
      std::chrono::steady_clock::now() - removal_started < 500ms &&
          !bridge.trackSnapshot("demand-removed-track"),
      "demand removal did not interrupt the untimed renderer-fence wait");

  const RendererTextureLeaseFence removed_fence{
      NativeCommandType::RemoteVideoFrame,
      "renderer-stall",
      9,
      "demand-removed-track"};
  {
    std::lock_guard lock(frames_mutex);
    for (const auto& [sequence, _] : frames) {
      require(
          releaseRendererTextureLease(removed_fence, sequence),
          "late demand-removed fence did not release exactly once");
    }
  }
  require(
      waitUntil(
          [&] {
            const auto stats = rendererTextureLeaseStats();
            return stats.outstanding_leases == baseline.outstanding_leases &&
                stats.outstanding_generations ==
                    baseline.outstanding_generations;
          },
          2s),
      "demand-removed renderer generation did not return to baseline");
#endif
  std::cout << "remote video renderer stall tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
