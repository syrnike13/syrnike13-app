#include "screen_gpu_capture.hpp"

#include <d3d11.h>
#include <d3d11_1.h>
#include <d3dcompiler.h>
#include <dxgi1_2.h>
#include <Windows.Graphics.Capture.Interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <wrl/client.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Security.Authorization.AppCapabilityAccess.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <numeric>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "../common/diagnostic_log.hpp"
#include "d3d11_gpu_completion.hpp"
#include "capture_backend_supervisor.hpp"
#include "gpu_completion_slot_policy.hpp"
#include "screen_capture_slot_state.hpp"
#include "screen_capture_priority.hpp"
#include "screen_dxgi_compositor.hpp"
#include "screen_frame_pipeline.hpp"
#include "screen_gpu_retirement.hpp"
#include "video_resource_admission.hpp"

using Microsoft::WRL::ComPtr;
namespace capture = winrt::Windows::Graphics::Capture;
namespace directx = winrt::Windows::Graphics::DirectX;
namespace d3dwinrt = winrt::Windows::Graphics::DirectX::Direct3D11;
namespace metadata = winrt::Windows::Foundation::Metadata;
namespace appcap = winrt::Windows::Security::Authorization::AppCapabilityAccess;

namespace syrnike::desktop_native::media {

std::shared_ptr<VideoResourceLease> requireScreenVideoResourceAdmission(
    VideoResourceAdmissionBudget& budget,
    const VideoResourceRequest& request) {
  try {
    return requireVideoResourceAdmission(budget, request);
  } catch (const VideoResourceSaturationError& error) {
    const auto& saturation = error.saturation();
    auto& logger = diagnostics::DiagnosticLog::instance();
    if (logger.enabled()) {
      logger.write(
          "screen_video_resource_saturated",
          {
              {"owner", videoResourceOwnerName(saturation.owner)},
              {"ownerId", saturation.owner_id},
              {"resourceClass",
               videoResourceClassName(saturation.resource_class)},
              {"current", saturation.current},
              {"requested", saturation.requested},
              {"limit", saturation.limit},
          });
    }
    throw ScreenGpuCaptureError(
        ScreenGpuCaptureErrorCode::ResourceSaturated,
        error.what());
  }
}

namespace {

constexpr std::size_t kOutputPoolSize = 5;
constexpr UINT64 kProducerKey = 0;
constexpr UINT64 kConsumerKey = 1;
constexpr auto kGpuCompletionTimeout = std::chrono::milliseconds(500);
constexpr std::size_t kMaxRetiredGpuPoolGenerations = 2;

std::string screenResourceOwnerId(
    const syrnike::voice::ScreenCaptureTarget& target) {
  if (target.window) {
    return "screen:window:" + std::to_string(
        reinterpret_cast<std::uintptr_t>(target.hwnd));
  }
  return "screen:monitor:" + std::to_string(target.screen_index);
}

std::string_view captureBackendName(CaptureBackend backend) noexcept {
  return backend == CaptureBackend::Dxgi ? "dxgi_gpu" : "wgc_gpu";
}

std::string_view captureErrorCodeName(
    ScreenGpuCaptureErrorCode code) noexcept {
  switch (code) {
    case ScreenGpuCaptureErrorCode::CaptureUnavailable:
      return "capture_unavailable";
    case ScreenGpuCaptureErrorCode::AccessLost:
      return "access_lost";
    case ScreenGpuCaptureErrorCode::DeviceUnavailable:
      return "device_unavailable";
    case ScreenGpuCaptureErrorCode::InteropUnavailable:
      return "interop_unavailable";
    case ScreenGpuCaptureErrorCode::FormatUnsupported:
      return "format_unsupported";
    case ScreenGpuCaptureErrorCode::ResourceSaturated:
      return "resource_saturated";
    case ScreenGpuCaptureErrorCode::GpuTimeout:
      return "gpu_timeout";
    case ScreenGpuCaptureErrorCode::DeviceLost:
      return "device_lost";
    case ScreenGpuCaptureErrorCode::PermissionDenied:
      return "permission_denied";
    case ScreenGpuCaptureErrorCode::TargetClosed:
      return "target_closed";
  }
  return "capture_unavailable";
}

std::string_view captureBackendActionName(
    CaptureBackendAction action) noexcept {
  switch (action) {
    case CaptureBackendAction::None:
      return "none";
    case CaptureBackendAction::ReinitializeActive:
      return "reinitialize_active";
    case CaptureBackendAction::RecreateActivePipeline:
      return "recreate_active_pipeline";
    case CaptureBackendAction::RecreateDevice:
      return "recreate_device";
    case CaptureBackendAction::SwitchBackend:
      return "switch_backend";
    case CaptureBackendAction::ProbePreferredBackend:
      return "probe_preferred_backend";
    case CaptureBackendAction::Fail:
      return "fail";
  }
  return "unknown";
}

void logScreenCaptureBackend(
    std::string_view event,
    std::string_view from,
    std::string_view to,
    std::string_view reason,
    long hresult = 0) noexcept {
  auto& logger = diagnostics::DiagnosticLog::instance();
  if (!logger.enabled()) return;
  logger.write(
      event,
      {
          {"from", from},
          {"to", to},
          {"reason", reason},
          {"hresult", static_cast<std::int64_t>(hresult)},
      });
}

void logInitialBackendFailure(
    const ScreenGpuCaptureError& failure) noexcept {
  auto& logger = diagnostics::DiagnosticLog::instance();
  if (!logger.enabled()) return;
  const auto& causes = failure.backendFailures();
  if (causes.size() != 2) return;
  logger.write(
      "screen_capture_backend_initialization_failed",
      {
          {"dxgiReason", captureErrorCodeName(causes[0].code)},
          {"dxgiHresult", static_cast<std::int64_t>(causes[0].hresult)},
          {"dxgiMessage", causes[0].message},
          {"wgcReason", captureErrorCodeName(causes[1].code)},
          {"wgcHresult", static_cast<std::int64_t>(causes[1].hresult)},
          {"wgcMessage", causes[1].message},
      });
}

std::uint64_t nextScreenFrameSequence() noexcept {
  static std::atomic<std::uint64_t> sequence{0};
  return sequence.fetch_add(1, std::memory_order_relaxed) + 1;
}

appcap::AppCapabilityAccessStatus borderlessCaptureAccess() noexcept {
  static std::once_flag once;
  static appcap::AppCapabilityAccessStatus cached =
      appcap::AppCapabilityAccessStatus::DeniedBySystem;
  std::call_once(once, [] {
    try {
      const auto operation = capture::GraphicsCaptureAccess::RequestAccessAsync(
          capture::GraphicsCaptureAccessKind::Borderless);
      const auto deadline =
          std::chrono::steady_clock::now() + std::chrono::milliseconds(750);
      while (operation.Status() ==
                 winrt::Windows::Foundation::AsyncStatus::Started &&
             std::chrono::steady_clock::now() < deadline) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }
      if (operation.Status() ==
          winrt::Windows::Foundation::AsyncStatus::Completed) {
        cached = operation.GetResults();
      } else {
        operation.Cancel();
      }
    } catch (...) {
    }
  });
  return cached;
}

void disableCaptureBorderIfAllowed(
    const capture::GraphicsCaptureSession& session) {
  try {
    if (!metadata::ApiInformation::IsApiContractPresent(
            L"Windows.Foundation.UniversalApiContract", 12) ||
        !metadata::ApiInformation::IsPropertyPresent(
            L"Windows.Graphics.Capture.GraphicsCaptureSession",
            L"IsBorderRequired")) {
      return;
    }

    const auto status = borderlessCaptureAccess();
    if (status == appcap::AppCapabilityAccessStatus::Allowed) {
      session.IsBorderRequired(false);
    }
  } catch (...) {
  }
}

std::uint64_t steadyMicros() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::steady_clock::now().time_since_epoch())
          .count());
}

bool sameLuid(const LUID& left, const LUID& right) {
  return left.HighPart == right.HighPart && left.LowPart == right.LowPart;
}

bool secureDesktopActive() noexcept {
  SetLastError(ERROR_SUCCESS);
  const HDESK desktop = OpenInputDesktop(
      0, FALSE, DESKTOP_SWITCHDESKTOP | DESKTOP_READOBJECTS);
  if (desktop) {
    CloseDesktop(desktop);
    return false;
  }
  return GetLastError() == ERROR_ACCESS_DENIED;
}

ScreenGpuCaptureErrorCode captureErrorForHr(HRESULT hr) noexcept {
  if (hr == DXGI_ERROR_ACCESS_LOST) {
    return ScreenGpuCaptureErrorCode::AccessLost;
  }
  if (hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET ||
      hr == DXGI_ERROR_DEVICE_HUNG) {
    return ScreenGpuCaptureErrorCode::DeviceLost;
  }
  if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
    return ScreenGpuCaptureErrorCode::GpuTimeout;
  }
  if (hr == E_ACCESSDENIED) {
    return ScreenGpuCaptureErrorCode::PermissionDenied;
  }
  if (hr == RO_E_CLOSED) return ScreenGpuCaptureErrorCode::TargetClosed;
  return ScreenGpuCaptureErrorCode::CaptureUnavailable;
}

[[noreturn]] void throwHr(
    ScreenGpuCaptureErrorCode code,
    const char* message,
    HRESULT hr) {
  throw ScreenGpuCaptureError(code, message, static_cast<long>(hr));
}

void requireHr(
    HRESULT hr,
    ScreenGpuCaptureErrorCode code,
    const char* message) {
  if (FAILED(hr)) throwHr(code, message, hr);
}

void requireGpuCompletion(HRESULT hr, const char* message) {
  if (SUCCEEDED(hr)) return;
  auto code = captureErrorForHr(hr);
  if (code == ScreenGpuCaptureErrorCode::CaptureUnavailable) {
    code = ScreenGpuCaptureErrorCode::DeviceLost;
  }
  throwHr(code, message, hr);
}

struct AdapterSelection {
  ComPtr<IDXGIAdapter1> adapter;
  ComPtr<IDXGIOutput1> output;
  DXGI_ADAPTER_DESC1 adapter_description{};
  DXGI_OUTPUT_DESC output_description{};
  UINT output_index = 0;
};

