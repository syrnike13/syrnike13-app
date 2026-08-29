#include <windows.h>

#include <atomic>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <thread>

#include "media/voice_control_lane.hpp"

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

syrnike::desktop_native::MediaCommand releaseCommand(
    std::uint64_t sequence,
    const char* request_id = "release") {
  syrnike::desktop_native::MediaCommand command;
  command.type = syrnike::desktop_native::NativeCommandType::ReleaseRemoteVideoFrame;
  command.request_id = request_id;
  command.session_id = "voice";
  command.generation = 7;
  command.track_id = "camera";
  command.frame_sequence = sequence;
  command.diagnostic_host_epoch = 11;
  return command;
}

syrnike::desktop_native::MediaCommand cameraPreviewDemandCommand(
    bool demanded,
    const char* request_id = "camera-demand") {
  syrnike::desktop_native::MediaCommand command;
  command.type =
      syrnike::desktop_native::NativeCommandType::SetLocalCameraPreviewDemand;
  command.request_id = request_id;
  command.session_id = "camera";
  command.generation = 9;
  command.demanded = demanded;
  command.diagnostic_host_epoch = 11;
  return command;
}

syrnike::desktop_native::MediaCommand cameraPreviewRetryCommand(
    const char* request_id = "camera-retry") {
  auto command = cameraPreviewDemandCommand(true, request_id);
  command.type =
      syrnike::desktop_native::NativeCommandType::RetryLocalCameraPreview;
  command.internal_message = "renderer_presentation_stall";
  return command;
}

struct SmallStackCloseProbe {
  syrnike::desktop_native::media::VoiceControlLane* lane = nullptr;
  std::atomic<std::size_t> discarded{0};
};

DWORD WINAPI closeOnSmallStack(void* context) noexcept {
  auto* probe = static_cast<SmallStackCloseProbe*>(context);
  if (!probe || !probe->lane) return 1;
  probe->discarded.store(
      probe->lane->closeAndDiscard(), std::memory_order_release);
  return 0;
}

void verifyBoundedCloseStackAndExactRelease() {
  using syrnike::desktop_native::media::VoiceControlAdmission;
  using syrnike::desktop_native::media::VoiceControlLane;

  VoiceControlLane lane;
  std::atomic<std::size_t> releases{0};
  std::atomic<std::size_t> releases_observing_empty_lane{0};
  for (std::uint64_t sequence = 1;
       sequence <= VoiceControlLane::kCapacity;
       ++sequence) {
    auto command = releaseCommand(sequence, "small-stack-close");
    command.on_drop = [&] {
      releases.fetch_add(1, std::memory_order_relaxed);
      if (lane.size() == 0) {
        releases_observing_empty_lane.fetch_add(1, std::memory_order_relaxed);
      }
    };
    require(
        lane.tryPush(std::move(command)) == VoiceControlAdmission::Accepted,
        "small-stack close fixture did not fill the bounded lane");
  }

  SmallStackCloseProbe probe{&lane};
  constexpr SIZE_T kReservedStackBytes = 64 * 1024;
  HANDLE worker = CreateThread(
      nullptr,
      kReservedStackBytes,
      closeOnSmallStack,
      &probe,
      STACK_SIZE_PARAM_IS_A_RESERVATION,
      nullptr);
  require(worker != nullptr, "small-stack close worker creation failed");
  require(
      WaitForSingleObject(worker, 5'000) == WAIT_OBJECT_0,
      "small-stack close worker did not finish");
  DWORD exit_code = 1;
  require(
      GetExitCodeThread(worker, &exit_code) && exit_code == 0,
      "small-stack close worker failed");
  CloseHandle(worker);

  require(
      probe.discarded.load(std::memory_order_acquire) ==
              VoiceControlLane::kCapacity &&
          releases.load(std::memory_order_acquire) ==
              VoiceControlLane::kCapacity &&
          releases_observing_empty_lane.load(std::memory_order_acquire) ==
              VoiceControlLane::kCapacity,
      "small-stack close did not exact-release outside the lane lock");
}

void verifyConcurrentCloseIsExactOnce() {
  using syrnike::desktop_native::media::VoiceControlAdmission;
  using syrnike::desktop_native::media::VoiceControlLane;

  VoiceControlLane lane;
  std::atomic<std::size_t> releases{0};
  for (std::uint64_t sequence = 1;
       sequence <= VoiceControlLane::kCapacity;
       ++sequence) {
    auto command = releaseCommand(sequence, "concurrent-close");
    command.on_drop = [&] {
      releases.fetch_add(1, std::memory_order_relaxed);
    };
    require(
        lane.tryPush(std::move(command)) == VoiceControlAdmission::Accepted,
        "concurrent close fixture did not fill the bounded lane");
  }

  std::size_t first_discarded = 0;
  std::size_t second_discarded = 0;
  std::thread first([&] { first_discarded = lane.closeAndDiscard(); });
  std::thread second([&] { second_discarded = lane.closeAndDiscard(); });
  first.join();
  second.join();
  require(
      first_discarded + second_discarded == VoiceControlLane::kCapacity &&
          releases.load(std::memory_order_acquire) ==
              VoiceControlLane::kCapacity &&
          lane.size() == 0,
      "concurrent close did not exact-release the bounded lane once");
}

}  // namespace

