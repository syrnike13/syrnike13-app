#include "capture/dxgi_monitor_capture.hpp"
#include "capture/dxgi_frame_compositor.hpp"
#include <dxgi1_6.h>
#include <condition_variable>
#include <thread>
#include <algorithm>

namespace syrnike::windows_media::capture {
namespace {
using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;
void check(HRESULT result, const char* operation) {
  if (FAILED(result)) throw detail::DxgiApiError(operation, result);
}
CaptureFailure typedFailure(HRESULT result, const char* operation) {
  auto kind = CaptureFailureKind::backend_failed;
  const char* code = "dxgi_capture_failed";
  if (result == E_ACCESSDENIED || result == DXGI_ERROR_SESSION_DISCONNECTED) {
    kind = CaptureFailureKind::secure_desktop;
    code = "dxgi_desktop_unavailable";
  } else if (result == DXGI_ERROR_ACCESS_LOST) {
    kind = CaptureFailureKind::access_lost;
    code = "dxgi_access_lost";
  } else if (result == DXGI_ERROR_DEVICE_REMOVED || result == DXGI_ERROR_DEVICE_RESET) {
    kind = CaptureFailureKind::device_removed;
    code = "dxgi_device_removed";
  } else if (result == DXGI_ERROR_UNSUPPORTED || result == E_NOTIMPL ||
             result == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE) {
    kind = CaptureFailureKind::unsupported;
    code = "dxgi_unavailable";
  }
  return {code,
          std::string(operation) + " (HRESULT " +
              std::to_string(static_cast<unsigned long>(result)) + ")",
          kind};
}
struct State {
  std::mutex mutex;
  std::condition_variable changed;
  std::atomic_bool stop{false};
  bool ready = false, done = false;
  MonitorCaptureBackend::FrameCallback on_frame;
  MonitorCaptureBackend::TerminalCallback on_terminal;
  std::optional<CaptureFailure> failure;
  DxgiCaptureDiagnostics diagnostics;
  std::shared_ptr<detail::DxgiPoolCounters> counters;
};
ComPtr<IDXGIOutput1> resolveOutput(const std::shared_ptr<D3d11DeviceOwner>& device,
                                   const sources::MonitorTargetToken& target,
                                   DXGI_OUTPUT_DESC& selected) {
  MONITORINFOEXW monitor{};
  monitor.cbSize = sizeof(monitor);
  if (!target.valid() ||
      !GetMonitorInfoW(reinterpret_cast<HMONITOR>(target.platformValue()), &monitor))
    throw CaptureFailure{"dxgi_source_unavailable", "Selected monitor is no longer available",
                         CaptureFailureKind::source_unavailable};
  ComPtr<IDXGIDevice> dxgi_device;
  check(device->device()->QueryInterface(IID_PPV_ARGS(&dxgi_device)), "DXGI device identity");
  ComPtr<IDXGIAdapter> adapter;
  check(dxgi_device->GetAdapter(&adapter), "DXGI device adapter");
  for (UINT index = 0;; ++index) {
    ComPtr<IDXGIOutput> output;
    const auto result = adapter->EnumOutputs(index, &output);
    if (result == DXGI_ERROR_NOT_FOUND) break;
    check(result, "DXGI output enumeration");
    DXGI_OUTPUT_DESC description{};
    check(output->GetDesc(&description), "DXGI output description");
    if (description.Monitor != reinterpret_cast<HMONITOR>(target.platformValue())) continue;
    if (!description.AttachedToDesktop)
      throw CaptureFailure{"dxgi_source_unavailable", "Selected output is detached",
                           CaptureFailureKind::source_unavailable};
    selected = description;
    ComPtr<IDXGIOutput1> result_output;
    check(output.As(&result_output), "DXGI duplication capability");
    return result_output;
  }
  // Never capture a different output or silently create a second GPU device.
  throw CaptureFailure{"dxgi_adapter_mismatch",
                       "Selected monitor is not on the engine D3D11 adapter",
                       CaptureFailureKind::unsupported};
}
void run(const std::shared_ptr<State>& state, sources::MonitorTargetToken target,
         bool debug) noexcept {
  std::shared_ptr<detail::DxgiFrameCompositor> compositor;
  ComPtr<IDXGIOutputDuplication> duplication;
  try {
    const auto device = processD3d11Device(debug);
    DXGI_OUTPUT_DESC output_description{};
    const auto output = resolveOutput(device, target, output_description);
    check(output->DuplicateOutput(device->device(), &duplication), "DXGI DuplicateOutput");
    DXGI_OUTDUPL_DESC description{};
    duplication->GetDesc(&description);
    // ModeDesc describes the oriented desktop. AcquireNextFrame returns the
    // unrotated surface, whose width/height are reversed for portrait outputs.
    const bool portrait = description.Rotation == DXGI_MODE_ROTATION_ROTATE90 ||
                          description.Rotation == DXGI_MODE_ROTATION_ROTATE270;
    compositor = std::make_shared<detail::DxgiFrameCompositor>(
        device, portrait ? description.ModeDesc.Height : description.ModeDesc.Width,
        portrait ? description.ModeDesc.Width : description.ModeDesc.Height, description.Rotation);
    if (compositor->width() !=
            static_cast<std::uint32_t>(output_description.DesktopCoordinates.right -
                                       output_description.DesktopCoordinates.left) ||
        compositor->height() !=
            static_cast<std::uint32_t>(output_description.DesktopCoordinates.bottom -
                                       output_description.DesktopCoordinates.top))
      throw detail::DxgiApiError(("DXGI output changed during prepare: mode=" +
                                  std::to_string(description.ModeDesc.Width) + "x" +
                                  std::to_string(description.ModeDesc.Height) + " rotation=" +
                                  std::to_string(description.Rotation) + " desktop=" +
                                  std::to_string(output_description.DesktopCoordinates.right -
                                                 output_description.DesktopCoordinates.left) +
                                  "x" +
                                  std::to_string(output_description.DesktopCoordinates.bottom -
                                                 output_description.DesktopCoordinates.top))
                                     .c_str(),
                                 DXGI_ERROR_ACCESS_LOST);
    {
      std::scoped_lock lock(state->mutex);
      state->counters = compositor->counters();
      state->ready = true;
      state->diagnostics.width = compositor->width();
      state->diagnostics.height = compositor->height();
      state->diagnostics.rotation = description.Rotation;
      state->changed.notify_all();
    }
    // One fixed allocation per owner, never resized from driver metadata.
    auto pointer_bytes = std::make_unique<
        std::array<std::uint8_t, kDxgiMaximumCursorDimension * kDxgiMaximumCursorDimension * 4>>();
    bool pointer_known = false;
    LARGE_INTEGER frequency{};
    if (!QueryPerformanceFrequency(&frequency) || frequency.QuadPart <= 0)
      throw std::runtime_error("QPC frequency unavailable");
    std::int64_t last_timestamp = 0;
    while (!state->stop) {
      const auto reserved = compositor->reserve();
      if (!reserved) {
        std::unique_lock lock(state->mutex);
        ++state->diagnostics.unavailable_slots;
        state->changed.wait_for(lock, std::chrono::milliseconds{5},
                                [&] { return state->stop.load(); });
        continue;
      }
      struct SlotGuard {
        std::shared_ptr<detail::DxgiFrameCompositor> compositor;
        std::size_t index;
        bool transferred = false;
        ~SlotGuard() {
          if (!transferred) compositor->release(index);
        }
      } slot{compositor, *reserved};
      // Wait for engine context ownership before acquiring a duplication
      // frame. AcquireNextFrame(0) never waits while this mutex is held.
      std::unique_lock context_lock(device->contextMutex(), std::try_to_lock);
      if (!context_lock.owns_lock()) {
        std::unique_lock lock(state->mutex);
        ++state->diagnostics.context_contention_waits;
        state->changed.wait_for(lock, std::chrono::milliseconds{1},
                                [&] { return state->stop.load(); });
        continue;
      }
      DXGI_OUTDUPL_FRAME_INFO frame{};
      ComPtr<IDXGIResource> desktop;
#ifdef WINDOWS_MEDIA_TEST_DXGI_ACQUIRE
      const auto acquired = WINDOWS_MEDIA_TEST_DXGI_ACQUIRE(duplication.Get(), &frame, &desktop);
#else
      const auto acquired = duplication->AcquireNextFrame(0, &frame, &desktop);
#endif
      if (acquired == DXGI_ERROR_WAIT_TIMEOUT) {
        context_lock.unlock();
        std::unique_lock lock(state->mutex);
        ++state->diagnostics.no_content;
        state->changed.wait_for(lock, std::chrono::milliseconds{2},
                                [&] { return state->stop.load(); });
        continue;
      }
      check(acquired, "DXGI AcquireNextFrame");
      const auto acquired_at = Clock::now();
      struct FrameGuard {
        IDXGIOutputDuplication* duplication;
        std::shared_ptr<State> state;
        Clock::time_point acquired_at;
        bool released = false;
        Clock::time_point copy_started{}, copy_finished{};
        HRESULT release() noexcept {
          if (released) return S_OK;
          released = true;
          const auto release_started = Clock::now();
          const auto result = duplication->ReleaseFrame();
          const auto released_at = Clock::now();
          const auto hold =
              std::chrono::duration_cast<std::chrono::microseconds>(released_at - acquired_at)
                  .count();
          // Publish both counters only after releasing the driver's frame.
          // A diagnostics reader must never delay the acquire/copy/release path.
          std::scoped_lock lock(state->mutex);
          ++state->diagnostics.acquired_frames;
          ++state->diagnostics.released_frames;
          if (static_cast<std::uint64_t>(hold) > state->diagnostics.maximum_duplication_hold_us) {
            const auto copy_begin =
                copy_started == Clock::time_point{} ? release_started : copy_started;
            const auto copy_end =
                copy_finished == Clock::time_point{} ? release_started : copy_finished;
            state->diagnostics.maximum_duplication_hold_us = static_cast<std::uint64_t>(hold);
            state->diagnostics.maximum_hold_before_copy_us =
                std::chrono::duration_cast<std::chrono::microseconds>(copy_begin - acquired_at)
                    .count();
            state->diagnostics.maximum_hold_copy_us =
                std::chrono::duration_cast<std::chrono::microseconds>(copy_end - copy_begin)
                    .count();
            state->diagnostics.maximum_hold_release_us =
                std::chrono::duration_cast<std::chrono::microseconds>(released_at - release_started)
                    .count();
          }
          return result;
        }
        ~FrameGuard() { (void)release(); }
      } held{duplication.Get(), state, acquired_at};
      if (state->stop) continue;
      ComPtr<ID3D11Texture2D> texture;
      check(desktop.As(&texture), "DXGI acquired texture");
      DXGI_OUTDUPL_POINTER_SHAPE_INFO shape{};
      UINT pointer_size = 0;
      const bool read_shape =
          frame.PointerShapeBufferSize || (!pointer_known && frame.PointerPosition.Visible);
      if (read_shape) {
        if (frame.PointerShapeBufferSize > pointer_bytes->size())
          throw detail::DxgiApiError("DXGI cursor buffer exceeds fixed capacity",
                                     DXGI_ERROR_UNSUPPORTED);
        check(duplication->GetFramePointerShape(static_cast<UINT>(pointer_bytes->size()),
                                                pointer_bytes->data(), &pointer_size, &shape),
              "DXGI pointer shape");
        if (pointer_size > pointer_bytes->size())
          throw detail::DxgiApiError("DXGI cursor size exceeds capacity", DXGI_ERROR_UNSUPPORTED);
      }
      held.copy_started = Clock::now();
      compositor->copyDesktop(*reserved, texture.Get(), context_lock);
      held.copy_finished = Clock::now();
      // Nothing below this point owns a duplication frame: CPU cursor decoding,
      // GPU composition and downstream conversion/publication use our slots.
      check(held.release(), "DXGI ReleaseFrame");
      context_lock.unlock();
      texture.Reset();
      desktop.Reset();
      if (read_shape) {
        compositor->pointerShape(std::span(pointer_bytes->data(), pointer_size), shape);
        pointer_known = true;
        std::scoped_lock lock(state->mutex);
        ++state->diagnostics.pointer_updates;
      }
      if (frame.LastMouseUpdateTime.QuadPart)
        compositor->pointerPosition(frame.PointerPosition.Position,
                                    frame.PointerPosition.Visible != FALSE);
      auto timestamp_ticks =
          (std::max)(frame.LastPresentTime.QuadPart, frame.LastMouseUpdateTime.QuadPart);
      if (timestamp_ticks <= 0) {
        LARGE_INTEGER now{};
        if (!QueryPerformanceCounter(&now)) throw std::runtime_error("QPC unavailable");
        timestamp_ticks = now.QuadPart;
      }
      const auto timestamp = timestamp_ticks / frequency.QuadPart * 10'000'000 +
                             timestamp_ticks % frequency.QuadPart * 10'000'000 / frequency.QuadPart;
      if (timestamp <= last_timestamp || state->stop) continue;
      auto resource = compositor->compose(*reserved);
      slot.transferred = true;
      check(device->removedReason(), "DXGI compositor device state");
      if (state->stop) continue;
      last_timestamp = timestamp;
      state->on_frame(BackendFrame{timestamp, compositor->width(), compositor->height(),
                                   FramePixelFormat::Bgra8, std::move(resource)});
      {
        std::scoped_lock lock(state->mutex);
        ++state->diagnostics.delivered_frames;
      }
    }
  } catch (const CaptureFailure& failure) {
    std::scoped_lock lock(state->mutex);
    state->failure = failure;
  } catch (const detail::DxgiApiError& error) {
    std::scoped_lock lock(state->mutex);
    state->failure = typedFailure(error.result, error.what());
  } catch (const std::exception& error) {
    std::scoped_lock lock(state->mutex);
    state->failure = CaptureFailure{"dxgi_capture_failed", error.what()};
  } catch (...) {
    std::scoped_lock lock(state->mutex);
    state->failure = CaptureFailure{"dxgi_capture_failed", "Unknown duplication failure"};
  }
  duplication.Reset();
  compositor.reset();
  MonitorCaptureBackend::TerminalCallback callback;
  std::optional<CaptureFailure> failure;
  {
    std::scoped_lock lock(state->mutex);
    if (!state->stop && state->failure) {
      callback = state->on_terminal;
      failure = state->failure;
    }
  }
  if (callback) {
    try {
      callback(*failure);
    } catch (...) {
    }
  }
  {
    std::scoped_lock lock(state->mutex);
    state->on_frame = {};
    state->on_terminal = {};
    state->done = true;
    state->changed.notify_all();
  }
}
class Backend final : public DxgiMonitorCaptureBackend {
 public:
  explicit Backend(bool debug) : debug_(debug), state_(std::make_shared<State>()) {}
  ~Backend() override {
    if (!stop(Clock::now() + std::chrono::seconds{5}).ok) std::terminate();
  }
  BackendStartResult start(const sources::MonitorTargetToken& target, FrameCallback on_frame,
                           TerminalCallback on_terminal) override {
    std::scoped_lock owner_lock(owner_mutex_);
    if (worker_.joinable() || state_->stop || !on_frame)
      return {false, CaptureFailure{"dxgi_invalid_state", "DXGI owner cannot start"}};
    state_->on_frame = std::move(on_frame);
    state_->on_terminal = std::move(on_terminal);
    try {
      worker_ =
          std::thread([state = state_, target, debug = debug_] { run(state, target, debug); });
    } catch (const std::exception& error) {
      state_->on_frame = {};
      state_->on_terminal = {};
      state_->done = true;
      return {false, CaptureFailure{"dxgi_thread_failed", error.what()}};
    }
    std::unique_lock lock(state_->mutex);
    if (!state_->changed.wait_for(lock, std::chrono::seconds{5},
                                  [&] { return state_->ready || state_->done; })) {
      state_->stop = true;
      return {false, CaptureFailure{"dxgi_prepare_timeout", "DXGI prepare exceeded deadline",
                                    CaptureFailureKind::stop_timeout}};
    }
    if (state_->failure) return {false, state_->failure};
    return {};
  }
  CaptureStopResult stop(Clock::time_point deadline) noexcept override {
    std::scoped_lock owner_lock(owner_mutex_);
    state_->stop = true;
    state_->changed.notify_all();
    if (!worker_.joinable()) return {};
    std::unique_lock lock(state_->mutex);
    if (!state_->changed.wait_until(lock, deadline, [&] { return state_->done; }))
      return {false, CaptureFailure{"dxgi_stop_timeout", "DXGI worker did not drain",
                                    CaptureFailureKind::stop_timeout}};
    lock.unlock();
    worker_.join();
    return {};
  }
  CaptureBackendProgress progress() const override {
    std::scoped_lock lock(state_->mutex);
    if (state_->failure && state_->failure->kind == CaptureFailureKind::secure_desktop)
      return {CaptureBackendProgressState::paused, state_->failure->kind};
    return {};
  }
  DxgiCaptureDiagnostics diagnostics() const override {
    std::scoped_lock lock(state_->mutex);
    auto result = state_->diagnostics;
    if (state_->counters) {
      result.active_leases = state_->counters->occupied;
      result.peak_leases = state_->counters->peak;
      result.allocated_textures = state_->counters->textures;
    }
    return result;
  }

 private:
  bool debug_;
  std::mutex owner_mutex_;
  std::shared_ptr<State> state_;
  std::thread worker_;
};
}  // namespace
std::unique_ptr<DxgiMonitorCaptureBackend> createDxgiMonitorCaptureBackend(bool request_debug) {
  return std::make_unique<Backend>(request_debug);
}
}  // namespace syrnike::windows_media::capture
