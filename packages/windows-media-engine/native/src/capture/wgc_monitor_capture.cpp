#include "capture/wgc_monitor_capture.hpp"
#include "capture/wgc_window_capture.hpp"

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
#include <thread>
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
using winrt::Windows::Graphics::SizeInt32;
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
  bool closed = false;
};

struct CaptureItemCache {
  std::mutex mutex;
  std::unordered_map<std::string, CaptureItemCacheEntry> items;
};

CaptureItemCache& captureItemCache() {
  // Closed is delivered asynchronously by WGC. Keep the bounded cache alive
  // through process teardown so a late callback cannot race C++ static
  // destruction; the utility/probe process is the ownership boundary.
  static auto* cache = new CaptureItemCache();
  return *cache;
}

inline constexpr std::size_t kMaximumCachedCaptureItems = 64;

void pruneClosedCaptureItems(CaptureItemCache& cache) {
  for (auto iterator = cache.items.begin(); iterator != cache.items.end();) {
    if (iterator->second.closed)
      iterator = cache.items.erase(iterator);
    else
      ++iterator;
  }
}

template <typename CreateItem>
GraphicsCaptureItem acquireCachedCaptureItem(std::string key,
                                             CreateItem create_item) {
  auto& cache = captureItemCache();
  std::lock_guard lock(cache.mutex);
  pruneClosedCaptureItems(cache);
  const auto found = cache.items.find(key);
  if (found != cache.items.end()) return found->second.item;

  const auto item_factory = winrt::get_activation_factory<
      GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  GraphicsCaptureItem item{nullptr};
  winrt::check_hresult(create_item(item_factory, item));
  const auto token = item.Closed(
      [key](const GraphicsCaptureItem&,
            const winrt::Windows::Foundation::IInspectable&) {
        auto& item_cache = captureItemCache();
        std::lock_guard cache_lock(item_cache.mutex);
        const auto found = item_cache.items.find(key);
        if (found != item_cache.items.end()) found->second.closed = true;
      });
  if (cache.items.size() < kMaximumCachedCaptureItems) {
    cache.items.emplace(key, CaptureItemCacheEntry{item, token, false});
  } else {
    item.Closed(token);
  }
  return item;
}

GraphicsCaptureItem acquireCaptureItem(std::uintptr_t platform_value,
                                       const std::string& stable_identity) {
  return acquireCachedCaptureItem(
      "monitor:" + stable_identity + "@" + std::to_string(platform_value),
      [platform_value](const auto& factory, GraphicsCaptureItem& item) {
        return factory->CreateForMonitor(
            reinterpret_cast<HMONITOR>(platform_value),
            winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item));
      });
}

GraphicsCaptureItem acquireWindowCaptureItem(
    std::uintptr_t platform_value, const std::string& stable_identity) {
  return acquireCachedCaptureItem(
      "window:" + stable_identity + "@" + std::to_string(platform_value),
      [platform_value](const auto& factory, GraphicsCaptureItem& item) {
        return factory->CreateForWindow(
            reinterpret_cast<HWND>(platform_value),
            winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item));
      });
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
                     std::shared_ptr<std::atomic<std::uint64_t>> peak_resources,
                     Direct3D11CaptureFrame frame,
                     ComPtr<ID3D11Texture2D> texture,
                     std::uint32_t width, std::uint32_t height)
      : device_(std::move(device)),
        live_resources_(std::move(live_resources)),
        peak_resources_(std::move(peak_resources)),
        frame_(std::move(frame)),
        texture_(std::move(texture)),
        width_(width),
        height_(height) {
    const auto current = live_resources_->fetch_add(1) + 1;
    auto peak = peak_resources_->load();
    while (peak < current &&
           !peak_resources_->compare_exchange_weak(peak, current)) {
    }
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
  std::shared_ptr<std::atomic<std::uint64_t>> peak_resources_;
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
  std::shared_ptr<std::atomic<std::uint64_t>> peak_engine_resources =
      std::make_shared<std::atomic<std::uint64_t>>(0);
  GraphicsCaptureItem item{nullptr};
  Direct3D11CaptureFramePool frame_pool{nullptr};
  GraphicsCaptureSession session{nullptr};
  winrt::event_token frame_arrived_token{};
  winrt::event_token closed_token{};
  std::optional<CaptureFailure> stop_failure;
  WgcMonitorCaptureDiagnostics diagnostics;
};