AdapterSelection selectAdapter(const syrnike::voice::ScreenCaptureTarget& target) {
  const HMONITOR requested_monitor = target.window
      ? MonitorFromWindow(target.hwnd, MONITOR_DEFAULTTONEAREST)
      : syrnike::voice::resolveScreenMonitorHandle(target);
  if (!target.window && !requested_monitor) {
    throw ScreenGpuCaptureError(
        ScreenGpuCaptureErrorCode::TargetClosed,
        "selected monitor is no longer available");
  }

  ComPtr<IDXGIFactory1> factory;
  requireHr(
      CreateDXGIFactory1(IID_PPV_ARGS(&factory)),
      ScreenGpuCaptureErrorCode::DeviceUnavailable,
      "failed to create DXGI factory");

  for (UINT adapter_index = 0;; ++adapter_index) {
    ComPtr<IDXGIAdapter1> adapter;
    const HRESULT adapter_result = factory->EnumAdapters1(adapter_index, &adapter);
    if (adapter_result == DXGI_ERROR_NOT_FOUND) break;
    requireHr(
        adapter_result,
        ScreenGpuCaptureErrorCode::DeviceUnavailable,
        "failed to enumerate DXGI adapters");

    DXGI_ADAPTER_DESC1 adapter_description{};
    requireHr(
        adapter->GetDesc1(&adapter_description),
        ScreenGpuCaptureErrorCode::DeviceUnavailable,
        "failed to describe DXGI adapter");
    if ((adapter_description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0) continue;

    for (UINT output_index = 0;; ++output_index) {
      ComPtr<IDXGIOutput> output;
      const HRESULT output_result = adapter->EnumOutputs(output_index, &output);
      if (output_result == DXGI_ERROR_NOT_FOUND) break;
      requireHr(
          output_result,
          ScreenGpuCaptureErrorCode::DeviceUnavailable,
          "failed to enumerate DXGI outputs");
      DXGI_OUTPUT_DESC output_description{};
      requireHr(
          output->GetDesc(&output_description),
          ScreenGpuCaptureErrorCode::DeviceUnavailable,
          "failed to describe DXGI output");
      const bool selected =
          output_description.Monitor == requested_monitor;
      if (!selected) continue;

      ComPtr<IDXGIOutput1> output1;
      requireHr(
          output.As(&output1),
          ScreenGpuCaptureErrorCode::CaptureUnavailable,
          "selected output does not support Desktop Duplication");
      return {
          std::move(adapter),
          std::move(output1),
          adapter_description,
          output_description,
          output_index,
      };
    }
  }
  if (!target.window &&
      !syrnike::voice::resolveScreenMonitorHandle(target)) {
    throw ScreenGpuCaptureError(
        ScreenGpuCaptureErrorCode::TargetClosed,
        "selected monitor is no longer available");
  }
  throw ScreenGpuCaptureError(
      ScreenGpuCaptureErrorCode::DeviceUnavailable,
      "no hardware DXGI adapter owns the selected capture target");
}

struct D3dDevice {
  std::shared_ptr<VideoResourceLease> resource_lease;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  LUID adapter_luid{};
};

D3dDevice createDevice(
    const AdapterSelection& selection,
    VideoResourceAdmissionBudget& resource_budget,
    std::string owner_id) {
  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
  D3D_FEATURE_LEVEL feature_level{};
  D3dDevice result;
  result.resource_lease = requireScreenVideoResourceAdmission(
      resource_budget,
      VideoResourceRequest{
          .owner = VideoResourceOwner::ScreenCapture,
          .owner_id = std::move(owner_id),
          .d3d_devices = 1,
          .gpu_generations = 1,
      });
  requireHr(
      D3D11CreateDevice(
          selection.adapter.Get(),
          D3D_DRIVER_TYPE_UNKNOWN,
          nullptr,
          flags,
          nullptr,
          0,
          D3D11_SDK_VERSION,
          &result.device,
          &feature_level,
          &result.context),
      ScreenGpuCaptureErrorCode::DeviceUnavailable,
      "failed to create capture D3D11 device");
  if (feature_level < D3D_FEATURE_LEVEL_11_0) {
    throw ScreenGpuCaptureError(
        ScreenGpuCaptureErrorCode::DeviceUnavailable,
        "screen capture requires D3D feature level 11_0");
  }
  ComPtr<IDXGIDevice> dxgi_device;
  requireHr(
      result.device.As(&dxgi_device),
      ScreenGpuCaptureErrorCode::DeviceUnavailable,
      "failed to query capture DXGI device");
  const auto& priority =
      syrnike::voice::configuredScreenMediaPriorityPolicy();
  static_cast<void>(syrnike::voice::setD3dGpuThreadPriority(
      dxgi_device.Get(),
      priority.publication_gpu_priority,
      syrnike::voice::ScreenD3dPriorityRole::Publication));
  DXGI_ADAPTER_DESC adapter_description{};
  requireHr(
      selection.adapter->GetDesc(&adapter_description),
      ScreenGpuCaptureErrorCode::DeviceUnavailable,
      "failed to read capture adapter LUID");
  result.adapter_luid = adapter_description.AdapterLuid;
  return result;
}

D3dDevice createSiblingDevice(
    ID3D11Device* source,
    VideoResourceAdmissionBudget& resource_budget,
    std::string owner_id) {
  ComPtr<IDXGIDevice> dxgi_device;
  requireHr(
      source->QueryInterface(IID_PPV_ARGS(&dxgi_device)),
      ScreenGpuCaptureErrorCode::DeviceUnavailable,
      "capture device does not expose IDXGIDevice");
  ComPtr<IDXGIAdapter> adapter;
  requireHr(
      dxgi_device->GetAdapter(&adapter),
      ScreenGpuCaptureErrorCode::DeviceUnavailable,
      "failed to resolve capture adapter for preview isolation");
  DXGI_ADAPTER_DESC description{};
  requireHr(
      adapter->GetDesc(&description),
      ScreenGpuCaptureErrorCode::DeviceUnavailable,
      "failed to describe preview adapter");

  D3dDevice result;
  result.resource_lease = requireScreenVideoResourceAdmission(
      resource_budget,
      VideoResourceRequest{
          .owner = VideoResourceOwner::ScreenPreview,
          .owner_id = std::move(owner_id),
          .d3d_devices = 1,
          .gpu_generations = 1,
      });
  D3D_FEATURE_LEVEL feature_level{};
  requireHr(
      D3D11CreateDevice(
          adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
          D3D11_CREATE_DEVICE_BGRA_SUPPORT |
              D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
          nullptr, 0, D3D11_SDK_VERSION, &result.device, &feature_level,
          &result.context),
      ScreenGpuCaptureErrorCode::DeviceUnavailable,
      "failed to create isolated preview D3D11 device");
  if (feature_level < D3D_FEATURE_LEVEL_11_0) {
    throw ScreenGpuCaptureError(
        ScreenGpuCaptureErrorCode::DeviceUnavailable,
        "isolated preview D3D11 device does not support feature level 11");
  }
  ComPtr<IDXGIDevice> preview_dxgi_device;
  if (SUCCEEDED(result.device.As(&preview_dxgi_device))) {
    const auto& priority =
        syrnike::voice::configuredScreenMediaPriorityPolicy();
    static_cast<void>(syrnike::voice::setD3dGpuThreadPriority(
        preview_dxgi_device.Get(),
        priority.preview_gpu_priority,
        syrnike::voice::ScreenD3dPriorityRole::Preview));
  }
  result.adapter_luid = description.AdapterLuid;
  return result;
}

RECT fitRect(
    std::uint32_t source_width,
    std::uint32_t source_height,
    std::uint32_t output_width,
    std::uint32_t output_height) {
  if (source_width == 0 || source_height == 0) return {};
  const double scale = std::min(
      static_cast<double>(output_width) / source_width,
      static_cast<double>(output_height) / source_height);
  const LONG width = static_cast<LONG>(std::max(2.0, std::floor(source_width * scale))) & ~1L;
  const LONG height = static_cast<LONG>(std::max(2.0, std::floor(source_height * scale))) & ~1L;
  const LONG left = (static_cast<LONG>(output_width) - width) / 2;
  const LONG top = (static_cast<LONG>(output_height) - height) / 2;
  return {left, top, left + width, top + height};
}

class GpuFramePool {
 public:
  GpuFramePool(
      ID3D11Device* device,
      ID3D11DeviceContext* context,
      LUID adapter_luid,
      std::uint32_t output_width,
      std::uint32_t output_height,
      std::shared_ptr<VideoResourceLease> resource_lease)
      : resource_lease_(std::move(resource_lease)),
        device_(device),
        context_(context),
        adapter_luid_(adapter_luid),
        output_width_(output_width),
        output_height_(output_height) {
    if (!device_ || !context_ || output_width_ == 0 || output_height_ == 0 ||
        (output_width_ & 1U) != 0 || (output_height_ & 1U) != 0) {
      throw ScreenGpuCaptureError(
          ScreenGpuCaptureErrorCode::FormatUnsupported,
          "NV12 output dimensions must be non-zero and even");
    }
    requireHr(
        device_->QueryInterface(IID_PPV_ARGS(&video_device_)),
        ScreenGpuCaptureErrorCode::FormatUnsupported,
        "D3D11 video device is unavailable");
    requireHr(
        context_->QueryInterface(IID_PPV_ARGS(&video_context_)),
        ScreenGpuCaptureErrorCode::FormatUnsupported,
        "D3D11 video context is unavailable");
    createTextures();
  }

  ~GpuFramePool() {
    for (auto& slot : slots_) {
      if (slot.shared_handle) CloseHandle(slot.shared_handle);
    }
  }

  ScreenGpuFrameResult process(
      ID3D11Texture2D* source,
      std::uint32_t source_width,
      std::uint32_t source_height,
      std::uint32_t content_width,
      std::uint32_t content_height,
      std::uint64_t timestamp_us,
      const char* method,
      syrnike::voice::ScreenCaptureFrameMetrics metrics,
      ScreenGpuFrame& frame) {
    retryPendingDiscards();
    pollCompletions();
    if (!source || source_width == 0 || source_height == 0) {
      return result(ScreenGpuFrameStatus::FatalError, method, metrics,
                    ScreenGpuCaptureErrorCode::InteropUnavailable);
    }
    configure(source_width, source_height);

    bool submitted = false;
    for (std::size_t attempt = 0; attempt < slots_.size(); ++attempt) {
      const std::size_t index = (next_slot_ + attempt) % slots_.size();
      auto& slot = slots_[index];
      if (slot.phase != SlotPhase::Available) continue;
      const HRESULT acquire = slot.mutex->AcquireSync(kProducerKey, 0);
      if (acquire == WAIT_TIMEOUT) continue;
      if (FAILED(acquire)) {
        metrics.hresult = static_cast<long>(acquire);
        return result(ScreenGpuFrameStatus::FatalError, method, metrics,
                      ScreenGpuCaptureErrorCode::DeviceLost);
      }
      slot_state_.producerAcquired(index);

      const auto sequence = nextScreenFrameSequence();
      bool gpu_work_submitted = false;
      try {
        D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC input_description{};
        input_description.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
        input_description.Texture2D.MipSlice = 0;
        input_description.Texture2D.ArraySlice = 0;
        ComPtr<ID3D11VideoProcessorInputView> input_view;
        requireHr(
            video_device_->CreateVideoProcessorInputView(
                source, enumerator_.Get(), &input_description, &input_view),
            ScreenGpuCaptureErrorCode::InteropUnavailable,
            "failed to create GPU capture input view");

        const RECT source_rect{
            0,
            0,
            static_cast<LONG>(std::min(source_width, content_width)),
            static_cast<LONG>(std::min(source_height, content_height)),
        };
        const RECT output_rect{
            0,
            0,
            static_cast<LONG>(output_width_),
            static_cast<LONG>(output_height_),
        };
        const RECT destination_rect = fitRect(
            static_cast<std::uint32_t>(source_rect.right),
            static_cast<std::uint32_t>(source_rect.bottom),
            output_width_,
            output_height_);
        video_context_->VideoProcessorSetStreamFrameFormat(
            processor_.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE input_color{};
        input_color.RGB_Range = 0;  // Full-range RGB from WGC/DXGI.
        input_color.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255;
        video_context_->VideoProcessorSetStreamColorSpace(
            processor_.Get(), 0, &input_color);
        D3D11_VIDEO_PROCESSOR_COLOR_SPACE output_color{};
        output_color.YCbCr_Matrix = 1;  // BT.709 for HD screen content.
        output_color.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
        video_context_->VideoProcessorSetOutputColorSpace(
            processor_.Get(), &output_color);
        video_context_->VideoProcessorSetStreamSourceRect(
            processor_.Get(), 0, TRUE, &source_rect);
        video_context_->VideoProcessorSetStreamDestRect(
            processor_.Get(), 0, TRUE, &destination_rect);
        video_context_->VideoProcessorSetOutputTargetRect(
            processor_.Get(), TRUE, &output_rect);
        D3D11_VIDEO_COLOR background{};
        background.YCbCr.Y = 0.0F;
        background.YCbCr.Cb = 0.5F;
        background.YCbCr.Cr = 0.5F;
        background.YCbCr.A = 1.0F;
        video_context_->VideoProcessorSetOutputBackgroundColor(
            processor_.Get(), TRUE, &background);

        D3D11_VIDEO_PROCESSOR_STREAM stream{};
        stream.Enable = TRUE;
        stream.pInputSurface = input_view.Get();
        requireHr(
            video_context_->VideoProcessorBlt(
                processor_.Get(), slot.output_view.Get(), 0, 1, &stream),
            ScreenGpuCaptureErrorCode::DeviceLost,
            "GPU screen conversion failed");
        gpu_work_submitted = true;
        slot.input_view = std::move(input_view);
        requireHr(
            slot.completion->begin(kGpuCompletionTimeout),
            ScreenGpuCaptureErrorCode::DeviceLost,
            "failed to arm GPU screen conversion completion");
        slot.sequence = sequence;
        slot.timestamp_us = timestamp_us != 0 ? timestamp_us : steadyMicros();
        metrics.output_width = output_width_;
        metrics.output_height = output_height_;
        slot.metrics = metrics;
        slot.phase = SlotPhase::Converting;
      } catch (const ScreenGpuCaptureError& error) {
        slot.input_view.Reset();
        if (gpu_work_submitted ||
            error.code() == ScreenGpuCaptureErrorCode::DeviceLost ||
            error.code() == ScreenGpuCaptureErrorCode::DeviceUnavailable) {
          markDeviceFailed();
        } else {
          static_cast<void>(slot.mutex->ReleaseSync(kProducerKey));
        }
        throw;
      } catch (...) {
        slot.input_view.Reset();
        if (gpu_work_submitted) {
          markDeviceFailed();
        } else {
          static_cast<void>(slot.mutex->ReleaseSync(kProducerKey));
        }
        throw;
      }

      next_slot_ = (index + 1) % slots_.size();
      submitted = true;
      ++gpu_submissions_;
      break;
    }

    pollCompletions();
    if (publishReady(frame)) {
      return result(
          ScreenGpuFrameStatus::NewFrame,
          method,
          slots_[frame.slot].metrics,
          ScreenGpuCaptureErrorCode::CaptureUnavailable,
          submitted);
    }
    if (submitted) {
      return result(ScreenGpuFrameStatus::NoFrame, method, metrics,
                    ScreenGpuCaptureErrorCode::CaptureUnavailable, true);
    }
    if (capacityExhausted()) {
      metrics.hresult = static_cast<long>(DXGI_ERROR_WAIT_TIMEOUT);
      return result(
          ScreenGpuFrameStatus::NoFrame,
          method,
          metrics,
          ScreenGpuCaptureErrorCode::GpuTimeout,
          false,
          true);
    }
    if (std::any_of(
            slots_.begin(), slots_.end(), [](const Slot& slot) {
              return slot.phase == SlotPhase::Converting;
            })) {
      return result(ScreenGpuFrameStatus::NoFrame, method, metrics,
                    ScreenGpuCaptureErrorCode::CaptureUnavailable);
    }

    // WGC/DXGI supplied a source texture, but every NV12 output slot is still
    // owned by the encoder.
    ++encoder_backpressure_ticks_;
    auto& logger = diagnostics::DiagnosticLog::instance();
    if (logger.enabled()) {
      logger.write(
          "gpu_frame_pool_exhausted",
          {
              {"total", static_cast<std::uint64_t>(kOutputPoolSize)},
              {"available", static_cast<std::uint64_t>(0)},
          });
    }
    return result(ScreenGpuFrameStatus::EncoderBackpressure, method, metrics,
                  ScreenGpuCaptureErrorCode::CaptureUnavailable);
  }

  ScreenGpuFrameResult poll(const char* method, ScreenGpuFrame& frame) {
    retryPendingDiscards();
    pollCompletions();
    if (publishReady(frame)) {
      return result(
          ScreenGpuFrameStatus::NewFrame,
          method,
          slots_[frame.slot].metrics,
          ScreenGpuCaptureErrorCode::CaptureUnavailable);
    }
    if (capacityExhausted()) {
      syrnike::voice::ScreenCaptureFrameMetrics metrics;
      metrics.hresult = static_cast<long>(DXGI_ERROR_WAIT_TIMEOUT);
      return result(
          ScreenGpuFrameStatus::NoFrame,
          method,
          metrics,
          ScreenGpuCaptureErrorCode::GpuTimeout,
          false,
          true);
    }
    return result(
        ScreenGpuFrameStatus::NoFrame,
        method,
        {},
        ScreenGpuCaptureErrorCode::CaptureUnavailable);
  }

  void discard(const ScreenGpuFrame& frame) noexcept {
    if (!sameLuid(frame.adapter_luid, adapter_luid_) ||
        frame.slot >= slots_.size() || frame.sequence == 0) {
      return;
    }
    auto& slot = slots_[frame.slot];
    if (slot.shared_handle != frame.shared_texture_handle) return;
    if (device_failed_.load(std::memory_order_acquire)) {
      static_cast<void>(slot_state_.abandon(frame.slot, frame.sequence));
      return;
    }
    slot_state_.discard(
        frame.slot,
        frame.sequence,
        [&slot] { return slot.mutex->AcquireSync(kConsumerKey, 0) == S_OK; },
        [&slot] { return SUCCEEDED(slot.mutex->ReleaseSync(kProducerKey)); });
  }

  [[nodiscard]] std::size_t availableSlots() const noexcept {
    return countScreenGpuAvailableSlots<kOutputPoolSize>(
        [this](std::size_t index) {
      const auto& slot = slots_[index];
      if (slot.mutex->AcquireSync(kProducerKey, 0) != S_OK) return false;
      return SUCCEEDED(slot.mutex->ReleaseSync(kProducerKey));
    });
  }

  [[nodiscard]] std::size_t totalSlots() const noexcept {
    return slot_state_.total();
  }

  [[nodiscard]] ScreenFrameFlowStats flowStats() const noexcept {
    const auto latency = completion_latency_.snapshot();
    ScreenFrameFlowStats stats;
    stats.gpu_submissions = gpu_submissions_.load(std::memory_order_relaxed);
    stats.encoder_backpressure_ticks =
        encoder_backpressure_ticks_.load(std::memory_order_relaxed);
    stats.superseded_ready_frames =
        superseded_ready_frames_.load(std::memory_order_relaxed);
    stats.gpu_slot_timeouts =
        gpu_slot_timeouts_.load(std::memory_order_relaxed);
    stats.gpu_slots_recovered =
        gpu_slots_recovered_.load(std::memory_order_relaxed);
    stats.gpu_frames_dropped_stale =
        gpu_frames_dropped_stale_.load(std::memory_order_relaxed);
    stats.gpu_slots_quarantined = quarantinedSlots();
    stats.gpu_completion_p50_us = latency.p50_us;
    stats.gpu_completion_p95_us = latency.p95_us;
    stats.gpu_completion_max_us = latency.max_us;
    return stats;
  }

 private:
  enum class SlotPhase {
    Available,
    Converting,
    Quarantined,
    Ready,
  };

  struct Slot {
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<IDXGIKeyedMutex> mutex;
    ComPtr<ID3D11VideoProcessorInputView> input_view;
    ComPtr<ID3D11VideoProcessorOutputView> output_view;
    std::unique_ptr<D3d11GpuCompletion> completion;
    HANDLE shared_handle = nullptr;
    SlotPhase phase = SlotPhase::Available;
    std::uint64_t sequence = 0;
    std::uint64_t timestamp_us = 0;
    syrnike::voice::ScreenCaptureFrameMetrics metrics;
  };

  void pollCompletions() {
    for (auto& slot : slots_) {
      if (slot.phase != SlotPhase::Converting &&
          slot.phase != SlotPhase::Quarantined) {
        continue;
      }
      std::uint64_t elapsed_us = 0;
      const HRESULT completion_result = slot.completion->poll(&elapsed_us);
      const auto transition = decideGpuCompletionSlotTransition(
          slot.phase == SlotPhase::Quarantined
              ? GpuCompletionSlotState::Quarantined
              : GpuCompletionSlotState::Pending,
          classifyGpuCompletionPoll(completion_result));
      if (transition.newly_quarantined) {
        slot.phase = SlotPhase::Quarantined;
        ++gpu_slot_timeouts_;
        quarantined_slots_.fetch_add(1, std::memory_order_relaxed);
      }
      if (transition.keep_pending) {
        continue;
      }
      if (transition.device_failed) {
        markDeviceFailed();
        requireGpuCompletion(
            completion_result, "GPU screen conversion did not complete");
      }
      if (transition.recovered_stale) {
        const HRESULT release = slot.mutex->ReleaseSync(kProducerKey);
        if (FAILED(release)) markDeviceFailed();
        requireHr(
            release, ScreenGpuCaptureErrorCode::DeviceLost,
            "failed to release recovered stale GPU frame");
        slot.input_view.Reset();
        slot.phase = SlotPhase::Available;
        slot.sequence = 0;
        slot.timestamp_us = 0;
        slot.metrics = {};
        ++gpu_slots_recovered_;
        ++gpu_frames_dropped_stale_;
        quarantined_slots_.fetch_sub(1, std::memory_order_relaxed);
        continue;
      }
      requireGpuCompletion(
          completion_result, "GPU screen conversion did not complete");
      completion_latency_.record(elapsed_us);
      slot.metrics.scale_us = static_cast<int>(std::min<std::uint64_t>(
          elapsed_us, static_cast<std::uint64_t>(std::numeric_limits<int>::max())));
      slot.input_view.Reset();
      slot.phase = SlotPhase::Ready;
    }
  }

  [[nodiscard]] std::size_t quarantinedSlots() const noexcept {
    return quarantined_slots_.load(std::memory_order_relaxed);
  }

 public:
  [[nodiscard]] bool capacityExhausted() const noexcept {
    return quarantinedSlots() == slots_.size();
  }

  [[nodiscard]] bool retirementSafe() const noexcept {
    if (device_failed_.load(std::memory_order_acquire)) {
      return slot_state_.available() == slot_state_.total();
    }
    // The keyed mutex is the ownership authority. Exact discard bookkeeping
    // can lag after the consumer has already returned producer key 0; using
    // that counter here would retain an otherwise idle D3D generation forever.
    // Retirement is off the capture hot path, so an exact non-blocking probe is
    // both safe and preferable to a stale logical count.
    return quarantinedSlots() == 0 &&
        std::none_of(slots_.begin(), slots_.end(), [](const Slot& slot) {
          return slot.phase == SlotPhase::Converting;
        }) &&
        availableSlots() == totalSlots();
  }

 private:

  bool publishReady(ScreenGpuFrame& frame) {
    std::optional<std::size_t> newest;
    for (std::size_t index = 0; index < slots_.size(); ++index) {
      if (slots_[index].phase != SlotPhase::Ready) continue;
      if (!newest || slots_[index].sequence > slots_[*newest].sequence) {
        newest = index;
      }
    }
    if (!newest) return false;

    // Raw frames have no codec dependencies. When several conversions finish
    // before the output clock can publish them, keep the newest visual state
    // and return every older producer-held slot without adding stream latency.
    for (std::size_t index = 0; index < slots_.size(); ++index) {
      auto& stale = slots_[index];
      if (index == *newest || stale.phase != SlotPhase::Ready) continue;
      const HRESULT stale_release = stale.mutex->ReleaseSync(kProducerKey);
      if (FAILED(stale_release)) markDeviceFailed();
      requireHr(
          stale_release, ScreenGpuCaptureErrorCode::DeviceLost,
          "failed to discard superseded GPU frame");
      stale.phase = SlotPhase::Available;
      stale.sequence = 0;
      stale.timestamp_us = 0;
      stale.metrics = {};
      ++superseded_ready_frames_;
    }

    const auto index = *newest;
    auto& slot = slots_[index];
    // Publish the generation before exposing consumer key 1. A late discard
    // for the previous frame can otherwise acquire the newly released key
    // while the slot still advertises the old sequence.
    slot_state_.publish(index, slot.sequence);
    const HRESULT release = slot.mutex->ReleaseSync(kConsumerKey);
    if (FAILED(release)) {
      slot_state_.cancelPublish(index, slot.sequence);
      markDeviceFailed();
      requireHr(
          release,
          ScreenGpuCaptureErrorCode::DeviceLost,
          "failed to release completed GPU frame to encoder");
    }
    slot.phase = SlotPhase::Available;
    frame.sequence = slot.sequence;
    frame.timestamp_us = slot.timestamp_us;
    frame.width = output_width_;
    frame.height = output_height_;
    frame.slot = static_cast<std::uint32_t>(index);
    frame.shared_texture_handle = slot.shared_handle;
    frame.adapter_luid = adapter_luid_;
    frame.format = DXGI_FORMAT_NV12;
    return true;
  }

  void retryPendingDiscards() noexcept {
    if (device_failed_.load(std::memory_order_acquire)) return;
    for (std::size_t index = 0; index < slots_.size(); ++index) {
      auto& slot = slots_[index];
      slot_state_.retry(
          index,
          [&slot] { return slot.mutex->AcquireSync(kConsumerKey, 0) == S_OK; },
          [&slot] { return SUCCEEDED(slot.mutex->ReleaseSync(kProducerKey)); });
    }
  }

  void markDeviceFailed() noexcept {
    device_failed_.store(true, std::memory_order_release);
    for (auto& slot : slots_) {
      if (slot.phase == SlotPhase::Available) continue;
      slot.input_view.Reset();
      slot.completion.reset();
      slot.phase = SlotPhase::Available;
      slot.sequence = 0;
      slot.timestamp_us = 0;
      slot.metrics = {};
    }
    quarantined_slots_.store(0, std::memory_order_relaxed);
  }

  ScreenGpuFrameResult result(
      ScreenGpuFrameStatus status,
      const char* method,
      syrnike::voice::ScreenCaptureFrameMetrics metrics,
      ScreenGpuCaptureErrorCode error_code,
      bool source_submitted = false,
      bool gpu_capacity_exhausted = false) const {
    // Ownership state is exact and lock-free. Keyed-mutex probes are reserved
    // for the one-second telemetry/control sample exposed by availableSlots().
    metrics.gpu_pool_slots_available =
        static_cast<std::uint32_t>(slot_state_.available());
    metrics.gpu_pool_slots_total =
        static_cast<std::uint32_t>(slot_state_.total());
    return {
        status,
        metrics,
        method,
        error_code,
        std::nullopt,
        source_submitted,
        gpu_capacity_exhausted,
    };
  }

  void createTextures() {
    D3D11_TEXTURE2D_DESC description{};
    description.Width = output_width_;
    description.Height = output_height_;
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = DXGI_FORMAT_NV12;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_DEFAULT;
    description.BindFlags = D3D11_BIND_RENDER_TARGET;
    description.MiscFlags =
        D3D11_RESOURCE_MISC_SHARED_NTHANDLE |
        D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
    for (auto& slot : slots_) {
      slot.completion =
          std::make_unique<D3d11GpuCompletion>(device_.Get(), context_.Get());
      requireHr(
          slot.completion->initializationResult(),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "failed to create GPU conversion completion query");
      requireHr(
          device_->CreateTexture2D(&description, nullptr, &slot.texture),
          ScreenGpuCaptureErrorCode::FormatUnsupported,
          "failed to create shared NV12 encoder texture");
      requireHr(
          slot.texture.As(&slot.mutex),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "shared NV12 texture does not expose keyed mutex");
      ComPtr<IDXGIResource1> resource;
      requireHr(
          slot.texture.As(&resource),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "shared NV12 texture does not expose IDXGIResource1");
      requireHr(
          resource->CreateSharedHandle(
              nullptr,
              DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
              nullptr,
              &slot.shared_handle),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "failed to export shared NV12 texture handle");
    }
  }

  void configure(std::uint32_t source_width, std::uint32_t source_height) {
    if (source_width_ == source_width && source_height_ == source_height &&
        processor_ && enumerator_) {
      return;
    }
    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
    content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    content.InputWidth = source_width;
    content.InputHeight = source_height;
    content.OutputWidth = output_width_;
    content.OutputHeight = output_height_;
    content.Usage = D3D11_VIDEO_USAGE_OPTIMAL_SPEED;
    ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
    requireHr(
        video_device_->CreateVideoProcessorEnumerator(&content, &enumerator),
        ScreenGpuCaptureErrorCode::FormatUnsupported,
        "failed to create D3D11 video processor enumerator");
    UINT input_flags = 0;
    UINT output_flags = 0;
    requireHr(
        enumerator->CheckVideoProcessorFormat(
            DXGI_FORMAT_B8G8R8A8_UNORM, &input_flags),
        ScreenGpuCaptureErrorCode::FormatUnsupported,
        "failed to query BGRA video processor support");
    requireHr(
        enumerator->CheckVideoProcessorFormat(DXGI_FORMAT_NV12, &output_flags),
        ScreenGpuCaptureErrorCode::FormatUnsupported,
        "failed to query NV12 video processor support");
    if ((input_flags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT) == 0 ||
        (output_flags & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT) == 0) {
      throw ScreenGpuCaptureError(
          ScreenGpuCaptureErrorCode::FormatUnsupported,
          "adapter cannot convert BGRA screen textures to NV12");
    }
    ComPtr<ID3D11VideoProcessor> processor;
    requireHr(
        video_device_->CreateVideoProcessor(enumerator.Get(), 0, &processor),
        ScreenGpuCaptureErrorCode::FormatUnsupported,
        "failed to create D3D11 video processor");

    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC output_description{};
    output_description.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    std::array<ComPtr<ID3D11VideoProcessorOutputView>, kOutputPoolSize> views;
    for (std::size_t index = 0; index < slots_.size(); ++index) {
      requireHr(
          video_device_->CreateVideoProcessorOutputView(
              slots_[index].texture.Get(),
              enumerator.Get(),
              &output_description,
              &views[index]),
          ScreenGpuCaptureErrorCode::FormatUnsupported,
          "failed to create NV12 video processor output view");
    }
    enumerator_ = std::move(enumerator);
    processor_ = std::move(processor);
    for (std::size_t index = 0; index < slots_.size(); ++index) {
      slots_[index].output_view = std::move(views[index]);
    }
    source_width_ = source_width;
    source_height_ = source_height;
  }

  // Declared first so admission remains held until this generation's D3D
  // objects have all been released.
  std::shared_ptr<VideoResourceLease> resource_lease_;
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<ID3D11VideoDevice> video_device_;
  ComPtr<ID3D11VideoContext> video_context_;
  ComPtr<ID3D11VideoProcessorEnumerator> enumerator_;
  ComPtr<ID3D11VideoProcessor> processor_;
  LUID adapter_luid_{};
  std::uint32_t output_width_ = 0;
  std::uint32_t output_height_ = 0;
  std::uint32_t source_width_ = 0;
  std::uint32_t source_height_ = 0;
  std::array<Slot, kOutputPoolSize> slots_;
  ScreenGpuSlotState<kOutputPoolSize> slot_state_;
  ScreenLatencyWindow<256> completion_latency_;
  std::size_t next_slot_ = 0;
  std::atomic<std::uint64_t> gpu_submissions_{0};
  std::atomic<std::uint64_t> encoder_backpressure_ticks_{0};
  std::atomic<std::uint64_t> superseded_ready_frames_{0};
  std::atomic<std::uint64_t> gpu_slot_timeouts_{0};
  std::atomic<std::uint64_t> gpu_slots_recovered_{0};
  std::atomic<std::uint64_t> gpu_frames_dropped_stale_{0};
  std::atomic<std::size_t> quarantined_slots_{0};
  std::atomic_bool device_failed_{false};
};

void addScreenFrameFlowCounters(
    ScreenFrameFlowStats& destination,
    const ScreenFrameFlowStats& source) noexcept {
  destination.gpu_submissions += source.gpu_submissions;
  destination.encoder_backpressure_ticks += source.encoder_backpressure_ticks;
  destination.superseded_ready_frames += source.superseded_ready_frames;
  destination.gpu_slot_timeouts += source.gpu_slot_timeouts;
  destination.gpu_slots_recovered += source.gpu_slots_recovered;
  destination.gpu_frames_dropped_stale += source.gpu_frames_dropped_stale;
  destination.gpu_pool_rollovers += source.gpu_pool_rollovers;
  destination.gpu_rollovers_blocked += source.gpu_rollovers_blocked;
  destination.preview_bridge_submissions += source.preview_bridge_submissions;
  destination.preview_bridge_acquires += source.preview_bridge_acquires;
  destination.preview_bridge_timeouts += source.preview_bridge_timeouts;
  destination.preview_bridge_slots_recovered +=
      source.preview_bridge_slots_recovered;
  destination.preview_gpu_submissions += source.preview_gpu_submissions;
  destination.preview_frames_completed += source.preview_frames_completed;
  destination.preview_slot_timeouts += source.preview_slot_timeouts;
  destination.preview_frames_dropped_stale +=
      source.preview_frames_dropped_stale;
  destination.preview_device_resets += source.preview_device_resets;
  destination.gpu_completion_max_us = std::max(
      destination.gpu_completion_max_us, source.gpu_completion_max_us);
}

// Owns bounded generations of encoder-facing NV12 textures. A single late
// completion only quarantines its slot. A fresh generation is allocated only
// after every slot in the active generation has timed out, and no more than two
// pending generations may be retained.
class GpuFramePipeline {
 public:
  GpuFramePipeline(
      ID3D11Device* device,
      ID3D11DeviceContext* context,
      LUID adapter_luid,
      std::uint32_t output_width,
      std::uint32_t output_height,
      VideoResourceAdmissionBudget& resource_budget,
      std::string owner_id)
      : resource_budget_(&resource_budget),
        owner_id_(std::move(owner_id)),
        device_(device),
        context_(context),
        adapter_luid_(adapter_luid),
        output_width_(output_width),
        output_height_(output_height) {
    active_ = createPool();
    retired_.reserve(kMaxRetiredGpuPoolGenerations);
  }

  ScreenGpuFrameResult process(
      ID3D11Texture2D* source,
      std::uint32_t source_width,
      std::uint32_t source_height,
      std::uint32_t content_width,
      std::uint32_t content_height,
      std::uint64_t timestamp_us,
      const char* method,
      syrnike::voice::ScreenCaptureFrameMetrics metrics,
      ScreenGpuFrame& frame) {
    cleanupRetired(method);
    auto active = activeSnapshot();
    auto result = active->process(
        source,
        source_width,
        source_height,
        content_width,
        content_height,
        timestamp_us,
        method,
        metrics,
        frame);
    if (!result.gpu_capacity_exhausted) return result;
    if (!rollover(method, result.metrics.hresult)) {
      result.status = ScreenGpuFrameStatus::FatalError;
      result.error_code = ScreenGpuCaptureErrorCode::GpuTimeout;
      return result;
    }
    active = activeSnapshot();
    return active->process(
        source,
        source_width,
        source_height,
        content_width,
        content_height,
        timestamp_us,
        method,
        metrics,
        frame);
  }

  ScreenGpuFrameResult poll(const char* method, ScreenGpuFrame& frame) {
    cleanupRetired(method);
    auto active = activeSnapshot();
    auto result = active->poll(method, frame);
    if (!result.gpu_capacity_exhausted) return result;
    if (!rollover(method, result.metrics.hresult)) {
      result.status = ScreenGpuFrameStatus::FatalError;
      result.error_code = ScreenGpuCaptureErrorCode::GpuTimeout;
      return result;
    }
    return activeSnapshot()->poll(method, frame);
  }

  void discard(const ScreenGpuFrame& frame) noexcept {
    const auto pools = poolSnapshot();
    pools.active->discard(frame);
    for (std::size_t index = 0; index < pools.retired_count; ++index) {
      pools.retired[index]->discard(frame);
    }
  }

  void pollRetirement(const char* method) noexcept {
    cleanupRetired(method);
    ScreenGpuFrame ignored;
    try {
      const auto active = activeSnapshot();
      const auto result = active->poll(method, ignored);
      if (result.status == ScreenGpuFrameStatus::NewFrame) {
        active->discard(ignored);
      }
    } catch (...) {
      // GpuFramePool marks a terminal device before throwing. The backend is
      // retained until any already-published encoder generations are released.
    }
  }

  [[nodiscard]] std::size_t availableSlots() const noexcept {
    return activeSnapshot()->availableSlots();
  }

  [[nodiscard]] std::size_t totalSlots() const noexcept {
    return activeSnapshot()->totalSlots();
  }

  [[nodiscard]] bool retirementSafe() const noexcept {
    const auto pools = poolSnapshot();
    return pools.retired_count == 0 && pools.active->retirementSafe();
  }

  [[nodiscard]] ScreenFrameFlowStats flowStats() const noexcept {
    ScreenFrameFlowStats result;
    PoolSnapshot pools;
    std::uint64_t gpu_pool_rollovers = 0;
    std::uint64_t gpu_rollovers_blocked = 0;
    {
      std::lock_guard lock(state_mutex_);
      result = completed_stats_;
      pools.active = active_;
      pools.retired_count = retired_.size();
      for (std::size_t index = 0; index < pools.retired_count; ++index) {
        pools.retired[index] = retired_[index];
      }
      gpu_pool_rollovers = gpu_pool_rollovers_;
      gpu_rollovers_blocked = gpu_rollovers_blocked_;
    }
    const auto active = pools.active->flowStats();
    addScreenFrameFlowCounters(result, active);
    result.gpu_completion_p50_us = active.gpu_completion_p50_us;
    result.gpu_completion_p95_us = active.gpu_completion_p95_us;
    result.gpu_completion_max_us = std::max(
        result.gpu_completion_max_us, active.gpu_completion_max_us);
    result.gpu_slots_quarantined = active.gpu_slots_quarantined;
    for (std::size_t index = 0; index < pools.retired_count; ++index) {
      const auto stats = pools.retired[index]->flowStats();
      addScreenFrameFlowCounters(result, stats);
      result.gpu_slots_quarantined += stats.gpu_slots_quarantined;
    }
    result.gpu_pool_rollovers += gpu_pool_rollovers;
    result.gpu_rollovers_blocked += gpu_rollovers_blocked;
    result.gpu_retired_generations = pools.retired_count;
    return result;
  }

 private:
  struct PoolSnapshot {
    std::shared_ptr<GpuFramePool> active;
    std::array<
        std::shared_ptr<GpuFramePool>,
        kMaxRetiredGpuPoolGenerations> retired;
    std::size_t retired_count = 0;
  };

  [[nodiscard]] std::shared_ptr<GpuFramePool> activeSnapshot() const noexcept {
    std::lock_guard lock(state_mutex_);
    return active_;
  }

  [[nodiscard]] PoolSnapshot poolSnapshot() const noexcept {
    std::lock_guard lock(state_mutex_);
    PoolSnapshot snapshot;
    snapshot.active = active_;
    snapshot.retired_count = retired_.size();
    for (std::size_t index = 0; index < snapshot.retired_count; ++index) {
      snapshot.retired[index] = retired_[index];
    }
    return snapshot;
  }

  std::shared_ptr<GpuFramePool> createPool() {
    const auto generation = ++next_generation_;
    auto resource_lease = requireScreenVideoResourceAdmission(
        *resource_budget_,
        VideoResourceRequest{
            .owner = VideoResourceOwner::ScreenCapture,
            .owner_id = owner_id_ + ":encoder_pool:" +
                std::to_string(generation),
            .gpu_generations = 1,
            .textures = {{
                .width = output_width_,
                .height = output_height_,
                .count = kOutputPoolSize,
                .format = VideoTextureFormat::Nv12,
            }},
        });
    return std::make_shared<GpuFramePool>(
        device_.Get(),
        context_.Get(),
        adapter_luid_,
        output_width_,
        output_height_,
        std::move(resource_lease));
  }

  bool rollover(const char* method, long hresult) {
    cleanupRetired(method);
    std::size_t retired_count = 0;
    {
      std::lock_guard lock(state_mutex_);
      retired_count = retired_.size();
    }
    if (retired_count >= kMaxRetiredGpuPoolGenerations) {
      if (!rollover_blocked_reported_) {
        rollover_blocked_reported_ = true;
        {
          std::lock_guard lock(state_mutex_);
          ++gpu_rollovers_blocked_;
        }
        diagnostics::DiagnosticLog::instance().write(
            "screen_gpu_pool_rollover_blocked",
            {
                {"method", method},
                {"hresult", static_cast<std::int64_t>(hresult)},
                {"retiredGenerations",
                 static_cast<std::uint64_t>(retired_count)},
            });
      }
      return false;
    }
    auto replacement = createPool();
    {
      std::lock_guard lock(state_mutex_);
      retired_.push_back(std::move(active_));
      active_ = std::move(replacement);
      ++gpu_pool_rollovers_;
      retired_count = retired_.size();
    }
    rollover_blocked_reported_ = false;
    diagnostics::DiagnosticLog::instance().write(
        "screen_gpu_pool_rollover",
        {
            {"method", method},
            {"hresult", static_cast<std::int64_t>(hresult)},
            {"count", gpu_pool_rollovers_},
            {"retiredGenerations",
             static_cast<std::uint64_t>(retired_count)},
        });
    return true;
  }

  void cleanupRetired(const char* method) {
    ScreenGpuFrame ignored;
    std::lock_guard lock(state_mutex_);
    for (auto iterator = retired_.begin(); iterator != retired_.end();) {
      try {
        const auto result = (*iterator)->poll(method, ignored);
        if (result.status == ScreenGpuFrameStatus::NewFrame) {
          (*iterator)->discard(ignored);
        }
      } catch (...) {
        // A terminal pool marks itself failed; retirement can proceed after
        // any encoder-owned generations are released.
      }
      if ((*iterator)->retirementSafe()) {
        addScreenFrameFlowCounters(completed_stats_, (*iterator)->flowStats());
        iterator = retired_.erase(iterator);
      } else {
        ++iterator;
      }
    }
    if (retired_.size() < kMaxRetiredGpuPoolGenerations) {
      rollover_blocked_reported_ = false;
    }
  }

  VideoResourceAdmissionBudget* resource_budget_ = nullptr;
  std::string owner_id_;
  std::uint64_t next_generation_ = 0;
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  LUID adapter_luid_{};
  std::uint32_t output_width_ = 0;
  std::uint32_t output_height_ = 0;
  mutable std::mutex state_mutex_;
  std::shared_ptr<GpuFramePool> active_;
  std::vector<std::shared_ptr<GpuFramePool>> retired_;
  ScreenFrameFlowStats completed_stats_;
  std::uint64_t gpu_pool_rollovers_ = 0;
  std::uint64_t gpu_rollovers_blocked_ = 0;
  bool rollover_blocked_reported_ = false;
};

class GpuPreviewRenderer final {
 public:
  GpuPreviewRenderer(ID3D11Device* device, ID3D11DeviceContext* context)
      : device_(device), context_(context) {
    constexpr char vertex_source[] = R"(
float4 main(uint vertex_id : SV_VertexID) : SV_Position {
  float2 position = vertex_id == 0 ? float2(-1.0, -1.0)
      : vertex_id == 1 ? float2(-1.0, 3.0)
                       : float2(3.0, -1.0);
  return float4(position, 0.0, 1.0);
}
)";
    constexpr char pixel_source[] = R"(
cbuffer PreviewConstants : register(b0) {
  float2 destination_origin;
  float2 destination_size;
  float2 content_uv;
  float2 padding;
};

Texture2D<float4> source_texture : register(t0);
SamplerState source_sampler : register(s0);

float4 main(float4 position : SV_Position) : SV_Target {
  float2 pixel = position.xy;
  if (pixel.x < destination_origin.x || pixel.y < destination_origin.y ||
      pixel.x >= destination_origin.x + destination_size.x ||
      pixel.y >= destination_origin.y + destination_size.y) {
    return float4(0.0, 0.0, 0.0, 1.0);
  }
  float2 local = (pixel - destination_origin) / destination_size;
  float2 uv = saturate(local) * content_uv;
  float4 colour = source_texture.SampleLevel(source_sampler, uv, 0.0);
  return float4(colour.rgb, 1.0);
}
)";
    const auto vertex = compile(
        vertex_source, "vs_5_0", "failed to compile preview vertex shader");
    const auto pixel = compile(
        pixel_source, "ps_5_0", "failed to compile preview pixel shader");
    requireHr(
        device_->CreateVertexShader(
            vertex->GetBufferPointer(), vertex->GetBufferSize(), nullptr,
            &vertex_shader_),
        ScreenGpuCaptureErrorCode::InteropUnavailable,
        "failed to create preview vertex shader");
    requireHr(
        device_->CreatePixelShader(
            pixel->GetBufferPointer(), pixel->GetBufferSize(), nullptr,
            &pixel_shader_),
        ScreenGpuCaptureErrorCode::InteropUnavailable,
        "failed to create preview pixel shader");
    D3D11_BUFFER_DESC constant_description{};
    constant_description.ByteWidth = sizeof(Constants);
    constant_description.Usage = D3D11_USAGE_DYNAMIC;
    constant_description.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    constant_description.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    requireHr(
        device_->CreateBuffer(
            &constant_description, nullptr, &constants_),
        ScreenGpuCaptureErrorCode::InteropUnavailable,
        "failed to create preview shader constants");
    D3D11_SAMPLER_DESC sampler_description{};
    sampler_description.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sampler_description.AddressU = D3D11_TEXTURE_ADDRESS_CLAMP;
    sampler_description.AddressV = D3D11_TEXTURE_ADDRESS_CLAMP;
    sampler_description.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sampler_description.MaxLOD = D3D11_FLOAT32_MAX;
    requireHr(
        device_->CreateSamplerState(&sampler_description, &sampler_),
        ScreenGpuCaptureErrorCode::InteropUnavailable,
        "failed to create preview sampler");
  }

  void render(
      ID3D11ShaderResourceView* source,
      ID3D11RenderTargetView* output,
      std::uint32_t source_width,
      std::uint32_t source_height,
      std::uint32_t content_width,
      std::uint32_t content_height,
      std::uint32_t output_width,
      std::uint32_t output_height) {
    const RECT destination = fitRect(
        content_width, content_height, output_width, output_height);
    const Constants values{
        {static_cast<float>(destination.left),
         static_cast<float>(destination.top)},
        {static_cast<float>(destination.right - destination.left),
         static_cast<float>(destination.bottom - destination.top)},
        {static_cast<float>(content_width) / source_width,
         static_cast<float>(content_height) / source_height},
        {},
    };
    D3D11_MAPPED_SUBRESOURCE mapped{};
    requireHr(
        context_->Map(
            constants_.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped),
        ScreenGpuCaptureErrorCode::DeviceLost,
        "failed to update preview shader constants");
    std::memcpy(mapped.pData, &values, sizeof(values));
    context_->Unmap(constants_.Get(), 0);

    D3D11_VIEWPORT viewport{};
    viewport.Width = static_cast<float>(output_width);
    viewport.Height = static_cast<float>(output_height);
    viewport.MaxDepth = 1.0F;
    constexpr float background[4]{0.0F, 0.0F, 0.0F, 1.0F};
    context_->ClearRenderTargetView(output, background);
    context_->OMSetRenderTargets(1, &output, nullptr);
    context_->RSSetViewports(1, &viewport);
    context_->IASetInputLayout(nullptr);
    context_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context_->VSSetShader(vertex_shader_.Get(), nullptr, 0);
    context_->PSSetShader(pixel_shader_.Get(), nullptr, 0);
    ID3D11Buffer* constant = constants_.Get();
    context_->PSSetConstantBuffers(0, 1, &constant);
    context_->PSSetSamplers(0, 1, sampler_.GetAddressOf());
    context_->PSSetShaderResources(0, 1, &source);
    context_->Draw(3, 0);
    ID3D11ShaderResourceView* no_source = nullptr;
    context_->PSSetShaderResources(0, 1, &no_source);
    context_->OMSetRenderTargets(0, nullptr, nullptr);
  }

 private:
  struct Constants {
    float destination_origin[2];
    float destination_size[2];
    float content_uv[2];
    float padding[2];
  };

  static ComPtr<ID3DBlob> compile(
      const char* source,
      const char* target,
      const char* message) {
    ComPtr<ID3DBlob> shader;
    ComPtr<ID3DBlob> errors;
    requireHr(
        D3DCompile(
            source, std::strlen(source), nullptr, nullptr, nullptr, "main",
            target,
            D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3,
            0, &shader, &errors),
        ScreenGpuCaptureErrorCode::InteropUnavailable,
        message);
    return shader;
  }

  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<ID3D11VertexShader> vertex_shader_;
  ComPtr<ID3D11PixelShader> pixel_shader_;
  ComPtr<ID3D11Buffer> constants_;
  ComPtr<ID3D11SamplerState> sampler_;
};

