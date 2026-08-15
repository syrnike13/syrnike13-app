#include "../src/media/video_resource_admission.hpp"

#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>

namespace media = syrnike::desktop_native::media;

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

media::VideoResourceRequest remotePool(
    std::string owner_id,
    std::uint32_t width = 1920,
    std::uint32_t height = 1080) {
  media::VideoResourceRequest request;
  request.owner = media::VideoResourceOwner::RemoteVideo;
  request.owner_id = std::move(owner_id);
  request.d3d_devices = 1;
  request.gpu_generations = 1;
  request.textures.push_back({
      .width = width,
      .height = height,
      .count = 5,
      .format = media::VideoTextureFormat::Bgra8,
  });
  return request;
}

void verifyFourKScreenUsesConfiguredBackingBytes() {
  const auto nv12_bytes = media::configuredVideoTextureBytes({
      .width = 3840,
      .height = 2160,
      .count = 5,
      .format = media::VideoTextureFormat::Nv12,
  });
  const auto bgra_bytes = media::configuredVideoTextureBytes({
      .width = 3840,
      .height = 2160,
      .count = 4,
      .format = media::VideoTextureFormat::Bgra8,
  });
  require(nv12_bytes == 62'259'200,
          "4K NV12 backing bytes lost per-texture allocation padding");
  require(bgra_bytes == 132'907'008,
          "4K BGRA backing bytes lost per-texture allocation padding");

  media::VideoResourceLimits limits{
      .maximum_d3d_devices = 2,
      .maximum_gpu_generations = 3,
      .maximum_textures = 12,
      .maximum_texture_backing_bytes = nv12_bytes + bgra_bytes,
      .maximum_hardware_encoder_sessions = 1,
  };
  media::VideoResourceAdmissionBudget budget(limits);
  media::VideoResourceRequest request;
  request.owner = media::VideoResourceOwner::ScreenCapture;
  request.owner_id = "screen-4k";
  request.d3d_devices = 2;
  request.gpu_generations = 3;
  request.hardware_encoder_sessions = 1;
  request.textures = {
      {3840, 2160, 5, media::VideoTextureFormat::Nv12},
      {3840, 2160, 4, media::VideoTextureFormat::Bgra8},
  };

  const auto admitted = budget.tryAcquire(request);
  require(admitted.admitted(), "configured 4K screen request was rejected");
  require(admitted.lease->usage().texture_backing_bytes ==
              nv12_bytes + bgra_bytes,
          "lease did not expose exact configured backing bytes");
  require(admitted.lease->ownerId() == "screen-4k",
          "lease identity lost its owner ID");
  require(admitted.lease->reservationId() != 0,
          "lease identity did not expose a reservation ID");
}

void verifyNonAlignedTexturesUseConservativeConfiguredBacking() {
  constexpr std::uint64_t bgra_logical_bytes = 24'847'212;
  const auto bgra_bytes = media::configuredVideoTextureBytes({
      .width = 1919,
      .height = 1079,
      .count = 3,
      .format = media::VideoTextureFormat::Bgra8,
  });
  require(bgra_bytes == 24'969'216,
          "odd BGRA dimensions did not align every texture allocation");
  require(bgra_bytes > bgra_logical_bytes,
          "BGRA configured backing was not conservative over logical bytes");

  constexpr std::uint64_t nv12_logical_bytes = 15'597'030;
  const auto nv12_bytes = media::configuredVideoTextureBytes({
      .width = 1922,
      .height = 1082,
      .count = 5,
      .format = media::VideoTextureFormat::Nv12,
  });
  require(nv12_bytes == 16'711'680,
          "NV12 pitch and allocation padding were not applied per texture");
  require(nv12_bytes > nv12_logical_bytes,
          "NV12 configured backing was not conservative over logical bytes");

  auto limits = media::productionVideoResourceLimits();
  limits.maximum_texture_backing_bytes = bgra_logical_bytes;
  media::VideoResourceAdmissionBudget budget(limits);
  media::VideoResourceRequest request;
  request.owner = media::VideoResourceOwner::RemoteVideo;
  request.owner_id = "non-aligned-remote";
  request.textures = {{
      1919, 1079, 3, media::VideoTextureFormat::Bgra8,
  }};
  const auto rejected = budget.tryAcquire(request);
  require(!rejected.admitted() && rejected.saturation &&
              rejected.saturation->resource_class ==
                  media::VideoResourceClass::TextureBackingBytes &&
              rejected.saturation->requested == bgra_bytes,
          "admission bypassed conservative configured backing bytes");
}

