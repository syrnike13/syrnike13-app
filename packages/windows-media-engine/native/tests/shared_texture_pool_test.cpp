#include "video/shared_texture_pool.hpp"
#include "video/remote_video_track.hpp"
#include "fault_evidence.hpp"

#include <d3d11sdklayers.h>

#include <array>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace syrnike::windows_media::video {
class RemoteVideoFaultInjector {
 public:
  static std::uint64_t revision(RemoteVideoTrack& owner) { return owner.revision_; }
  static bool decoded(RemoteVideoTrack& owner, std::uint64_t revision,
                      std::int64_t timestamp) {
    livekit::VideoFrameEvent event;
    event.frame = livekit::VideoFrame::create(64, 64, livekit::VideoBufferType::BGRA);
    event.timestamp_us = timestamp;
    return owner.acceptDecoded(revision, std::move(event));
  }
};
}  // namespace syrnike::windows_media::video

using namespace syrnike::windows_media::video;
void require(bool condition) {
  if (!condition) throw std::runtime_error("Pool invariant failed");
}

TextureLease nextInjectedFrame(RemoteVideoTrack& owner) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (std::chrono::steady_clock::now() < deadline) {
    const auto timestamp = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    require(RemoteVideoFaultInjector::decoded(owner, RemoteVideoFaultInjector::revision(owner), timestamp));
    if (auto frame = owner.takeFrame()) return *frame;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  throw std::runtime_error("Remote owner failed to upload a current decoded frame");
}

void staleRemoteDecodedFramesDoNotChangeAnotherOwner() {
  auto& pool = SharedTexturePool::processPool();
  RemoteVideoTrack replaced("replaced", "video");
  RemoteVideoTrack healthy("healthy", "video");
  replaced.demand(true);
  healthy.demand(true);
  const auto old_revision = RemoteVideoFaultInjector::revision(replaced);
  const auto old_frame = nextInjectedFrame(replaced);
  const auto healthy_frame = nextInjectedFrame(healthy);
  const auto healthy_generation = healthy.generation();
  replaced.demand(false);
  replaced.demand(true);
  require(!RemoteVideoFaultInjector::decoded(replaced, old_revision, 1));
  const auto replacement_frame = nextInjectedFrame(replaced);
  require(replacement_frame.generation != old_frame.generation);
  require(healthy.generation() == healthy_generation && !healthy.failed());
  require(pool.release(old_frame.generation, old_frame.sequence, old_frame.slot));
  require(!pool.release(old_frame.generation, old_frame.sequence, old_frame.slot));
  require(pool.release(replacement_frame.generation, replacement_frame.sequence, replacement_frame.slot));
  replaced.stop();
  require(!RemoteVideoFaultInjector::decoded(replaced, RemoteVideoFaultInjector::revision(replaced), 2));
  require(!replaced.takeFrame());
  require(pool.release(healthy_frame.generation, healthy_frame.sequence, healthy_frame.slot));
  const auto continued = nextInjectedFrame(healthy);
  require(continued.generation == healthy_generation);
  require(pool.release(continued.generation, continued.sequence, continued.slot));
  healthy.stop();
  const auto resources = pool.snapshot();
  require(resources.backing_bytes == 0 && resources.delivered == 0 &&
          resources.retired == 0 && resources.quarantined == 0);
}
int main() try {
  auto& pool = SharedTexturePool::processPool();
  const auto generation = pool.beginGeneration();
  std::vector<std::uint8_t> frame(640 * 360 * 4, 128);
  std::array<TextureLease, 4> leases;
  for (auto& lease : leases) {
    const auto value = pool.upload(generation, 640, 360, 1, frame);
    require(value.has_value());
    lease = *value;
  }
  const auto bytes = pool.snapshot().backing_bytes;
  for (int i = 0; i < 100; ++i)
    require(!pool.upload(generation, 640, 360, i, frame));
  require(pool.snapshot().backing_bytes == bytes);
  pool.retire(generation);
  const auto next = pool.beginGeneration();
  require(pool.snapshot().retired == 4 &&
          pool.snapshot().retired_generations == 1);
  require(!pool.upload(next, 640, 360, 1, frame));
  for (const auto& lease : leases) {
    require(!pool.release(next, lease.sequence, lease.slot));
    require(!pool.release(lease.generation, lease.sequence + 100, lease.slot));
    require(pool.release(lease.generation, lease.sequence, lease.slot));
    require(!pool.release(lease.generation, lease.sequence, lease.slot));
  }
  require(pool.snapshot().backing_bytes == 0);
  pool.retire(next);
  const auto first_owner = pool.beginGeneration(),
             second_owner = pool.beginGeneration();
  const auto first_frame = pool.upload(first_owner, 640, 360, 1, frame);
  const auto second_frame = pool.upload(second_owner, 640, 360, 1, frame);
  require(first_frame.has_value() && second_frame.has_value());
  pool.retire(first_owner);
  require(pool.release(first_frame->generation, first_frame->sequence,
                       first_frame->slot));
  require(pool.release(second_frame->generation, second_frame->sequence,
                       second_frame->slot));
  const auto still_active = pool.upload(second_owner, 640, 360, 2, frame);
  require(still_active.has_value());
  require(pool.release(still_active->generation, still_active->sequence,
                       still_active->slot));
  pool.retire(second_owner);
  require(pool.snapshot().backing_bytes == 0);
  for (int i = 0; i < 30; ++i) {
    const auto current = pool.beginGeneration();
    require(!pool.upload(generation, 640, 360, 1, frame));
    const auto value = pool.upload(current, 640, 360, 1, frame);
    require(value.has_value());
    require(
        !pool.release(leases[0].generation, leases[0].sequence, value->slot));
    require(pool.release(value->generation, value->sequence, value->slot));
    pool.retire(current);
    require(pool.snapshot().backing_bytes == 0);
  }
  syrnike::windows_media::tests::repeatFault("remote-video-late-decoded", staleRemoteDecodedFramesDoNotChangeAnotherOwner);
  auto device = syrnike::windows_media::capture::processD3d11Device(true);
  require(device->debugLayerEnabled());
  Microsoft::WRL::ComPtr<ID3D11Debug> debug;
  require(SUCCEEDED(device->device()->QueryInterface(IID_PPV_ARGS(&debug))));
  Microsoft::WRL::ComPtr<ID3D11InfoQueue> messages;
  require(SUCCEEDED(device->device()->QueryInterface(IID_PPV_ARGS(&messages))));
  messages->ClearStoredMessages();
  require(
      SUCCEEDED(debug->ReportLiveDeviceObjects(static_cast<D3D11_RLDO_FLAGS>(
          D3D11_RLDO_DETAIL | D3D11_RLDO_IGNORE_INTERNAL))));
  for (UINT64 i = 0; i < messages->GetNumStoredMessages(); ++i) {
    SIZE_T size = 0;
    require(SUCCEEDED(messages->GetMessage(i, nullptr, &size)));
    std::vector<std::uint8_t> buffer(size);
    auto* message = reinterpret_cast<D3D11_MESSAGE*>(buffer.data());
    require(SUCCEEDED(messages->GetMessage(i, message, &size)));
    require(message->ID != D3D11_MESSAGE_ID_LIVE_TEXTURE2D);
  }
  std::cout << "Fixed pool, stale/duplicate release, retirement, 30 cycles and "
               "D3D debug checks passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
