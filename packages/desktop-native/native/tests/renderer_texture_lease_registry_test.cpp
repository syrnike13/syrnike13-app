#include <cstdint>
#include <chrono>
#include <future>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

#include "media/renderer_texture_lease_registry.hpp"

namespace {

using syrnike::desktop_native::media::RendererTextureLeaseFence;
using syrnike::desktop_native::media::RendererTextureLeaseOwner;
using syrnike::desktop_native::media::RendererTextureLeaseRegistry;
using syrnike::desktop_native::media::RendererTextureLeaseRetainStatus;
using syrnike::desktop_native::media::RendererTextureLeaseWakeState;

std::shared_ptr<void> countedLease(int& destroyed) {
  return std::shared_ptr<void>(
      new int(1),
      [&destroyed](void* value) {
        delete static_cast<int*>(value);
        ++destroyed;
      });
}

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main() try {
  {
    RendererTextureLeaseRegistry registry(8, 3, 2);
    int destroyed = 0;
    const RendererTextureLeaseFence fence{
        syrnike::desktop_native::NativeCommandType::RemoteVideoFrame,
        "voice",
        7,
        "stall-track"};
    const RendererTextureLeaseOwner owner{fence, 11};
    const RendererTextureLeaseOwner replacement{fence, 12};
    auto owner_wake = std::make_shared<RendererTextureLeaseWakeState>();
    auto replacement_wake =
        std::make_shared<RendererTextureLeaseWakeState>();

    const auto first =
        registry.tryRetain(owner, countedLease(destroyed), owner_wake);
    const auto second =
        registry.tryRetain(owner, countedLease(destroyed), owner_wake);
    const auto third =
        registry.tryRetain(owner, countedLease(destroyed), owner_wake);
    require(
        first.retained() && second.retained() && third.retained() &&
            third.remaining_in_generation == 0,
        "third renderer lease did not expose the generation stall boundary");
    require(
        registry
                .tryRetain(owner, countedLease(destroyed), owner_wake)
                .status ==
            RendererTextureLeaseRetainStatus::GenerationCapacity,
        "full renderer generation did not return a typed capacity result");

    const auto owner_revision = owner_wake->revision();
    const auto replacement_revision = replacement_wake->revision();
    require(
        registry.release(fence, first.sequence),
        "exact renderer fence did not release the retained lease");
    require(
        owner_wake->waitForChange(owner_revision).changed &&
            replacement_wake->revision() == replacement_revision,
        "renderer release woke a replacement generation instead of its owner");
  }

  {
    RendererTextureLeaseRegistry registry(4, 3, 2);
    int destroyed = 0;
    const RendererTextureLeaseFence fence{
        syrnike::desktop_native::NativeCommandType::RemoteVideoFrame,
        "retiring-session",
        19,
        "retiring-track"};
    const RendererTextureLeaseOwner owner{fence, 31};
    auto wake = std::make_shared<RendererTextureLeaseWakeState>();
    std::weak_ptr<RendererTextureLeaseWakeState> weak_wake = wake;
    const auto retained =
        registry.tryRetain(owner, countedLease(destroyed), wake);
    require(retained.retained(), "retiring renderer lease was not admitted");

    const auto revision = wake->revision();
    auto waiter = std::async(std::launch::async, [wake, revision] {
      return wake->waitForChange(revision);
    });
    wake->close();
    require(
        waiter.wait_for(std::chrono::milliseconds(100)) ==
                std::future_status::ready &&
            waiter.get().closed,
        "closing a retiring renderer generation did not stop its waiter");
    wake.reset();
    require(!weak_wake.expired(),
            "registry did not keep closed wake state alive for a late fence");
    require(registry.release(fence, retained.sequence),
            "late exact fence did not release the retiring lease");
    require(weak_wake.expired() && destroyed == 1,
            "late release retained or called through destroyed worker state");
  }

  RendererTextureLeaseRegistry registry(8, 3, 2);
  int destroyed = 0;
  const RendererTextureLeaseFence fence{
      syrnike::desktop_native::NativeCommandType::RemoteVideoFrame, "voice", 7, "track-a"};
  const RendererTextureLeaseOwner first{fence, 1};
  const RendererTextureLeaseOwner replacement{fence, 2};
  const RendererTextureLeaseOwner excess{fence, 3};

  const auto first_sequence =
      registry.tryRetain(first, countedLease(destroyed));
  const auto second_sequence =
      registry.tryRetain(first, countedLease(destroyed));
  const auto third_sequence =
      registry.tryRetain(first, countedLease(destroyed));
  require(
      first_sequence.retained() && second_sequence.retained() &&
          third_sequence.retained(),
      "first renderer generation did not admit its documented lease budget");
  require(
      !registry.tryRetain(first, countedLease(destroyed)).retained(),
      "one renderer generation exceeded its lease budget");

  const auto replacement_sequence =
      registry.tryRetain(replacement, countedLease(destroyed));
  require(
      replacement_sequence.retained(),
      "bounded replacement renderer generation was not admitted");
  require(
      !registry.tryRetain(excess, countedLease(destroyed)).retained(),
      "a third unfenced renderer generation was admitted");

  require(
      !registry.release(
          RendererTextureLeaseFence{
              syrnike::desktop_native::NativeCommandType::RemoteVideoFrame, "voice", 7, "wrong-track"},
          first_sequence.sequence),
      "stale track acknowledgement released a live lease");
  require(
      registry.release(fence, first_sequence.sequence) &&
          !registry.release(fence, first_sequence.sequence),
      "renderer release was not exact and idempotent");
  require(
      registry.release(fence, second_sequence.sequence) &&
          registry.release(fence, third_sequence.sequence),
      "first renderer generation did not retire after its final fences");

  const auto resumed_sequence =
      registry.tryRetain(excess, countedLease(destroyed));
  require(
      resumed_sequence.retained() &&
          resumed_sequence.sequence > replacement_sequence.sequence,
      "released generation did not admit a fresh unique lease sequence");
  require(
      !registry.release(fence, first_sequence.sequence),
      "stale sequence acknowledgement released a newer lease");
  require(
      !registry.release(
          RendererTextureLeaseFence{
              syrnike::desktop_native::NativeCommandType::RemoteVideoFrame, "voice", 6, "track-a"},
          resumed_sequence.sequence),
      "stale media generation acknowledgement released a newer lease");
  require(
      !registry.release(
          RendererTextureLeaseFence{
              syrnike::desktop_native::NativeCommandType::LocalCameraPreviewFrame, "voice", 7, "track-a"},
          resumed_sequence.sequence),
      "a different shared-texture path released a newer lease");
  require(
      registry.release(fence, replacement_sequence.sequence) &&
          registry.release(fence, resumed_sequence.sequence),
      "final renderer fences did not release retained generations");

  const auto stats = registry.stats();
  require(
      stats.outstanding_leases == 0 && stats.outstanding_generations == 0,
      "renderer lease registry did not return to baseline");
  require(destroyed == 7, "renderer lease resources were not released once");

  RendererTextureLeaseRegistry process_budget(2, 2, 2);
  int process_destroyed = 0;
  const RendererTextureLeaseFence remote_fence{
      syrnike::desktop_native::NativeCommandType::RemoteVideoFrame, "voice", 7, "remote-track"};
  const RendererTextureLeaseFence camera_fence{
      syrnike::desktop_native::NativeCommandType::LocalCameraPreviewFrame, "voice", 7, "camera-track"};
  const auto remote_sequence = process_budget.tryRetain(
      RendererTextureLeaseOwner{remote_fence, 1},
      countedLease(process_destroyed));
  const auto camera_sequence = process_budget.tryRetain(
      RendererTextureLeaseOwner{camera_fence, 2},
      countedLease(process_destroyed));
  require(remote_sequence.retained() && camera_sequence.retained(),
          "process renderer lease budget rejected available capacity");
  require(
      !process_budget.tryRetain(
          RendererTextureLeaseOwner{remote_fence, 1},
          countedLease(process_destroyed)).retained() &&
          process_budget.stats().outstanding_leases == 2,
      "process renderer lease cap evicted an unfenced resource");
  require(
      process_budget.release(remote_fence, remote_sequence.sequence) &&
          process_budget.release(camera_fence, camera_sequence.sequence) &&
          process_budget.stats().outstanding_leases == 0 &&
          process_destroyed == 3,
      "process renderer lease budget did not return to baseline");

  std::cout << "renderer texture lease registry tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
