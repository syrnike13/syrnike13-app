#pragma once

#include <chrono>
#include <functional>
#include <memory>

#include "capture/wgc_monitor_capture.hpp"
#include "capture/window_capture.hpp"

namespace syrnike::windows_media::capture {

struct WgcWindowCaptureDiagnostics : WgcMonitorCaptureDiagnostics {
  bool cleanup_completed = false;
  std::uint64_t stale_repaints = 0;
  std::uint64_t stale_session_resets = 0;
};

// A shown window without frames is asked to repaint, then its session is
// recreated. The window is never captured as a frozen last frame.
inline constexpr auto kWindowStaleRepaintAfter = std::chrono::seconds{2};
inline constexpr auto kWindowStaleResetAfterRepaint = std::chrono::seconds{1};
inline constexpr auto kWindowStaleResetInterval = std::chrono::seconds{10};

struct WgcWindowCaptureTestHooks {
  std::function<void()> before_frame_visibility_check;
  std::function<void()> before_frame_callback;
  std::function<void()> before_frame_pool_recreate;
};

struct WgcWindowCaptureOptions {
  bool request_d3d_debug_layer = kDefaultD3dDebugLayer;
  std::shared_ptr<WgcWindowCaptureTestHooks> test_hooks;
  bool include_cursor = true;
  std::uint32_t maximum_width = 0, maximum_height = 0;
  std::uint32_t frame_pool_size = kMaximumWindowFrames + 1;
  std::chrono::microseconds min_update_interval{0};
};

class WgcWindowCaptureBackend : public WindowCaptureBackend {
 public:
  virtual WgcWindowCaptureDiagnostics diagnostics() const = 0;
};

std::unique_ptr<WgcWindowCaptureBackend> createWgcWindowCaptureBackend(
    WgcWindowCaptureOptions options = {});

}  // namespace syrnike::windows_media::capture
