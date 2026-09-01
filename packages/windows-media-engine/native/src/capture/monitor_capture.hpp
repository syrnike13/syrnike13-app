#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>

#include "sources/source_registry.hpp"

namespace syrnike::windows_media::capture {

inline constexpr std::size_t kMaximumMonitorFrames = 3;

enum class CaptureState { Idle, Starting, Running, Stopped, Failed };
enum class FramePixelFormat { Bgra8 };
enum class LeaseReleaseStatus { Released, AlreadyReleased };

struct CaptureFailure {
  std::string code;
  std::string message;
};

struct FrameMetadata {
  std::uint64_t sequence = 0;
  std::int64_t capture_timestamp_100ns = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  FramePixelFormat format = FramePixelFormat::Bgra8;
  std::uint64_t generation = 1;
};

class FrameResource {
 public:
  virtual ~FrameResource() = default;
  virtual std::uint64_t sampledHash() = 0;
};

struct BackendFrame {
  std::int64_t capture_timestamp_100ns = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  FramePixelFormat format = FramePixelFormat::Bgra8;
  std::shared_ptr<FrameResource> resource;
  std::uint64_t generation = 1;
};

class FrameLease final {
 public:
  FrameLease() = default;
  ~FrameLease();
  FrameLease(FrameLease&& other) noexcept;
  FrameLease& operator=(FrameLease&& other) noexcept;
  FrameLease(const FrameLease&) = delete;
  FrameLease& operator=(const FrameLease&) = delete;

  explicit operator bool() const noexcept;
  const FrameMetadata& metadata() const;
  std::uint64_t sampledHash() const;
  LeaseReleaseStatus release() noexcept;

 private:
  struct State;
  explicit FrameLease(std::shared_ptr<State> state);
  static FrameLease create(FrameMetadata metadata,
                           std::shared_ptr<FrameResource> resource,
                           std::function<void()> on_release);
  std::shared_ptr<State> state_;
  friend class MonitorCapture;
  friend class WindowCapture;
};

struct CaptureStats {
  std::uint64_t received_frames = 0;
  std::uint64_t dropped_frames = 0;
  std::size_t maximum_queue_depth = 0;
  std::size_t outstanding_leases = 0;
  bool timestamps_monotonic = true;
};

struct CaptureStartResult {
  bool ok = true;
  std::optional<CaptureFailure> failure;
};

struct CaptureStopResult {
  bool ok = true;
  std::optional<CaptureFailure> failure;
};

struct BackendStartResult {
  bool ok = true;
  std::optional<CaptureFailure> failure;
};

class MonitorCaptureBackend {
 public:
  using FrameCallback = std::function<void(BackendFrame)>;
  using TerminalCallback = std::function<void(CaptureFailure)>;

  virtual ~MonitorCaptureBackend() = default;
  virtual BackendStartResult start(
      const sources::MonitorTargetToken& target,
      FrameCallback on_frame,
      TerminalCallback on_terminal) = 0;
  virtual CaptureStopResult stop(
      std::chrono::steady_clock::time_point deadline) noexcept = 0;
  virtual void finalizeStop() noexcept {}
};

class MonitorCapture final {
 public:
  MonitorCapture(sources::SourceRegistry& registry, std::string source_id,
                 std::unique_ptr<MonitorCaptureBackend> backend);
  ~MonitorCapture();
  MonitorCapture(const MonitorCapture&) = delete;
  MonitorCapture& operator=(const MonitorCapture&) = delete;

  CaptureStartResult start();
  std::optional<FrameLease> waitForFrame(std::chrono::milliseconds timeout);
  CaptureStopResult stop(std::chrono::milliseconds lease_deadline);
  CaptureState state() const;
  CaptureStats stats() const;
  std::optional<CaptureFailure> terminalFailure() const;

 private:
  struct SharedState;
  sources::SourceRegistry& registry_;
  std::string source_id_;
  std::unique_ptr<MonitorCaptureBackend> backend_;
  std::shared_ptr<SharedState> shared_;
};

const char* toString(CaptureState value) noexcept;
const char* toString(FramePixelFormat value) noexcept;

}  // namespace syrnike::windows_media::capture
