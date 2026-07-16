#include "screen_video_capture_benchmark.hpp"

#include <d3d11.h>
#include <dxgi1_2.h>
#include <windows.h>
#include <Windows.Graphics.Capture.Interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <wrl/client.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Security.Authorization.AppCapabilityAccess.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
#include <cmath>
#include <stdexcept>
#include <thread>

#include "screen_capture_priority.hpp"

using Microsoft::WRL::ComPtr;
namespace capture = winrt::Windows::Graphics::Capture;
namespace directx = winrt::Windows::Graphics::DirectX;
namespace d3dwinrt = winrt::Windows::Graphics::DirectX::Direct3D11;
namespace appcap = winrt::Windows::Security::Authorization::AppCapabilityAccess;

namespace syrnike::voice {
namespace {

void copyScaledBgra(
    ScreenVideoFrame& frame,
    const uint8_t* source,
    uint32_t source_width,
    uint32_t source_height,
    uint32_t source_stride,
    uint32_t output_width,
    uint32_t output_height) {
  frame.bgra.resize(static_cast<size_t>(output_width) * output_height * 4);

  if (source_width == output_width && source_height == output_height &&
      source_stride == output_width * 4) {
    std::memcpy(frame.bgra.data(), source, frame.bgra.size());
    return;
  }

  if (source_width == output_width && source_height == output_height) {
    const size_t output_stride = static_cast<size_t>(output_width) * 4;
    for (uint32_t row = 0; row < output_height; ++row) {
      std::memcpy(
          frame.bgra.data() + static_cast<size_t>(row) * output_stride,
          source + static_cast<size_t>(row) * source_stride,
          output_stride);
    }
    return;
  }

  for (uint32_t row = 0; row < output_height; ++row) {
    const uint32_t source_row = static_cast<uint32_t>(
        (static_cast<uint64_t>(row) * source_height) / output_height);
    const auto* source_line = source + static_cast<size_t>(source_row) * source_stride;
    auto* output_line = frame.bgra.data() + static_cast<size_t>(row) * output_width * 4;
    for (uint32_t col = 0; col < output_width; ++col) {
      const uint32_t source_col = static_cast<uint32_t>(
          (static_cast<uint64_t>(col) * source_width) / output_width);
      std::memcpy(output_line + static_cast<size_t>(col) * 4, source_line + static_cast<size_t>(source_col) * 4, 4);
    }
  }
}

void disableCaptureBorderIfAllowed(capture::GraphicsCaptureSession& session) {
  try {
    const auto status = capture::GraphicsCaptureAccess::RequestAccessAsync(
        capture::GraphicsCaptureAccessKind::Borderless).get();
    if (status == appcap::AppCapabilityAccessStatus::Allowed) {
      session.IsBorderRequired(false);
    }
  } catch (...) {
  }
}

ScreenCaptureFrameResult captureResult(
    ScreenCaptureFrameStatus status,
    const char* method,
    ScreenCaptureFrameMetrics metrics = {}) {
  ScreenCaptureFrameResult result;
  result.status = status;
  result.method = method;
  result.metrics = metrics;
  return result;
}

ComPtr<ID3D11Texture2D> createReadbackTexture(
    ID3D11Device* device,
    uint32_t width,
    uint32_t height) {
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = width;
  desc.Height = height;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_STAGING;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

  ComPtr<ID3D11Texture2D> texture;
  const HRESULT hr = device->CreateTexture2D(&desc, nullptr, &texture);
  if (FAILED(hr)) throw std::runtime_error("failed to create d3d readback texture");
  return texture;
}

class D3dReadbackRing {
public:
  void reset(ID3D11Device* device, uint32_t width, uint32_t height) {
    width_ = width;
    height_ = height;
    write_slot_ = 0;
    read_slot_ = 0;
    for (auto& slot : slots_) {
      slot.texture = createReadbackTexture(device, width, height);
      slot.pending = false;
      slot.metrics = {};
    }
  }