// Independent BGRA pool for Electron preview. A slot remains occupied until
// Electron reports that every renderer GPU reference has been released. The
// capture path never waits for a slot: preview is simply skipped under load.
class GpuPreviewPool {
 public:
  GpuPreviewPool(
      ID3D11Device* device,
      ID3D11DeviceContext* context,
      std::uint32_t max_width,
      std::uint32_t max_height,
      VideoResourceAdmissionBudget& resource_budget,
      std::string owner_id)
      : resource_budget_(&resource_budget),
        owner_id_(std::move(owner_id)),
        capture_device_(device),
        capture_context_(context),
        max_width_(max_width),
        max_height_(max_height) {
    const auto preview = createSiblingDevice(
        capture_device_.Get(),
        *resource_budget_,
        owner_id_ + ":device:1");
    preview_device_ = preview.device;
    preview_context_ = preview.context;
    preview_device_lease_ = preview.resource_lease;
    renderer_ = std::make_unique<GpuPreviewRenderer>(
        preview_device_.Get(), preview_context_.Get());
  }

  ~GpuPreviewPool() {
    std::lock_guard lock(mutex_);
    for (auto& slot : slots_) {
      closeRemoteHandle(slot);
      if (slot.bridge_handle) CloseHandle(slot.bridge_handle);
      if (slot.shared_handle) CloseHandle(slot.shared_handle);
    }
  }

