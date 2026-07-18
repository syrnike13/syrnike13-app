#include "screen_gpu_capture.hpp"

#include <d3d11.h>
#include <d3d11_1.h>
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
#include <limits>
#include <mutex>
#include <optional>
#include <string>
#include <utility>

#include "../common/diagnostic_log.hpp"
#include "d3d11_gpu_completion.hpp"
#include "screen_capture_priority.hpp"
#include "screen_dxgi_compositor.hpp"

using Microsoft::WRL::ComPtr;
namespace capture = winrt::Windows::Graphics::Capture;
namespace directx = winrt::Windows::Graphics::DirectX;
namespace d3dwinrt = winrt::Windows::Graphics::DirectX::Direct3D11;
namespace metadata = winrt::Windows::Foundation::Metadata;
namespace appcap = winrt::Windows::Security::Authorization::AppCapabilityAccess;

namespace syrnike::desktop_native::media {
namespace {

constexpr std::size_t kOutputPoolSize = 5;
constexpr UINT64 kProducerKey = 0;
constexpr UINT64 kConsumerKey = 1;
constexpr auto kGpuCompletionTimeout = std::chrono::milliseconds(500);

void logScreenCaptureBackend(
    std::string_view event,
    std::string_view reason,
    long hresult = 0) noexcept {
  auto& logger = diagnostics::DiagnosticLog::instance();
  if (!logger.enabled()) return;
  logger.write(
      event,
      {
          {"from", "dxgi_gpu"},
          {"to", "wgc_gpu"},
          {"reason", reason},
          {"hresult", static_cast<std::int64_t>(hresult)},
      });
}

std::uint64_t nextScreenFrameSequence() noexcept {
  static std::atomic<std::uint64_t> sequence{0};
  return sequence.fetch_add(1, std::memory_order_relaxed) + 1;
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

    const auto status = capture::GraphicsCaptureAccess::RequestAccessAsync(
        capture::GraphicsCaptureAccessKind::Borderless).get();
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

std::uint64_t qpcMicros(LARGE_INTEGER timestamp) {
  if (timestamp.QuadPart <= 0) return 0;
  static const LARGE_INTEGER frequency = [] {
    LARGE_INTEGER value{};
    QueryPerformanceFrequency(&value);
    return value;
  }();
  if (frequency.QuadPart <= 0) return 0;
  const auto seconds = timestamp.QuadPart / frequency.QuadPart;
  const auto remainder = timestamp.QuadPart % frequency.QuadPart;
  return static_cast<std::uint64_t>(seconds) * 1'000'000ULL +
      static_cast<std::uint64_t>(remainder) * 1'000'000ULL /
          static_cast<std::uint64_t>(frequency.QuadPart);
}

std::uint64_t wgcTimestampMicros(
    winrt::Windows::Foundation::TimeSpan timestamp) {
  const auto ticks = timestamp.count();
  return ticks > 0 ? static_cast<std::uint64_t>(ticks / 10) : 0;
}

bool sameLuid(const LUID& left, const LUID& right) {
  return left.HighPart == right.HighPart && left.LowPart == right.LowPart;
}

bool sameRect(const RECT& left, const RECT& right) {
  return left.left == right.left && left.top == right.top &&
      left.right == right.right && left.bottom == right.bottom;
}

ScreenGpuCaptureErrorCode captureErrorForHr(HRESULT hr) noexcept {
  if (hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET ||
      hr == DXGI_ERROR_DEVICE_HUNG) {
    return ScreenGpuCaptureErrorCode::DeviceLost;
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

struct AdapterSelection {
  ComPtr<IDXGIAdapter1> adapter;
  ComPtr<IDXGIOutput1> output;
  DXGI_ADAPTER_DESC1 adapter_description{};
  DXGI_OUTPUT_DESC output_description{};
  UINT output_index = 0;
};

AdapterSelection selectAdapter(const syrnike::voice::ScreenCaptureTarget& target) {
  ComPtr<IDXGIFactory1> factory;
  requireHr(
      CreateDXGIFactory1(IID_PPV_ARGS(&factory)),
      ScreenGpuCaptureErrorCode::DeviceUnavailable,
      "failed to create DXGI factory");

  const HMONITOR requested_monitor = target.window
      ? MonitorFromWindow(target.hwnd, MONITOR_DEFAULTTONEAREST)
      : MonitorFromRect(&target.rect, MONITOR_DEFAULTTONEAREST);
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
      const bool selected = requested_monitor
          ? output_description.Monitor == requested_monitor
          : sameRect(output_description.DesktopCoordinates, target.rect);
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
  throw ScreenGpuCaptureError(
      ScreenGpuCaptureErrorCode::DeviceUnavailable,
      "no hardware DXGI adapter owns the selected capture target");
}

struct D3dDevice {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  LUID adapter_luid{};
};

D3dDevice createDevice(const AdapterSelection& selection) {
  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
  D3D_FEATURE_LEVEL feature_level{};
  D3dDevice result;
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
  syrnike::voice::setD3dGpuThreadPriority(dxgi_device.Get(), 3);
  DXGI_ADAPTER_DESC adapter_description{};
  requireHr(
      selection.adapter->GetDesc(&adapter_description),
      ScreenGpuCaptureErrorCode::DeviceUnavailable,
      "failed to read capture adapter LUID");
  result.adapter_luid = adapter_description.AdapterLuid;
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
      std::uint32_t output_height)
      : device_(device),
        context_(context),
        completion_(device, context),
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
    requireHr(
        completion_.initializationResult(),
        ScreenGpuCaptureErrorCode::InteropUnavailable,
        "failed to create GPU conversion completion query");
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
    if (!source || source_width == 0 || source_height == 0) {
      return result(ScreenGpuFrameStatus::FatalError, method, metrics,
                    ScreenGpuCaptureErrorCode::InteropUnavailable);
    }
    configure(source_width, source_height);

    for (std::size_t attempt = 0; attempt < slots_.size(); ++attempt) {
      const std::size_t index = (next_slot_ + attempt) % slots_.size();
      auto& slot = slots_[index];
      const HRESULT acquire = slot.mutex->AcquireSync(kProducerKey, 0);
      if (acquire == WAIT_TIMEOUT) continue;
      if (FAILED(acquire)) {
        metrics.hresult = static_cast<long>(acquire);
        return result(ScreenGpuFrameStatus::FatalError, method, metrics,
                      ScreenGpuCaptureErrorCode::DeviceLost);
      }

      bool released = false;
      try {
        const auto conversion_started_at = std::chrono::steady_clock::now();
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
        requireHr(
            completion_.wait(kGpuCompletionTimeout),
            ScreenGpuCaptureErrorCode::DeviceLost,
            "GPU screen conversion did not complete");
        requireHr(
            slot.mutex->ReleaseSync(kConsumerKey),
            ScreenGpuCaptureErrorCode::DeviceLost,
            "failed to release GPU frame to encoder");
        metrics.scale_us = static_cast<int>(
            std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - conversion_started_at)
                .count());
        released = true;
      } catch (...) {
        if (!released) slot.mutex->ReleaseSync(kProducerKey);
        throw;
      }

      next_slot_ = (index + 1) % slots_.size();
      frame.sequence = nextScreenFrameSequence();
      frame.timestamp_us = timestamp_us != 0 ? timestamp_us : steadyMicros();
      frame.width = output_width_;
      frame.height = output_height_;
      frame.slot = static_cast<std::uint32_t>(index);
      frame.shared_texture_handle = slot.shared_handle;
      frame.adapter_luid = adapter_luid_;
      frame.format = DXGI_FORMAT_NV12;
      metrics.output_width = output_width_;
      metrics.output_height = output_height_;
      return result(ScreenGpuFrameStatus::NewFrame, method, metrics,
                    ScreenGpuCaptureErrorCode::CaptureUnavailable);
    }

    // WGC/DXGI supplied a source texture, but every NV12 output slot is still
    // owned by the encoder. Keep this distinct from a capture-source miss so
    // the actor can restart the stalled MFT instead of recreating WGC.
    return result(ScreenGpuFrameStatus::EncoderBackpressure, method, metrics,
                  ScreenGpuCaptureErrorCode::CaptureUnavailable);
  }

  void discard(const ScreenGpuFrame& frame) noexcept {
    if (!sameLuid(frame.adapter_luid, adapter_luid_) ||
        frame.slot >= slots_.size() || frame.sequence == 0) {
      return;
    }
    auto& slot = slots_[frame.slot];
    if (slot.shared_handle != frame.shared_texture_handle) return;
    if (slot.mutex->AcquireSync(kConsumerKey, 0) == S_OK) {
      slot.mutex->ReleaseSync(kProducerKey);
    }
  }

 private:
  struct Slot {
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<IDXGIKeyedMutex> mutex;
    ComPtr<ID3D11VideoProcessorOutputView> output_view;
    HANDLE shared_handle = nullptr;
  };

  static ScreenGpuFrameResult result(
      ScreenGpuFrameStatus status,
      const char* method,
      syrnike::voice::ScreenCaptureFrameMetrics metrics,
      ScreenGpuCaptureErrorCode error_code) {
    return {status, metrics, method, error_code};
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

  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<ID3D11VideoDevice> video_device_;
  ComPtr<ID3D11VideoContext> video_context_;
  D3d11GpuCompletion completion_;
  ComPtr<ID3D11VideoProcessorEnumerator> enumerator_;
  ComPtr<ID3D11VideoProcessor> processor_;
  LUID adapter_luid_{};
  std::uint32_t output_width_ = 0;
  std::uint32_t output_height_ = 0;
  std::uint32_t source_width_ = 0;
  std::uint32_t source_height_ = 0;
  std::array<Slot, kOutputPoolSize> slots_;
  std::size_t next_slot_ = 0;
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
      std::uint32_t max_height)
      : device_(device),
        context_(context),
        completion_(device, context),
        max_width_(max_width),
        max_height_(max_height) {
    requireHr(
        device_->QueryInterface(IID_PPV_ARGS(&video_device_)),
        ScreenGpuCaptureErrorCode::FormatUnsupported,
        "D3D11 preview video device is unavailable");
    requireHr(
        context_->QueryInterface(IID_PPV_ARGS(&video_context_)),
        ScreenGpuCaptureErrorCode::FormatUnsupported,
        "D3D11 preview video context is unavailable");
    requireHr(
        completion_.initializationResult(),
        ScreenGpuCaptureErrorCode::InteropUnavailable,
        "failed to create preview completion query");
  }

  ~GpuPreviewPool() {
    std::lock_guard lock(mutex_);
    for (auto& slot : slots_) {
      closeRemoteHandle(slot);
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
    if (!demand.demanded && pending_) {
      for (auto& slot : slots_) {
        if (!slot.occupied || slot.sequence != pending_->sequence) continue;
        closeRemoteHandle(slot);
        slot.occupied = false;
        break;
      }
      pending_.reset();
    }
  }

  void process(
      ID3D11Texture2D* source,
      std::uint32_t source_width,
      std::uint32_t source_height,
      std::uint32_t content_width,
      std::uint32_t content_height,
      std::uint64_t timestamp_us) {
    ScreenPreviewDemand demand;
    std::uint64_t demand_revision = 0;
    std::uint64_t reserved_sequence = 0;
    std::size_t slot_index = slots_.size();
    const auto now = std::chrono::steady_clock::now();
    {
      std::lock_guard lock(mutex_);
      demand = demand_;
      demand_revision = demand_revision_;
      if (!demand.demanded || demand.electron_main_pid == 0 || pending_) return;
      if (now < next_retry_at_) return;
      const auto interval = std::chrono::microseconds(1'000'000 / demand.fps);
      if (last_frame_at_ != std::chrono::steady_clock::time_point{} &&
          now - last_frame_at_ < interval) return;
      for (std::size_t attempt = 0; attempt < slots_.size(); ++attempt) {
        const auto candidate = (next_slot_ + attempt) % slots_.size();
        if (!slots_[candidate].occupied) {
          slots_[candidate].occupied = true;
          reserved_sequence = nextScreenFrameSequence();
          slots_[candidate].sequence = reserved_sequence;
          slot_index = candidate;
          break;
        }
      }
    }
    if (slot_index == slots_.size()) return;

    auto& slot = slots_[slot_index];
    try {
      configureSlot(slot, source_width, source_height, demand.width, demand.height);
      D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC input_description{};
      input_description.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
      ComPtr<ID3D11VideoProcessorInputView> input_view;
      requireHr(
          video_device_->CreateVideoProcessorInputView(
              source, slot.enumerator.Get(), &input_description, &input_view),
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "failed to create preview input view");
      const RECT source_rect{
          0, 0,
          static_cast<LONG>(std::min(source_width, content_width)),
          static_cast<LONG>(std::min(source_height, content_height)),
      };
      const RECT output_rect{0, 0, static_cast<LONG>(demand.width), static_cast<LONG>(demand.height)};
      const auto destination_rect = fitRect(
          static_cast<std::uint32_t>(source_rect.right),
          static_cast<std::uint32_t>(source_rect.bottom),
          demand.width, demand.height);
      video_context_->VideoProcessorSetStreamFrameFormat(
          slot.processor.Get(), 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
      D3D11_VIDEO_PROCESSOR_COLOR_SPACE input_color{};
      input_color.RGB_Range = 0;
      input_color.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255;
      video_context_->VideoProcessorSetStreamColorSpace(
          slot.processor.Get(), 0, &input_color);
      D3D11_VIDEO_PROCESSOR_COLOR_SPACE output_color{};
      output_color.RGB_Range = 0;
      output_color.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255;
      video_context_->VideoProcessorSetOutputColorSpace(
          slot.processor.Get(), &output_color);
      video_context_->VideoProcessorSetStreamSourceRect(
          slot.processor.Get(), 0, TRUE, &source_rect);
      video_context_->VideoProcessorSetStreamDestRect(
          slot.processor.Get(), 0, TRUE, &destination_rect);
      video_context_->VideoProcessorSetOutputTargetRect(
          slot.processor.Get(), TRUE, &output_rect);
      D3D11_VIDEO_COLOR background{};
      background.RGBA.A = 1.0F;
      video_context_->VideoProcessorSetOutputBackgroundColor(
          slot.processor.Get(), FALSE, &background);
      D3D11_VIDEO_PROCESSOR_STREAM stream{};
      stream.Enable = TRUE;
      stream.pInputSurface = input_view.Get();
      requireHr(
          video_context_->VideoProcessorBlt(
              slot.processor.Get(), slot.output_view.Get(), 0, 1, &stream),
          ScreenGpuCaptureErrorCode::DeviceLost,
          "GPU preview copy failed");
      requireHr(
          completion_.wait(kGpuCompletionTimeout),
          ScreenGpuCaptureErrorCode::DeviceLost,
          "GPU preview copy did not complete");

      HANDLE main_process = OpenProcess(PROCESS_DUP_HANDLE, FALSE, demand.electron_main_pid);
      if (!main_process) throw ScreenGpuCaptureError(
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "Electron main process is unavailable for preview");
      HANDLE duplicated = nullptr;
      const BOOL duplicated_ok = DuplicateHandle(
          GetCurrentProcess(), slot.shared_handle, main_process, &duplicated,
          0, FALSE, DUPLICATE_SAME_ACCESS);
      CloseHandle(main_process);
      if (!duplicated_ok) throw ScreenGpuCaptureError(
          ScreenGpuCaptureErrorCode::InteropUnavailable,
          "failed to duplicate preview texture handle");

      std::lock_guard lock(mutex_);
      slot.remote_handle = duplicated;
      slot.remote_pid = demand.electron_main_pid;
      if (demand_revision != demand_revision_ || !demand_.demanded) {
        closeRemoteHandle(slot);
        slot.occupied = false;
        return;
      }
      last_frame_at_ = now;
      next_slot_ = (slot_index + 1) % slots_.size();
      pending_ = ScreenPreviewFrame{
          reserved_sequence,
          timestamp_us != 0 ? timestamp_us : steadyMicros(),
          demand.width,
          demand.height,
          reinterpret_cast<std::uint64_t>(duplicated),
      };
    } catch (const ScreenGpuCaptureError& error) {
      std::lock_guard lock(mutex_);
      closeRemoteHandle(slot);
      slot.texture.Reset();
      slot.occupied = false;
      recordFailureLocked(error.code(), error.hresult(), error.what(), now);
    } catch (const std::exception& error) {
      std::lock_guard lock(mutex_);
      closeRemoteHandle(slot);
      slot.texture.Reset();
      slot.occupied = false;
      recordFailureLocked(
          ScreenGpuCaptureErrorCode::InteropUnavailable, 0, error.what(), now);
    } catch (...) {
      std::lock_guard lock(mutex_);
      closeRemoteHandle(slot);
      slot.texture.Reset();
      slot.occupied = false;
      recordFailureLocked(
          ScreenGpuCaptureErrorCode::InteropUnavailable, 0,
          "unknown local screen preview failure", now);
    }
  }

  bool take(ScreenPreviewFrame& frame) {
    std::lock_guard lock(mutex_);
    if (!pending_) return false;
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
    for (auto& slot : slots_) {
      if (!slot.occupied || slot.sequence != sequence) continue;
      closeRemoteHandle(slot);
      slot.occupied = false;
      return;
    }
  }

  std::size_t inFlight() const noexcept {
    std::lock_guard lock(mutex_);
    return static_cast<std::size_t>(std::count_if(
        slots_.begin(), slots_.end(), [](const auto& slot) { return slot.occupied; }));
  }

 private:
  struct Slot {
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<ID3D11VideoProcessorEnumerator> enumerator;
    ComPtr<ID3D11VideoProcessor> processor;
    ComPtr<ID3D11VideoProcessorOutputView> output_view;
    HANDLE shared_handle = nullptr;
    HANDLE remote_handle = nullptr;
    std::uint32_t remote_pid = 0;
    std::uint32_t source_width = 0;
    std::uint32_t source_height = 0;
    std::uint32_t output_width = 0;
    std::uint32_t output_height = 0;
    std::uint64_t sequence = 0;
    bool occupied = false;
  };

  void configureSlot(
      Slot& slot,
      std::uint32_t source_width,
      std::uint32_t source_height,
      std::uint32_t output_width,
      std::uint32_t output_height) {
    if (slot.texture && slot.source_width == source_width &&
        slot.source_height == source_height && slot.output_width == output_width &&
        slot.output_height == output_height) return;
    if (slot.shared_handle) CloseHandle(slot.shared_handle);
    slot.texture.Reset();
    slot.enumerator.Reset();
    slot.processor.Reset();
    slot.output_view.Reset();
    slot.shared_handle = nullptr;
    slot.source_width = 0;
    slot.source_height = 0;
    slot.output_width = 0;
    slot.output_height = 0;

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
    // without IDXGIKeyedMutex. The video processor writes directly into this
    // texture, and the slot remains immutable while Electron owns the frame.
    description.MiscFlags =
        D3D11_RESOURCE_MISC_SHARED_NTHANDLE |
        D3D11_RESOURCE_MISC_SHARED;
    requireHr(
        device_->CreateTexture2D(&description, nullptr, &slot.texture),
        ScreenGpuCaptureErrorCode::InteropUnavailable,
        "failed to create shared BGRA preview texture");
    ComPtr<IDXGIResource1> resource;
    requireHr(
        slot.texture.As(&resource),
        ScreenGpuCaptureErrorCode::InteropUnavailable,
        "preview texture does not expose IDXGIResource1");
    requireHr(
        resource->CreateSharedHandle(
            nullptr, DXGI_SHARED_RESOURCE_READ, nullptr, &slot.shared_handle),
        ScreenGpuCaptureErrorCode::InteropUnavailable,
        "failed to export preview texture handle");

    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
    content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    content.InputWidth = source_width;
    content.InputHeight = source_height;
    content.OutputWidth = output_width;
    content.OutputHeight = output_height;
    content.Usage = D3D11_VIDEO_USAGE_OPTIMAL_SPEED;
    requireHr(
        video_device_->CreateVideoProcessorEnumerator(&content, &slot.enumerator),
        ScreenGpuCaptureErrorCode::FormatUnsupported,
        "failed to create preview video processor enumerator");
    requireHr(
        video_device_->CreateVideoProcessor(slot.enumerator.Get(), 0, &slot.processor),
        ScreenGpuCaptureErrorCode::FormatUnsupported,
        "failed to create preview video processor");
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC output_description{};
    output_description.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    requireHr(
        video_device_->CreateVideoProcessorOutputView(
            slot.texture.Get(), slot.enumerator.Get(), &output_description,
            &slot.output_view),
        ScreenGpuCaptureErrorCode::FormatUnsupported,
        "failed to create preview output view");
    slot.source_width = source_width;
    slot.source_height = source_height;
    slot.output_width = output_width;
    slot.output_height = output_height;
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

  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<ID3D11VideoDevice> video_device_;
  ComPtr<ID3D11VideoContext> video_context_;
  D3d11GpuCompletion completion_;
  const std::uint32_t max_width_;
  const std::uint32_t max_height_;
  mutable std::mutex mutex_;
  ScreenPreviewDemand demand_;
  std::array<Slot, 3> slots_;
  std::optional<ScreenPreviewFrame> pending_;
  std::optional<ScreenPreviewFailure> pending_failure_;
  std::size_t next_slot_ = 0;
  std::uint64_t demand_revision_ = 0;
  std::chrono::steady_clock::time_point last_frame_at_{};
  std::chrono::steady_clock::time_point next_retry_at_{};
  std::chrono::steady_clock::time_point last_failure_report_at_{};
  std::uint64_t suppressed_failures_ = 0;
};

class DxgiGpuCapturer final : public ScreenGpuCapturer {
 public:
  DxgiGpuCapturer(
      const syrnike::voice::ScreenCaptureTarget& target,
      std::uint32_t width,
      std::uint32_t height)
      : target_(target), selection_(selectAdapter(target_)), d3d_(createDevice(selection_)),
        compositor_(d3d_.device.Get(), d3d_.context.Get()),
        pool_(d3d_.device.Get(), d3d_.context.Get(), d3d_.adapter_luid, width, height),
        preview_(d3d_.device.Get(), d3d_.context.Get(), width, height) {
    recreateDuplication();
  }

  ScreenGpuFrameResult capture(ScreenGpuFrame& frame) override {
    const auto started_at = std::chrono::steady_clock::now();
    DXGI_OUTDUPL_FRAME_INFO frame_info{};
    ComPtr<IDXGIResource> resource;
    HRESULT hr = duplication_->AcquireNextFrame(1, &frame_info, &resource);
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) return {ScreenGpuFrameStatus::NoFrame, {}, method()};
    if (hr == DXGI_ERROR_ACCESS_LOST) {
      syrnike::voice::ScreenCaptureFrameMetrics metrics;
      metrics.hresult = static_cast<long>(hr);
      try {
        recreateDuplication();
        return {ScreenGpuFrameStatus::RecoverableLost, metrics, method()};
      } catch (const ScreenGpuCaptureError& error) {
        metrics.hresult = error.hresult();
        return {ScreenGpuFrameStatus::FatalError, metrics, method(), error.code()};
      }
    }
    if (FAILED(hr)) {
      syrnike::voice::ScreenCaptureFrameMetrics metrics;
      metrics.hresult = static_cast<long>(hr);
      return {ScreenGpuFrameStatus::FatalError, metrics, method(),
              hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET
                  ? ScreenGpuCaptureErrorCode::DeviceLost
                  : ScreenGpuCaptureErrorCode::CaptureUnavailable};
    }

    ComPtr<ID3D11Texture2D> texture;
    hr = resource.As(&texture);
    if (FAILED(hr)) {
      duplication_->ReleaseFrame();
      syrnike::voice::ScreenCaptureFrameMetrics metrics;
      metrics.hresult = static_cast<long>(hr);
      return {ScreenGpuFrameStatus::FatalError, metrics, method(),
              ScreenGpuCaptureErrorCode::InteropUnavailable};
    }
    syrnike::voice::ScreenCaptureFrameMetrics metrics;
    metrics.source_width = native_width_;
    metrics.source_height = native_height_;
    metrics.content_width = native_width_;
    metrics.content_height = native_height_;
    metrics.capture_us = static_cast<int>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - started_at)
            .count());
    const auto timestamp_us = qpcMicros(frame_info.LastPresentTime);
    ScreenGpuFrameResult result;
    try {
      auto* composed = compositor_.compose(
          texture.Get(), duplication_.Get(), frame_info,
          selection_.output_description.Rotation);
      result = pool_.process(
          composed, native_width_, native_height_, native_width_, native_height_,
          timestamp_us, method(), metrics, frame);
      preview_.process(
          composed, native_width_, native_height_, native_width_, native_height_,
          timestamp_us);
    } catch (const ScreenGpuCaptureError& error) {
      metrics.hresult = error.hresult();
      result = {ScreenGpuFrameStatus::FatalError, metrics, method(), error.code()};
    }
    duplication_->ReleaseFrame();
    return result;
  }

  void discard(const ScreenGpuFrame& frame) noexcept override { pool_.discard(frame); }
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

 private:
  void recreateDuplication() {
    duplication_.Reset();
    requireHr(
        selection_.output->GetDesc(&selection_.output_description),
        ScreenGpuCaptureErrorCode::CaptureUnavailable,
        "failed to refresh selected DXGI output");
    requireHr(
        selection_.output->DuplicateOutput(d3d_.device.Get(), &duplication_),
        ScreenGpuCaptureErrorCode::CaptureUnavailable,
        "failed to create DXGI output duplication");
    native_width_ = static_cast<std::uint32_t>(
        selection_.output_description.DesktopCoordinates.right -
        selection_.output_description.DesktopCoordinates.left);
    native_height_ = static_cast<std::uint32_t>(
        selection_.output_description.DesktopCoordinates.bottom -
        selection_.output_description.DesktopCoordinates.top);
  }

  syrnike::voice::ScreenCaptureTarget target_;
  AdapterSelection selection_;
  D3dDevice d3d_;
  DxgiFrameCompositor compositor_;
  GpuFramePool pool_;
  GpuPreviewPool preview_;
  ComPtr<IDXGIOutputDuplication> duplication_;
  std::uint32_t native_width_ = 0;
  std::uint32_t native_height_ = 0;
};

class WgcGpuCapturer final : public ScreenGpuCapturer {
 public:
  WgcGpuCapturer(
      const syrnike::voice::ScreenCaptureTarget& target,
      std::uint32_t width,
      std::uint32_t height)
      : target_(target), selection_(selectAdapter(target_)), d3d_(createDevice(selection_)),
        pool_(d3d_.device.Get(), d3d_.context.Get(), d3d_.adapter_luid, width, height),
        preview_(d3d_.device.Get(), d3d_.context.Get(), width, height) {
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
    std::uint64_t timestamp_us = 0;
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
        timestamp_us = wgcTimestampMicros(capture_frame.SystemRelativeTime());
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
    if (!capture_frame) return handleNoFrame();
    if (content_size.Width <= 0 || content_size.Height <= 0) {
      return handleNoFrame();
    }
    last_frame_at_ = std::chrono::steady_clock::now();
    if (content_size.Width != pool_size_.Width || content_size.Height != pool_size_.Height) {
      try {
        capture_frame.Close();
        recreateFramePool(content_size);
        return {ScreenGpuFrameStatus::RecoverableLost, {}, method()};
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
      auto result = pool_.process(
          texture.Get(),
          static_cast<std::uint32_t>(pool_size_.Width),
          static_cast<std::uint32_t>(pool_size_.Height),
          static_cast<std::uint32_t>(content_size.Width),
          static_cast<std::uint32_t>(content_size.Height),
          timestamp_us, method(), metrics, frame);
      preview_.process(
          texture.Get(),
          static_cast<std::uint32_t>(pool_size_.Width),
          static_cast<std::uint32_t>(pool_size_.Height),
          static_cast<std::uint32_t>(content_size.Width),
          static_cast<std::uint32_t>(content_size.Height),
          timestamp_us);
      return result;
    } catch (const ScreenGpuCaptureError& error) {
      metrics.hresult = error.hresult();
      return {ScreenGpuFrameStatus::FatalError, metrics, method(), error.code()};
    }
  }

  void discard(const ScreenGpuFrame& frame) noexcept override { pool_.discard(frame); }
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

 private:
  ScreenGpuFrameResult handleNoFrame() {
    // Recover WGC only when the capture source itself stops delivering frames.
    // Encoder-owned output slots are reported separately as
    // EncoderBackpressure and require recreating the publication/encoder.
    constexpr auto stall_timeout = std::chrono::seconds(2);
    const auto now = std::chrono::steady_clock::now();
    if (now - last_frame_at_ < stall_timeout ||
        now - last_restart_at_ < stall_timeout) {
      return {ScreenGpuFrameStatus::NoFrame, {}, method()};
    }
    last_restart_at_ = now;
    try {
      closeCaptureSession();
      target_closed_.store(false, std::memory_order_release);
      initialize();
      last_frame_at_ = now;
      return {ScreenGpuFrameStatus::RecoverableLost, {}, method()};
    } catch (const ScreenGpuCaptureError& error) {
      syrnike::voice::ScreenCaptureFrameMetrics metrics;
      metrics.hresult = error.hresult();
      return {
          error.code() == ScreenGpuCaptureErrorCode::TargetClosed
              ? ScreenGpuFrameStatus::TargetClosed
              : ScreenGpuFrameStatus::FatalError,
          metrics,
          method(),
          error.code(),
      };
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
    item_ = nullptr;
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
      const HMONITOR monitor = MonitorFromRect(
          &target_.rect, MONITOR_DEFAULTTONULL);
      if (!monitor) {
        throw ScreenGpuCaptureError(
            ScreenGpuCaptureErrorCode::TargetClosed,
            "selected monitor is no longer available");
      }
      hr = interop->CreateForMonitor(
          monitor,
          __uuidof(ABI::Windows::Graphics::Capture::IGraphicsCaptureItem),
          reinterpret_cast<void**>(raw_item.put()));
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
    frame_pool_ = capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
        winrt_device_,
        directx::DirectXPixelFormat::B8G8R8A8UIntNormalized,
        3,
        pool_size_);
    session_ = frame_pool_.CreateCaptureSession(item_);
    session_.IsCursorCaptureEnabled(true);
    disableCaptureBorderIfAllowed(session_);
    session_.StartCapture();
    const auto now = std::chrono::steady_clock::now();
    last_frame_at_ = now;
    last_restart_at_ = now;
  }

  void recreateFramePool(winrt::Windows::Graphics::SizeInt32 size) {
    if (size.Width <= 0 || size.Height <= 0) return;
    pool_size_ = size;
    frame_pool_.Recreate(
        winrt_device_,
        directx::DirectXPixelFormat::B8G8R8A8UIntNormalized,
        3,
        pool_size_);
  }

  syrnike::voice::ScreenCaptureTarget target_;
  AdapterSelection selection_;
  D3dDevice d3d_;
  GpuFramePool pool_;
  GpuPreviewPool preview_;
  d3dwinrt::IDirect3DDevice winrt_device_{nullptr};
  capture::GraphicsCaptureItem item_{nullptr};
  capture::Direct3D11CaptureFramePool frame_pool_{nullptr};
  capture::GraphicsCaptureSession session_{nullptr};
  winrt::Windows::Graphics::SizeInt32 pool_size_{};
  winrt::event_token closed_token_{};
  bool closed_subscribed_ = false;
  std::atomic_bool target_closed_{false};
  std::chrono::steady_clock::time_point last_frame_at_{};
  std::chrono::steady_clock::time_point last_restart_at_{};
};

std::shared_ptr<ScreenGpuCapturer> createWgcGpuCapturer(
    const syrnike::voice::ScreenCaptureTarget& target,
    std::uint32_t width,
    std::uint32_t height) {
  try {
    return std::make_shared<WgcGpuCapturer>(target, width, height);
  } catch (const ScreenGpuCaptureError&) {
    throw;
  } catch (const winrt::hresult_error& error) {
    throw ScreenGpuCaptureError(
        ScreenGpuCaptureErrorCode::CaptureUnavailable,
        "Windows Graphics Capture initialization failed",
        static_cast<long>(error.code()));
  }
}

class MonitorGpuCapturer final : public ScreenGpuCapturer {
 public:
  MonitorGpuCapturer(
      const syrnike::voice::ScreenCaptureTarget& target,
      std::uint32_t width,
      std::uint32_t height)
      : target_(target), width_(width), height_(height) {
    try {
      dxgi_ = std::make_shared<DxgiGpuCapturer>(target_, width_, height_);
      active_ = dxgi_;
    } catch (const ScreenGpuCaptureError& error) {
      wgc_ = createWgcGpuCapturer(target_, width_, height_);
      active_ = wgc_;
      logScreenCaptureBackend(
          "screen_capture_backend_initial_fallback", error.what(), error.hresult());
    } catch (const std::exception& error) {
      wgc_ = createWgcGpuCapturer(target_, width_, height_);
      active_ = wgc_;
      logScreenCaptureBackend(
          "screen_capture_backend_initial_fallback", error.what());
    }
  }