  bool enqueue(
      ID3D11DeviceContext* context,
      ID3D11Texture2D* texture,
      ScreenCaptureFrameMetrics metrics) {
    auto& slot = slots_[write_slot_];
    if (slot.pending || !slot.texture) return false;
    context->CopyResource(slot.texture.Get(), texture);
    slot.metrics = metrics;
    slot.pending = true;
    write_slot_ = (write_slot_ + 1) % slots_.size();
    return true;
  }

  ScreenCaptureFrameResult tryRead(
      ID3D11DeviceContext* context,
      ScreenVideoFrame& frame,
      const char* method,
      uint32_t output_width,
      uint32_t output_height) {
    for (size_t attempt = 0; attempt < slots_.size(); ++attempt) {
      auto& slot = slots_[read_slot_];
      if (!slot.pending) {
        read_slot_ = (read_slot_ + 1) % slots_.size();
        continue;
      }

      D3D11_MAPPED_SUBRESOURCE mapped{};
      const auto read_started_at = std::chrono::steady_clock::now();
      const HRESULT hr = context->Map(
          slot.texture.Get(),
          0,
          D3D11_MAP_READ,
          D3D11_MAP_FLAG_DO_NOT_WAIT,
          &mapped);
      if (hr == DXGI_ERROR_WAS_STILL_DRAWING) {
        return captureResult(ScreenCaptureFrameStatus::NoFrame, method, slot.metrics);
      }
      if (FAILED(hr)) {
        auto metrics = slot.metrics;
        metrics.hresult = static_cast<long>(hr);
        return captureResult(ScreenCaptureFrameStatus::FatalError, method, metrics);
      }

      auto metrics = slot.metrics;
      metrics.readback_us = static_cast<int>(
          std::chrono::duration_cast<std::chrono::microseconds>(
              std::chrono::steady_clock::now() - read_started_at)
              .count());
      const auto scale_started_at = std::chrono::steady_clock::now();
      const auto* source = static_cast<const uint8_t*>(mapped.pData);
      const uint32_t source_width = metrics.content_width > 0 ? metrics.content_width : width_;
      const uint32_t source_height = metrics.content_height > 0 ? metrics.content_height : height_;
      copyScaledBgra(
          frame,
          source,
          source_width,
          source_height,
          mapped.RowPitch,
          output_width,
          output_height);
      metrics.scale_us = static_cast<int>(
          std::chrono::duration_cast<std::chrono::microseconds>(
              std::chrono::steady_clock::now() - scale_started_at)
              .count());
      context->Unmap(slot.texture.Get(), 0);
      slot.pending = false;
      slot.metrics = {};
      read_slot_ = (read_slot_ + 1) % slots_.size();
      frame.method = method;
      return captureResult(ScreenCaptureFrameStatus::NewFrame, method, metrics);
    }

    return captureResult(ScreenCaptureFrameStatus::NoFrame, method);
  }

private:
  struct ReadbackSlot {
    ComPtr<ID3D11Texture2D> texture;
    bool pending = false;
    ScreenCaptureFrameMetrics metrics;
  };

  std::array<ReadbackSlot, 3> slots_;
  size_t write_slot_ = 0;
  size_t read_slot_ = 0;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
};

class DxgiScreenVideoCapturer final : public ScreenVideoCapturer {
public:
  DxgiScreenVideoCapturer(const ScreenCaptureTarget& target, uint32_t width, uint32_t height)
      : target_(target), width_(width), height_(height) {
    init();
  }

  ScreenCaptureFrameResult capture(ScreenVideoFrame& frame) override {
    const auto started_at = std::chrono::steady_clock::now();
    DXGI_OUTDUPL_FRAME_INFO frame_info{};
    ComPtr<IDXGIResource> resource;
    HRESULT hr = duplication_->AcquireNextFrame(1, &frame_info, &resource);
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
      return readback_.tryRead(context_.Get(), frame, method(), width_, height_);
    }
    if (hr == DXGI_ERROR_ACCESS_LOST) {
      ScreenCaptureFrameMetrics metrics;
      metrics.hresult = static_cast<long>(hr);
      if (SUCCEEDED(recreateDuplication())) {
        return captureResult(ScreenCaptureFrameStatus::RecoverableLost, method(), metrics);
      }
      return captureResult(ScreenCaptureFrameStatus::FatalError, method(), metrics);
    }
    if (FAILED(hr)) {
      ScreenCaptureFrameMetrics metrics;
      metrics.hresult = static_cast<long>(hr);
      return captureResult(ScreenCaptureFrameStatus::FatalError, method(), metrics);
    }

