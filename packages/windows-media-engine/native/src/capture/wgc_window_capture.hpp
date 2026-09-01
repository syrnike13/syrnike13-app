#pragma once

#include <functional>
#include <memory>

#include "capture/wgc_monitor_capture.hpp"
#include "capture/window_capture.hpp"

namespace syrnike::windows_media::capture {

struct WgcWindowCaptureDiagnostics : WgcMonitorCaptureDiagnostics {
  bool cleanup_completed = false;
};

struct WgcWindowCaptureTestHooks {
  std::function<void()> before_frame_callback;
  std::function<void()> before_frame_pool_recreate;
};

struct WgcWindowCaptureOptions {
  bool request_d3d_debug_layer = kDefaultD3dDebugLayer;
  std::shared_ptr<WgcWindowCaptureTestHooks> test_hooks;
};

class WgcWindowCaptureBackend : public WindowCaptureBackend {
 public:
  virtual WgcWindowCaptureDiagnostics diagnostics() const = 0;
};

std::unique_ptr<WgcWindowCaptureBackend> createWgcWindowCaptureBackend(
    WgcWindowCaptureOptions options = {});

}  // namespace syrnike::windows_media::capture