  void setDemand(ScreenPreviewDemand demand) {
    demand.width = std::clamp<std::uint32_t>(
        demand.width & ~1U, 16,
        std::max<std::uint32_t>(16, std::min<std::uint32_t>(max_width_, 3840)));
    demand.height = std::clamp<std::uint32_t>(
        demand.height & ~1U, 16,
        std::max<std::uint32_t>(16, std::min<std::uint32_t>(max_height_, 2160)));
    demand.fps = std::clamp<std::uint32_t>(demand.fps, 1, 60);
    std::lock_guard lock(mutex_);
    demand_ = demand;
    ++demand_revision_;
    const bool has_demand = demand.demanded && demand.electron_main_pid != 0;
    if (!has_demand) {
      desired_configuration_.reset();
      for (auto& slot : slots_) {
        if (slot.phase == SlotPhase::Configuring) {
          slot.phase = SlotPhase::Available;
        }
      }
    }
    if (!has_demand && pending_) {
      if (const auto slot = lease_state_.release(pending_->sequence)) {
        closeRemoteHandle(slots_[*slot]);
        slots_[*slot].phase = SlotPhase::Available;
      }
      pending_.reset();
    }
    if (!has_demand) {
      for (std::size_t index = 0; index < slots_.size(); ++index) {
        auto& slot = slots_[index];
        if (slot.phase != SlotPhase::Ready) continue;
        static_cast<void>(lease_state_.release(slot.sequence));
        slot.phase = SlotPhase::Available;
      }
    }
  }

  [[nodiscard]] bool tryEnqueue(
      ID3D11Texture2D* source,
      std::uint32_t source_width,
      std::uint32_t source_height,
      std::uint32_t content_width,
      std::uint32_t content_height,
      std::uint64_t timestamp_us) noexcept {
    ScreenPreviewDemand demand;
    std::uint64_t demand_revision = 0;
    std::uint64_t reserved_sequence = 0;
    std::size_t slot_index = slots_.size();
    ComPtr<ID3D11Texture2D> capture_bridge;
    ComPtr<IDXGIKeyedMutex> capture_bridge_mutex;
    const auto now = std::chrono::steady_clock::now();
    {
      std::unique_lock lock(mutex_, std::try_to_lock);
      if (!lock.owns_lock()) {
        ++enqueue_lock_drops_;
        return true;
      }
      demand = demand_;
      demand_revision = demand_revision_;
      revokeExpiredLocked(now);
      if (!demand.demanded || demand.electron_main_pid == 0) return false;
      desired_configuration_ = PreviewConfiguration{
          source_width,
          source_height,
          demand.width,
          demand.height,
      };
      if (now < next_retry_at_) return true;
      const auto interval = std::chrono::microseconds(1'000'000 / demand.fps);
      if (last_frame_at_ != std::chrono::steady_clock::time_point{} &&
          now - last_frame_at_ < interval) return true;
      reserved_sequence = nextScreenFrameSequence();
      for (std::size_t attempt = 0; attempt < slots_.size(); ++attempt) {
        const auto candidate = (next_slot_ + attempt) % slots_.size();
        const auto& slot = slots_[candidate];
        if (slot.phase != SlotPhase::Available ||
            !matches(slot, *desired_configuration_)) {
          continue;
        }
        if (const auto reserved = lease_state_.reserve(
                reserved_sequence, now, candidate)) {
          slot_index = *reserved;
          break;
        }
      }
      if (slot_index == slots_.size()) {
        ++enqueue_coalesced_drops_;
        return true;
      }
      auto& slot = slots_[slot_index];
      ++bridge_submissions_;
      last_frame_at_ = now;
      next_slot_ = (slot_index + 1) % slots_.size();
      slot.phase = SlotPhase::BridgePending;
      slot.bridge_submitted_at = now;
      slot.sequence = reserved_sequence;
      slot.timestamp_us = timestamp_us != 0 ? timestamp_us : steadyMicros();
      slot.demand_revision = demand_revision;
      slot.content_width = std::min(source_width, content_width);
      slot.content_height = std::min(source_height, content_height);
      capture_bridge = slot.capture_bridge;
      capture_bridge_mutex = slot.capture_bridge_mutex;
    }

    bool bridge_acquired = false;
    try {
      const HRESULT acquire =
          capture_bridge_mutex->AcquireSync(kProducerKey, 0);
      if (acquire == WAIT_TIMEOUT || acquire == DXGI_ERROR_WAIT_TIMEOUT) {
        std::unique_lock lock(mutex_, std::try_to_lock);
        auto& slot = slots_[slot_index];
        if (lock.owns_lock() && slot.sequence == reserved_sequence) {
          slot.phase = SlotPhase::Available;
          static_cast<void>(lease_state_.release(reserved_sequence));
        }
        return true;
      }
      requireHr(
          acquire,
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "failed to acquire isolated preview bridge");
      bridge_acquired = true;
      capture_context_->CopyResource(capture_bridge.Get(), source);
      requireHr(
          capture_bridge_mutex->ReleaseSync(kConsumerKey),
          ScreenGpuCaptureErrorCode::DeviceLost,
          "failed to submit isolated preview bridge copy");
      bridge_acquired = false;
    } catch (const ScreenGpuCaptureError& error) {
      if (bridge_acquired) {
        static_cast<void>(
            capture_bridge_mutex->ReleaseSync(kProducerKey));
      }
      std::unique_lock lock(mutex_, std::try_to_lock);
      if (!lock.owns_lock()) return true;
      auto& slot = slots_[slot_index];
      if (slot.sequence != reserved_sequence) return true;
      if (error.code() == ScreenGpuCaptureErrorCode::DeviceLost ||
          error.code() == ScreenGpuCaptureErrorCode::DeviceUnavailable) {
        preview_device_reset_required_ = true;
      }
      resetSlotResources(slot);
      static_cast<void>(lease_state_.release(reserved_sequence));
      recordFailureLocked(error.code(), error.hresult(), error.what(), now);
    } catch (const std::exception& error) {
      if (bridge_acquired) {
        static_cast<void>(
            capture_bridge_mutex->ReleaseSync(kProducerKey));
      }
      std::unique_lock lock(mutex_, std::try_to_lock);
      if (!lock.owns_lock()) return true;
      auto& slot = slots_[slot_index];
      if (slot.sequence != reserved_sequence) return true;
      resetSlotResources(slot);
      static_cast<void>(lease_state_.release(reserved_sequence));
      recordFailureLocked(
          ScreenGpuCaptureErrorCode::InteropUnavailable, 0, error.what(), now);
    } catch (...) {
      if (bridge_acquired) {
        static_cast<void>(
            capture_bridge_mutex->ReleaseSync(kProducerKey));
      }
      std::unique_lock lock(mutex_, std::try_to_lock);
      if (!lock.owns_lock()) return true;
      auto& slot = slots_[slot_index];
      if (slot.sequence != reserved_sequence) return true;
      resetSlotResources(slot);
      static_cast<void>(lease_state_.release(reserved_sequence));
      recordFailureLocked(
          ScreenGpuCaptureErrorCode::InteropUnavailable, 0,
          "unknown local screen preview failure", now);
    }
    return true;
  }

  void poll() noexcept {
    const auto now = std::chrono::steady_clock::now();
    tryResetPreviewDevice(now);
    try {
      configureAvailableSlot();
      pollCompletions();
      publishReady(now);
    } catch (const ScreenGpuCaptureError& error) {
      std::lock_guard lock(mutex_);
      if (error.code() == ScreenGpuCaptureErrorCode::DeviceLost ||
          error.code() == ScreenGpuCaptureErrorCode::DeviceUnavailable) {
        preview_device_reset_required_ = true;
      }
      recordFailureLocked(error.code(), error.hresult(), error.what(), now);
    } catch (const std::exception& error) {
      std::lock_guard lock(mutex_);
      recordFailureLocked(
          ScreenGpuCaptureErrorCode::InteropUnavailable, 0, error.what(), now);
    } catch (...) {
      std::lock_guard lock(mutex_);
      recordFailureLocked(
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          0,
          "unknown asynchronous screen preview failure",
          now);
    }
  }

  [[nodiscard]] bool pendingWork() const noexcept {
    const auto now = std::chrono::steady_clock::now();
    std::lock_guard lock(mutex_);
    if (preview_device_reset_required_ && now >= next_retry_at_) return true;
    for (const auto& slot : slots_) {
      switch (slot.phase) {
        case SlotPhase::Configuring:
        case SlotPhase::BridgePending:
        case SlotPhase::BridgeQuarantined:
        case SlotPhase::Converting:
        case SlotPhase::Quarantined:
        case SlotPhase::Ready:
          return true;
        case SlotPhase::Available:
          if (demand_.demanded && demand_.electron_main_pid != 0 &&
              desired_configuration_ && now >= next_retry_at_ &&
              !matches(slot, *desired_configuration_)) {
            return true;
          }
          break;
        case SlotPhase::Delivered:
          break;
      }
    }
    return false;
  }

  bool take(ScreenPreviewFrame& frame) {
    poll();
    std::lock_guard lock(mutex_);
    revokeExpiredLocked(std::chrono::steady_clock::now());
    if (!pending_) return false;
    const auto pending_sequence = lease_state_.takePending();
    if (!pending_sequence || *pending_sequence != pending_->sequence) {
      pending_.reset();
      return false;
    }
    frame = *pending_;
    pending_.reset();
    return true;
  }

  bool takeFailure(ScreenPreviewFailure& failure) {
    std::lock_guard lock(mutex_);
    if (!pending_failure_) return false;
    failure = std::move(*pending_failure_);
    pending_failure_.reset();
    return true;
  }

  void release(std::uint64_t sequence) noexcept {
    std::lock_guard lock(mutex_);
    if (const auto slot = lease_state_.release(sequence)) {
      closeRemoteHandle(slots_[*slot]);
      slots_[*slot].phase = SlotPhase::Available;
    }
  }

  std::size_t inFlight() const noexcept {
    std::lock_guard lock(mutex_);
    revokeExpiredLocked(std::chrono::steady_clock::now());
    return lease_state_.inFlight();
  }

  ScreenFrameFlowStats flowStats() const noexcept {
    std::lock_guard lock(mutex_);
    ScreenFrameFlowStats result;
    result.preview_bridge_submissions = bridge_submissions_;
    result.preview_bridge_acquires = bridge_acquires_;
    result.preview_bridge_timeouts = bridge_timeouts_;
    result.preview_bridge_slots_recovered = bridge_slots_recovered_;
    result.preview_gpu_submissions = gpu_submissions_;
    result.preview_frames_completed = frames_completed_;
    result.preview_slot_timeouts = slot_timeouts_;
    result.preview_frames_dropped_stale = frames_dropped_stale_;
    result.preview_device_resets = device_resets_;
    return result;
  }

 private:
  enum class SlotPhase {
    Available,
    Configuring,
    BridgePending,
    BridgeQuarantined,
    Converting,
    Quarantined,
    Ready,
    Delivered,
  };

  struct Slot {
    std::shared_ptr<VideoResourceLease> device_lease;
    std::shared_ptr<VideoResourceLease> texture_lease;
    ComPtr<ID3D11Texture2D> capture_bridge;
    ComPtr<IDXGIKeyedMutex> capture_bridge_mutex;
    ComPtr<ID3D11Texture2D> preview_bridge;
    ComPtr<IDXGIKeyedMutex> preview_bridge_mutex;
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<ID3D11ShaderResourceView> source_view;
    ComPtr<ID3D11RenderTargetView> output_view;
    std::unique_ptr<D3d11GpuCompletion> completion;
    HANDLE bridge_handle = nullptr;
    HANDLE shared_handle = nullptr;
    HANDLE remote_handle = nullptr;
    std::uint32_t remote_pid = 0;
    std::uint32_t source_width = 0;
    std::uint32_t source_height = 0;
    std::uint32_t output_width = 0;
    std::uint32_t output_height = 0;
    SlotPhase phase = SlotPhase::Available;
    std::uint64_t sequence = 0;
    std::uint64_t timestamp_us = 0;
    std::uint64_t demand_revision = 0;
    std::chrono::steady_clock::time_point bridge_submitted_at{};
    std::uint32_t content_width = 0;
    std::uint32_t content_height = 0;
    std::uint64_t device_generation = 0;
  };

  struct PreviewConfiguration {
    std::uint32_t source_width = 0;
    std::uint32_t source_height = 0;
    std::uint32_t output_width = 0;
    std::uint32_t output_height = 0;
  };

  bool matches(
      const Slot& slot,
      const PreviewConfiguration& configuration) const noexcept {
    return slot.texture && slot.source_width == configuration.source_width &&
        slot.source_height == configuration.source_height &&
        slot.output_width == configuration.output_width &&
        slot.output_height == configuration.output_height &&
        slot.device_generation == device_generation_;
  }

  void configureAvailableSlot() {
    PreviewConfiguration configuration;
    std::uint64_t demand_revision = 0;
    std::size_t slot_index = slots_.size();
    {
      std::lock_guard lock(mutex_);
      if (!demand_.demanded || demand_.electron_main_pid == 0 ||
          !desired_configuration_ ||
          std::chrono::steady_clock::now() < next_retry_at_) {
        return;
      }
      configuration = *desired_configuration_;
      demand_revision = demand_revision_;
      for (std::size_t attempt = 0; attempt < slots_.size(); ++attempt) {
        const auto candidate = (next_configure_slot_ + attempt) % slots_.size();
        auto& slot = slots_[candidate];
        if (slot.phase != SlotPhase::Available ||
            matches(slot, configuration)) {
          continue;
        }
        slot.phase = SlotPhase::Configuring;
        slot_index = candidate;
        break;
      }
    }
    if (slot_index == slots_.size()) return;

    try {
      auto candidate = createConfiguredSlot(configuration);
      std::lock_guard lock(mutex_);
      auto& slot = slots_[slot_index];
      const bool configuration_is_current =
          demand_.demanded && demand_.electron_main_pid != 0 &&
          demand_revision_ == demand_revision && desired_configuration_ &&
          desired_configuration_->source_width == configuration.source_width &&
          desired_configuration_->source_height == configuration.source_height &&
          desired_configuration_->output_width == configuration.output_width &&
          desired_configuration_->output_height == configuration.output_height;
      if (slot.phase != SlotPhase::Configuring || !configuration_is_current) {
        if (slot.phase == SlotPhase::Configuring) {
          slot.phase = SlotPhase::Available;
        }
        resetSlotResources(candidate);
        return;
      }
      resetSlotResources(slot);
      slot = std::move(candidate);
      next_configure_slot_ = (slot_index + 1) % slots_.size();
    } catch (const ScreenGpuCaptureError& error) {
      std::lock_guard lock(mutex_);
      if (slots_[slot_index].phase == SlotPhase::Configuring) {
        slots_[slot_index].phase = SlotPhase::Available;
      }
      if (error.code() == ScreenGpuCaptureErrorCode::DeviceLost ||
          error.code() == ScreenGpuCaptureErrorCode::DeviceUnavailable) {
        preview_device_reset_required_ = true;
      }
      recordFailureLocked(
          error.code(), error.hresult(), error.what(),
          std::chrono::steady_clock::now());
    } catch (const std::exception& error) {
      std::lock_guard lock(mutex_);
      if (slots_[slot_index].phase == SlotPhase::Configuring) {
        slots_[slot_index].phase = SlotPhase::Available;
      }
      recordFailureLocked(
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          0,
          error.what(),
          std::chrono::steady_clock::now());
    }
  }

  void pollCompletions() {
    const auto now = std::chrono::steady_clock::now();
    for (std::size_t index = 0; index < slots_.size(); ++index) {
      auto& slot = slots_[index];
      {
        std::lock_guard lock(mutex_);
        if (slot.phase == SlotPhase::BridgePending ||
            slot.phase == SlotPhase::BridgeQuarantined) {
          const bool was_quarantined =
              slot.phase == SlotPhase::BridgeQuarantined;
          const HRESULT acquire =
              slot.preview_bridge_mutex->AcquireSync(kConsumerKey, 0);
          if (acquire == WAIT_TIMEOUT || acquire == DXGI_ERROR_WAIT_TIMEOUT) {
            if (!was_quarantined &&
                slot.bridge_submitted_at !=
                    std::chrono::steady_clock::time_point{} &&
                now - slot.bridge_submitted_at >= kGpuCompletionTimeout) {
              slot.phase = SlotPhase::BridgeQuarantined;
              ++bridge_timeouts_;
            }
            continue;
          }
          requireHr(
              acquire,
              ScreenGpuCaptureErrorCode::DeviceLost,
              "isolated preview bridge became unavailable");
          ++bridge_acquires_;
          if (was_quarantined) {
            requireHr(
                slot.preview_bridge_mutex->ReleaseSync(kProducerKey),
                ScreenGpuCaptureErrorCode::DeviceLost,
                "failed to release recovered stale preview bridge");
            static_cast<void>(lease_state_.release(slot.sequence));
            slot.phase = SlotPhase::Available;
            slot.sequence = 0;
            slot.timestamp_us = 0;
            slot.bridge_submitted_at = {};
            ++bridge_slots_recovered_;
            ++frames_dropped_stale_;
            continue;
          }
          bool bridge_acquired = true;
          try {
            beginPreviewConversion(slot);
            requireHr(
                slot.preview_bridge_mutex->ReleaseSync(kProducerKey),
                ScreenGpuCaptureErrorCode::DeviceLost,
                "failed to release isolated preview bridge");
            bridge_acquired = false;
            slot.phase = SlotPhase::Converting;
            slot.bridge_submitted_at = {};
          } catch (...) {
            if (bridge_acquired) {
              static_cast<void>(
                  slot.preview_bridge_mutex->ReleaseSync(kProducerKey));
            }
            throw;
          }
        }
        if (slot.phase != SlotPhase::Converting &&
            slot.phase != SlotPhase::Quarantined) {
          continue;
        }
      }
      std::uint64_t elapsed_us = 0;
      const HRESULT completion_result = slot.completion->poll(&elapsed_us);
      std::lock_guard lock(mutex_);
      const auto transition = decideGpuCompletionSlotTransition(
          slot.phase == SlotPhase::Quarantined
              ? GpuCompletionSlotState::Quarantined
              : GpuCompletionSlotState::Pending,
          classifyGpuCompletionPoll(completion_result));
      if (transition.newly_quarantined) {
        slot.phase = SlotPhase::Quarantined;
        ++slot_timeouts_;
      }
      if (transition.keep_pending) continue;
      if (transition.device_failed) {
        static_cast<void>(lease_state_.release(slot.sequence));
        slot.phase = SlotPhase::Available;
        slot.texture.Reset();
        slot.completion.reset();
        auto code = captureErrorForHr(completion_result);
        if (code == ScreenGpuCaptureErrorCode::CaptureUnavailable) {
          code = ScreenGpuCaptureErrorCode::DeviceLost;
        }
        throwHr(code, "GPU preview copy did not complete", completion_result);
      }
      if (transition.recovered_stale) {
        static_cast<void>(lease_state_.release(slot.sequence));
        slot.phase = SlotPhase::Available;
        slot.sequence = 0;
        slot.timestamp_us = 0;
        ++frames_dropped_stale_;
        continue;
      }
      requireGpuCompletion(
          completion_result, "GPU preview copy did not complete");
      slot.phase = SlotPhase::Ready;
      ++frames_completed_;
    }
    std::lock_guard lock(mutex_);
    const bool all_slots_stalled = std::all_of(
        slots_.begin(), slots_.end(), [](const Slot& slot) {
          return slot.phase == SlotPhase::BridgeQuarantined ||
              slot.phase == SlotPhase::Quarantined;
        });
    if (all_slots_stalled && !preview_device_reset_required_) {
      // The preview owns a sibling D3D device and disposable bridge textures.
      // Once every slot has crossed its freshness deadline, keeping that
      // generation cannot produce another frame. Rebuild only this isolated
      // preview generation; capture and encoder submission keep running.
      preview_device_reset_required_ = true;
      next_retry_at_ = std::max(
          next_retry_at_, now + std::chrono::milliseconds(500));
    }
  }

