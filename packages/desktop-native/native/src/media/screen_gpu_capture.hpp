#pragma once

#include <windows.h>
#include <dxgiformat.h>

#include <cstdint>
#include <cstddef>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "screen_video_capture.hpp"

namespace syrnike::desktop_native::media {

class CaptureBackendSupervisor;
class VideoResourceAdmissionBudget;
class VideoResourceLease;
struct VideoResourceRequest;

enum class ScreenGpuCaptureErrorCode {
  CaptureUnavailable,
  AccessLost,
  DeviceUnavailable,
  InteropUnavailable,
  FormatUnsupported,
  ResourceSaturated,
  GpuTimeout,
  DeviceLost,
  PermissionDenied,
  TargetClosed,
};

struct ScreenGpuBackendFailure {
  std::string backend;
  ScreenGpuCaptureErrorCode code =
      ScreenGpuCaptureErrorCode::CaptureUnavailable;
  long hresult = 0;
  std::string message;
};

class ScreenGpuCaptureError final : public std::runtime_error {
 public:
  ScreenGpuCaptureError(
      ScreenGpuCaptureErrorCode code,
      std::string message,
      long hresult = 0,
      std::vector<ScreenGpuBackendFailure> backend_failures = {});

  [[nodiscard]] ScreenGpuCaptureErrorCode code() const noexcept { return code_; }
  [[nodiscard]] long hresult() const noexcept { return hresult_; }
  [[nodiscard]] const std::vector<ScreenGpuBackendFailure>&
  backendFailures() const noexcept { return backend_failures_; }

 private:
  ScreenGpuCaptureErrorCode code_;
  long hresult_;
  std::vector<ScreenGpuBackendFailure> backend_failures_;
};

// Screen capture and its compositor share this adapter so every saturation
// reports the same resource identity/counts before becoming a typed capture
// failure.
[[nodiscard]] std::shared_ptr<VideoResourceLease>
requireScreenVideoResourceAdmission(
    VideoResourceAdmissionBudget& budget,
    const VideoResourceRequest& request);

ScreenGpuCaptureError combineInitialMonitorCaptureFailures(
    const ScreenGpuCaptureError& dxgi_failure,
    const ScreenGpuCaptureError& wgc_failure);

enum class ScreenGpuFrameStatus {
  NewFrame,
  NoFrame,
  EncoderBackpressure,
  RecoverableLost,
  TargetClosed,
  FatalError,
};

struct ScreenGpuFrame {
  std::uint64_t sequence = 0;
  std::uint64_t timestamp_us = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t slot = 0;
  HANDLE shared_texture_handle = nullptr;
  LUID adapter_luid{};
  DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN;
};

struct ScreenGpuRecoveryTransition {
  std::string backend;
  std::string action;
  std::uint64_t count = 0;
  long hresult = 0;
  ScreenGpuCaptureErrorCode error_code =
      ScreenGpuCaptureErrorCode::CaptureUnavailable;
};

struct ScreenGpuFrameResult {
  ScreenGpuFrameStatus status = ScreenGpuFrameStatus::NoFrame;
  syrnike::voice::ScreenCaptureFrameMetrics metrics;
  const char* method = "unknown";
  ScreenGpuCaptureErrorCode error_code = ScreenGpuCaptureErrorCode::CaptureUnavailable;
  std::optional<ScreenGpuRecoveryTransition> recovery_transition;
  bool source_submitted = false;
  bool gpu_capacity_exhausted = false;
};

struct ScreenFrameFlowStats {
  std::uint64_t source_updates = 0;
  std::uint64_t gpu_submissions = 0;
  std::uint64_t idle_refreshes = 0;
  std::uint64_t coalesced_source_updates = 0;
  std::uint64_t encoder_backpressure_ticks = 0;
  std::uint64_t superseded_ready_frames = 0;
  std::uint64_t gpu_slot_timeouts = 0;
  std::uint64_t gpu_slots_recovered = 0;
  std::uint64_t gpu_frames_dropped_stale = 0;
  std::uint64_t gpu_pool_rollovers = 0;
  std::uint64_t gpu_rollovers_blocked = 0;
  std::uint64_t gpu_retired_generations = 0;
  std::uint64_t gpu_slots_quarantined = 0;
  std::uint64_t preview_bridge_submissions = 0;
  std::uint64_t preview_bridge_acquires = 0;
  std::uint64_t preview_bridge_timeouts = 0;
  std::uint64_t preview_bridge_slots_recovered = 0;
  std::uint64_t preview_gpu_submissions = 0;
  std::uint64_t preview_frames_completed = 0;
  std::uint64_t preview_slot_timeouts = 0;
  std::uint64_t preview_frames_dropped_stale = 0;
  std::uint64_t preview_device_resets = 0;
  std::uint64_t gpu_completion_p50_us = 0;
  std::uint64_t gpu_completion_p95_us = 0;
  std::uint64_t gpu_completion_max_us = 0;
};

struct ScreenPreviewDemand {
  bool demanded = false;
  std::uint32_t width = 1280;
  std::uint32_t height = 720;
  std::uint32_t fps = 30;
  std::uint32_t electron_main_pid = 0;
};

struct ScreenPreviewFrame {
  std::uint64_t sequence = 0;
  std::uint64_t timestamp_us = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint64_t nt_handle = 0;
};

struct ScreenPreviewFailure {
  ScreenGpuCaptureErrorCode code = ScreenGpuCaptureErrorCode::InteropUnavailable;
  long hresult = 0;
  std::string message;
  std::uint64_t suppressed = 0;
};

// A strict GPU-only capturer. Every NewFrame references a shared NV12 D3D11
// texture guarded by IDXGIKeyedMutex: producer key 0, consumer key 1. The
// downstream encoder must release key 0 after it has finished reading.
class ScreenGpuCapturer {
 public:
  static std::shared_ptr<ScreenGpuCapturer> create(
      const syrnike::voice::ScreenCaptureTarget& target,
      std::uint32_t width,
      std::uint32_t height,
      std::shared_ptr<CaptureBackendSupervisor> supervisor = {},
      VideoResourceAdmissionBudget* resource_budget = nullptr);