struct WindowBackendState {
  mutable std::mutex mutex;
  std::mutex callback_serial_mutex;
  std::condition_variable callbacks_finished;
  std::condition_variable observer_condition;
  std::atomic<bool> stop_requested{false};
  bool active = false;
  bool stop_started = false;
  bool stopped = false;
  bool finalized = false;
  bool terminal_sent = false;
  bool no_content = false;
  std::size_t active_callbacks = 0;
  std::chrono::steady_clock::time_point cleanup_deadline =
      std::chrono::steady_clock::time_point::max();
  std::uint64_t generation = 1;
  std::uint32_t width = 1;
  std::uint32_t height = 1;
  std::optional<SizeInt32> pending_size;
  HWND window = nullptr;
  WindowCaptureBackend::FrameCallback on_frame;
  WindowCaptureBackend::EventCallback on_event;
  WindowCaptureBackend::TerminalCallback on_terminal;
  std::shared_ptr<DeviceState> device;
  IDirect3DDevice direct3d_device{nullptr};
  std::shared_ptr<std::atomic<std::uint64_t>> live_engine_resources =
      std::make_shared<std::atomic<std::uint64_t>>(0);
  std::shared_ptr<std::atomic<std::uint64_t>> peak_engine_resources =
      std::make_shared<std::atomic<std::uint64_t>>(0);
  GraphicsCaptureItem item{nullptr};
  Direct3D11CaptureFramePool frame_pool{nullptr};
  GraphicsCaptureSession session{nullptr};
  winrt::event_token frame_arrived_token{};
  winrt::event_token closed_token{};
  std::thread observer;
  std::optional<CaptureFailure> stop_failure;
  WgcWindowCaptureDiagnostics diagnostics;
  std::shared_ptr<WgcWindowCaptureTestHooks> test_hooks;
};

template <typename State>
class CallbackGuard final {
 public:
  explicit CallbackGuard(std::shared_ptr<State> state)
      : state_(std::move(state)) {}
  ~CallbackGuard() {
    std::lock_guard lock(state_->mutex);
    --state_->active_callbacks;
    state_->callbacks_finished.notify_all();
  }

