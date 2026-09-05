#include "capture/wgc_window_capture.hpp"
#include "capture/wgc_capture_support.hpp"

#include <windows.h>
#include <d3d11.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <wrl/client.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <optional>
#include <thread>
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
using winrt::Windows::Graphics::Capture::Direct3D11CaptureFramePool;
using winrt::Windows::Graphics::Capture::GraphicsCaptureItem;
using winrt::Windows::Graphics::Capture::GraphicsCaptureSession;
using winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
using winrt::Windows::Graphics::DirectX::DirectXPixelFormat;
using DxgiInterfaceAccess =
    ::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess;
using detail::WgcDeviceState;
using detail::acquireWindowCaptureItem;
using detail::createWgcDevice;
using detail::createWinrtD3DDevice;
using detail::ensureRoInitialized;
using detail::hresultText;
using detail::makeWgcFrameResource;

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
  std::shared_ptr<WgcDeviceState> device;
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
  // A terminal signal stops WGC callbacks, but the consumer may still hold its
  // final frame. WindowCapture::stop calls us again after all leases drain.
  // Do not freeze resource diagnostics or finalize the shared readback device
  // during that interval.
  if (!state->stopped || state->live_engine_resources->load() != 0) return;
  state->finalized = true;
  state->diagnostics.live_engine_objects =
      state->live_engine_resources->load();
  state->diagnostics.peak_engine_objects =
      state->peak_engine_resources->load();
  if (state->device) {
    {
      std::lock_guard context_lock(state->device->owner->contextMutex());
      state->device->readback_staging.Reset();
      state->device->readback_width = 0;
      state->device->readback_height = 0;
    }
  }
  if (state->device && state->diagnostics.d3d_debug_enabled) {
    ComPtr<ID3D11Debug> debug;
    const HRESULT query = state->device->owner->device()->QueryInterface(
        IID_PPV_ARGS(&debug));
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
      auto device = createWgcDevice(options_.request_d3d_debug_layer,
                                    debug_enabled);
      const auto direct3d_device = createWinrtD3DDevice(device);

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
              D3D11_TEXTURE2D_DESC texture_description{};
              source_texture->GetDesc(&texture_description);
              // Recreate can race the compositor's resize. ContentSize may
              // already describe the new window while this surface still
              // belongs to the smaller pool. Drop that transitional frame;
              // never publish metadata extending beyond its actual backing.
              if (texture_description.Width < static_cast<UINT>(content_size.Width) ||
                  texture_description.Height < static_cast<UINT>(content_size.Height)) {
                frame.Close();
                return;
              }
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
                    makeWgcFrameResource(
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

std::unique_ptr<WgcWindowCaptureBackend> createWgcWindowCaptureBackend(
    WgcWindowCaptureOptions options) {
  return std::make_unique<WgcWindowCaptureBackendImpl>(options);
}

}  // namespace syrnike::windows_media::capture