int main() try {
  using syrnike::desktop_native::MediaCommand;
  using syrnike::desktop_native::media::RendererTextureLeaseStats;
  using syrnike::desktop_native::media::VoiceControlAdmission;
  using syrnike::desktop_native::media::VoiceControlLane;

  std::uint64_t now_ms = 1'000;
  VoiceControlLane lane([&] { return now_ms; });
  require(
      lane.tryPush(releaseCommand(1, "first")) ==
          VoiceControlAdmission::Accepted,
      "voice-control lane rejected its first release");
  require(
      lane.tryPush(releaseCommand(1, "duplicate")) ==
          VoiceControlAdmission::Duplicate,
      "pending duplicate release consumed another mailbox slot");
  require(
      lane.tryPush(cameraPreviewDemandCommand(false, "camera-off")) ==
          VoiceControlAdmission::Accepted,
      "camera preview demand was not admitted to voice-control");
  require(
      lane.tryPush(cameraPreviewDemandCommand(false, "camera-off-duplicate")) ==
          VoiceControlAdmission::Duplicate,
      "duplicate camera preview demand consumed another mailbox slot");
  require(
      lane.tryPush(cameraPreviewDemandCommand(true, "camera-on")) ==
          VoiceControlAdmission::Accepted,
      "opposite camera preview demand was incorrectly coalesced");
  require(
      lane.tryPush(cameraPreviewRetryCommand()) ==
          VoiceControlAdmission::Accepted,
      "camera preview retry was not admitted to voice-control");
  require(
      lane.tryPush(cameraPreviewRetryCommand("camera-retry-duplicate")) ==
          VoiceControlAdmission::Duplicate,
      "duplicate camera preview retry consumed another mailbox slot");

  for (std::uint64_t sequence = 2;
       lane.size() < VoiceControlLane::kCapacity;
       ++sequence) {
    require(
        lane.tryPush(releaseCommand(sequence)) ==
            VoiceControlAdmission::Accepted,
        "voice-control lane rejected work below capacity");
  }
  require(
      lane.tryPush(releaseCommand(10'000)) == VoiceControlAdmission::Full,
      "voice-control lane exceeded its fixed capacity");
  auto saturated_camera_demand = cameraPreviewDemandCommand(false);
  saturated_camera_demand.generation = 10;
  require(
      lane.tryPush(std::move(saturated_camera_demand)) ==
          VoiceControlAdmission::Full,
      "full voice-control lane accepted a new camera preview demand");

  now_ms = 1'250;
  auto snapshot = lane.snapshot(
      11,
      RendererTextureLeaseStats{3, 2, 64, 3, 2});
  require(
      snapshot.host_epoch == 11 &&
          snapshot.queue_depth == VoiceControlLane::kCapacity &&
          snapshot.queue_capacity == VoiceControlLane::kCapacity &&
          snapshot.oldest_queue_wait_ms == 250 &&
          snapshot.current_operation.empty() &&
          snapshot.worker_state == "busy" &&
          snapshot.retirement_state == "retiring" &&
          snapshot.outstanding_renderer_leases == 3 &&
          snapshot.worker_owner == "voice-control-worker" &&
          snapshot.retirement_owner == "renderer-texture-lease-registry",
      "voice-control probe lost queue, owner, epoch, or retirement state");

  auto first = lane.waitPop();
  require(first && first->frame_sequence == 1,
          "voice-control lane lost FIFO ordering");
  snapshot = lane.snapshot(11, RendererTextureLeaseStats{});
  require(
      snapshot.current_operation == "releaseRemoteVideoFrame" &&
          snapshot.last_queue_wait_ms == 250,
      "voice-control probe did not expose the current operation");
  lane.complete(*first);
  require(
      lane.tryPush(releaseCommand(1, "late")) ==
          VoiceControlAdmission::Duplicate,
      "late release bypassed the bounded completed-release ledger");

  require(
      lane.closeAndDiscard() == VoiceControlLane::kCapacity - 1,
      "voice-control close did not retire every queued command");
  require(
      lane.tryPush(releaseCommand(20'000)) == VoiceControlAdmission::Closed,
      "closed voice-control lane accepted another command");
  verifyBoundedCloseStackAndExactRelease();
  verifyConcurrentCloseIsExactOnce();
  return 0;
} catch (...) {
  return 1;
}
