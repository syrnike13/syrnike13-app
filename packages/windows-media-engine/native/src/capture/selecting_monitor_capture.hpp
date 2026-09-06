#pragma once
#include "capture/backend_selection_policy.hpp"
#include "capture/dxgi_monitor_capture.hpp"

namespace syrnike::windows_media::capture {
struct CaptureEnvironment {
  bool desktop_available = true;
  std::uint64_t display_revision = 0;
  std::optional<std::uint64_t> hdr_revision;
  bool source_available = true;
};
struct SelectingMonitorOptions {
  std::optional<CaptureBackendKind> forced;
  // Resolve again on each prepare: display topology changes can replace HMONITOR.
  std::function<std::optional<sources::MonitorTargetToken>()> resolve_target;
  std::function<std::unique_ptr<MonitorCaptureBackend>(CaptureBackendKind)> create_backend;
  std::function<CaptureEnvironment()> environment;
};
struct BackendSelectionDiagnostics {
  BackendSelectionState policy;
  std::uint64_t attempts = 0, delivered_frames = 0, pauses = 0;
  std::size_t live_generations = 0, maximum_live_generations = 0;
  std::size_t retained_frames = 0;
  DxgiCaptureDiagnostics dxgi;
  std::optional<CaptureFailure> last_failure;
};
class SelectingMonitorCaptureBackend : public MonitorCaptureBackend {
 public:
  virtual void select(std::optional<CaptureBackendKind>) = 0;
  virtual BackendSelectionDiagnostics diagnostics() const = 0;
};
std::unique_ptr<SelectingMonitorCaptureBackend> createSelectingMonitorCaptureBackend(
    SelectingMonitorOptions options = {});
}  // namespace syrnike::windows_media::capture