  virtual ~ScreenGpuCapturer() = default;
  virtual ScreenGpuFrameResult capture(ScreenGpuFrame& frame) = 0;
  virtual void discard(const ScreenGpuFrame& frame) noexcept = 0;
  // Called only after the outbound encoder has received the current frame.
  // Implementations may enqueue an optional preview copy, but must never wait
  // for preview resize/import/delivery work.
  virtual bool requestPreviewFrame() noexcept { return false; }
  // Runs preview/recovery retirement work on the actor's optional-work lane.
  // Active encoder capture must never call this method inline.
  virtual void pollOptionalWork() noexcept {}
  [[nodiscard]] virtual bool optionalWorkPending() const noexcept {
    return false;
  }
  virtual void setPreviewDemand(ScreenPreviewDemand demand) = 0;
  virtual bool takePreviewFrame(ScreenPreviewFrame& frame) = 0;
  virtual bool takePreviewFailure(ScreenPreviewFailure& failure) = 0;
  virtual void releasePreviewFrame(std::uint64_t sequence) noexcept = 0;
  [[nodiscard]] virtual std::size_t previewFramesInFlight() const noexcept = 0;
  [[nodiscard]] virtual const char* method() const noexcept = 0;
  [[nodiscard]] virtual LUID adapterLuid() const noexcept = 0;
  [[nodiscard]] virtual std::size_t frameSlotsAvailable() const noexcept = 0;
  [[nodiscard]] virtual std::size_t frameSlotsTotal() const noexcept = 0;
  [[nodiscard]] virtual bool retirementSafe() const noexcept {
    return previewFramesInFlight() == 0 &&
        frameSlotsAvailable() == frameSlotsTotal();
  }
  virtual void pollRetirement() noexcept = 0;
  [[nodiscard]] virtual ScreenFrameFlowStats frameFlowStats() const noexcept = 0;
  [[nodiscard]] virtual std::uint64_t recoverableLossCount() const noexcept {
    return 0;
  }
};

}  // namespace syrnike::desktop_native::media