  ScreenGpuFrameResult capture(ScreenGpuFrame& frame) override {
    auto result = active_->capture(frame);
    if (active_ != dxgi_) return result;

    const bool should_fallback = fallback_policy_.shouldFallback(result.status);
    if (result.status == ScreenGpuFrameStatus::RecoverableLost) {
      if (!should_fallback ||
          !switchToWgc("repeated_recovery", result.metrics.hresult)) {
        return result;
      }
      result.method = active_->method();
      return result;
    }
    if (should_fallback &&
        switchToWgc("fatal_error", result.metrics.hresult)) {
      result.status = ScreenGpuFrameStatus::RecoverableLost;
      result.method = active_->method();
      return result;
    }
    return result;
  }

  void discard(const ScreenGpuFrame& frame) noexcept override {
    if (dxgi_) dxgi_->discard(frame);
    if (wgc_) wgc_->discard(frame);
  }

  void setPreviewDemand(ScreenPreviewDemand demand) override {
    preview_demand_ = demand;
    if (dxgi_) dxgi_->setPreviewDemand(demand);
    if (wgc_) wgc_->setPreviewDemand(demand);
  }

  bool takePreviewFrame(ScreenPreviewFrame& frame) override {
    return (dxgi_ && dxgi_->takePreviewFrame(frame)) ||
        (wgc_ && wgc_->takePreviewFrame(frame));
  }

