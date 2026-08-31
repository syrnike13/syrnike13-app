#include "capture/wgc_monitor_capture.hpp"

#include <windows.h>
#include <roapi.h>
#include <d3d11_4.h>
#include <d3d11sdklayers.h>
#include <dxgi1_6.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <unordered_map>
#include <utility>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/base.h>

namespace syrnike::windows_media::capture {
namespace {

using Microsoft::WRL::ComPtr;
using winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame;
using winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool;
using winrt::Windows::Graphics::Capture::GraphicsCaptureItem;
using winrt::Windows::Graphics::Capture::GraphicsCaptureSession;
using winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
using winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DSurface;
using winrt::Windows::Graphics::DirectX::DirectXPixelFormat;
using DxgiInterfaceAccess =
    ::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess;

std::string hresultText(HRESULT value) {
  std::ostringstream output;
  output << "HRESULT 0x" << std::hex
         << static_cast<std::uint32_t>(value);
  return output.str();
}

struct DeviceState {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  std::mutex context_mutex;
};

struct DebugDeviceCache {
  std::mutex mutex;
  std::shared_ptr<DeviceState> device;
};

DebugDeviceCache& debugDeviceCache() {
  static DebugDeviceCache cache;
  return cache;
}

struct CaptureItemCacheEntry {
  GraphicsCaptureItem item{nullptr};
  winrt::event_token closed_token{};
};

struct CaptureItemCache {
  std::mutex mutex;
  std::unordered_map<std::string, CaptureItemCacheEntry> items;
};

CaptureItemCache& captureItemCache() {
  static CaptureItemCache cache;
  return cache;
}

GraphicsCaptureItem acquireCaptureItem(std::uintptr_t platform_value,
                                       const std::string& stable_identity) {
  auto& cache = captureItemCache();
  std::lock_guard lock(cache.mutex);
  const std::string key = stable_identity + "@" +
                          std::to_string(platform_value);
  const auto found = cache.items.find(key);
  if (found != cache.items.end()) return found->second.item;

  const auto item_factory = winrt::get_activation_factory<
      GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  GraphicsCaptureItem item{nullptr};
  winrt::check_hresult(item_factory->CreateForMonitor(
      reinterpret_cast<HMONITOR>(platform_value),
      winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item)));
  const auto token = item.Closed(
      [key](const GraphicsCaptureItem&,
            const winrt::Windows::Foundation::IInspectable&) {
        auto& item_cache = captureItemCache();
        std::lock_guard cache_lock(item_cache.mutex);
        item_cache.items.erase(key);
      });
  cache.items.emplace(key, CaptureItemCacheEntry{item, token});
  return item;
}

std::shared_ptr<DeviceState> createD3DDevice(bool request_debug,
                                             bool& debug_enabled) {
  auto create = [](UINT flags) {
    auto device = std::make_shared<DeviceState>();
    constexpr D3D_FEATURE_LEVEL levels[] = {
        D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    D3D_FEATURE_LEVEL selected_level{};
    const HRESULT result = D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        flags | D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels,
        static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION,
        &device->device, &selected_level, &device->context);
    (void)selected_level;
    return std::pair{result, std::move(device)};
  };

  if (request_debug) {
    auto& cache = debugDeviceCache();
    std::lock_guard lock(cache.mutex);
    if (cache.device) {
      debug_enabled = true;
      return cache.device;
    }
    auto [result, device] = create(D3D11_CREATE_DEVICE_DEBUG);
    if (SUCCEEDED(result)) {
      debug_enabled = true;
      cache.device = device;
      return cache.device;
    }
  }
  auto [result, device] = create(0);
  if (FAILED(result)) {
    throw winrt::hresult_error(result);
  }
  debug_enabled = false;
  return device;
}

class D3D11FrameResource final : public FrameResource {
 public:
  D3D11FrameResource(std::shared_ptr<DeviceState> device,
                     std::shared_ptr<std::atomic<std::uint64_t>> live_resources,
                     Direct3D11CaptureFrame frame,
                     ComPtr<ID3D11Texture2D> texture,
                     std::uint32_t width, std::uint32_t height)
      : device_(std::move(device)),
        live_resources_(std::move(live_resources)),
        frame_(std::move(frame)),
        texture_(std::move(texture)),
        width_(width),
        height_(height) {
    live_resources_->fetch_add(1);
  }