 private:
  std::shared_ptr<State> state_;
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

CaptureStopResult cleanupWindowResources(
    const std::shared_ptr<WindowBackendState>& state,
    std::chrono::steady_clock::time_point deadline) noexcept {
  GraphicsCaptureItem item{nullptr};
  Direct3D11CaptureFramePool frame_pool{nullptr};
  GraphicsCaptureSession session{nullptr};
  winrt::event_token frame_token{};
  winrt::event_token closed_token{};
  for (;;) {
    std::unique_lock lock(state->mutex);
    if (state->stopped) {
      return state->stop_failure
                 ? CaptureStopResult{false, state->stop_failure}
                 : CaptureStopResult{};
    }
    if (!state->stop_started) {
      state->stop_started = true;
      state->active = false;
      item = state->item;
      frame_pool = state->frame_pool;
      session = state->session;
      frame_token = state->frame_arrived_token;
      closed_token = state->closed_token;
      break;
    }
    if (!state->callbacks_finished.wait_until(
            lock, deadline,
            [&] { return state->stopped || !state->stop_started; })) {
      return {false,
              CaptureFailure{"wgc_stop_in_progress_deadline_exceeded",
                             "WGC cleanup exceeded the stop deadline"}};
    }
  }

  auto record_failure = [&state](CaptureFailure failure) {
    std::lock_guard lock(state->mutex);
    if (!state->stop_failure) state->stop_failure = std::move(failure);
  };
  auto cleanup = [&record_failure](auto&& operation) {
    try {
      operation();
    } catch (const winrt::hresult_error& error) {
      record_failure({"wgc_stop_failed", hresultText(error.code())});
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
  session = nullptr;
  frame_pool = nullptr;
  item = nullptr;

  std::unique_lock lock(state->mutex);
  if (!state->callbacks_finished.wait_until(
          lock, deadline, [&] { return state->active_callbacks == 0; })) {
    CaptureFailure failure{
        "wgc_callback_deadline_exceeded",
        "WGC callback did not finish before the stop deadline"};
    state->stop_failure = failure;
    state->stop_started = false;
    state->callbacks_finished.notify_all();
    return {false, failure};
  }
  state->session = nullptr;
  state->frame_pool = nullptr;
  state->item = nullptr;
  state->direct3d_device = nullptr;
  state->stopped = true;
  state->callbacks_finished.notify_all();
  return state->stop_failure
             ? CaptureStopResult{false, state->stop_failure}
             : CaptureStopResult{};
}

void finalizeWindowResources(
    const std::shared_ptr<WindowBackendState>& state) noexcept {
  std::lock_guard lock(state->mutex);
  if (state->finalized) return;
  state->finalized = true;
  state->diagnostics.live_engine_objects =
      state->live_engine_resources->load();
  state->diagnostics.peak_engine_objects =
      state->peak_engine_resources->load();
  if (state->device && state->diagnostics.d3d_debug_enabled) {
    {
      std::lock_guard context_lock(state->device->context_mutex);
      state->device->context->ClearState();
      state->device->context->Flush();
    }
    ComPtr<ID3D11Debug> debug;
    const HRESULT query = state->device->device.As(&debug);
    if (SUCCEEDED(query)) {
      state->diagnostics.live_objects_hresult = debug->ReportLiveDeviceObjects(
          D3D11_RLDO_DETAIL | D3D11_RLDO_IGNORE_INTERNAL);
      state->diagnostics.live_objects_reported =
          SUCCEEDED(state->diagnostics.live_objects_hresult);
    } else {
      state->diagnostics.live_objects_hresult = query;
    }
  }
  state->on_frame = {};
  state->on_event = {};
  state->on_terminal = {};
  state->test_hooks.reset();
  state->device.reset();
  state->diagnostics.cleanup_completed = true;
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

void sendWindowTerminal(const std::shared_ptr<WindowBackendState>& state,
                        CaptureFailure failure) {
  WindowCaptureBackend::TerminalCallback callback;
  {
    std::lock_guard lock(state->mutex);
    if (!state->active || state->terminal_sent) return;
    state->terminal_sent = true;
    state->active = false;
    state->stop_requested.store(true);
    state->cleanup_deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds{5};
    callback = state->on_terminal;
  }
  state->observer_condition.notify_all();
  if (callback) callback(std::move(failure));
}

void sendWindowEvent(const std::shared_ptr<WindowBackendState>& state,
                     WindowBackendEvent event) {
  WindowCaptureBackend::EventCallback callback;
  {
    std::lock_guard lock(state->mutex);
    if (!state->active || state->terminal_sent) return;
    callback = state->on_event;
  }
  if (callback) callback(std::move(event));
}

std::int64_t steadyTimestamp100ns() {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t,
                                                          std::ratio<1, 10'000'000>>>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
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
            CallbackGuard<BackendState> guard(state);
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
                         state->device, state->live_engine_resources,
                         state->peak_engine_resources, frame,
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
    state_->diagnostics.live_engine_objects =
        state_->live_engine_resources->load();
    state_->diagnostics.peak_engine_objects =
        state_->peak_engine_resources->load();
    if (state_->device && state_->diagnostics.d3d_debug_enabled) {
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

class WgcWindowCaptureBackendImpl final : public WgcWindowCaptureBackend {
 public:
  explicit WgcWindowCaptureBackendImpl(WgcWindowCaptureOptions options)
      : options_(options), state_(std::make_shared<WindowBackendState>()) {
    state_->diagnostics.d3d_debug_requested =
        options_.request_d3d_debug_layer;
    state_->test_hooks = options_.test_hooks;
  }

  ~WgcWindowCaptureBackendImpl() override {
    (void)stop(std::chrono::steady_clock::now() + std::chrono::seconds{5});
  }

  BackendStartResult start(const sources::WindowTargetToken& target,
                           FrameCallback on_frame,
                           EventCallback on_event,
                           TerminalCallback on_terminal) override {
    if (!target.valid()) {
      return {false, CaptureFailure{"invalid_window_target",
                                    "native window target is empty"}};
    }
    const HWND window = reinterpret_cast<HWND>(target.platformValue());
    if (!IsWindow(window)) {
      return {false, CaptureFailure{"source_closed",
                                    "window closed before WGC startup"}};
    }
    try {
      ensureRoInitialized();
      if (!GraphicsCaptureSession::IsSupported()) {
        return {false, CaptureFailure{"wgc_unsupported",
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

      GraphicsCaptureItem item = acquireWindowCaptureItem(
          target.platformValue(), target.cacheKey());
      const auto item_size = item.Size();
      const SizeInt32 initial_size{(std::max)(item_size.Width, 1),
                                   (std::max)(item_size.Height, 1)};
      auto frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
          direct3d_device, DirectXPixelFormat::B8G8R8A8UIntNormalized,
          static_cast<int>(kMaximumWindowFrames + 1), initial_size);
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
            CallbackGuard<WindowBackendState> guard(state);
            std::lock_guard serial(state->callback_serial_mutex);
            try {
              auto frame = sender.TryGetNextFrame();
              if (!frame) return;
              const auto content_size = frame.ContentSize();
              if (content_size.Width <= 0 || content_size.Height <= 0) return;
              const std::int64_t timestamp =
                  frame.SystemRelativeTime().count();

              bool size_changed = false;
              bool resize_cancelled = false;
              std::uint64_t pending_generation = 1;
              {
                std::lock_guard lock(state->mutex);
                if (!state->active || state->stop_requested.load()) return;
                size_changed =
                    static_cast<std::uint32_t>(content_size.Width) !=
                        state->width ||
                    static_cast<std::uint32_t>(content_size.Height) !=
                        state->height;
                if (size_changed) state->pending_size = content_size;
                if (!size_changed && state->pending_size) {
                  state->pending_size.reset();
                  resize_cancelled = true;
                }
                pending_generation = state->generation;
              }

              if (resize_cancelled) {
                sendWindowEvent(state, WindowBackendEvent{
                    WindowBackendEventKind::ResizeCancelled,
                    pending_generation,
                    static_cast<std::uint32_t>(content_size.Width),
                    static_cast<std::uint32_t>(content_size.Height), timestamp});
              }

              if (size_changed) {
                frame.Close();
                frame = nullptr;
                sendWindowEvent(state, WindowBackendEvent{
                    WindowBackendEventKind::ResizePending, pending_generation,
                    static_cast<std::uint32_t>(content_size.Width),
                    static_cast<std::uint32_t>(content_size.Height), timestamp});
                if (state->live_engine_resources->load() != 0) return;

                SizeInt32 resize_to{};
                std::uint64_t generation = 0;
                {
                  std::lock_guard lock(state->mutex);
                  if (!state->active || state->stop_requested.load() ||
                      !state->pending_size) {
                    return;
                  }
                  resize_to = *state->pending_size;
                }
                if (state->test_hooks &&
                    state->test_hooks->before_frame_pool_recreate) {
                  state->test_hooks->before_frame_pool_recreate();
                }
                {
                  std::lock_guard lock(state->mutex);
                  if (!state->active || state->stop_requested.load()) return;
                }
                sender.Recreate(
                    state->direct3d_device,
                    DirectXPixelFormat::B8G8R8A8UIntNormalized,
                    static_cast<int>(kMaximumWindowFrames + 1), resize_to);
                {
                  std::lock_guard lock(state->mutex);
                  if (!state->active || state->stop_requested.load()) return;
                  state->width = static_cast<std::uint32_t>(resize_to.Width);
                  state->height = static_cast<std::uint32_t>(resize_to.Height);
                  state->pending_size.reset();
                  generation = ++state->generation;
                }
                sendWindowEvent(state, WindowBackendEvent{
                    WindowBackendEventKind::Resized, generation,
                    static_cast<std::uint32_t>(resize_to.Width),
                    static_cast<std::uint32_t>(resize_to.Height), timestamp});
                return;
              }

              const auto surface = frame.Surface();
              const auto access = surface.as<DxgiInterfaceAccess>();
              ComPtr<ID3D11Texture2D> source_texture;
              winrt::check_hresult(access->GetInterface(
                  IID_PPV_ARGS(&source_texture)));
              FrameCallback callback;
              std::uint64_t generation = 1;
              {
                std::lock_guard lock(state->mutex);
                if (!state->active || state->stop_requested.load()) return;
                callback = state->on_frame;
                generation = state->generation;
              }
              if (callback) {
                if (state->test_hooks &&
                    state->test_hooks->before_frame_callback) {
                  state->test_hooks->before_frame_callback();
                }
                callback(BackendFrame{
                    timestamp, static_cast<std::uint32_t>(content_size.Width),
                    static_cast<std::uint32_t>(content_size.Height),
                    FramePixelFormat::Bgra8,
                    std::make_shared<D3D11FrameResource>(
                        state->device, state->live_engine_resources,
                        state->peak_engine_resources, frame,
                        std::move(source_texture),
                        static_cast<std::uint32_t>(content_size.Width),
                        static_cast<std::uint32_t>(content_size.Height)),
                    generation});
              }
            } catch (const winrt::hresult_error& error) {
              sendWindowTerminal(
                  state, {"wgc_frame_failed", hresultText(error.code())});
            } catch (const std::exception& error) {
              sendWindowTerminal(state, {"wgc_frame_failed", error.what()});
            }
          });
      const auto closed_token = item.Closed(
          [weak](const GraphicsCaptureItem&,
                 const winrt::Windows::Foundation::IInspectable&) {
            if (const auto state = weak.lock()) {
              {
                std::lock_guard lock(state->mutex);
                if (!state->active || state->stop_requested.load()) return;
                ++state->active_callbacks;
              }
              CallbackGuard<WindowBackendState> guard(state);
              sendWindowTerminal(state,
                                 {"source_closed", "captured window closed"});
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
        state_->on_event = std::move(on_event);
        state_->on_terminal = std::move(on_terminal);
        state_->device = std::move(device);
        state_->direct3d_device = direct3d_device;
        state_->item = item;
        state_->frame_pool = frame_pool;
        state_->session = session;
        state_->frame_arrived_token = frame_token;
        state_->closed_token = closed_token;
        state_->window = window;
        state_->width = static_cast<std::uint32_t>(initial_size.Width);
        state_->height = static_cast<std::uint32_t>(initial_size.Height);
        state_->active = true;
        state_->diagnostics.d3d_debug_enabled = debug_enabled;
      }
      session.StartCapture();

      {
        std::lock_guard lock(state_->mutex);
        if (!state_->stop_requested.load()) {
          state_->observer = std::thread([weak] {
            const auto state = weak.lock();
            if (!state) return;
            std::unique_lock lock(state->mutex);
            while (!state->stop_requested.load()) {
              state->observer_condition.wait_for(
                  lock, std::chrono::milliseconds{25},
                  [&] { return state->stop_requested.load(); });
              if (state->stop_requested.load()) break;
              const HWND observed = state->window;
              const auto generation = state->generation;
              const auto width = state->width;
              const auto height = state->height;
              lock.unlock();
              if (!IsWindow(observed)) {
                sendWindowTerminal(
                    state, {"source_closed", "captured window was destroyed"});
                lock.lock();
                continue;
              }
              const bool no_content = IsIconic(observed) != FALSE ||
                                      IsWindowVisible(observed) == FALSE;
              WindowBackendEventKind event_kind{};
              bool changed = false;
              lock.lock();
              if (state->active && state->no_content != no_content) {
                state->no_content = no_content;
                changed = true;
                event_kind = no_content
                                 ? WindowBackendEventKind::TemporarilyNoContent
                                 : WindowBackendEventKind::ContentRestored;
              }
              lock.unlock();
              if (changed) {
                sendWindowEvent(state, WindowBackendEvent{
                    event_kind, generation, width, height,
                    steadyTimestamp100ns()});
              }
              lock.lock();
            }
            const bool terminal_cleanup = state->terminal_sent;
            const auto cleanup_deadline = state->cleanup_deadline;
            lock.unlock();
            if (terminal_cleanup) {
              const auto cleaned =
                  cleanupWindowResources(state, cleanup_deadline);
              if (cleaned.ok) finalizeWindowResources(state);
            }
          });
        }
      }
      sendWindowEvent(state_, WindowBackendEvent{
                                  WindowBackendEventKind::Started, 1,
                                  static_cast<std::uint32_t>(initial_size.Width),
                                  static_cast<std::uint32_t>(initial_size.Height),
                                  steadyTimestamp100ns()});
      if (IsIconic(window) != FALSE || IsWindowVisible(window) == FALSE ||
          item_size.Width <= 0 || item_size.Height <= 0) {
        {
          std::lock_guard lock(state_->mutex);
          state_->no_content = true;
        }
        sendWindowEvent(state_, WindowBackendEvent{
                                    WindowBackendEventKind::TemporarilyNoContent,
                                    1,
                                    static_cast<std::uint32_t>(initial_size.Width),
                                    static_cast<std::uint32_t>(initial_size.Height),
                                    steadyTimestamp100ns()});
      }
      return {};
    } catch (const winrt::hresult_error& error) {
      return {false,
              CaptureFailure{"wgc_start_failed", hresultText(error.code())}};
    } catch (const std::exception& error) {
      return {false, CaptureFailure{"wgc_start_failed", error.what()}};
    }
  }

  CaptureStopResult stop(
      std::chrono::steady_clock::time_point deadline) noexcept override {
    state_->stop_requested.store(true);
    std::thread observer;
    {
      std::lock_guard lock(state_->mutex);
      state_->active = false;
      state_->cleanup_deadline =
          (std::min)(state_->cleanup_deadline, deadline);
      if (state_->observer.joinable()) observer = std::move(state_->observer);
    }
    state_->observer_condition.notify_all();
    if (observer.joinable()) observer.join();
    return cleanupWindowResources(state_, deadline);
  }

  void finalizeStop() noexcept override {
    finalizeWindowResources(state_);
  }

  WgcWindowCaptureDiagnostics diagnostics() const override {
    std::lock_guard lock(state_->mutex);
    return state_->diagnostics;
  }

 private:
  WgcWindowCaptureOptions options_;
  std::shared_ptr<WindowBackendState> state_;
};

}  // namespace

std::unique_ptr<WgcMonitorCaptureBackend> createWgcMonitorCaptureBackend(
    WgcMonitorCaptureOptions options) {
  return std::make_unique<WgcMonitorCaptureBackendImpl>(options);
}

std::unique_ptr<WgcWindowCaptureBackend> createWgcWindowCaptureBackend(
    WgcWindowCaptureOptions options) {
  return std::make_unique<WgcWindowCaptureBackendImpl>(options);
}

}  // namespace syrnike::windows_media::capture