    ComPtr<ID3D11Texture2D> texture;
    hr = resource.As(&texture);
    if (FAILED(hr)) {
      duplication_->ReleaseFrame();
      ScreenCaptureFrameMetrics metrics;
      metrics.hresult = static_cast<long>(hr);
      return captureResult(ScreenCaptureFrameStatus::FatalError, method(), metrics);
    }

    ScreenCaptureFrameMetrics metrics;
    metrics.source_width = native_width_;
    metrics.source_height = native_height_;
    metrics.content_width = native_width_;
    metrics.content_height = native_height_;
    metrics.output_width = width_;
    metrics.output_height = height_;
    metrics.capture_us = static_cast<int>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - started_at)
            .count());
    const bool queued = readback_.enqueue(context_.Get(), texture.Get(), metrics);
    if (!queued) {
      auto read_result = readback_.tryRead(context_.Get(), frame, method(), width_, height_);
      if (read_result.status == ScreenCaptureFrameStatus::NewFrame) {
        readback_.enqueue(context_.Get(), texture.Get(), metrics);
      }
      duplication_->ReleaseFrame();
      return read_result;
    }
    duplication_->ReleaseFrame();
    return readback_.tryRead(context_.Get(), frame, method(), width_, height_);
  }

  const char* method() const override { return "dxgi"; }

private:
  void init() {
    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    D3D_FEATURE_LEVEL feature_level{};
    HRESULT hr = D3D11CreateDevice(
        nullptr,
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,
        flags,
        nullptr,
        0,
        D3D11_SDK_VERSION,
        &device_,
        &feature_level,
        &context_);
    if (FAILED(hr)) throw std::runtime_error("failed to create d3d11 device");

    ComPtr<IDXGIDevice> dxgi_device;
    hr = device_.As(&dxgi_device);
    if (FAILED(hr)) throw std::runtime_error("failed to open dxgi device");
    setD3dGpuThreadPriority(dxgi_device.Get(), 3);

    hr = dxgi_device->GetAdapter(&adapter_);
    if (FAILED(hr)) throw std::runtime_error("failed to open dxgi adapter");

    hr = recreateDuplication();
    if (FAILED(hr)) throw std::runtime_error("failed to duplicate dxgi output");
  }

  HRESULT recreateDuplication() {
    duplication_.Reset();

    ComPtr<IDXGIOutput> output;
    HRESULT hr = adapter_->EnumOutputs(static_cast<UINT>(target_.screen_index - 1), &output);
    if (FAILED(hr)) return hr;

    ComPtr<IDXGIOutput1> output1;
    hr = output.As(&output1);
    if (FAILED(hr)) return hr;

    DXGI_OUTPUT_DESC output_desc{};
    hr = output->GetDesc(&output_desc);
    if (FAILED(hr)) return hr;
    native_width_ = static_cast<uint32_t>(
        output_desc.DesktopCoordinates.right - output_desc.DesktopCoordinates.left);
    native_height_ = static_cast<uint32_t>(
        output_desc.DesktopCoordinates.bottom - output_desc.DesktopCoordinates.top);

    hr = output1->DuplicateOutput(device_.Get(), &duplication_);
    if (FAILED(hr)) return hr;

    readback_.reset(device_.Get(), native_width_, native_height_);
    return S_OK;
  }

  ScreenCaptureTarget target_;
  uint32_t width_;
  uint32_t height_;
  uint32_t native_width_ = 0;
  uint32_t native_height_ = 0;
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<IDXGIAdapter> adapter_;
  ComPtr<IDXGIOutputDuplication> duplication_;
  D3dReadbackRing readback_;
};