  ~D3D11FrameResource() override { live_resources_->fetch_sub(1); }

  std::uint64_t sampledHash() override {
    D3D11_TEXTURE2D_DESC description{};
    texture_->GetDesc(&description);
    D3D11_TEXTURE2D_DESC staging_description = description;
    staging_description.Width = (std::min)(description.Width, width_);
    staging_description.Height = (std::min)(description.Height, height_);
    staging_description.Usage = D3D11_USAGE_STAGING;
    staging_description.BindFlags = 0;
    staging_description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    staging_description.MiscFlags = 0;
    staging_description.MipLevels = 1;
    staging_description.ArraySize = 1;
    staging_description.SampleDesc = {1, 0};
    ComPtr<ID3D11Texture2D> staging;
    winrt::check_hresult(device_->device->CreateTexture2D(
        &staging_description, nullptr, &staging));
    constexpr char staging_name[] = "SyrnikeMonitorHashStaging";
    (void)staging->SetPrivateData(WKPDID_D3DDebugObjectName,
                                  sizeof(staging_name) - 1, staging_name);

    D3D11_MAPPED_SUBRESOURCE mapped{};
    {
      std::lock_guard lock(device_->context_mutex);
      const D3D11_BOX source_box{0, 0, 0, staging_description.Width,
                                 staging_description.Height, 1};
      device_->context->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0,
                                              texture_.Get(), 0, &source_box);
      winrt::check_hresult(device_->context->Map(
          staging.Get(), 0, D3D11_MAP_READ, 0, &mapped));
    }
    struct Unmapper {
      std::shared_ptr<DeviceState> device;
      ID3D11Texture2D* texture;
      ~Unmapper() {
        std::lock_guard lock(device->context_mutex);
        device->context->Unmap(texture, 0);
      }
    } unmapper{device_, staging.Get()};

    constexpr std::uint64_t offset_basis = 1469598103934665603ULL;
    constexpr std::uint64_t prime = 1099511628211ULL;
    std::uint64_t hash = offset_basis;
    const auto* bytes = static_cast<const std::uint8_t*>(mapped.pData);
    const std::uint32_t sample_width =
        (std::min)(staging_description.Width, 64U);
    const std::uint32_t sample_height =
        (std::min)(staging_description.Height, 64U);
    for (std::uint32_t sample_y = 0; sample_y < sample_height; ++sample_y) {
      const auto y = static_cast<std::uint64_t>(sample_y) *
                     staging_description.Height / sample_height;
      const auto* row = bytes + y * mapped.RowPitch;
      for (std::uint32_t sample_x = 0; sample_x < sample_width; ++sample_x) {
        const auto x = static_cast<std::uint64_t>(sample_x) *
                       staging_description.Width / sample_width;
        const auto* pixel = row + x * 4U;
        for (std::uint32_t channel = 0; channel < 4; ++channel) {
          hash = (hash ^ pixel[channel]) * prime;
        }
      }
    }
    hash = (hash ^ staging_description.Width) * prime;
    return (hash ^ staging_description.Height) * prime;
  }

 private:
  std::shared_ptr<DeviceState> device_;
  std::shared_ptr<std::atomic<std::uint64_t>> live_resources_;
  Direct3D11CaptureFrame frame_{nullptr};
  ComPtr<ID3D11Texture2D> texture_;
  std::uint32_t width_ = 0;
  std::uint32_t height_ = 0;
};

