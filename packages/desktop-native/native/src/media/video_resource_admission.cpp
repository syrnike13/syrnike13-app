#include "video_resource_admission.hpp"

#include <algorithm>
#include <limits>
#include <map>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace syrnike::desktop_native::media {
namespace {

std::uint64_t checkedAdd(
    std::uint64_t left,
    std::uint64_t right,
    const char* description) {
  if (right > (std::numeric_limits<std::uint64_t>::max)() - left) {
    throw std::overflow_error(description);
  }
  return left + right;
}

std::uint64_t checkedMultiply(
    std::uint64_t left,
    std::uint64_t right,
    const char* description) {
  if (left != 0 &&
      right > (std::numeric_limits<std::uint64_t>::max)() / left) {
    throw std::overflow_error(description);
  }
  return left * right;
}

std::uint64_t checkedAlignUp(
    std::uint64_t value,
    std::uint64_t alignment,
    const char* description) {
  const auto remainder = value % alignment;
  if (remainder == 0) return value;
  return checkedAdd(value, alignment - remainder, description);
}

// D3D11 exposes the configured dimensions but not a pre-construction physical
// allocation size, and Microsoft documents that RowPitch may include padding.
// For our single-mip, non-MSAA shared textures, the process budget therefore
// uses the stricter Direct3D configured-layout policy represented by
// D3D12_TEXTURE_DATA_PITCH_ALIGNMENT and
// D3D12_DEFAULT_RESOURCE_PLACEMENT_ALIGNMENT. This is a conservative admission
// bound, not a claim about a driver's private heap allocation.
constexpr std::uint64_t kConfiguredRowPitchAlignment = 256;
constexpr std::uint64_t kConfiguredAllocationAlignment = 64 * 1024;

void addUsage(VideoResourceUsage& target, const VideoResourceUsage& addition) {
  target.d3d_devices = checkedAdd(
      target.d3d_devices, addition.d3d_devices, "D3D device usage overflow");
  target.gpu_generations = checkedAdd(
      target.gpu_generations,
      addition.gpu_generations,
      "GPU generation usage overflow");
  target.textures = checkedAdd(
      target.textures, addition.textures, "texture usage overflow");
  target.texture_backing_bytes = checkedAdd(
      target.texture_backing_bytes,
      addition.texture_backing_bytes,
      "texture backing usage overflow");
  target.hardware_encoder_sessions = checkedAdd(
      target.hardware_encoder_sessions,
      addition.hardware_encoder_sessions,
      "hardware encoder usage overflow");
}

void subtractUsage(
    VideoResourceUsage& target,
    const VideoResourceUsage& released) noexcept {
  target.d3d_devices -= released.d3d_devices;
  target.gpu_generations -= released.gpu_generations;
  target.textures -= released.textures;
  target.texture_backing_bytes -= released.texture_backing_bytes;
  target.hardware_encoder_sessions -= released.hardware_encoder_sessions;
}

void updatePeak(VideoResourceUsage& peak, const VideoResourceUsage& current) {
  peak.d3d_devices = std::max(peak.d3d_devices, current.d3d_devices);
  peak.gpu_generations =
      std::max(peak.gpu_generations, current.gpu_generations);
  peak.textures = std::max(peak.textures, current.textures);
  peak.texture_backing_bytes =
      std::max(peak.texture_backing_bytes, current.texture_backing_bytes);
  peak.hardware_encoder_sessions = std::max(
      peak.hardware_encoder_sessions, current.hardware_encoder_sessions);
}

VideoResourceUsage requestUsage(const VideoResourceRequest& request) {
  if (request.owner_id.empty()) {
    throw std::invalid_argument("video resource owner ID is required");
  }
  VideoResourceUsage usage{
      .d3d_devices = request.d3d_devices,
      .gpu_generations = request.gpu_generations,
      .hardware_encoder_sessions = request.hardware_encoder_sessions,
  };
  for (const auto& texture : request.textures) {
    usage.textures = checkedAdd(
        usage.textures, texture.count, "texture count overflow");
    usage.texture_backing_bytes = checkedAdd(
        usage.texture_backing_bytes,
        configuredVideoTextureBytes(texture),
        "texture backing request overflow");
  }
  if (usage == VideoResourceUsage{}) {
    throw std::invalid_argument("video resource request is empty");
  }
  return usage;
}

std::optional<VideoResourceSaturation> saturationFor(
    const VideoResourceLimits& limits,
    const VideoResourceUsage& current,
    const VideoResourceRequest& request,
    const VideoResourceUsage& requested) {
  const auto saturated = [&](VideoResourceClass resource_class,
                             std::uint64_t in_use,
                             std::uint64_t amount,
                             std::uint64_t limit)
      -> std::optional<VideoResourceSaturation> {
    if (amount <= limit && in_use <= limit - amount) return std::nullopt;
    return VideoResourceSaturation{
        .resource_class = resource_class,
        .owner = request.owner,
        .owner_id = request.owner_id,
        .requested_usage = requested,
        .current = in_use,
        .requested = amount,
        .limit = limit,
    };
  };

  if (auto result = saturated(
          VideoResourceClass::D3dDevices,
          current.d3d_devices,
          requested.d3d_devices,
          limits.maximum_d3d_devices)) {
    return result;
  }
  if (auto result = saturated(
          VideoResourceClass::GpuGenerations,
          current.gpu_generations,
          requested.gpu_generations,
          limits.maximum_gpu_generations)) {
    return result;
  }
  if (auto result = saturated(
          VideoResourceClass::Textures,
          current.textures,
          requested.textures,
          limits.maximum_textures)) {
    return result;
  }
  if (auto result = saturated(
          VideoResourceClass::TextureBackingBytes,
          current.texture_backing_bytes,
          requested.texture_backing_bytes,
          limits.maximum_texture_backing_bytes)) {
    return result;
  }
  return saturated(
      VideoResourceClass::HardwareEncoderSessions,
      current.hardware_encoder_sessions,
      requested.hardware_encoder_sessions,
      limits.maximum_hardware_encoder_sessions);
}

}  // namespace