  void beginPreviewConversion(Slot& slot) {
    renderer_->render(
        slot.source_view.Get(), slot.output_view.Get(),
        slot.source_width, slot.source_height,
        slot.content_width, slot.content_height,
        slot.output_width, slot.output_height);
    requireHr(
        slot.completion->begin(kGpuCompletionTimeout),
        ScreenGpuCaptureErrorCode::DeviceLost,
        "failed to arm GPU preview completion");
    ++gpu_submissions_;
  }

  void publishReady(std::chrono::steady_clock::time_point now) {
    std::lock_guard lock(mutex_);
    revokeExpiredLocked(now);
    const auto discard_ready = [this](Slot& slot) {
      static_cast<void>(lease_state_.release(slot.sequence));
      slot.phase = SlotPhase::Available;
      slot.sequence = 0;
      slot.timestamp_us = 0;
      ++frames_dropped_stale_;
    };
    std::optional<std::size_t> newest;
    for (std::size_t index = 0; index < slots_.size(); ++index) {
      auto& slot = slots_[index];
      if (slot.phase != SlotPhase::Ready) continue;
      if (!demand_.demanded || demand_.electron_main_pid == 0 ||
          slot.demand_revision != demand_revision_ ||
          slot.sequence <= last_published_sequence_) {
        discard_ready(slot);
        continue;
      }
      if (!newest || slot.sequence > slots_[*newest].sequence) {
        newest = index;
      }
    }
    if (!newest) return;
    for (std::size_t index = 0; index < slots_.size(); ++index) {
      auto& slot = slots_[index];
      if (index == *newest || slot.phase != SlotPhase::Ready) continue;
      discard_ready(slot);
    }
    if (pending_) return;

    const auto index = *newest;
    auto& slot = slots_[index];

    HANDLE main_process =
        OpenProcess(PROCESS_DUP_HANDLE, FALSE, demand_.electron_main_pid);
    if (!main_process) {
      static_cast<void>(lease_state_.release(slot.sequence));
      slot.phase = SlotPhase::Available;
      throw ScreenGpuCaptureError(
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "Electron main process is unavailable for preview");
    }
    HANDLE duplicated = nullptr;
    const BOOL duplicated_ok = DuplicateHandle(
        GetCurrentProcess(),
        slot.shared_handle,
        main_process,
        &duplicated,
        0,
        FALSE,
        DUPLICATE_SAME_ACCESS);
    CloseHandle(main_process);
    if (!duplicated_ok) {
      static_cast<void>(lease_state_.release(slot.sequence));
      slot.phase = SlotPhase::Available;
      throw ScreenGpuCaptureError(
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "failed to duplicate preview texture handle");
    }

    slot.remote_handle = duplicated;
    slot.remote_pid = demand_.electron_main_pid;
    slot.phase = SlotPhase::Delivered;
    lease_state_.publishPending(slot.sequence);
    last_published_sequence_ = slot.sequence;
    pending_ = ScreenPreviewFrame{
        slot.sequence,
        slot.timestamp_us,
        slot.output_width,
        slot.output_height,
        reinterpret_cast<std::uint64_t>(duplicated),
    };
  }

  void revokeExpiredLocked(
      std::chrono::steady_clock::time_point now) const noexcept {
    constexpr auto lease_timeout = std::chrono::seconds(5);
    lease_state_.expire(
        now,
        lease_timeout,
        [](std::size_t, std::uint64_t) {
          // Electron owns the delivered allocation until its renderer fence.
          // The main-process bridge handles timeout recovery and bounded
          // replacement admission without making this native slot writable.
        });
  }

  Slot createConfiguredSlot(const PreviewConfiguration& configuration) {
    const auto source_width = configuration.source_width;
    const auto source_height = configuration.source_height;
    const auto output_width = configuration.output_width;
    const auto output_height = configuration.output_height;
    Slot candidate;
    candidate.device_lease = preview_device_lease_;
    candidate.texture_lease = requireScreenVideoResourceAdmission(
        *resource_budget_,
        VideoResourceRequest{
            .owner = VideoResourceOwner::ScreenPreview,
            .owner_id = owner_id_ + ":slot:" +
                std::to_string(++slot_generation_),
            .gpu_generations = 1,
            .textures = {
                {
                    .width = source_width,
                    .height = source_height,
                    .count = 1,
                    .format = VideoTextureFormat::Bgra8,
                },
                {
                    .width = output_width,
                    .height = output_height,
                    .count = 1,
                    .format = VideoTextureFormat::Bgra8,
                },
            },
        });
    try {
      candidate.completion = std::make_unique<D3d11GpuCompletion>(
          preview_device_.Get(), preview_context_.Get());
      requireHr(
          candidate.completion->initializationResult(),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "failed to create preview completion query");

      D3D11_TEXTURE2D_DESC bridge_description{};
      bridge_description.Width = source_width;
      bridge_description.Height = source_height;
      bridge_description.MipLevels = 1;
      bridge_description.ArraySize = 1;
      bridge_description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      bridge_description.SampleDesc.Count = 1;
      bridge_description.Usage = D3D11_USAGE_DEFAULT;
      bridge_description.BindFlags =
          D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
      bridge_description.MiscFlags =
          D3D11_RESOURCE_MISC_SHARED_NTHANDLE |
          D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
      requireHr(
          capture_device_->CreateTexture2D(
              &bridge_description, nullptr, &candidate.capture_bridge),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "failed to create isolated preview bridge texture");
      requireHr(
          candidate.capture_bridge.As(&candidate.capture_bridge_mutex),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "capture preview bridge does not expose keyed mutex");
      ComPtr<IDXGIResource1> bridge_resource;
      requireHr(
          candidate.capture_bridge.As(&bridge_resource),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "capture preview bridge does not expose IDXGIResource1");
      requireHr(
          bridge_resource->CreateSharedHandle(
              nullptr,
              DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
              nullptr,
              &candidate.bridge_handle),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "failed to export isolated preview bridge");
      ComPtr<ID3D11Device1> preview_device1;
      requireHr(
          preview_device_.As(&preview_device1),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "isolated preview device does not expose ID3D11Device1");
      requireHr(
          preview_device1->OpenSharedResource1(
              candidate.bridge_handle,
              IID_PPV_ARGS(&candidate.preview_bridge)),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "failed to open isolated preview bridge");
      requireHr(
          candidate.preview_bridge.As(&candidate.preview_bridge_mutex),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "consumer preview bridge does not expose keyed mutex");

      D3D11_TEXTURE2D_DESC description{};
      description.Width = output_width;
      description.Height = output_height;
      description.MipLevels = 1;
      description.ArraySize = 1;
      description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      description.SampleDesc.Count = 1;
      description.Usage = D3D11_USAGE_DEFAULT;
      description.BindFlags =
          D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
      // Electron's BGRA shared-texture contract requires an NT shared handle
      // without IDXGIKeyedMutex. The render pass writes directly into this
      // texture, and the slot remains immutable while Electron owns the frame.
      description.MiscFlags =
          D3D11_RESOURCE_MISC_SHARED_NTHANDLE |
          D3D11_RESOURCE_MISC_SHARED;
      requireHr(
          preview_device_->CreateTexture2D(
              &description, nullptr, &candidate.texture),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "failed to create shared BGRA preview texture");
      ComPtr<IDXGIResource1> resource;
      requireHr(
          candidate.texture.As(&resource),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "preview texture does not expose IDXGIResource1");
      requireHr(
          resource->CreateSharedHandle(
              nullptr,
              DXGI_SHARED_RESOURCE_READ,
              nullptr,
              &candidate.shared_handle),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "failed to export preview texture handle");
      requireHr(
          preview_device_->CreateShaderResourceView(
              candidate.preview_bridge.Get(),
              nullptr,
              &candidate.source_view),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "failed to create isolated preview source view");
      requireHr(
          preview_device_->CreateRenderTargetView(
              candidate.texture.Get(), nullptr, &candidate.output_view),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "failed to create preview render target");
    } catch (...) {
      resetSlotResources(candidate);
      throw;
    }
    candidate.source_width = source_width;
    candidate.source_height = source_height;
    candidate.output_width = output_width;
    candidate.output_height = output_height;
    candidate.device_generation = device_generation_;

    return candidate;
  }

  static void resetSlotResources(Slot& slot) noexcept {
    closeRemoteHandle(slot);
    if (slot.bridge_handle) CloseHandle(slot.bridge_handle);
    if (slot.shared_handle) CloseHandle(slot.shared_handle);
    slot.bridge_handle = nullptr;
    slot.shared_handle = nullptr;
    slot.capture_bridge_mutex.Reset();
    slot.capture_bridge.Reset();
    slot.preview_bridge_mutex.Reset();
    slot.preview_bridge.Reset();
    slot.source_view.Reset();
    slot.output_view.Reset();
    slot.texture.Reset();
    slot.completion.reset();
    slot.texture_lease.reset();
    slot.device_lease.reset();
    slot = Slot{};
  }

  static void closeRemoteHandle(Slot& slot) noexcept {
    if (!slot.remote_handle || slot.remote_pid == 0) {
      slot.remote_handle = nullptr;
      slot.remote_pid = 0;
      return;
    }
    const HANDLE process = OpenProcess(PROCESS_DUP_HANDLE, FALSE, slot.remote_pid);
    if (process) {
      HANDLE local = nullptr;
      if (DuplicateHandle(
              process, slot.remote_handle, GetCurrentProcess(), &local, 0, FALSE,
              DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS)) {
        CloseHandle(local);
      }
      CloseHandle(process);
    }
    slot.remote_handle = nullptr;
    slot.remote_pid = 0;
  }

  void recordFailureLocked(
      ScreenGpuCaptureErrorCode code,
      long hresult,
      std::string message,
      std::chrono::steady_clock::time_point now) {
    next_retry_at_ = now + std::chrono::seconds(1);
    if (last_failure_report_at_ != std::chrono::steady_clock::time_point{} &&
        now - last_failure_report_at_ < std::chrono::seconds(10)) {
      ++suppressed_failures_;
      return;
    }
    pending_failure_ = ScreenPreviewFailure{
        code, hresult, std::move(message), suppressed_failures_};
    suppressed_failures_ = 0;
    last_failure_report_at_ = now;
  }

  void tryResetPreviewDevice(
      std::chrono::steady_clock::time_point now) noexcept {
    {
      std::lock_guard lock(mutex_);
      if (!preview_device_reset_required_ || now < next_retry_at_) return;
    }

    try {
      auto replacement = createSiblingDevice(
          capture_device_.Get(),
          *resource_budget_,
          owner_id_ + ":device:" +
              std::to_string(device_generation_ + 1));
      auto replacement_renderer = std::make_unique<GpuPreviewRenderer>(
          replacement.device.Get(), replacement.context.Get());

      std::lock_guard lock(mutex_);
      preview_device_ = std::move(replacement.device);
      preview_context_ = std::move(replacement.context);
      preview_device_lease_ = std::move(replacement.resource_lease);
      renderer_ = std::move(replacement_renderer);
      ++device_generation_;
      ++device_resets_;
      for (auto& slot : slots_) {
        if (slot.phase == SlotPhase::Delivered) continue;
        if (slot.sequence != 0) {
          static_cast<void>(lease_state_.release(slot.sequence));
        }
        closeRemoteHandle(slot);
        if (slot.bridge_handle) CloseHandle(slot.bridge_handle);
        if (slot.shared_handle) CloseHandle(slot.shared_handle);
        slot = Slot{};
      }
      preview_device_reset_required_ = false;
      next_retry_at_ = {};
    } catch (const ScreenGpuCaptureError& error) {
      std::lock_guard lock(mutex_);
      recordFailureLocked(error.code(), error.hresult(), error.what(), now);
    } catch (const std::exception& error) {
      std::lock_guard lock(mutex_);
      recordFailureLocked(
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          0,
          error.what(),
          now);
    } catch (...) {
      std::lock_guard lock(mutex_);
      recordFailureLocked(
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          0,
          "unknown isolated preview device reset failure",
          now);
    }
  }

  VideoResourceAdmissionBudget* resource_budget_ = nullptr;
  std::string owner_id_;
  std::shared_ptr<VideoResourceLease> preview_device_lease_;
  ComPtr<ID3D11Device> capture_device_;
  ComPtr<ID3D11DeviceContext> capture_context_;
  ComPtr<ID3D11Device> preview_device_;
  ComPtr<ID3D11DeviceContext> preview_context_;
  std::unique_ptr<GpuPreviewRenderer> renderer_;
  const std::uint32_t max_width_;
  const std::uint32_t max_height_;
  mutable std::mutex mutex_;
  ScreenPreviewDemand demand_;
  mutable std::array<Slot, 3> slots_;
  mutable ScreenPreviewLeaseState<3> lease_state_;
  mutable std::optional<ScreenPreviewFrame> pending_;
  std::optional<ScreenPreviewFailure> pending_failure_;
  std::optional<PreviewConfiguration> desired_configuration_;
  std::size_t next_slot_ = 0;
  std::size_t next_configure_slot_ = 0;
  std::uint64_t last_published_sequence_ = 0;
  std::uint64_t demand_revision_ = 0;
  std::uint64_t device_generation_ = 1;
  std::uint64_t slot_generation_ = 0;
  bool preview_device_reset_required_ = false;
  std::chrono::steady_clock::time_point last_frame_at_{};
  std::chrono::steady_clock::time_point next_retry_at_{};
  std::chrono::steady_clock::time_point last_failure_report_at_{};
  std::uint64_t suppressed_failures_ = 0;
  std::uint64_t bridge_submissions_ = 0;
  std::uint64_t bridge_acquires_ = 0;
  std::uint64_t bridge_timeouts_ = 0;
  std::uint64_t bridge_slots_recovered_ = 0;
  std::uint64_t gpu_submissions_ = 0;
  std::uint64_t frames_completed_ = 0;
  std::uint64_t slot_timeouts_ = 0;
  std::uint64_t frames_dropped_stale_ = 0;
  std::uint64_t device_resets_ = 0;
  std::uint64_t enqueue_lock_drops_ = 0;
  std::uint64_t enqueue_coalesced_drops_ = 0;
};

class DxgiGpuCapturer final : public ScreenGpuCapturer {
 public:
  DxgiGpuCapturer(
      const syrnike::voice::ScreenCaptureTarget& target,
      std::uint32_t width,
      std::uint32_t height,
      VideoResourceAdmissionBudget& resource_budget,
      std::string owner_id)
      : target_(target),
        resource_budget_(&resource_budget),
        owner_id_(std::move(owner_id)),
        selection_(selectAdapter(target_)),
        d3d_(createDevice(
            selection_, *resource_budget_, owner_id_ + ":dxgi_device")),
        compositor_(
            d3d_.device.Get(), d3d_.context.Get(), *resource_budget_, owner_id_),
        pipeline_(
            d3d_.device.Get(), d3d_.context.Get(), d3d_.adapter_luid, width,
            height, *resource_budget_, owner_id_),
        preview_(
            d3d_.device.Get(), d3d_.context.Get(), width, height,
            *resource_budget_, owner_id_ + ":preview") {
    recreateDuplication();
  }

  ScreenGpuFrameResult capture(ScreenGpuFrame& frame) override {
    if (!duplication_) {
      return {
          ScreenGpuFrameStatus::RecoverableLost,
          {},
          method(),
          duplication_access_lost_
              ? ScreenGpuCaptureErrorCode::AccessLost
              : ScreenGpuCaptureErrorCode::CaptureUnavailable,
      };
    }
    const auto capture_started_at = std::chrono::steady_clock::now();
    DXGI_OUTDUPL_FRAME_INFO frame_info{};
    ComPtr<IDXGIResource> resource;
    HRESULT hr = duplication_->AcquireNextFrame(1, &frame_info, &resource);
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
      try {
        return sampleLatest(frame);
      } catch (const ScreenGpuCaptureError& error) {
        syrnike::voice::ScreenCaptureFrameMetrics metrics;
        metrics.hresult = error.hresult();
        return {
            ScreenGpuFrameStatus::FatalError,
            metrics,
            method(),
            error.code(),
        };
      }
    }
    if (hr == DXGI_ERROR_ACCESS_LOST) {
      duplication_access_lost_ = true;
      syrnike::voice::ScreenCaptureFrameMetrics metrics;
      metrics.hresult = static_cast<long>(hr);
      return {
          ScreenGpuFrameStatus::RecoverableLost,
          metrics,
          method(),
          ScreenGpuCaptureErrorCode::AccessLost,
      };
    }
    if (FAILED(hr)) {
      syrnike::voice::ScreenCaptureFrameMetrics metrics;
      metrics.hresult = static_cast<long>(hr);
      return {ScreenGpuFrameStatus::FatalError, metrics, method(),
              hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET
                  ? ScreenGpuCaptureErrorCode::DeviceLost
                  : ScreenGpuCaptureErrorCode::CaptureUnavailable};
    }
    const auto duplication_acquired_at = std::chrono::steady_clock::now();

    syrnike::voice::ScreenCaptureFrameMetrics metrics;
    ScreenDxgiFrameLease frame_lease(
        metrics.duplication_hold_us,
        duplication_acquired_at,
        [this]() noexcept {
          return static_cast<long>(duplication_->ReleaseFrame());
        },
        [] { return std::chrono::steady_clock::now(); });