struct BackendState {
  mutable std::mutex mutex;
  std::condition_variable callbacks_finished;
  std::atomic<bool> stop_requested{false};
  bool active = false;
  bool stop_started = false;
  bool stopped = false;
  bool finalized = false;
  bool terminal_sent = false;
  std::size_t active_callbacks = 0;
  MonitorCaptureBackend::FrameCallback on_frame;
  MonitorCaptureBackend::TerminalCallback on_terminal;
  std::shared_ptr<DeviceState> device;
  std::shared_ptr<std::atomic<std::uint64_t>> live_engine_resources =
      std::make_shared<std::atomic<std::uint64_t>>(0);
  GraphicsCaptureItem item{nullptr};
  Direct3D11CaptureFramePool frame_pool{nullptr};
  GraphicsCaptureSession session{nullptr};
  winrt::event_token frame_arrived_token{};
  winrt::event_token closed_token{};
  std::optional<CaptureFailure> stop_failure;
  WgcMonitorCaptureDiagnostics diagnostics;
};

class CallbackGuard final {
 public:
  explicit CallbackGuard(std::shared_ptr<BackendState> state)
      : state_(std::move(state)) {}
  ~CallbackGuard() {
    std::lock_guard lock(state_->mutex);
    --state_->active_callbacks;
    state_->callbacks_finished.notify_all();
  }

 private:
  std::shared_ptr<BackendState> state_;
};

class ScopedRoInitialization final {
 public:
  ScopedRoInitialization() {
    result_ = RoInitialize(RO_INIT_MULTITHREADED);
    if (FAILED(result_) && result_ != RPC_E_CHANGED_MODE) {
      winrt::check_hresult(result_);
    }
  }
  ~ScopedRoInitialization() {
    if (SUCCEEDED(result_)) RoUninitialize();
  }

 private:
  HRESULT result_ = E_FAIL;
};

void ensureRoInitialized() {
  thread_local ScopedRoInitialization apartment;
  (void)apartment;
}

void sendTerminal(const std::shared_ptr<BackendState>& state,
                  CaptureFailure failure) {
  MonitorCaptureBackend::TerminalCallback callback;
  {
    std::lock_guard lock(state->mutex);
    if (!state->active || state->terminal_sent) return;
    state->terminal_sent = true;
    callback = state->on_terminal;
  }
  if (callback) callback(std::move(failure));
}

class WgcMonitorCaptureBackendImpl final : public WgcMonitorCaptureBackend {
 public:
  explicit WgcMonitorCaptureBackendImpl(WgcMonitorCaptureOptions options)
      : options_(options), state_(std::make_shared<BackendState>()) {
    state_->diagnostics.d3d_debug_requested =
        options_.request_d3d_debug_layer;
  }

  ~WgcMonitorCaptureBackendImpl() override {
    (void)stop(std::chrono::steady_clock::now() + std::chrono::seconds{5});
  }

  BackendStartResult start(const sources::MonitorTargetToken& target,
                           FrameCallback on_frame,
                           TerminalCallback on_terminal) override {
    if (!target.valid()) {
      return {false, CaptureFailure{"invalid_monitor_target",
                                    "native monitor target is empty"}};
    }
    try {
      ensureRoInitialized();
      if (!GraphicsCaptureSession::IsSupported()) {
        return {false, CaptureFailure{
                          "wgc_unsupported",
                          "Windows Graphics Capture is unsupported"}};
      }
      if (state_->stop_requested.load()) {
        return {false, CaptureFailure{"capture_start_cancelled",
                                      "capture stopped during WGC startup"}};
      }

      bool debug_enabled = false;
      auto device = createD3DDevice(options_.request_d3d_debug_layer,
                                    debug_enabled);

      ComPtr<IDXGIDevice> dxgi_device;
      winrt::check_hresult(device->device.As(&dxgi_device));
      winrt::com_ptr<::IInspectable> inspectable;
      winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(
          dxgi_device.Get(), inspectable.put()));
      const auto direct3d_device = inspectable.as<IDirect3DDevice>();

      GraphicsCaptureItem item = acquireCaptureItem(
          target.platformValue(), target.cacheKey());
      const auto size = item.Size();
      if (size.Width <= 0 || size.Height <= 0) {
        return {false, CaptureFailure{"invalid_monitor_size",
                                      "WGC monitor size is empty"}};
      }
      auto frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
          direct3d_device, DirectXPixelFormat::B8G8R8A8UIntNormalized,
          static_cast<int>(kMaximumMonitorFrames + 1),
          size);
      auto session = frame_pool.CreateCaptureSession(item);