class WgcScreenVideoCapturer final : public ScreenVideoCapturer {
public:
  WgcScreenVideoCapturer(const ScreenCaptureTarget& target, uint32_t width, uint32_t height)
      : target_(target), width_(width), height_(height) {
    init();
  }

  ~WgcScreenVideoCapturer() override {
    if (closed_subscribed_ && item_) {
      item_.Closed(closed_token_);
    }
  }

  ScreenCaptureFrameResult capture(ScreenVideoFrame& frame) override {
    const auto started_at = std::chrono::steady_clock::now();
    if (target_closed_.load(std::memory_order_relaxed) ||
        !target_.hwnd ||
        !IsWindow(target_.hwnd)) {
      return captureResult(ScreenCaptureFrameStatus::TargetClosed, method());
    }

    const auto timeout = std::chrono::milliseconds(1);
    auto deadline = std::chrono::steady_clock::now() + timeout;
    capture::Direct3D11CaptureFrame capture_frame{nullptr};
    while (std::chrono::steady_clock::now() < deadline) {
      capture_frame = frame_pool_.TryGetNextFrame();
      if (capture_frame) break;
      Sleep(1);
    }
    if (!capture_frame) {
      return readback_.tryRead(context_.Get(), frame, method(), width_, height_);
    }

    const auto content_size = capture_frame.ContentSize();
    if (content_size.Width > 0 && content_size.Height > 0 &&
        (content_size.Width != pool_size_.Width || content_size.Height != pool_size_.Height)) {
      ScreenCaptureFrameMetrics metrics;
      metrics.source_width = static_cast<uint32_t>(std::max(1, content_size.Width));
      metrics.source_height = static_cast<uint32_t>(std::max(1, content_size.Height));
      metrics.content_width = metrics.source_width;
      metrics.content_height = metrics.source_height;
      metrics.output_width = width_;
      metrics.output_height = height_;
      try {
        recreateFramePool(content_size);
        return captureResult(ScreenCaptureFrameStatus::RecoverableLost, method(), metrics);
      } catch (const winrt::hresult_error& error) {
        metrics.hresult = static_cast<long>(error.code());
        return captureResult(ScreenCaptureFrameStatus::FatalError, method(), metrics);
      }
    }

    ComPtr<ID3D11Texture2D> texture;
    auto access = capture_frame.Surface().as<Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    HRESULT hr = access->GetInterface(IID_PPV_ARGS(&texture));
    if (FAILED(hr)) {
      ScreenCaptureFrameMetrics metrics;
      metrics.hresult = static_cast<long>(hr);
      return captureResult(ScreenCaptureFrameStatus::FatalError, method(), metrics);
    }

    ScreenCaptureFrameMetrics metrics;
    metrics.source_width = native_width_;
    metrics.source_height = native_height_;
    metrics.content_width = static_cast<uint32_t>(std::max(1, content_size.Width));
    metrics.content_height = static_cast<uint32_t>(std::max(1, content_size.Height));
    metrics.output_width = width_;
    metrics.output_height = height_;
    metrics.capture_us = static_cast<int>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - started_at)
            .count());
    if (!readback_.enqueue(context_.Get(), texture.Get(), metrics)) {
      auto read_result = readback_.tryRead(context_.Get(), frame, method(), width_, height_);
      if (read_result.status == ScreenCaptureFrameStatus::NewFrame) {
        readback_.enqueue(context_.Get(), texture.Get(), metrics);
      }
      return read_result;
    }
    return readback_.tryRead(context_.Get(), frame, method(), width_, height_);
  }

  const char* method() const override { return "wgc"; }