    ComPtr<ID3D11Texture2D> texture;
    hr = resource.As(&texture);
    if (FAILED(hr)) {
      frame_lease.release();
      metrics.hresult = static_cast<long>(hr);
      return {ScreenGpuFrameStatus::FatalError, metrics, method(),
              ScreenGpuCaptureErrorCode::InteropUnavailable};
    }
    metrics.source_width = native_width_;
    metrics.source_height = native_height_;
    metrics.content_width = native_width_;
    metrics.content_height = native_height_;
    metrics.capture_us = static_cast<int>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - capture_started_at)
            .count());
    ScreenGpuFrameResult result;
    try {
      auto* composed = compositor_.compose(
          texture.Get(), duplication_.Get(), frame_info,
          selection_.output_description.Rotation);
      // D3D11 retains resources referenced by submitted commands. Keep the
      // composed output, release Desktop Duplication immediately, and let the
      // bounded output pool observe completion asynchronously. This mirrors
      // OBS's CopyResource -> ReleaseFrame ownership model without blocking
      // capture on the GPU command queue.
      latest_texture_ = composed;
      const HRESULT release_result = frame_lease.release();
      if (FAILED(release_result)) {
        throwHr(
            captureErrorForHr(release_result),
            "failed to release DXGI frame after composition",
            release_result);
      }
      latest_metrics_ = metrics;
      cadence_.noteSourceUpdate();
      result = sampleLatest(frame);
    } catch (const ScreenGpuCaptureError& error) {
      metrics.hresult = error.hresult();
      result = {ScreenGpuFrameStatus::FatalError, metrics, method(), error.code()};
    }
    if (!frame_lease.released()) frame_lease.release();
    return result;
  }

  void discard(const ScreenGpuFrame& frame) noexcept override {
    pipeline_.discard(frame);
  }
  bool requestPreviewFrame() noexcept override {
    if (!latest_texture_) return false;
    return preview_.tryEnqueue(
        latest_texture_.Get(), native_width_, native_height_, native_width_,
        native_height_, steadyMicros());
  }
  void pollOptionalWork() noexcept override {
    preview_.poll();
  }
  bool optionalWorkPending() const noexcept override {
    return preview_.pendingWork();
  }
  void pollRetirement() noexcept override {
    preview_.poll();
    pipeline_.pollRetirement(method());
  }
  void setPreviewDemand(ScreenPreviewDemand demand) override {
    preview_.setDemand(demand);
  }
  bool takePreviewFrame(ScreenPreviewFrame& frame) override {
    return preview_.take(frame);
  }
  bool takePreviewFailure(ScreenPreviewFailure& failure) override {
    return preview_.takeFailure(failure);
  }
  void releasePreviewFrame(std::uint64_t sequence) noexcept override {
    preview_.release(sequence);
  }
  std::size_t previewFramesInFlight() const noexcept override {
    return preview_.inFlight();
  }
  const char* method() const noexcept override { return "dxgi_gpu"; }
  LUID adapterLuid() const noexcept override { return d3d_.adapter_luid; }
  std::size_t frameSlotsAvailable() const noexcept override {
    return pipeline_.availableSlots();
  }
  std::size_t frameSlotsTotal() const noexcept override {
    return pipeline_.totalSlots();
  }
  bool retirementSafe() const noexcept override {
    return preview_.inFlight() == 0 && pipeline_.retirementSafe();
  }
  ScreenFrameFlowStats frameFlowStats() const noexcept override {
    auto stats = pipeline_.flowStats();
    const auto preview_stats = preview_.flowStats();
    stats.preview_bridge_submissions =
        preview_stats.preview_bridge_submissions;
    stats.preview_bridge_acquires = preview_stats.preview_bridge_acquires;
    stats.preview_bridge_timeouts = preview_stats.preview_bridge_timeouts;
    stats.preview_bridge_slots_recovered =
        preview_stats.preview_bridge_slots_recovered;
    stats.preview_gpu_submissions = preview_stats.preview_gpu_submissions;
    stats.preview_frames_completed = preview_stats.preview_frames_completed;
    stats.preview_slot_timeouts = preview_stats.preview_slot_timeouts;
    stats.preview_frames_dropped_stale =
        preview_stats.preview_frames_dropped_stale;
    stats.preview_device_resets = preview_stats.preview_device_resets;
    stats.source_updates = cadence_.sourceRevision();
    stats.idle_refreshes = cadence_.idleRefreshes();
    stats.coalesced_source_updates = cadence_.coalescedSourceUpdates();
    return stats;
  }

  void reinitializeDuplication() {
    // Desktop Duplication permits only one duplication per output in a
    // process. Reset the lost interface before DuplicateOutput creates its
    // replacement; constructing a second capturer first can never recover.
    recreateDuplication();
  }

  void suspendDuplication() noexcept {
    duplication_.Reset();
    duplication_lease_.reset();
  }

 private:
  ScreenGpuFrameResult sampleLatest(ScreenGpuFrame& frame) {
    if (!latest_texture_) {
      return pipeline_.poll(method(), frame);
    }

    const auto now = std::chrono::steady_clock::now();
    const auto reason = cadence_.decision(now);
    const auto timestamp_us = steadyMicros();
    if (reason == ScreenFrameSubmitReason::None) {
      return pipeline_.poll(method(), frame);
    }

    auto metrics = latest_metrics_;
    if (reason == ScreenFrameSubmitReason::IdleRefresh) {
      metrics.capture_us = 0;
      metrics.duplication_hold_us = 0;
    }
    auto result = pipeline_.process(
        latest_texture_.Get(), native_width_, native_height_, native_width_,
        native_height_, timestamp_us, method(), metrics, frame);
    if (result.source_submitted) cadence_.noteSubmitted(reason, now);
    return result;
  }

  void recreateDuplication() {
    requireHr(
        selection_.output->GetDesc(&selection_.output_description),
        ScreenGpuCaptureErrorCode::CaptureUnavailable,
        "failed to refresh selected DXGI output");
    const auto candidate_width = static_cast<std::uint32_t>(
        selection_.output_description.DesktopCoordinates.right -
        selection_.output_description.DesktopCoordinates.left);
    const auto candidate_height = static_cast<std::uint32_t>(
        selection_.output_description.DesktopCoordinates.bottom -
        selection_.output_description.DesktopCoordinates.top);
    auto candidate_lease = requireScreenVideoResourceAdmission(
        *resource_budget_,
        VideoResourceRequest{
            .owner = VideoResourceOwner::ScreenCapture,
            .owner_id = owner_id_ + ":dxgi_duplication:" +
                std::to_string(++duplication_generation_),
            .gpu_generations = 1,
            .textures = {{
                .width = candidate_width,
                .height = candidate_height,
                .count = 1,
                .format = VideoTextureFormat::Bgra8,
            }},
        });
    duplication_.Reset();
    duplication_lease_.reset();
    ComPtr<IDXGIOutputDuplication> candidate_duplication;
    requireHr(
        selection_.output->DuplicateOutput(
            d3d_.device.Get(), &candidate_duplication),
        ScreenGpuCaptureErrorCode::CaptureUnavailable,
        "failed to create DXGI output duplication");
    duplication_ = std::move(candidate_duplication);
    duplication_lease_ = std::move(candidate_lease);
    // A duplication session boundary can also change the desktop dimensions.
    // Never sample the previous session's texture using the refreshed output
    // description; wait for the first frame from the replacement duplication.
    latest_texture_.Reset();
    latest_metrics_ = {};
    cadence_.reset();
    duplication_access_lost_ = false;
    native_width_ = candidate_width;
    native_height_ = candidate_height;
  }

  syrnike::voice::ScreenCaptureTarget target_;
  VideoResourceAdmissionBudget* resource_budget_ = nullptr;
  std::string owner_id_;
  AdapterSelection selection_;
  D3dDevice d3d_;
  DxgiFrameCompositor compositor_;
  GpuFramePipeline pipeline_;
  GpuPreviewPool preview_;
  ScreenFrameCadence cadence_;
  ComPtr<ID3D11Texture2D> latest_texture_;
  syrnike::voice::ScreenCaptureFrameMetrics latest_metrics_;
  std::shared_ptr<VideoResourceLease> duplication_lease_;
  ComPtr<IDXGIOutputDuplication> duplication_;
  std::uint64_t duplication_generation_ = 0;
  bool duplication_access_lost_ = false;
  std::uint32_t native_width_ = 0;
  std::uint32_t native_height_ = 0;
};

class WgcGpuCapturer final : public ScreenGpuCapturer {
 public:
  WgcGpuCapturer(
      const syrnike::voice::ScreenCaptureTarget& target,
      std::uint32_t width,
      std::uint32_t height,
      VideoResourceAdmissionBudget& resource_budget,
      std::string owner_id)
      : target_(target),
        resource_budget_(&resource_budget),
        owner_id_(std::move(owner_id)),
        selection_(selectAdapter(target_)),
        d3d_(createDevice(
            selection_, *resource_budget_, owner_id_ + ":wgc_device")),
        pipeline_(
            d3d_.device.Get(), d3d_.context.Get(), d3d_.adapter_luid, width,
            height, *resource_budget_, owner_id_),
        preview_(
            d3d_.device.Get(), d3d_.context.Get(), width, height,
            *resource_budget_, owner_id_ + ":preview") {
    initialize();
  }

  ~WgcGpuCapturer() override {
    closeCaptureSession();
  }

  ScreenGpuFrameResult capture(ScreenGpuFrame& frame) override {
    if (target_closed_.load(std::memory_order_acquire) ||
        (target_.window && !IsWindow(target_.hwnd))) {
      return {ScreenGpuFrameStatus::TargetClosed, {}, method(),
              ScreenGpuCaptureErrorCode::TargetClosed};
    }
    const auto started_at = std::chrono::steady_clock::now();
    capture::Direct3D11CaptureFrame capture_frame{nullptr};
    winrt::Windows::Graphics::SizeInt32 content_size{};
    try {
      capture_frame = frame_pool_.TryGetNextFrame();
      if (capture_frame) {
        // Sampling runs on its own cadence. Drain the bounded WGC queue so a
        // delayed capture iteration publishes the newest complete desktop
        // composition instead of adding latency frame by frame.
        for (std::size_t drained = 0; drained < 3; ++drained) {
          auto newer = frame_pool_.TryGetNextFrame();
          if (!newer) break;
          capture_frame.Close();
          capture_frame = std::move(newer);
        }
        content_size = capture_frame.ContentSize();
      }
    } catch (const winrt::hresult_error& error) {
      syrnike::voice::ScreenCaptureFrameMetrics metrics;
      metrics.hresult = static_cast<long>(error.code());
      const auto code = captureErrorForHr(error.code());
      return {
          code == ScreenGpuCaptureErrorCode::TargetClosed
              ? ScreenGpuFrameStatus::TargetClosed
              : ScreenGpuFrameStatus::FatalError,
          metrics,
          method(),
          code,
      };
    }
    if (!capture_frame) {
      try {
        return sampleLatest(frame);
      } catch (const ScreenGpuCaptureError& error) {
        syrnike::voice::ScreenCaptureFrameMetrics metrics;
        metrics.hresult = error.hresult();
        return {
            ScreenGpuFrameStatus::FatalError,
            metrics,
            method(),
            error.code(),
        };
      }
    }
    if (content_size.Width <= 0 || content_size.Height <= 0) {
      return {ScreenGpuFrameStatus::NoFrame, {}, method()};
    }
    if (content_size.Width != pool_size_.Width || content_size.Height != pool_size_.Height) {
      try {
        capture_frame.Close();
        recreateFramePool(content_size);
        return {ScreenGpuFrameStatus::NoFrame, {}, method()};
      } catch (const winrt::hresult_error& error) {
        syrnike::voice::ScreenCaptureFrameMetrics metrics;
        metrics.hresult = static_cast<long>(error.code());
        const auto code = captureErrorForHr(error.code());
        return {
            code == ScreenGpuCaptureErrorCode::TargetClosed
                ? ScreenGpuFrameStatus::TargetClosed
                : ScreenGpuFrameStatus::FatalError,
            metrics,
            method(),
            code,
        };
      }
    }

    ComPtr<ID3D11Texture2D> texture;
    try {
      auto access = capture_frame.Surface().as<
          Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
      const HRESULT hr = access->GetInterface(IID_PPV_ARGS(&texture));
      if (FAILED(hr)) {
        syrnike::voice::ScreenCaptureFrameMetrics metrics;
        metrics.hresult = static_cast<long>(hr);
        return {ScreenGpuFrameStatus::FatalError, metrics, method(),
                ScreenGpuCaptureErrorCode::InteropUnavailable};
      }
    } catch (const winrt::hresult_error& error) {
      syrnike::voice::ScreenCaptureFrameMetrics metrics;
      metrics.hresult = static_cast<long>(error.code());
      const auto code = captureErrorForHr(error.code());
      const auto reported_code = code == ScreenGpuCaptureErrorCode::CaptureUnavailable
          ? ScreenGpuCaptureErrorCode::InteropUnavailable
          : code;
      return {
          code == ScreenGpuCaptureErrorCode::TargetClosed
              ? ScreenGpuFrameStatus::TargetClosed
              : ScreenGpuFrameStatus::FatalError,
          metrics,
          method(),
          reported_code,
      };
    }

    syrnike::voice::ScreenCaptureFrameMetrics metrics;
    metrics.source_width = static_cast<std::uint32_t>(pool_size_.Width);
    metrics.source_height = static_cast<std::uint32_t>(pool_size_.Height);
    metrics.content_width = static_cast<std::uint32_t>(content_size.Width);
    metrics.content_height = static_cast<std::uint32_t>(content_size.Height);
    metrics.capture_us = static_cast<int>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - started_at)
            .count());
    try {
      ensureLatestTexture(
          static_cast<std::uint32_t>(pool_size_.Width),
          static_cast<std::uint32_t>(pool_size_.Height));
      d3d_.context->CopyResource(latest_texture_.Get(), texture.Get());
      latest_content_width_ = static_cast<std::uint32_t>(content_size.Width);
      latest_content_height_ = static_cast<std::uint32_t>(content_size.Height);
      latest_metrics_ = metrics;
      cadence_.noteSourceUpdate();
      capture_frame.Close();
      return sampleLatest(frame);
    } catch (const ScreenGpuCaptureError& error) {
      metrics.hresult = error.hresult();
      return {ScreenGpuFrameStatus::FatalError, metrics, method(), error.code()};
    } catch (const winrt::hresult_error& error) {
      metrics.hresult = static_cast<long>(error.code());
      const auto code = captureErrorForHr(error.code());
      return {
          code == ScreenGpuCaptureErrorCode::TargetClosed
              ? ScreenGpuFrameStatus::TargetClosed
              : ScreenGpuFrameStatus::FatalError,
          metrics,
          method(),
          code,
      };
    }
  }

  void discard(const ScreenGpuFrame& frame) noexcept override {
    pipeline_.discard(frame);
  }
  bool requestPreviewFrame() noexcept override {
    if (!latest_texture_) return false;
    return preview_.tryEnqueue(
        latest_texture_.Get(), latest_width_, latest_height_,
        latest_content_width_, latest_content_height_, steadyMicros());
  }
  void pollOptionalWork() noexcept override {
    preview_.poll();
  }
  bool optionalWorkPending() const noexcept override {
    return preview_.pendingWork();
  }
  void pollRetirement() noexcept override {
    preview_.poll();
    pipeline_.pollRetirement(method());
  }
  void setPreviewDemand(ScreenPreviewDemand demand) override {
    preview_.setDemand(demand);
  }
  bool takePreviewFrame(ScreenPreviewFrame& frame) override {
    return preview_.take(frame);
  }
  bool takePreviewFailure(ScreenPreviewFailure& failure) override {
    return preview_.takeFailure(failure);
  }
  void releasePreviewFrame(std::uint64_t sequence) noexcept override {
    preview_.release(sequence);
  }
  std::size_t previewFramesInFlight() const noexcept override {
    return preview_.inFlight();
  }
  const char* method() const noexcept override { return "wgc_gpu"; }
  LUID adapterLuid() const noexcept override { return d3d_.adapter_luid; }
  std::size_t frameSlotsAvailable() const noexcept override {
    return pipeline_.availableSlots();
  }
  std::size_t frameSlotsTotal() const noexcept override {
    return pipeline_.totalSlots();
  }
  bool retirementSafe() const noexcept override {
    return preview_.inFlight() == 0 && pipeline_.retirementSafe();
  }
  ScreenFrameFlowStats frameFlowStats() const noexcept override {
    auto stats = pipeline_.flowStats();
    const auto preview_stats = preview_.flowStats();
    stats.preview_bridge_submissions =
        preview_stats.preview_bridge_submissions;
    stats.preview_bridge_acquires = preview_stats.preview_bridge_acquires;
    stats.preview_bridge_timeouts = preview_stats.preview_bridge_timeouts;
    stats.preview_bridge_slots_recovered =
        preview_stats.preview_bridge_slots_recovered;
    stats.preview_gpu_submissions = preview_stats.preview_gpu_submissions;
    stats.preview_frames_completed = preview_stats.preview_frames_completed;
    stats.preview_slot_timeouts = preview_stats.preview_slot_timeouts;
    stats.preview_frames_dropped_stale =
        preview_stats.preview_frames_dropped_stale;
    stats.preview_device_resets = preview_stats.preview_device_resets;
    stats.source_updates = cadence_.sourceRevision();
    stats.idle_refreshes = cadence_.idleRefreshes();
    stats.coalesced_source_updates = cadence_.coalescedSourceUpdates();
    return stats;
  }

 private:
  void ensureLatestTexture(std::uint32_t width, std::uint32_t height) {
    if (latest_texture_ && latest_width_ == width && latest_height_ == height) {
      return;
    }
    auto candidate_lease = requireScreenVideoResourceAdmission(
        *resource_budget_,
        VideoResourceRequest{
            .owner = VideoResourceOwner::ScreenCapture,
            .owner_id = owner_id_ + ":wgc_latest:" +
                std::to_string(++latest_texture_generation_),
            .textures = {{
                .width = width,
                .height = height,
                .count = 1,
                .format = VideoTextureFormat::Bgra8,
            }},
        });
    D3D11_TEXTURE2D_DESC description{};
    description.Width = width;
    description.Height = height;
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_DEFAULT;
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    ComPtr<ID3D11Texture2D> candidate_texture;
    requireHr(
        d3d_.device->CreateTexture2D(
            &description, nullptr, &candidate_texture),
        ScreenGpuCaptureErrorCode::DeviceLost,
        "failed to create WGC latest-frame texture");
    latest_texture_ = std::move(candidate_texture);
    latest_texture_lease_ = std::move(candidate_lease);
    latest_width_ = width;
    latest_height_ = height;
    cadence_.reset();
  }

  ScreenGpuFrameResult sampleLatest(ScreenGpuFrame& frame) {
    if (!latest_texture_) {
      return pipeline_.poll(method(), frame);
    }

    const auto now = std::chrono::steady_clock::now();
    const auto reason = cadence_.decision(now);
    const auto timestamp_us = steadyMicros();
    if (reason == ScreenFrameSubmitReason::None) {
      return pipeline_.poll(method(), frame);
    }

    auto metrics = latest_metrics_;
    if (reason == ScreenFrameSubmitReason::IdleRefresh) metrics.capture_us = 0;
    auto result = pipeline_.process(
        latest_texture_.Get(), latest_width_, latest_height_,
        latest_content_width_, latest_content_height_, timestamp_us, method(),
        metrics, frame);
    if (result.source_submitted) cadence_.noteSubmitted(reason, now);
    return result;
  }

  void closeCaptureSession() noexcept {
    try {
      if (closed_subscribed_ && item_) item_.Closed(closed_token_);
    } catch (...) {
    }
    closed_subscribed_ = false;
    try {
      if (session_) session_.Close();
    } catch (...) {
    }
    try {
      if (frame_pool_) frame_pool_.Close();
    } catch (...) {
    }
    session_ = nullptr;
    frame_pool_ = nullptr;
    frame_pool_lease_.reset();
    item_ = nullptr;
    latest_texture_.Reset();
    latest_texture_lease_.reset();
  }

  void initialize() {
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
    } catch (const winrt::hresult_error& error) {
      if (error.code() != RPC_E_CHANGED_MODE) throw;
    }
    ComPtr<IDXGIDevice> dxgi_device;
    requireHr(
        d3d_.device.As(&dxgi_device),
        ScreenGpuCaptureErrorCode::InteropUnavailable,
        "failed to query WGC DXGI device");
    IInspectable* raw_device = nullptr;
    requireHr(
        CreateDirect3D11DeviceFromDXGIDevice(dxgi_device.Get(), &raw_device),
        ScreenGpuCaptureErrorCode::InteropUnavailable,
        "failed to create WGC Direct3D device");
    winrt::com_ptr<IInspectable> inspectable_device;
    inspectable_device.attach(raw_device);
    winrt_device_ = inspectable_device.as<d3dwinrt::IDirect3DDevice>();

    auto interop = winrt::get_activation_factory<
        capture::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    winrt::com_ptr<ABI::Windows::Graphics::Capture::IGraphicsCaptureItem> raw_item;
    HRESULT hr = E_FAIL;
    if (target_.window) {
      hr = interop->CreateForWindow(
          target_.hwnd,
          __uuidof(ABI::Windows::Graphics::Capture::IGraphicsCaptureItem),
          reinterpret_cast<void**>(raw_item.put()));
    } else {
      const HMONITOR monitor =
          syrnike::voice::resolveScreenMonitorHandle(target_);
      if (!monitor) {
        throw ScreenGpuCaptureError(
            ScreenGpuCaptureErrorCode::TargetClosed,
            "selected monitor is no longer available");
      }
      hr = interop->CreateForMonitor(
          monitor,
          __uuidof(ABI::Windows::Graphics::Capture::IGraphicsCaptureItem),
          reinterpret_cast<void**>(raw_item.put()));
      if (FAILED(hr) &&
          !syrnike::voice::resolveScreenMonitorHandle(target_)) {
        throw ScreenGpuCaptureError(
            ScreenGpuCaptureErrorCode::TargetClosed,
            "selected monitor is no longer available",
            static_cast<long>(hr));
      }
    }
    requireHr(
        hr,
        ScreenGpuCaptureErrorCode::CaptureUnavailable,
        "failed to create WGC item for selected target");
    item_ = raw_item.as<capture::GraphicsCaptureItem>();
    closed_token_ = item_.Closed([this](auto const&, auto const&) {
      target_closed_.store(true, std::memory_order_release);
    });
    closed_subscribed_ = true;
    pool_size_ = item_.Size();
    if (pool_size_.Width <= 0 || pool_size_.Height <= 0) {
      throw ScreenGpuCaptureError(
          ScreenGpuCaptureErrorCode::CaptureUnavailable,
          "selected WGC window has invalid dimensions");
    }
    auto candidate_pool_lease = acquireWgcFramePoolLease(
        static_cast<std::uint32_t>(pool_size_.Width),
        static_cast<std::uint32_t>(pool_size_.Height));
    frame_pool_ = capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
        winrt_device_,
        directx::DirectXPixelFormat::B8G8R8A8UIntNormalized,
        3,
        pool_size_);
    frame_pool_lease_ = std::move(candidate_pool_lease);
    session_ = frame_pool_.CreateCaptureSession(item_);
    session_.IsCursorCaptureEnabled(true);
    disableCaptureBorderIfAllowed(session_);
    session_.StartCapture();
  }

  void recreateFramePool(winrt::Windows::Graphics::SizeInt32 size) {
    if (size.Width <= 0 || size.Height <= 0) return;
    auto candidate_pool_lease = acquireWgcFramePoolLease(
        static_cast<std::uint32_t>(size.Width),
        static_cast<std::uint32_t>(size.Height));
    frame_pool_.Recreate(
        winrt_device_,
        directx::DirectXPixelFormat::B8G8R8A8UIntNormalized,
        3,
        size);
    pool_size_ = size;
    frame_pool_lease_ = std::move(candidate_pool_lease);
    latest_texture_.Reset();
    latest_texture_lease_.reset();
    latest_width_ = 0;
    latest_height_ = 0;
    latest_content_width_ = 0;
    latest_content_height_ = 0;
    latest_metrics_ = {};
    cadence_.reset();
  }

  std::shared_ptr<VideoResourceLease> acquireWgcFramePoolLease(
      std::uint32_t width,
      std::uint32_t height) {
    return requireScreenVideoResourceAdmission(
        *resource_budget_,
        VideoResourceRequest{
            .owner = VideoResourceOwner::ScreenCapture,
            .owner_id = owner_id_ + ":wgc_frame_pool:" +
                std::to_string(++frame_pool_generation_),
            .gpu_generations = 1,
            .textures = {{
                .width = width,
                .height = height,
                .count = 3,
                .format = VideoTextureFormat::Bgra8,
            }},
        });
  }

  syrnike::voice::ScreenCaptureTarget target_;
  VideoResourceAdmissionBudget* resource_budget_ = nullptr;
  std::string owner_id_;
  AdapterSelection selection_;
  D3dDevice d3d_;
  GpuFramePipeline pipeline_;
  GpuPreviewPool preview_;
  ScreenFrameCadence cadence_;
  std::shared_ptr<VideoResourceLease> latest_texture_lease_;
  ComPtr<ID3D11Texture2D> latest_texture_;
  syrnike::voice::ScreenCaptureFrameMetrics latest_metrics_;
  std::uint32_t latest_width_ = 0;
  std::uint32_t latest_height_ = 0;
  std::uint32_t latest_content_width_ = 0;
  std::uint32_t latest_content_height_ = 0;
  std::uint64_t latest_texture_generation_ = 0;
  d3dwinrt::IDirect3DDevice winrt_device_{nullptr};
  capture::GraphicsCaptureItem item_{nullptr};
  std::shared_ptr<VideoResourceLease> frame_pool_lease_;
  capture::Direct3D11CaptureFramePool frame_pool_{nullptr};
  capture::GraphicsCaptureSession session_{nullptr};
  winrt::Windows::Graphics::SizeInt32 pool_size_{};
  winrt::event_token closed_token_{};
  bool closed_subscribed_ = false;
  std::atomic_bool target_closed_{false};
  std::uint64_t frame_pool_generation_ = 0;
};