      const std::weak_ptr weak = state_;
      const auto frame_token = frame_pool.FrameArrived(
          [weak](const Direct3D11CaptureFramePool& sender,
                 const winrt::Windows::Foundation::IInspectable&) {
            const auto state = weak.lock();
            if (!state) return;
            {
              std::lock_guard lock(state->mutex);
              if (!state->active || state->stop_requested.load()) return;
              ++state->active_callbacks;
            }
            CallbackGuard guard(state);
            try {
              const auto frame = sender.TryGetNextFrame();
              if (!frame) return;
              const auto content_size = frame.ContentSize();
              if (content_size.Width <= 0 || content_size.Height <= 0) return;
              const auto surface = frame.Surface();
              const auto access = surface.as<DxgiInterfaceAccess>();
              ComPtr<ID3D11Texture2D> source_texture;
              winrt::check_hresult(access->GetInterface(
                  IID_PPV_ARGS(&source_texture)));
              const std::int64_t timestamp =
                  frame.SystemRelativeTime().count();
              FrameCallback callback;
              {
                std::lock_guard lock(state->mutex);
                if (!state->active || state->stop_requested.load()) return;
                callback = state->on_frame;
              }
              if (callback) {
                callback(BackendFrame{
                    timestamp, static_cast<std::uint32_t>(content_size.Width),
                    static_cast<std::uint32_t>(content_size.Height),
                     FramePixelFormat::Bgra8,
                     std::make_shared<D3D11FrameResource>(
                         state->device, state->live_engine_resources, frame,
                         std::move(source_texture),
                         static_cast<std::uint32_t>(content_size.Width),
                         static_cast<std::uint32_t>(content_size.Height))});
              }
            } catch (const winrt::hresult_error& error) {
              sendTerminal(state,
                           {"wgc_frame_failed", hresultText(error.code())});
            } catch (const std::exception& error) {
              sendTerminal(state, {"wgc_frame_failed", error.what()});
            }
          });
      const auto closed_token = item.Closed(
          [weak](const GraphicsCaptureItem&,
                 const winrt::Windows::Foundation::IInspectable&) {
            if (const auto state = weak.lock()) {
              sendTerminal(state, {"source_removed",
                                   "captured monitor was removed"});
            }
          });

