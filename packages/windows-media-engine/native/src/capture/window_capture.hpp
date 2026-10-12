#pragma once

#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

#include "capture/monitor_capture.hpp"
#include "sources/source_registry.hpp"

namespace syrnike::windows_media::capture {

inline constexpr std::size_t kMaximumWindowFrames = kMaximumMonitorFrames;
inline constexpr std::size_t kMaximumWindowEvents = 64;

enum class WindowCaptureEventKind {
  Running,
  Resized,
  TemporarilyNoContent,
  ContentRestored,
  SourceClosed,
  CaptureFailed,
};

struct WindowCaptureEvent {
  WindowCaptureEventKind kind = WindowCaptureEventKind::Running;
  std::uint64_t generation = 1;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::int64_t timestamp_100ns = 0;
  std::optional<CaptureFailure> failure;
};

enum class WindowBackendEventKind {
  Started,
  ResizePending,
  ResizeCancelled,
  Resized,
  TemporarilyNoContent,
  ContentRestored,
};

struct WindowBackendEvent {
  WindowBackendEventKind kind = WindowBackendEventKind::Started;
  std::uint64_t generation = 1;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::int64_t timestamp_100ns = 0;
};

struct WindowCaptureStats {
  CaptureStats frames;
  std::uint64_t generation = 1;
  std::uint64_t resize_count = 0;
  std::uint64_t no_content_intervals = 0;
  std::uint64_t dropped_events = 0;
};

class WindowCaptureBackend {
 public:
  using FrameCallback = std::function<void(BackendFrame)>;
  using EventCallback = std::function<void(WindowBackendEvent)>;
  using TerminalCallback = std::function<void(CaptureFailure)>;

  virtual ~WindowCaptureBackend() = default;
  virtual BackendStartResult start(
      const sources::WindowTargetToken& target,
      FrameCallback on_frame,
      EventCallback on_event,
      TerminalCallback on_terminal) = 0;
  virtual CaptureStopResult stop(
      std::chrono::steady_clock::time_point deadline) noexcept = 0;
  virtual void finalizeStop() noexcept {}
};

class WindowCapture final {
 public:
  WindowCapture(sources::SourceRegistry& registry, std::string source_id,
                std::unique_ptr<WindowCaptureBackend> backend);
  ~WindowCapture();
  WindowCapture(const WindowCapture&) = delete;
  WindowCapture& operator=(const WindowCapture&) = delete;

  CaptureStartResult start();
  std::optional<FrameLease> waitForFrame(std::chrono::milliseconds timeout);
  std::optional<WindowCaptureEvent> waitForEvent(
      std::chrono::milliseconds timeout);
  CaptureStopResult stop(std::chrono::milliseconds lease_deadline);
  CaptureState state() const;
  WindowCaptureStats stats() const;
  std::optional<CaptureFailure> terminalFailure() const;

 private:
  struct SharedState;
  sources::SourceRegistry& registry_;
  std::string source_id_;
  std::unique_ptr<WindowCaptureBackend> backend_;
  std::shared_ptr<SharedState> shared_;
  std::timed_mutex stop_mutex_;
};

const char* toString(WindowCaptureEventKind value) noexcept;

}  // namespace syrnike::windows_media::capture
