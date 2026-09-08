#pragma once

#include <memory>

#include "capture/monitor_capture.hpp"

namespace syrnike::windows_media::capture {

#ifdef _DEBUG
inline constexpr bool kDefaultD3dDebugLayer = true;
#else
inline constexpr bool kDefaultD3dDebugLayer = false;
#endif

struct WgcMonitorCaptureOptions {
  bool request_d3d_debug_layer = kDefaultD3dDebugLayer;
  // Optional one-shot admission bounds; normal capture keeps existing defaults.
  std::uint32_t maximum_width = 0, maximum_height = 0;
  std::uint32_t frame_pool_size = kMaximumMonitorFrames + 1;
};

struct WgcMonitorCaptureDiagnostics {
  bool d3d_debug_requested = false;
  bool d3d_debug_enabled = false;
  bool live_objects_reported = false;
  long live_objects_hresult = 0;
  std::size_t live_engine_objects = 0;
  std::size_t peak_engine_objects = 0;
};

class WgcMonitorCaptureBackend : public MonitorCaptureBackend {
 public:
  virtual WgcMonitorCaptureDiagnostics diagnostics() const = 0;
};

std::unique_ptr<WgcMonitorCaptureBackend> createWgcMonitorCaptureBackend(
    WgcMonitorCaptureOptions options = {});

}  // namespace syrnike::windows_media::capture