void verifyConfiguredBackingOverflowFailsClosed() {
  bool geometry_overflow = false;
  try {
    static_cast<void>(media::configuredVideoTextureBytes({
        .width = UINT32_MAX,
        .height = UINT32_MAX,
        .count = 1,
        .format = media::VideoTextureFormat::Bgra8,
    }));
  } catch (const std::overflow_error&) {
    geometry_overflow = true;
  }
  require(geometry_overflow,
          "BGRA configured backing arithmetic did not fail closed");

  bool count_overflow = false;
  try {
    static_cast<void>(media::configuredVideoTextureBytes({
        .width = 3840,
        .height = 2160,
        .count = UINT64_MAX,
        .format = media::VideoTextureFormat::Nv12,
    }));
  } catch (const std::overflow_error&) {
    count_overflow = true;
  }
  require(count_overflow,
          "NV12 texture-count arithmetic did not fail closed");
}

void verifyCameraAndScreenShareEncoderBudget() {
  media::VideoResourceLimits limits = media::productionVideoResourceLimits();
  limits.maximum_hardware_encoder_sessions = 2;
  media::VideoResourceAdmissionBudget budget(limits);

  media::VideoResourceRequest screen;
  screen.owner = media::VideoResourceOwner::ScreenEncoder;
  screen.owner_id = "screen";
  screen.hardware_encoder_sessions = 1;
  auto screen_admission = budget.tryAcquire(screen);
  require(screen_admission.admitted(), "screen encoder was not admitted");

  media::VideoResourceRequest camera;
  camera.owner = media::VideoResourceOwner::CameraEncoder;
  camera.owner_id = "camera";
  camera.hardware_encoder_sessions = 1;
  auto camera_admission = budget.tryAcquire(camera);
  require(camera_admission.admitted(), "camera encoder was not admitted");

  auto third = budget.tryAcquire(screen);
  require(!third.admitted(), "third hardware encoder exceeded the process cap");
  require(third.saturation.has_value(), "encoder rejection was not typed");
  require(third.saturation->resource_class ==
              media::VideoResourceClass::HardwareEncoderSessions,
          "encoder rejection reported the wrong resource class");
  require(third.saturation->code() == "gpu_encoder_session_saturated",
          "encoder rejection lost its stable typed code");

  bool typed_rejection = false;
  try {
    static_cast<void>(media::requireVideoResourceAdmission(budget, screen));
  } catch (const media::VideoResourceSaturationError& error) {
    typed_rejection =
        error.saturation().resource_class ==
            media::VideoResourceClass::HardwareEncoderSessions &&
        error.saturation().owner == media::VideoResourceOwner::ScreenEncoder;
  }
  require(typed_rejection,
          "production admission bridge did not preserve typed saturation");

  camera_admission.lease.reset();
  auto retry = budget.tryAcquire(screen);
  require(retry.admitted(), "returned encoder capacity was not reusable");
}

void verifyMultipleRemoteTracksAreProcessBounded() {
  constexpr std::uint64_t one_pool_bytes = 41'615'360;
  media::VideoResourceLimits limits{
      .maximum_d3d_devices = 8,
      .maximum_gpu_generations = 8,
      .maximum_textures = 40,
      .maximum_texture_backing_bytes = one_pool_bytes * 3,
      .maximum_hardware_encoder_sessions = 2,
  };
  media::VideoResourceAdmissionBudget budget(limits);
  auto first = budget.tryAcquire(remotePool("remote-a"));
  auto second = budget.tryAcquire(remotePool("remote-b"));
  auto third = budget.tryAcquire(remotePool("remote-c"));
  require(first.admitted() && second.admitted() && third.admitted(),
          "three configured remote pools did not fit their exact byte limit");

  auto fourth = budget.tryAcquire(remotePool("remote-d"));
  require(!fourth.admitted(), "fourth remote pool exceeded the byte budget");
  require(fourth.saturation->resource_class ==
              media::VideoResourceClass::TextureBackingBytes,
          "remote saturation did not report texture backing bytes");
  const auto snapshot = budget.snapshot();
  require(snapshot.current.texture_backing_bytes == one_pool_bytes * 3,
          "remote usage exceeded the configured byte bound");
  require(snapshot.current.d3d_devices == 3,
          "remote devices were not accounted process-wide");
}