std::shared_ptr<ScreenGpuCapturer> createWgcGpuCapturer(
    const syrnike::voice::ScreenCaptureTarget& target,
    std::uint32_t width,
    std::uint32_t height,
    VideoResourceAdmissionBudget& resource_budget,
    const std::string& owner_id) {
  try {
    return std::make_shared<WgcGpuCapturer>(
        target, width, height, resource_budget, owner_id);
  } catch (const ScreenGpuCaptureError&) {
    throw;
  } catch (const winrt::hresult_error& error) {
    throw ScreenGpuCaptureError(
        ScreenGpuCaptureErrorCode::CaptureUnavailable,
        "Windows Graphics Capture initialization failed",
        static_cast<long>(error.code()));
  }
}

// Window capture has no DXGI fallback, but it still needs the same local
// failure boundary as monitor capture. A dead WGC/D3D generation is replaced
// behind this wrapper while the publication remains alive and drops frames.
class WindowGpuCapturer final : public ScreenGpuCapturer {
 public:
  WindowGpuCapturer(
      syrnike::voice::ScreenCaptureTarget target,
      std::uint32_t width,
      std::uint32_t height,
      VideoResourceAdmissionBudget& resource_budget,
      std::string owner_id)
      : target_(std::move(target)),
        width_(width),
        height_(height),
        resource_budget_(&resource_budget),
        owner_id_(std::move(owner_id)) {
    active_.store(
        createWgcGpuCapturer(
            target_, width_, height_, *resource_budget_, owner_id_),
        std::memory_order_release);
  }

  ScreenGpuFrameResult capture(ScreenGpuFrame& frame) override {
    const auto now = std::chrono::steady_clock::now();
    const auto active = active_.load(std::memory_order_acquire);
    if (!active) {
      return {
          ScreenGpuFrameStatus::RecoverableLost,
          {},
          "wgc_gpu",
          ScreenGpuCaptureErrorCode::CaptureUnavailable,
      };
    }
    auto result = active->capture(frame);
    if (result.status == ScreenGpuFrameStatus::NewFrame) {
      if (awaiting_recovery_confirmation_) {
        ++successful_recoveries_;
        awaiting_recovery_confirmation_ = false;
        diagnostics::DiagnosticLog::instance().write(
            "screen_window_gpu_recovery_fresh_frame",
            {
                {"backend", "wgc_gpu"},
                {"attempt", recovery_attempts_},
                {"durationMs", static_cast<std::uint64_t>(
                     std::chrono::duration_cast<std::chrono::milliseconds>(
                         now - recovery_started_at_)
                         .count())},
            });
      }
      backoff_exponent_ = 0;
      next_retry_at_ = {};
      return result;
    }
    if (result.status == ScreenGpuFrameStatus::NoFrame ||
        result.status == ScreenGpuFrameStatus::EncoderBackpressure ||
        result.status == ScreenGpuFrameStatus::TargetClosed) {
      return result;
    }
    if (now >= next_retry_at_) {
      recover(result, now);
    }
    if (result.status != ScreenGpuFrameStatus::TargetClosed) {
      result.status = ScreenGpuFrameStatus::RecoverableLost;
      result.method = "wgc_gpu";
    }
    return result;
  }

  void discard(const ScreenGpuFrame& frame) noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    if (active) active->discard(frame);
    const auto retired = retirement_.snapshot();
    for (std::size_t index = 0; index < retired.size; ++index) {
      if (retired.capturers[index] != active) {
        retired.capturers[index]->discard(frame);
      }
    }
  }
  bool requestPreviewFrame() noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    return active && active->requestPreviewFrame();
  }
  void pollOptionalWork() noexcept override {
    if (const auto active = active_.load(std::memory_order_acquire)) {
      active->pollOptionalWork();
    }
    retirement_.poll();
  }
  bool optionalWorkPending() const noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    return (active && active->optionalWorkPending()) ||
        retirement_.pollPending();
  }
  void pollRetirement() noexcept override {
    if (const auto active = active_.load(std::memory_order_acquire)) {
      active->pollRetirement();
    }
    retirement_.poll();
  }

  void setPreviewDemand(ScreenPreviewDemand demand) override {
    std::lock_guard transition_lock(preview_transition_mutex_);
    {
      std::lock_guard lock(mutex_);
      preview_demand_ = demand;
    }
    if (const auto active = active_.load(std::memory_order_acquire)) {
      active->setPreviewDemand(demand);
    }
  }

  bool takePreviewFrame(ScreenPreviewFrame& frame) override {
    const auto active = active_.load(std::memory_order_acquire);
    return active && active->takePreviewFrame(frame);
  }

  bool takePreviewFailure(ScreenPreviewFailure& failure) override {
    const auto active = active_.load(std::memory_order_acquire);
    return active && active->takePreviewFailure(failure);
  }

  void releasePreviewFrame(std::uint64_t sequence) noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    if (active) active->releasePreviewFrame(sequence);
    const auto retired = retirement_.snapshot();
    for (std::size_t index = 0; index < retired.size; ++index) {
      if (retired.capturers[index] != active) {
        retired.capturers[index]->releasePreviewFrame(sequence);
      }
    }
  }

  std::size_t previewFramesInFlight() const noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    std::size_t total = active ? active->previewFramesInFlight() : 0;
    const auto retired = retirement_.snapshot();
    for (std::size_t index = 0; index < retired.size; ++index) {
      if (retired.capturers[index] != active) {
        total += retired.capturers[index]->previewFramesInFlight();
      }
    }
    return total;
  }

  const char* method() const noexcept override { return "wgc_gpu"; }

  LUID adapterLuid() const noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    return active ? active->adapterLuid() : LUID{};
  }

  std::size_t frameSlotsAvailable() const noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    return active ? active->frameSlotsAvailable() : 0;
  }

  std::size_t frameSlotsTotal() const noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    return active ? active->frameSlotsTotal() : 0;
  }

  bool retirementSafe() const noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    return active && active->retirementSafe() && retirement_.size() == 0;
  }

  ScreenFrameFlowStats frameFlowStats() const noexcept override {
    auto result = retirement_.completedStats();
    if (const auto active = active_.load(std::memory_order_acquire)) {
      const auto active_stats = active->frameFlowStats();
      addScreenFrameFlowCounters(result, active_stats);
      result.source_updates = active_stats.source_updates;
      result.idle_refreshes = active_stats.idle_refreshes;
      result.coalesced_source_updates =
          active_stats.coalesced_source_updates;
      result.gpu_completion_p50_us = active_stats.gpu_completion_p50_us;
      result.gpu_completion_p95_us = active_stats.gpu_completion_p95_us;
      result.gpu_retired_generations =
          active_stats.gpu_retired_generations + retirement_.size();
      result.gpu_slots_quarantined = active_stats.gpu_slots_quarantined;
    }
    return result;
  }

  std::uint64_t recoverableLossCount() const noexcept override {
    return successful_recoveries_.load(std::memory_order_relaxed);
  }

 private:
  void recover(
      ScreenGpuFrameResult& result,
      std::chrono::steady_clock::time_point now) noexcept {
    scheduleBackoff(now);
    try {
      ScreenPreviewDemand demand;
      const auto previous = active_.load(std::memory_order_acquire);
      {
        std::lock_guard lock(mutex_);
        demand = preview_demand_;
      }
      const std::vector<std::shared_ptr<ScreenGpuCapturer>> retiring{
          previous};
      // Candidate construction allocates a WGC frame pool, D3D device,
      // encoder pool, and preview device. Refuse it before any of those
      // allocations when the old generation cannot yet be retained.
      if (!retirement_.canRetire(retiring)) {
        result.gpu_capacity_exhausted = true;
        diagnostics::DiagnosticLog::instance().write(
            "screen_window_gpu_recovery_deferred",
            {
                {"reason", "retired_capacity"},
                {"backend", "wgc_gpu"},
                {"retiredBackends",
                 static_cast<std::uint64_t>(retirement_.size())},
                {"limit", static_cast<std::uint64_t>(
                     ScreenGpuRetirementLane::kCapacity)},
                {"retryMs", static_cast<std::uint64_t>(
                     std::chrono::duration_cast<std::chrono::milliseconds>(
                         next_retry_at_ - now)
                         .count())},
            });
        return;
      }
      auto candidate = createWgcGpuCapturer(
          target_, width_, height_, *resource_budget_, owner_id_);
      {
        // Demand changes and the recovery swap share this narrow transition
        // gate. Backend callbacks stay outside mutex_, while a concurrent UI
        // demand update cannot re-enable the generation being detached.
        std::lock_guard transition_lock(preview_transition_mutex_);
        {
          std::lock_guard lock(mutex_);
          demand = preview_demand_;
        }
        candidate->setPreviewDemand(demand);
        auto retirement_plan = retirement_.prepare(retiring, demand);
        {
          std::lock_guard lock(mutex_);
          if (!retirement_.commit(retirement_plan)) {
            throw ScreenGpuCaptureError(
                ScreenGpuCaptureErrorCode::ResourceSaturated,
                "screen window recovery retirement lane is full");
          }
          active_.store(candidate, std::memory_order_release);
        }
      }
      ++recovery_attempts_;
      awaiting_recovery_confirmation_ = true;
      recovery_started_at_ = now;
      result.recovery_transition = ScreenGpuRecoveryTransition{
          "wgc_gpu",
          "recreate_device",
          recovery_attempts_,
          result.metrics.hresult,
          result.error_code,
      };
    } catch (const ScreenGpuCaptureError& error) {
      const bool saturated =
          error.code() == ScreenGpuCaptureErrorCode::ResourceSaturated;
      result.gpu_capacity_exhausted = saturated;
      diagnostics::DiagnosticLog::instance().write(
          saturated
              ? "screen_window_gpu_recovery_deferred"
              : "screen_window_gpu_recovery_failed",
          {
              {"reason", captureErrorCodeName(error.code())},
              {"backend", "wgc_gpu"},
              {"message", std::string(error.what())},
              {"hresult", static_cast<std::int64_t>(error.hresult())},
              {"retryMs", static_cast<std::uint64_t>(
                   std::chrono::duration_cast<std::chrono::milliseconds>(
                       next_retry_at_ - now)
                       .count())},
          });
    } catch (const std::exception& error) {
      diagnostics::DiagnosticLog::instance().write(
          "screen_window_gpu_recovery_failed",
          {
              {"message", std::string(error.what())},
              {"hresult", static_cast<std::int64_t>(result.metrics.hresult)},
          });
    } catch (...) {
      diagnostics::DiagnosticLog::instance().write(
          "screen_window_gpu_recovery_failed",
          {
              {"message", "unknown WGC recovery failure"},
              {"hresult", static_cast<std::int64_t>(result.metrics.hresult)},
          });
    }
  }

  void scheduleBackoff(
      std::chrono::steady_clock::time_point now) noexcept {
    const auto delay = std::min(
        std::chrono::milliseconds(1'000),
        std::chrono::milliseconds(250) *
            (std::uint32_t{1} << std::min(backoff_exponent_, 2U)));
    next_retry_at_ = now + delay;
    backoff_exponent_ = std::min(backoff_exponent_ + 1, 3U);
  }

  syrnike::voice::ScreenCaptureTarget target_;
  std::uint32_t width_ = 0;
  std::uint32_t height_ = 0;
  VideoResourceAdmissionBudget* resource_budget_ = nullptr;
  std::string owner_id_;
  ScreenPreviewDemand preview_demand_;
  std::atomic<std::shared_ptr<ScreenGpuCapturer>> active_;
  mutable std::mutex mutex_;
  std::mutex preview_transition_mutex_;
  ScreenGpuRetirementLane retirement_;
  std::chrono::steady_clock::time_point next_retry_at_{};
  std::uint32_t backoff_exponent_ = 0;
  std::uint64_t recovery_attempts_ = 0;
  std::atomic<std::uint64_t> successful_recoveries_{0};
  bool awaiting_recovery_confirmation_ = false;
  std::chrono::steady_clock::time_point recovery_started_at_{};
};

class MonitorGpuCapturer final : public ScreenGpuCapturer {
 public:
  MonitorGpuCapturer(
      const syrnike::voice::ScreenCaptureTarget& target,
      std::uint32_t width,
      std::uint32_t height,
      std::shared_ptr<CaptureBackendSupervisor> supervisor,
      VideoResourceAdmissionBudget& resource_budget,
      std::string owner_id)
      : target_(target),
        width_(width),
        height_(height),
        resource_budget_(&resource_budget),
        owner_id_(std::move(owner_id)),
        supervisor_(supervisor
            ? std::move(supervisor)
            : std::make_shared<CaptureBackendSupervisor>()) {
    std::optional<ScreenGpuCaptureError> dxgi_failure;
    try {
      auto dxgi =
          std::make_shared<DxgiGpuCapturer>(
              target_, width_, height_, *resource_budget_, owner_id_);
      dxgi_.store(dxgi, std::memory_order_release);
      active_.store(dxgi, std::memory_order_release);
      supervisor_->backendActivated(
          CaptureBackend::Dxgi, CaptureBackendSupervisor::Clock::now());
      return;
    } catch (const ScreenGpuCaptureError& error) {
      if (error.code() == ScreenGpuCaptureErrorCode::TargetClosed) {
        throw;
      }
      if (error.code() == ScreenGpuCaptureErrorCode::ResourceSaturated) {
        // Admission denied before DXGI construction. Trying WGC on the same
        // physical adapter would consume the same exhausted process budget.
        throw;
      }
      dxgi_failure = error;
    } catch (const std::exception& error) {
      dxgi_failure.emplace(
          ScreenGpuCaptureErrorCode::CaptureUnavailable,
          error.what());
    } catch (...) {
      dxgi_failure.emplace(
          ScreenGpuCaptureErrorCode::CaptureUnavailable,
          "unknown DXGI initialization failure");
    }

    try {
      auto wgc = createWgcGpuCapturer(
          target_, width_, height_, *resource_budget_, owner_id_);
      wgc_.store(wgc, std::memory_order_release);
      active_.store(wgc, std::memory_order_release);
      supervisor_->backendActivated(
          CaptureBackend::Wgc, CaptureBackendSupervisor::Clock::now());
      logScreenCaptureBackend(
          "screen_capture_backend_initial_fallback", "dxgi_gpu", "wgc_gpu",
          dxgi_failure->what(), dxgi_failure->hresult());
    } catch (const ScreenGpuCaptureError& wgc_failure) {
      if (wgc_failure.code() ==
          ScreenGpuCaptureErrorCode::ResourceSaturated) {
        throw;
      }
      auto combined = combineInitialMonitorCaptureFailures(
          *dxgi_failure, wgc_failure);
      logInitialBackendFailure(combined);
      throw combined;
    } catch (const std::exception& error) {
      const ScreenGpuCaptureError wgc_failure(
          ScreenGpuCaptureErrorCode::CaptureUnavailable,
          error.what());
      auto combined = combineInitialMonitorCaptureFailures(
          *dxgi_failure, wgc_failure);
      logInitialBackendFailure(combined);
      throw combined;
    } catch (...) {
      const ScreenGpuCaptureError wgc_failure(
          ScreenGpuCaptureErrorCode::CaptureUnavailable,
          "unknown WGC initialization failure");
      auto combined = combineInitialMonitorCaptureFailures(
          *dxgi_failure, wgc_failure);
      logInitialBackendFailure(combined);
      throw combined;
    }
  }

  ScreenGpuFrameResult capture(ScreenGpuFrame& frame) override {
    const auto now = CaptureBackendSupervisor::Clock::now();
    const auto active = active_.load(std::memory_order_acquire);
    if (!active) {
      return {
          ScreenGpuFrameStatus::RecoverableLost,
          {},
          "monitor-supervisor",
          ScreenGpuCaptureErrorCode::CaptureUnavailable,
      };
    }
    auto result = active->capture(frame);
    const auto successful_recoveries_before =
        supervisor_->successfulRecoveryCount();
    const auto decision = supervisor_->observe(
        {
            result.status,
            result.error_code,
            secureDesktopActive(),
            desktopInputChanged(),
        },
        now);
    if (result.status == ScreenGpuFrameStatus::NewFrame &&
        supervisor_->successfulRecoveryCount() >
            successful_recoveries_before) {
      diagnostics::DiagnosticLog::instance().write(
          "screen_backend_recovery_fresh_frame",
          {
              {"backend", captureBackendName(supervisor_->activeBackend())},
              {"attempt", supervisor_->recoveryAttemptCount()},
              {"deferrals", supervisor_->recoveryDeferralCount()},
          });
    }
    if (decision.action == CaptureBackendAction::Fail) {
      return result;
    }
    if (decision.action != CaptureBackendAction::None) {
      const auto recovery =
          recover(decision, result.error_code, result.metrics.hresult, now);
      result.recovery_transition = recovery.transition;
      result.gpu_capacity_exhausted = recovery.capacity_exhausted;
      if (recovery.target_closed) {
        result.status = ScreenGpuFrameStatus::TargetClosed;
        result.error_code = ScreenGpuCaptureErrorCode::TargetClosed;
        return result;
      }
    }
    if (result.status == ScreenGpuFrameStatus::FatalError ||
        result.status == ScreenGpuFrameStatus::RecoverableLost) {
      result.status = ScreenGpuFrameStatus::RecoverableLost;
      if (const auto current = active_.load(std::memory_order_acquire)) {
        result.method = current->method();
      }
    }
    return result;
  }