      {
        std::lock_guard lock(state_->mutex);
        if (state_->stop_requested.load()) {
          item.Closed(closed_token);
          frame_pool.FrameArrived(frame_token);
          session.Close();
          frame_pool.Close();
          return {false, CaptureFailure{"capture_start_cancelled",
                                        "capture stopped during WGC startup"}};
        }
        state_->on_frame = std::move(on_frame);
        state_->on_terminal = std::move(on_terminal);
        state_->device = std::move(device);
        state_->item = item;
        state_->frame_pool = frame_pool;
        state_->session = session;
        state_->frame_arrived_token = frame_token;
        state_->closed_token = closed_token;
        state_->active = true;
        state_->diagnostics.d3d_debug_enabled = debug_enabled;
      }
      session.StartCapture();
      return {};
    } catch (const winrt::hresult_error& error) {
      return {false, CaptureFailure{"wgc_start_failed",
                                    hresultText(error.code())}};
    } catch (const std::exception& error) {
      return {false, CaptureFailure{"wgc_start_failed", error.what()}};
    }
  }

  CaptureStopResult stop(
      std::chrono::steady_clock::time_point deadline) noexcept override {
    state_->stop_requested.store(true);
    GraphicsCaptureItem item{nullptr};
    Direct3D11CaptureFramePool frame_pool{nullptr};
    GraphicsCaptureSession session{nullptr};
    winrt::event_token frame_token{};
    winrt::event_token closed_token{};
    bool perform_cleanup = false;
    {
      std::lock_guard lock(state_->mutex);
      if (state_->stopped) {
        return state_->stop_failure
                   ? CaptureStopResult{false, state_->stop_failure}
                   : CaptureStopResult{};
      }
      if (!state_->stop_started) {
        state_->stop_started = true;
        state_->active = false;
        item = state_->item;
        frame_pool = state_->frame_pool;
        session = state_->session;
        frame_token = state_->frame_arrived_token;
        closed_token = state_->closed_token;
        perform_cleanup = true;
      }
    }

    if (perform_cleanup) {
      auto record_failure = [this](CaptureFailure failure) {
        std::lock_guard lock(state_->mutex);
        if (!state_->stop_failure) {
          state_->stop_failure = std::move(failure);
        }
      };
      auto cleanup = [&record_failure](auto&& operation) {
        try {
          operation();
        } catch (const winrt::hresult_error& error) {
          record_failure(
              {"wgc_stop_failed", hresultText(error.code())});
        } catch (const std::exception& error) {
          record_failure({"wgc_stop_failed", error.what()});
        } catch (...) {
          record_failure({"wgc_stop_failed", "unknown WinRT stop failure"});
        }
      };
      cleanup([] { ensureRoInitialized(); });
      if (item) cleanup([&] { item.Closed(closed_token); });
      if (frame_pool) cleanup([&] { frame_pool.FrameArrived(frame_token); });
      if (session) cleanup([&] { session.Close(); });
      if (frame_pool) cleanup([&] { frame_pool.Close(); });
    }
    session = nullptr;
    frame_pool = nullptr;
    item = nullptr;

    std::unique_lock lock(state_->mutex);
    if (!state_->callbacks_finished.wait_until(
            lock, deadline,
            [this] { return state_->active_callbacks == 0; })) {
      CaptureFailure failure{
          "wgc_callback_deadline_exceeded",
          "WGC callback did not finish before the stop deadline"};
      state_->stop_failure = failure;
      return {false, failure};
    }
    state_->session = nullptr;
    state_->frame_pool = nullptr;
    state_->item = nullptr;
    state_->stopped = true;
    return state_->stop_failure
               ? CaptureStopResult{false, state_->stop_failure}
               : CaptureStopResult{};
  }

  void finalizeStop() noexcept override {
    std::lock_guard lock(state_->mutex);
    if (state_->finalized) return;
    state_->finalized = true;
    if (state_->device && state_->diagnostics.d3d_debug_enabled) {
      state_->diagnostics.live_engine_objects =
          state_->live_engine_resources->load();
      {
        std::lock_guard context_lock(state_->device->context_mutex);
        state_->device->context->ClearState();
        state_->device->context->Flush();
      }
      ComPtr<ID3D11Debug> debug;
      const HRESULT query = state_->device->device.As(&debug);
      if (SUCCEEDED(query)) {
        state_->diagnostics.live_objects_hresult = debug->ReportLiveDeviceObjects(
            D3D11_RLDO_DETAIL | D3D11_RLDO_IGNORE_INTERNAL);
        state_->diagnostics.live_objects_reported =
            SUCCEEDED(state_->diagnostics.live_objects_hresult);
      } else {
        state_->diagnostics.live_objects_hresult = query;
      }
    }
    state_->on_frame = {};
    state_->on_terminal = {};
    state_->device.reset();
  }

  WgcMonitorCaptureDiagnostics diagnostics() const override {
    std::lock_guard lock(state_->mutex);
    return state_->diagnostics;
  }

 private:
  WgcMonitorCaptureOptions options_;
  std::shared_ptr<BackendState> state_;
};

}  // namespace

std::unique_ptr<WgcMonitorCaptureBackend> createWgcMonitorCaptureBackend(
    WgcMonitorCaptureOptions options) {
  return std::make_unique<WgcMonitorCaptureBackendImpl>(options);
}

}  // namespace syrnike::windows_media::capture