struct VideoResourceBudgetState {
  explicit VideoResourceBudgetState(VideoResourceLimits configured_limits)
      : limits(configured_limits) {}

  mutable std::mutex mutex;
  VideoResourceLimits limits;
  VideoResourceUsage current;
  VideoResourceUsage peak;
  std::uint64_t next_reservation_id = 0;
  std::uint64_t rejected_admissions = 0;
  std::map<std::uint64_t, VideoResourceLeaseIdentity> reservations;
};

const char* videoResourceClassName(
    VideoResourceClass resource_class) noexcept {
  switch (resource_class) {
    case VideoResourceClass::D3dDevices:
      return "d3d_devices";
    case VideoResourceClass::GpuGenerations:
      return "gpu_generations";
    case VideoResourceClass::Textures:
      return "textures";
    case VideoResourceClass::TextureBackingBytes:
      return "texture_backing_bytes";
    case VideoResourceClass::HardwareEncoderSessions:
      return "hardware_encoder_sessions";
  }
  return "unknown";
}

const char* videoResourceOwnerName(VideoResourceOwner owner) noexcept {
  switch (owner) {
    case VideoResourceOwner::ScreenCapture:
      return "screen_capture";
    case VideoResourceOwner::ScreenPreview:
      return "screen_preview";
    case VideoResourceOwner::ScreenEncoder:
      return "screen_encoder";
    case VideoResourceOwner::CameraCapture:
      return "camera_capture";
    case VideoResourceOwner::CameraEncoder:
      return "camera_encoder";
    case VideoResourceOwner::RemoteVideo:
      return "remote_video";
  }
  return "unknown";
}

std::string VideoResourceSaturation::code() const {
  switch (resource_class) {
    case VideoResourceClass::D3dDevices:
      return "gpu_device_saturated";
    case VideoResourceClass::GpuGenerations:
      return "gpu_generation_saturated";
    case VideoResourceClass::Textures:
      return "gpu_texture_saturated";
    case VideoResourceClass::TextureBackingBytes:
      return "gpu_texture_bytes_saturated";
    case VideoResourceClass::HardwareEncoderSessions:
      return "gpu_encoder_session_saturated";
  }
  return "gpu_resource_saturated";
}

std::string VideoResourceSaturation::message() const {
  std::ostringstream output;
  output << code() << ": owner=" << videoResourceOwnerName(owner)
         << " ownerId=" << owner_id
         << " class=" << videoResourceClassName(resource_class)
         << " current=" << current << " requested=" << requested
         << " limit=" << limit;
  return output.str();
}

VideoResourceSaturationError::VideoResourceSaturationError(
    VideoResourceSaturation saturation)
    : std::runtime_error(saturation.message()),
      saturation_(std::move(saturation)) {}