void verifyRolloverAndRendererFenceRetainCapacity() {
  constexpr std::uint64_t one_pool_bytes = 41'615'360;
  media::VideoResourceLimits limits{
      .maximum_d3d_devices = 2,
      .maximum_gpu_generations = 2,
      .maximum_textures = 10,
      .maximum_texture_backing_bytes = one_pool_bytes * 2,
      .maximum_hardware_encoder_sessions = 2,
  };
  media::VideoResourceAdmissionBudget budget(limits);
  auto active = budget.tryAcquire(remotePool("remote-active"));
  auto replacement = budget.tryAcquire(remotePool("remote-candidate"));
  require(active.admitted() && replacement.admitted(),
          "active and candidate generations were not jointly admitted");

  auto renderer_held = active.lease;
  active.lease.reset();
  auto blocked = budget.tryAcquire(remotePool("remote-third"));
  require(!blocked.admitted(),
          "renderer-held retired generation returned capacity too early");
  require(budget.snapshot().active_reservations == 2,
          "renderer-held generation disappeared from the snapshot");

  // Ownership, rather than elapsed time, is authoritative. Repeated attempts
  // model a completion delayed well beyond 500 ms without growing the bound.
  for (int attempt = 0; attempt < 100; ++attempt) {
    const auto delayed = budget.tryAcquire(remotePool("remote-delayed"));
    require(!delayed.admitted(),
            "delayed renderer fence admitted an unbounded generation");
  }
  require(budget.snapshot().peak.gpu_generations == 2,
          "delayed completions exceeded the generation bound");

  renderer_held.reset();
  auto recovered = budget.tryAcquire(remotePool("remote-recovered"));
  require(recovered.admitted(),
          "late renderer fence did not restore admission capacity");
}

void verifyCapacityReturnsExactlyOnce() {
  auto limits = media::productionVideoResourceLimits();
  media::VideoResourceAdmissionBudget budget(limits);
  auto admitted = budget.tryAcquire(remotePool("exact-release", 640, 360));
  require(admitted.admitted(), "exact-release fixture was rejected");
  auto second_owner = admitted.lease;
  const auto reservation_id = admitted.lease->reservationId();
  admitted.lease.reset();
  require(budget.snapshot().active_reservations == 1,
          "first shared owner returned capacity prematurely");
  second_owner.reset();
  const auto baseline = budget.snapshot();
  require(baseline.active_reservations == 0,
          "last owner did not return reservation capacity");
  require(baseline.current == media::VideoResourceUsage{},
          "released reservation did not return every resource class");

  second_owner.reset();
  require(budget.snapshot().current == media::VideoResourceUsage{},
          "repeated shared reset returned capacity more than once");
  require(reservation_id != 0, "release fixture had no reservation identity");
}

void verifyGroupedUsageIncludesEveryPoolGeneration() {
  auto limits = media::productionVideoResourceLimits();
  media::VideoResourceAdmissionBudget budget(limits);
  const auto one_4k_pool_bytes = media::configuredVideoTextureBytes({
      .width = 3840,
      .height = 2160,
      .count = 5,
      .format = media::VideoTextureFormat::Bgra8,
  });
  auto active = budget.tryAcquire(remotePool("remote:viewer-track", 3840, 2160));
  auto retired = budget.tryAcquire(remotePool("remote:viewer-track", 3840, 2160));
  require(active.admitted() && retired.admitted(),
          "active and retired 4K pool generations were not admitted");
  require(
      budget
              .usageFor(
                  media::VideoResourceOwner::RemoteVideo,
                  "remote:viewer-track")
              .texture_backing_bytes == one_4k_pool_bytes * 2,
      "grouped remote-video usage omitted a hidden pool generation");

  retired.lease.reset();
  require(
      budget
              .usageFor(
                  media::VideoResourceOwner::RemoteVideo,
                  "remote:viewer-track")
              .texture_backing_bytes == one_4k_pool_bytes,
      "grouped remote-video usage did not release one exact generation");
  active.lease.reset();
  require(
      budget.usageFor(
          media::VideoResourceOwner::RemoteVideo,
          "remote:viewer-track") == media::VideoResourceUsage{},
      "grouped remote-video usage did not return to baseline");
}

}  // namespace

int main() {
  try {
    verifyFourKScreenUsesConfiguredBackingBytes();
    verifyNonAlignedTexturesUseConservativeConfiguredBacking();
    verifyConfiguredBackingOverflowFailsClosed();
    verifyCameraAndScreenShareEncoderBudget();
    verifyMultipleRemoteTracksAreProcessBounded();
    verifyRolloverAndRendererFenceRetainCapacity();
    verifyCapacityReturnsExactlyOnce();
    verifyGroupedUsageIncludesEveryPoolGeneration();
    std::cout << "video resource admission tests passed\n";
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