private:
  void init() {
    try {
      winrt::init_apartment(winrt::apartment_type::multi_threaded);
    } catch (const winrt::hresult_error& error) {
      if (error.code() != RPC_E_CHANGED_MODE) {
        throw;
      }
    }

    UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
    D3D_FEATURE_LEVEL feature_level{};
    HRESULT hr = D3D11CreateDevice(
        nullptr,
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,
        flags,
        nullptr,
        0,
        D3D11_SDK_VERSION,
        &device_,
        &feature_level,
        &context_);
    if (FAILED(hr)) throw std::runtime_error("failed to create wgc d3d11 device");

    ComPtr<IDXGIDevice> dxgi_device;
    hr = device_.As(&dxgi_device);
    if (FAILED(hr)) throw std::runtime_error("failed to open wgc dxgi device");
    setD3dGpuThreadPriority(dxgi_device.Get(), 3);

    IInspectable* raw_device = nullptr;
    hr = CreateDirect3D11DeviceFromDXGIDevice(dxgi_device.Get(), &raw_device);
    if (FAILED(hr)) throw std::runtime_error("failed to create wgc direct3d device");
    winrt::com_ptr<IInspectable> inspectable_device;
    inspectable_device.attach(raw_device);
    winrt_device_ = inspectable_device.as<d3dwinrt::IDirect3DDevice>();

    auto interop = winrt::get_activation_factory<capture::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    winrt::com_ptr<ABI::Windows::Graphics::Capture::IGraphicsCaptureItem> raw_item;
    hr = interop->CreateForWindow(
        target_.hwnd,
        __uuidof(ABI::Windows::Graphics::Capture::IGraphicsCaptureItem),
        reinterpret_cast<void**>(raw_item.put()));
    if (FAILED(hr)) throw std::runtime_error("failed to create wgc item for window");
    item_ = raw_item.as<capture::GraphicsCaptureItem>();
    closed_token_ = item_.Closed([this](auto const&, auto const&) {
      target_closed_.store(true, std::memory_order_relaxed);
    });
    closed_subscribed_ = true;

    const auto size = item_.Size();
    pool_size_ = size;
    native_width_ = static_cast<uint32_t>(std::max(1, pool_size_.Width));
    native_height_ = static_cast<uint32_t>(std::max(1, pool_size_.Height));

    frame_pool_ = capture::Direct3D11CaptureFramePool::CreateFreeThreaded(
        winrt_device_,
        directx::DirectXPixelFormat::B8G8R8A8UIntNormalized,
        3,
        pool_size_);
    session_ = frame_pool_.CreateCaptureSession(item_);
    session_.IsCursorCaptureEnabled(true);
    disableCaptureBorderIfAllowed(session_);
    session_.StartCapture();

    readback_.reset(device_.Get(), native_width_, native_height_);
  }

  void recreateFramePool(winrt::Windows::Graphics::SizeInt32 size) {
    if (size.Width <= 0 || size.Height <= 0) return;
    pool_size_ = size;
    native_width_ = static_cast<uint32_t>(std::max(1, pool_size_.Width));
    native_height_ = static_cast<uint32_t>(std::max(1, pool_size_.Height));
    frame_pool_.Recreate(
        winrt_device_,
        directx::DirectXPixelFormat::B8G8R8A8UIntNormalized,
        3,
        pool_size_);
    readback_.reset(device_.Get(), native_width_, native_height_);
  }

  ScreenCaptureTarget target_;
  uint32_t width_;
  uint32_t height_;
  uint32_t native_width_ = 0;
  uint32_t native_height_ = 0;
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  D3dReadbackRing readback_;
  d3dwinrt::IDirect3DDevice winrt_device_{nullptr};
  capture::GraphicsCaptureItem item_{nullptr};
  capture::Direct3D11CaptureFramePool frame_pool_{nullptr};
  capture::GraphicsCaptureSession session_{nullptr};
  winrt::Windows::Graphics::SizeInt32 pool_size_{};
  winrt::event_token closed_token_{};
  bool closed_subscribed_ = false;
  std::atomic_bool target_closed_{false};
};

}  // namespace

std::unique_ptr<ScreenVideoCapturer> ScreenVideoCapturer::create(
    const ScreenCaptureTarget& target,
    uint32_t width,
    uint32_t height) {
  if (!target.window) {
    return std::make_unique<DxgiScreenVideoCapturer>(target, width, height);
  }
  return std::make_unique<WgcScreenVideoCapturer>(target, width, height);
}

}  // namespace syrnike::voice
