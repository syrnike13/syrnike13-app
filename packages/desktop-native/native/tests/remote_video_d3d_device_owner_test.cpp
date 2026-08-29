#include <windows.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>

#include <livekit/video_frame.h>

#include "media/remote_video_texture_pool.hpp"
#include "media/video_resource_admission.hpp"

namespace {
using namespace std::chrono_literals;
using syrnike::desktop_native::media::RemoteVideoD3dDeviceOperation;
using syrnike::desktop_native::media::RemoteVideoD3dDeviceOwner;
using syrnike::desktop_native::media::RemoteVideoGpuRolloverCause;
using syrnike::desktop_native::media::RemoteVideoTexturePool;
using syrnike::desktop_native::media::VideoResourceAdmissionBudget;
using syrnike::desktop_native::media::VideoResourceOwner;
using syrnike::desktop_native::media::selectRemoteVideoD3dDeviceOwnerForRollover;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
}  // namespace

int main() try {
  auto limits = syrnike::desktop_native::media::productionVideoResourceLimits();
  limits.maximum_d3d_devices = 2;
  limits.maximum_gpu_generations = 3;
  VideoResourceAdmissionBudget budget(limits);

  std::mutex probe_mutex;
  std::condition_variable probe_changed;
  bool first_submit_entered = false;
  bool release_first_submit = false;
  std::atomic_bool block_next_submit{false};
  std::atomic_uint32_t submit_entries{0};
  std::atomic_uint32_t poll_entries{0};
  auto owner = RemoteVideoD3dDeviceOwner::create(
      budget,
      "remote:shared-owner-test",
      GetCurrentProcessId(),
      [&](RemoteVideoD3dDeviceOperation operation) {
        if (operation == RemoteVideoD3dDeviceOperation::Poll) {
          poll_entries.fetch_add(1);
          return;
        }
        submit_entries.fetch_add(1);
        if (!block_next_submit.exchange(false)) return;
        std::unique_lock lock(probe_mutex);
        first_submit_entered = true;
        probe_changed.notify_all();
        probe_changed.wait(lock, [&] { return release_first_submit; });
      });
  require(owner->multithreadProtected(),
      "shared owner did not enable ID3D10Multithread protection");
  const auto owner_identity = owner->identity();
  const auto device_reservation = owner->deviceReservationId();

  auto first = std::make_unique<RemoteVideoTexturePool>(
      owner, budget, "remote:shared-owner-test", 64, 64, 1);
  auto second = std::make_unique<RemoteVideoTexturePool>(
      owner, budget, "remote:shared-owner-test", 64, 64, 1);
  require(first->deviceOwnerIdentity() == owner_identity &&
          second->deviceOwnerIdentity() == owner_identity &&
          first->deviceReservationId() == device_reservation &&
          first->generationReservationId() != second->generationReservationId(),
      "capacity generations did not share one admitted device owner");
  auto usage = budget.usageFor(
      VideoResourceOwner::RemoteVideo, "remote:shared-owner-test");
  require(usage.d3d_devices == 1 && usage.gpu_generations == 2,
      "shared generations did not admit exactly one device and two pools");

  auto frame = livekit::VideoFrame::create(
      64, 64, livekit::VideoBufferType::BGRA);
  require(second->submit(frame, 2),
      "retired-generation seed submit failed");
  block_next_submit.store(true);
  std::thread first_submit([&] { require(first->submit(frame, 1),
      "first shared-owner submit failed"); });
  {
    std::unique_lock lock(probe_mutex);
    require(probe_changed.wait_for(lock, 2s, [&] { return first_submit_entered; }),
        "first context operation did not enter");
  }
  std::thread retired_poll([&] { (void)second->poll(); });
  std::this_thread::sleep_for(50ms);
  require(poll_entries.load() == 0,
      "retired-generation poll overlapped an active submit");
  {
    std::lock_guard lock(probe_mutex);
    release_first_submit = true;
  }
  probe_changed.notify_all();
  first_submit.join();
  retired_poll.join();
  require(poll_entries.load() == 1,
      "serialized retired-generation poll never reached the owner");

  const auto drain_upload = [](RemoteVideoTexturePool& pool) {
    const auto deadline = std::chrono::steady_clock::now() + 2s;
    while (!pool.retirementSafe() &&
           std::chrono::steady_clock::now() < deadline) {
      (void)pool.poll();
      std::this_thread::sleep_for(1ms);
    }
    (void)pool.discardReady();
  };
  drain_upload(*first);
  drain_upload(*second);
  require(first->retirementSafe() && second->retirementSafe(),
      "shared-owner uploads did not become retirement-safe");

  first_submit_entered = false;
  release_first_submit = false;
  block_next_submit.store(true);
  std::thread active_submit([&] { require(first->submit(frame, 3),
      "active shared-owner submit failed"); });
  {
    std::unique_lock lock(probe_mutex);
    require(
        probe_changed.wait_for(
            lock, 2s, [&] { return first_submit_entered; }),
        "active context operation did not enter");
  }
  std::atomic_bool retired_release_done{false};
  std::thread retired_release([&] {
    second.reset();
    retired_release_done.store(true, std::memory_order_release);
  });
  std::this_thread::sleep_for(50ms);
  require(!retired_release_done.load(std::memory_order_acquire),
      "retired generation released driver resources during an active submit");
  {
    std::lock_guard lock(probe_mutex);
    release_first_submit = true;
  }
  probe_changed.notify_all();
  active_submit.join();
  retired_release.join();
  require(retired_release_done.load(std::memory_order_acquire),
      "serialized retired-generation release never completed");

  second = std::make_unique<RemoteVideoTexturePool>(
      owner, budget, "remote:shared-owner-test", 64, 64, 1);

  auto capacity_owner = selectRemoteVideoD3dDeviceOwnerForRollover(
      owner, RemoteVideoGpuRolloverCause::CapacityExhausted,
      budget, "remote:shared-owner-test", GetCurrentProcessId());
  require(capacity_owner->identity() == owner_identity,
      "capacity rollover replaced the healthy device owner");
  auto replacement_owner = selectRemoteVideoD3dDeviceOwnerForRollover(
      owner, RemoteVideoGpuRolloverCause::DeviceFailure,
      budget, "remote:shared-owner-test", GetCurrentProcessId());
  require(replacement_owner->identity() != owner_identity,
      "device failure reused the failed owner generation");
  auto replacement = std::make_unique<RemoteVideoTexturePool>(
      replacement_owner, budget, "remote:shared-owner-test", 64, 64, 1);
  usage = budget.usageFor(
      VideoResourceOwner::RemoteVideo, "remote:shared-owner-test");
  require(usage.d3d_devices == 2 && usage.gpu_generations == 3,
      "device-failure replacement did not retain old owner generations");

  replacement.reset();
  replacement_owner.reset();
  first.reset();
  second.reset();
  capacity_owner.reset();
  owner.reset();
  usage = budget.usageFor(
      VideoResourceOwner::RemoteVideo, "remote:shared-owner-test");
  require(usage == syrnike::desktop_native::media::VideoResourceUsage{},
      "shared device and generation admissions were not exactly released");

  {
    VideoResourceAdmissionBudget handle_budget(
        syrnike::desktop_native::media::productionVideoResourceLimits());
    auto handle_pool = std::make_unique<RemoteVideoTexturePool>(
        handle_budget,
        "remote:handle-lifetime",
        GetCurrentProcessId(),
        64,
        64,
        1);
    auto source = livekit::VideoFrame::create(
        64, 64, livekit::VideoBufferType::BGRA);
    require(handle_pool->submit(source, 9), "handle lifetime submit failed");
    syrnike::desktop_native::media::RemoteVideoTextureFrame delivered;
    const auto deadline = std::chrono::steady_clock::now() + 2s;
    while (!handle_pool->take(delivered) &&
           std::chrono::steady_clock::now() < deadline) {
      (void)handle_pool->poll();
      std::this_thread::sleep_for(1ms);
    }
    require(
        delivered.nt_handle != 0 && delivered.lease,
        "handle lifetime take failed");
    const auto electron_handle = reinterpret_cast<HANDLE>(delivered.nt_handle);
    DWORD flags = 0;
    require(
        GetHandleInformation(electron_handle, &flags) != FALSE,
        "duplicated Electron handle was not valid after take");
    handle_pool.reset();
    require(
        GetHandleInformation(electron_handle, &flags) != FALSE,
        "pool destruction closed a live Electron NT handle");
    delivered.lease.reset();
    require(
        GetHandleInformation(electron_handle, &flags) != FALSE,
        "lease release closed a live Electron NT handle");
    CloseHandle(electron_handle);
  }

  std::cout << "Remote video D3D device owner tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << "Remote video D3D device owner tests failed: "
            << error.what() << '\n';
  return 1;
}