  bool takePreviewFailure(ScreenPreviewFailure& failure) override {
    return (dxgi_ && dxgi_->takePreviewFailure(failure)) ||
        (wgc_ && wgc_->takePreviewFailure(failure));
  }

  void releasePreviewFrame(std::uint64_t sequence) noexcept override {
    if (dxgi_) dxgi_->releasePreviewFrame(sequence);
    if (wgc_) wgc_->releasePreviewFrame(sequence);
  }

  std::size_t previewFramesInFlight() const noexcept override {
    return (dxgi_ ? dxgi_->previewFramesInFlight() : 0) +
        (wgc_ ? wgc_->previewFramesInFlight() : 0);
  }

  const char* method() const noexcept override { return active_->method(); }
  LUID adapterLuid() const noexcept override { return active_->adapterLuid(); }

 private:
  bool switchToWgc(std::string_view reason, long hresult) noexcept {
    if (active_ == wgc_) return true;
    try {
      if (!wgc_) {
        wgc_ = createWgcGpuCapturer(target_, width_, height_);
        wgc_->setPreviewDemand(preview_demand_);
      }
      active_ = wgc_;
      logScreenCaptureBackend(
          "screen_capture_backend_runtime_fallback", reason, hresult);
      return true;
    } catch (...) {
      return false;
    }
  }