  void discard(const ScreenGpuFrame& frame) noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    if (active) active->discard(frame);
    const auto retired = retirement_.snapshot();
    for (std::size_t index = 0; index < retired.size; ++index) {
      if (retired.capturers[index] != active) {
        retired.capturers[index]->discard(frame);
      }
    }
  }
  bool requestPreviewFrame() noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    return active && active->requestPreviewFrame();
  }
  void pollOptionalWork() noexcept override {
    if (const auto active = active_.load(std::memory_order_acquire)) {
      active->pollOptionalWork();
    }
    retirement_.poll();
  }
  bool optionalWorkPending() const noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    return (active && active->optionalWorkPending()) ||
        retirement_.pollPending();
  }
  void pollRetirement() noexcept override {
    if (const auto active = active_.load(std::memory_order_acquire)) {
      active->pollRetirement();
    }
    retirement_.poll();
  }

  void setPreviewDemand(ScreenPreviewDemand demand) override {
    std::lock_guard transition_lock(preview_transition_mutex_);
    {
      std::lock_guard lock(backend_mutex_);
      preview_demand_ = demand;
    }
    if (const auto active = active_.load(std::memory_order_acquire)) {
      active->setPreviewDemand(demand);
    }
  }

  bool takePreviewFrame(ScreenPreviewFrame& frame) override {
    const auto active = active_.load(std::memory_order_acquire);
    return active && active->takePreviewFrame(frame);
  }

  bool takePreviewFailure(ScreenPreviewFailure& failure) override {
    const auto active = active_.load(std::memory_order_acquire);
    return active && active->takePreviewFailure(failure);
  }

  void releasePreviewFrame(std::uint64_t sequence) noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    if (active) active->releasePreviewFrame(sequence);
    const auto retired = retirement_.snapshot();
    for (std::size_t index = 0; index < retired.size; ++index) {
      if (retired.capturers[index] != active) {
        retired.capturers[index]->releasePreviewFrame(sequence);
      }
    }
  }

  std::size_t previewFramesInFlight() const noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    std::size_t total = active ? active->previewFramesInFlight() : 0;
    const auto retired = retirement_.snapshot();
    for (std::size_t index = 0; index < retired.size; ++index) {
      if (retired.capturers[index] != active) {
        total += retired.capturers[index]->previewFramesInFlight();
      }
    }
    return total;
  }

  const char* method() const noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    return active ? active->method() : "monitor-supervisor";
  }
  LUID adapterLuid() const noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    return active ? active->adapterLuid() : LUID{};
  }
  std::size_t frameSlotsAvailable() const noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    return active ? active->frameSlotsAvailable() : 0;
  }
  std::size_t frameSlotsTotal() const noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    return active ? active->frameSlotsTotal() : 0;
  }
  bool retirementSafe() const noexcept override {
    const auto active = active_.load(std::memory_order_acquire);
    return active && active->retirementSafe() && retirement_.size() == 0;
  }
  ScreenFrameFlowStats frameFlowStats() const noexcept override {
    auto result = retirement_.completedStats();
    const auto active = active_.load(std::memory_order_acquire);
    const auto retired = retirement_.snapshot();
    for (std::size_t index = 0; index < retired.size; ++index) {
      if (retired.capturers[index] == active) continue;
      const auto stats = retired.capturers[index]->frameFlowStats();
      addScreenFrameFlowCounters(result, stats);
      result.gpu_slots_quarantined += stats.gpu_slots_quarantined;
    }
    if (active) {
      const auto stats = active->frameFlowStats();
      result.source_updates = stats.source_updates;
      result.idle_refreshes = stats.idle_refreshes;
      result.coalesced_source_updates = stats.coalesced_source_updates;
      result.gpu_retired_generations =
          stats.gpu_retired_generations + retirement_.size();
      result.gpu_completion_p50_us = stats.gpu_completion_p50_us;
      result.gpu_completion_p95_us = stats.gpu_completion_p95_us;
    }
    return result;
  }
  std::uint64_t recoverableLossCount() const noexcept override {
    return supervisor_->successfulRecoveryCount();
  }

 private:
  struct RecoveryResult {
    std::optional<ScreenGpuRecoveryTransition> transition;
    bool target_closed = false;
    bool capacity_exhausted = false;
  };

  RecoveryResult recover(
      const CaptureBackendDecision& decision,
      ScreenGpuCaptureErrorCode error_code,
      long hresult,
      CaptureBackendSupervisor::Clock::time_point now) noexcept {
    const auto recovery_started = CaptureBackendSupervisor::Clock::now();
    const char* phase = "resolve_target";
    auto recoveryDurationMs = [&] {
      return static_cast<std::uint64_t>(
          std::chrono::duration_cast<std::chrono::milliseconds>(
              CaptureBackendSupervisor::Clock::now() - recovery_started)
              .count());
    };
    auto& recovery_logger = diagnostics::DiagnosticLog::instance();
    if (recovery_logger.enabled()) {
      recovery_logger.write(
          "screen_backend_recovery_started",
          {
              {"target", captureBackendName(decision.target)},
              {"action", captureBackendActionName(decision.action)},
              {"hresult", static_cast<std::int64_t>(hresult)},
              {"count", supervisor_->recoveryAttemptCount()},
          });
    }
    try {
      const auto from = supervisor_->activeBackend();
      if (!syrnike::voice::resolveScreenMonitorHandle(target_)) {
        throw ScreenGpuCaptureError(
            ScreenGpuCaptureErrorCode::TargetClosed,
            "selected monitor is no longer available");
      }
      const auto target = decision.action ==
              CaptureBackendAction::ProbePreferredBackend
          ? CaptureBackend::Dxgi
          : decision.target;
      bool force_new =
          decision.action == CaptureBackendAction::RecreateDevice ||
          decision.action == CaptureBackendAction::RecreateActivePipeline ||
          decision.action == CaptureBackendAction::ReinitializeActive ||
          decision.action == CaptureBackendAction::SwitchBackend ||
          decision.action == CaptureBackendAction::ProbePreferredBackend;
      auto candidate = (target == CaptureBackend::Dxgi ? dxgi_ : wgc_)
          .load(std::memory_order_acquire);
      if (decision.action == CaptureBackendAction::ReinitializeActive &&
          target == CaptureBackend::Dxgi) {
        if (const auto existing =
                std::dynamic_pointer_cast<DxgiGpuCapturer>(candidate)) {
          phase = "reinitialize_dxgi_duplication";
          if (recovery_logger.enabled()) {
            recovery_logger.write(
                "screen_backend_recovery_stage",
                {
                    {"phase", phase},
                    {"status", "started"},
                    {"durationMs", recoveryDurationMs()},
                });
          }
          existing->reinitializeDuplication();
          if (recovery_logger.enabled()) {
            recovery_logger.write(
                "screen_backend_recovery_stage",
                {
                    {"phase", phase},
                    {"status", "completed"},
                    {"durationMs", recoveryDurationMs()},
                });
          }
          force_new = false;
        } else {
          candidate.reset();
        }
      }

      std::vector<std::shared_ptr<ScreenGpuCapturer>> retiring;
      if (force_new) {
        const auto append_retiring = [&retiring](
                                         std::shared_ptr<ScreenGpuCapturer>
                                             backend) {
          if (!backend ||
              std::find(retiring.begin(), retiring.end(), backend) !=
                  retiring.end()) {
            return;
          }
          retiring.push_back(std::move(backend));
        };
        {
          std::lock_guard lock(backend_mutex_);
          const auto active = active_.load(std::memory_order_relaxed);
          // Switching also retires the backend being left behind. Keeping it
          // in an inactive slot would let its preview demand create a frame
          // that the active-only delivery path can never route.
          append_retiring(active);
          if (decision.action == CaptureBackendAction::RecreateDevice) {
            append_retiring(dxgi_.load(std::memory_order_relaxed));
            append_retiring(wgc_.load(std::memory_order_relaxed));
          } else {
            append_retiring(candidate);
          }
        }
        if (!retirement_.canRetire(retiring)) {
          diagnostics::DiagnosticLog::instance().write(
              "screen_retired_backend_capacity_exhausted",
              {
                  {"retiredBackends",
                   static_cast<std::uint64_t>(retirement_.size())},
                  {"limit", static_cast<std::uint64_t>(
                       ScreenGpuRetirementLane::kCapacity)},
              });
          throw ScreenGpuCaptureError(
              ScreenGpuCaptureErrorCode::ResourceSaturated,
              "screen GPU recovery is waiting for retired frame leases");
        }
        if (target == CaptureBackend::Dxgi) {
          if (const auto existing =
                  std::dynamic_pointer_cast<DxgiGpuCapturer>(candidate)) {
            existing->suspendDuplication();
          }
        }
        candidate.reset();
      }
      ScreenPreviewDemand preview_demand;
      if (target == CaptureBackend::Dxgi) {
        if (!candidate) {
          candidate = std::make_shared<DxgiGpuCapturer>(
              target_, width_, height_, *resource_budget_, owner_id_);
        }
      } else if (!candidate) {
        candidate = createWgcGpuCapturer(
            target_, width_, height_, *resource_budget_, owner_id_);
      }

      {
        // Serialize only preview-demand transitions. Encoder release routing
        // uses retirement_.snapshot() and never waits for this gate.
        std::lock_guard transition_lock(preview_transition_mutex_);
        {
          std::lock_guard lock(backend_mutex_);
          preview_demand = preview_demand_;
        }
        candidate->setPreviewDemand(preview_demand);
        auto retirement_plan = retirement_.prepare(
            retiring, preview_demand);
        std::lock_guard lock(backend_mutex_);
        if (!retirement_.commit(retirement_plan)) {
          throw ScreenGpuCaptureError(
              ScreenGpuCaptureErrorCode::ResourceSaturated,
              "screen GPU recovery retirement lane is full");
        }
        for (const auto& backend : retiring) {
          if (dxgi_.load(std::memory_order_relaxed) == backend) {
            dxgi_.store({}, std::memory_order_release);
          }
          if (wgc_.load(std::memory_order_relaxed) == backend) {
            wgc_.store({}, std::memory_order_release);
          }
        }
        if (decision.action == CaptureBackendAction::RecreateDevice) {
          dxgi_.store(
              std::shared_ptr<ScreenGpuCapturer>{},
              std::memory_order_release);
          wgc_.store(
              std::shared_ptr<ScreenGpuCapturer>{},
              std::memory_order_release);
        }
        auto* slot = target == CaptureBackend::Dxgi ? &dxgi_ : &wgc_;
        slot->store(candidate, std::memory_order_release);
        active_.store(candidate, std::memory_order_release);
      }
      supervisor_->backendActivated(target, now, true);
      ScreenGpuRecoveryTransition transition{
          std::string(captureBackendName(target)),
          std::string(captureBackendActionName(decision.action)),
          supervisor_->recoveryAttemptCount(),
          hresult,
          error_code,
      };
      phase = "completed";
      auto& logger = diagnostics::DiagnosticLog::instance();
      if (logger.enabled()) {
        logger.write(
            "screen_backend_restart",
            {
                {"target", captureBackendName(target)},
                {"action", captureBackendActionName(decision.action)},
                {"hresult", static_cast<std::int64_t>(hresult)},
                {"count", transition.count},
                {"durationMs", recoveryDurationMs()},
            });
        logger.write(
            "screen_backend_recovery_finished",
            {
                {"phase", phase},
                {"status", "completed"},
                {"target", captureBackendName(target)},
                {"action", captureBackendActionName(decision.action)},
                {"durationMs", recoveryDurationMs()},
            });
      }
      logScreenCaptureBackend(
          "screen_capture_backend_transition",
          captureBackendName(from), captureBackendName(target),
          captureBackendActionName(decision.action),
          hresult);
      return {std::move(transition), false};
    } catch (const ScreenGpuCaptureError& error) {
      if (recovery_logger.enabled()) {
        recovery_logger.write(
            "screen_backend_recovery_finished",
            {
                {"phase", phase},
                {"status", "failed"},
                {"errorCode", static_cast<std::uint64_t>(error.code())},
                {"hresult", static_cast<std::int64_t>(error.hresult())},
                {"durationMs", recoveryDurationMs()},
            });
      }
      if (error.code() == ScreenGpuCaptureErrorCode::GpuTimeout ||
          error.code() == ScreenGpuCaptureErrorCode::ResourceSaturated) {
        // The replacement was intentionally deferred because an older frame
        // lease or process-budget reservation is still alive. This is
        // capacity backpressure, not an activation failure, so it must not arm
        // a DXGI/WGC fallback.
        supervisor_->recoveryDeferred(decision, error.code(), now);
        const auto retry_at = supervisor_->nextRetryAt();
        if (recovery_logger.enabled()) {
          recovery_logger.write(
              "screen_backend_recovery_deferred",
              {
                  {"phase", phase},
                  {"reason", captureErrorCodeName(error.code())},
                  {"backend",
                   captureBackendName(supervisor_->activeBackend())},
                  {"target", captureBackendName(decision.target)},
                  {"action", captureBackendActionName(decision.action)},
                  {"retryMs", static_cast<std::uint64_t>(
                       std::chrono::duration_cast<std::chrono::milliseconds>(
                           retry_at - now)
                           .count())},
                  {"deferrals", supervisor_->recoveryDeferralCount()},
              });
        }
        logScreenCaptureBackend(
            "screen_capture_backend_recovery_deferred",
            captureBackendName(supervisor_->activeBackend()),
            captureBackendName(decision.target),
            error.what(),
            error.hresult());
        return {std::nullopt, false, true};
      }
      supervisor_->activationFailed(decision, now);
      logScreenCaptureBackend(
          "screen_capture_backend_recovery_failed",
          captureBackendName(supervisor_->activeBackend()),
          captureBackendName(decision.target),
          error.what(),
          error.hresult());
      return {
          std::nullopt,
          error.code() == ScreenGpuCaptureErrorCode::TargetClosed,
      };
    } catch (const std::exception& error) {
      if (recovery_logger.enabled()) {
        recovery_logger.write(
            "screen_backend_recovery_finished",
            {
                {"phase", phase},
                {"status", "failed"},
                {"message", error.what()},
                {"durationMs", recoveryDurationMs()},
            });
      }
      supervisor_->activationFailed(decision, now);
      logScreenCaptureBackend(
          "screen_capture_backend_recovery_failed",
          captureBackendName(supervisor_->activeBackend()),
          captureBackendName(decision.target),
          error.what());
      return {};
    } catch (...) {
      if (recovery_logger.enabled()) {
        recovery_logger.write(
            "screen_backend_recovery_finished",
            {
                {"phase", phase},
                {"status", "failed"},
                {"message", "unknown capture backend recovery failure"},
                {"durationMs", recoveryDurationMs()},
            });
      }
      supervisor_->activationFailed(decision, now);
      logScreenCaptureBackend(
          "screen_capture_backend_recovery_failed",
          captureBackendName(supervisor_->activeBackend()),
          captureBackendName(decision.target),
          "unknown capture backend recovery failure");
      return {};
    }
  }

  syrnike::voice::ScreenCaptureTarget target_;
  std::uint32_t width_ = 0;
  std::uint32_t height_ = 0;
  VideoResourceAdmissionBudget* resource_budget_ = nullptr;
  std::string owner_id_;
  ScreenPreviewDemand preview_demand_;
  std::atomic<std::shared_ptr<ScreenGpuCapturer>> dxgi_;
  std::atomic<std::shared_ptr<ScreenGpuCapturer>> wgc_;
  std::atomic<std::shared_ptr<ScreenGpuCapturer>> active_;
  std::shared_ptr<CaptureBackendSupervisor> supervisor_;
  DWORD last_input_tick_ = 0;
  mutable std::mutex backend_mutex_;
  std::mutex preview_transition_mutex_;
  ScreenGpuRetirementLane retirement_;

  bool desktopInputChanged() noexcept {
    LASTINPUTINFO input{};
    input.cbSize = sizeof(input);
    if (!GetLastInputInfo(&input)) return false;
    const bool changed =
        last_input_tick_ != 0 && input.dwTime != last_input_tick_;
    last_input_tick_ = input.dwTime;
    return changed;
  }
};

}  // namespace

ScreenGpuCaptureError::ScreenGpuCaptureError(
    ScreenGpuCaptureErrorCode code,
    std::string message,
    long hresult,
    std::vector<ScreenGpuBackendFailure> backend_failures)
    : std::runtime_error(std::move(message)),
      code_(code),
      hresult_(hresult),
      backend_failures_(std::move(backend_failures)) {}

ScreenGpuCaptureError combineInitialMonitorCaptureFailures(
    const ScreenGpuCaptureError& dxgi_failure,
    const ScreenGpuCaptureError& wgc_failure) {
  const bool target_closed =
      wgc_failure.code() == ScreenGpuCaptureErrorCode::TargetClosed;
  const bool wgc_permission_denied =
      wgc_failure.code() == ScreenGpuCaptureErrorCode::PermissionDenied ||
      wgc_failure.hresult() == static_cast<long>(E_ACCESSDENIED);
  const bool dxgi_permanently_unavailable =
      dxgi_failure.code() == ScreenGpuCaptureErrorCode::InteropUnavailable;
  // WGC permission failure is terminal only when DXGI is also permanently
  // unusable. DXGI E_ACCESSDENIED can mean a temporary secure desktop, and
  // unsupported formats can recover after a display-mode change, so both
  // remain retryable even though WGC is unavailable on this machine.
  const bool permission_denied =
      wgc_permission_denied && dxgi_permanently_unavailable;
  const auto code = target_closed
      ? ScreenGpuCaptureErrorCode::TargetClosed
      : (permission_denied
          ? ScreenGpuCaptureErrorCode::PermissionDenied
          : (dxgi_failure.code() == ScreenGpuCaptureErrorCode::PermissionDenied
              ? ScreenGpuCaptureErrorCode::CaptureUnavailable
              : dxgi_failure.code()));
  const long hresult = target_closed || permission_denied
      ? wgc_failure.hresult()
      : (dxgi_failure.hresult() != 0
          ? dxgi_failure.hresult()
          : wgc_failure.hresult());
  std::vector<ScreenGpuBackendFailure> causes;
  causes.reserve(2);
  causes.push_back({
      "dxgi_gpu",
      dxgi_failure.code(),
      dxgi_failure.hresult(),
      dxgi_failure.what(),
  });
  causes.push_back({
      "wgc_gpu",
      wgc_failure.code(),
      wgc_failure.hresult(),
      wgc_failure.what(),
  });
  return ScreenGpuCaptureError(
      code,
      "DXGI initialization failed: " + std::string(dxgi_failure.what()) +
          " (HRESULT " + std::to_string(dxgi_failure.hresult()) +
          "); WGC initialization failed: " +
          std::string(wgc_failure.what()) + " (HRESULT " +
          std::to_string(wgc_failure.hresult()) + ")",
      hresult,
      std::move(causes));
}

std::shared_ptr<ScreenGpuCapturer> ScreenGpuCapturer::create(
    const syrnike::voice::ScreenCaptureTarget& target,
    std::uint32_t width,
    std::uint32_t height,
    std::shared_ptr<CaptureBackendSupervisor> supervisor,
    VideoResourceAdmissionBudget* resource_budget) {
  if (target.window && (!target.hwnd || !IsWindow(target.hwnd))) {
    throw ScreenGpuCaptureError(
        ScreenGpuCaptureErrorCode::TargetClosed,
        "selected window is no longer available");
  }
  auto& budget = resource_budget
      ? *resource_budget
      : processVideoResourceAdmissionBudget();
  auto owner_id = screenResourceOwnerId(target);
  if (target.window) {
    return std::make_shared<WindowGpuCapturer>(
        target, width, height, budget, std::move(owner_id));
  }
  return std::make_shared<MonitorGpuCapturer>(
      target, width, height, std::move(supervisor), budget,
      std::move(owner_id));
}

}  // namespace syrnike::desktop_native::media
