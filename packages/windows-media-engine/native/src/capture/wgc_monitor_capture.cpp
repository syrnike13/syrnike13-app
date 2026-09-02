#include "capture/wgc_monitor_capture.hpp"
#include "capture/wgc_capture_support.hpp"

#include <windows.h>
#include <d3d11_4.h>
#include <d3d11sdklayers.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <wrl/client.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <optional>
#include <utility>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/base.h>

namespace syrnike::windows_media::capture {
namespace {

using Microsoft::WRL::ComPtr;
using winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool;
using winrt::Windows::Graphics::Capture::GraphicsCaptureItem;
using winrt::Windows::Graphics::Capture::GraphicsCaptureSession;
using winrt::Windows::Graphics::DirectX::DirectXPixelFormat;
using DxgiInterfaceAccess =
    ::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess;
using detail::WgcDeviceState;
using detail::acquireMonitorCaptureItem;
using detail::createWgcDevice;
using detail::createWinrtD3DDevice;
using detail::ensureRoInitialized;
using detail::hresultText;
using detail::makeWgcFrameResource;

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
  std::shared_ptr<WgcDeviceState> device;
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
      auto device = createWgcDevice(options_.request_d3d_debug_layer,
                                    debug_enabled);

      const auto direct3d_device = createWinrtD3DDevice(device);

      GraphicsCaptureItem item = acquireMonitorCaptureItem(
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
                     makeWgcFrameResource(
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
    if (state_->device) {
      {
        std::lock_guard context_lock(state_->device->context_mutex);
        state_->device->readback_staging.Reset();
        state_->device->readback_width = 0;
        state_->device->readback_height = 0;
        if (state_->diagnostics.d3d_debug_enabled) {
          state_->device->context->ClearState();
          state_->device->context->Flush();
        }
      }
    }
    if (state_->device && state_->diagnostics.d3d_debug_enabled) {
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