  syrnike::voice::ScreenCaptureTarget target_;
  std::uint32_t width_ = 0;
  std::uint32_t height_ = 0;
  ScreenPreviewDemand preview_demand_;
  std::shared_ptr<ScreenGpuCapturer> dxgi_;
  std::shared_ptr<ScreenGpuCapturer> wgc_;
  std::shared_ptr<ScreenGpuCapturer> active_;
  DxgiFallbackPolicy fallback_policy_;
};

}  // namespace

ScreenGpuCaptureError::ScreenGpuCaptureError(
    ScreenGpuCaptureErrorCode code,
    std::string message,
    long hresult)
    : std::runtime_error(std::move(message)), code_(code), hresult_(hresult) {}

std::shared_ptr<ScreenGpuCapturer> ScreenGpuCapturer::create(
    const syrnike::voice::ScreenCaptureTarget& target,
    std::uint32_t width,
    std::uint32_t height) {
  if (target.window && (!target.hwnd || !IsWindow(target.hwnd))) {
    throw ScreenGpuCaptureError(
        ScreenGpuCaptureErrorCode::TargetClosed,
        "selected window is no longer available");
  }
  if (target.window) return createWgcGpuCapturer(target, width, height);
  return std::make_shared<MonitorGpuCapturer>(target, width, height);
}

}  // namespace syrnike::desktop_native::media