std::uint64_t configuredVideoTextureBytes(
    const VideoTextureLayout& layout) {
  if (layout.width == 0 || layout.height == 0 || layout.count == 0) {
    throw std::invalid_argument(
        "configured video texture dimensions and count must be positive");
  }
  std::uint64_t logical_row_bytes = 0;
  std::uint64_t rows = layout.height;
  switch (layout.format) {
    case VideoTextureFormat::Bgra8:
      logical_row_bytes = checkedMultiply(
          layout.width, 4, "BGRA texture row bytes overflow");
      break;
    case VideoTextureFormat::Nv12:
      if ((layout.width & 1U) != 0 || (layout.height & 1U) != 0) {
        throw std::invalid_argument("NV12 texture dimensions must be even");
      }
      logical_row_bytes = layout.width;
      // Microsoft specifies NV12 staging/init backing as
      // rowPitch * (height + height / 2) for the Y and interleaved UV planes.
      rows = checkedAdd(
          layout.height,
          layout.height / 2,
          "NV12 texture plane rows overflow");
      break;
  }
  const auto configured_row_pitch = checkedAlignUp(
      logical_row_bytes,
      kConfiguredRowPitchAlignment,
      "configured video texture row pitch overflow");
  const auto configured_surface_bytes = checkedMultiply(
      configured_row_pitch,
      rows,
      "configured video texture surface backing overflow");
  const auto configured_bytes_per_texture = checkedAlignUp(
      configured_surface_bytes,
      kConfiguredAllocationAlignment,
      "configured video texture allocation backing overflow");
  return checkedMultiply(
      configured_bytes_per_texture,
      layout.count,
      "configured texture pool backing overflow");
}

VideoResourceLease::VideoResourceLease(
    std::shared_ptr<VideoResourceBudgetState> state,
    VideoResourceLeaseIdentity identity)
    : state_(std::move(state)), identity_(std::move(identity)) {}

VideoResourceLease::~VideoResourceLease() {
  if (!state_ || identity_.reservation_id == 0) return;
  std::lock_guard lock(state_->mutex);
  const auto found = state_->reservations.find(identity_.reservation_id);
  if (found == state_->reservations.end()) return;
  subtractUsage(state_->current, found->second.usage);
  state_->reservations.erase(found);
}

VideoResourceAdmissionBudget::VideoResourceAdmissionBudget(
    VideoResourceLimits limits)
    : state_(std::make_shared<VideoResourceBudgetState>(limits)) {}

VideoResourceAdmission VideoResourceAdmissionBudget::tryAcquire(
    const VideoResourceRequest& request) {
  const auto usage = requestUsage(request);
  std::lock_guard lock(state_->mutex);
  if (const auto saturation = saturationFor(
          state_->limits, state_->current, request, usage)) {
    ++state_->rejected_admissions;
    return {.saturation = saturation};
  }
  if (state_->next_reservation_id ==
      (std::numeric_limits<std::uint64_t>::max)()) {
    throw std::overflow_error("video resource reservation ID exhausted");
  }
  VideoResourceLeaseIdentity identity{
      .reservation_id = ++state_->next_reservation_id,
      .owner = request.owner,
      .owner_id = request.owner_id,
      .usage = usage,
  };
  auto next_current = state_->current;
  addUsage(next_current, usage);
  auto next_peak = state_->peak;
  updatePeak(next_peak, next_current);
  auto lease = std::shared_ptr<VideoResourceLease>(
      new VideoResourceLease(state_, identity));
  // Both allocations complete before publishing the accounting mutation. A
  // bad_alloc therefore leaves neither usage nor a half-visible reservation.
  state_->reservations.emplace(identity.reservation_id, identity);
  state_->current = next_current;
  state_->peak = next_peak;
  return {
      .lease = std::move(lease),
  };
}

VideoResourceBudgetSnapshot VideoResourceAdmissionBudget::snapshot() const {
  std::lock_guard lock(state_->mutex);
  VideoResourceBudgetSnapshot result{
      .limits = state_->limits,
      .current = state_->current,
      .peak = state_->peak,
      .active_reservations = state_->reservations.size(),
      .rejected_admissions = state_->rejected_admissions,
  };
  result.reservations.reserve(state_->reservations.size());
  for (const auto& [_, reservation] : state_->reservations) {
    result.reservations.push_back(reservation);
  }
  return result;
}

VideoResourceUsage VideoResourceAdmissionBudget::usageFor(
    VideoResourceOwner owner,
    std::string_view owner_id) const {
  VideoResourceUsage usage;
  std::lock_guard lock(state_->mutex);
  for (const auto& [_, reservation] : state_->reservations) {
    if (reservation.owner != owner ||
        std::string_view(reservation.owner_id) != owner_id) {
      continue;
    }
    addUsage(usage, reservation.usage);
  }
  return usage;
}

std::shared_ptr<VideoResourceLease> requireVideoResourceAdmission(
    VideoResourceAdmissionBudget& budget,
    const VideoResourceRequest& request) {
  auto admission = budget.tryAcquire(request);
  if (admission.lease) return std::move(admission.lease);
  if (!admission.saturation) {
    throw std::logic_error("video resource admission returned no outcome");
  }
  throw VideoResourceSaturationError(std::move(*admission.saturation));
}

VideoResourceAdmissionBudget& processVideoResourceAdmissionBudget() {
  static VideoResourceAdmissionBudget budget(productionVideoResourceLimits());
  return budget;
}

}  // namespace syrnike::desktop_native::media
