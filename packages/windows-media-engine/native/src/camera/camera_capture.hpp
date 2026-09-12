#pragma once

#include "camera/camera_device_registry.hpp"
#include "camera/camera_frame.hpp"

#include <chrono>
#include <functional>
#include <memory>
#include <stop_token>
#include <thread>

namespace syrnike::windows_media::camera {
enum class CameraFailure {
  none, invalid_state, unavailable, unsupported_profile, unsupported_format,
  malformed_sample, device_removed, source_error, format_changed, no_frames,
  start_timeout, flush_timeout, stop_timeout, cancelled
};
enum class CameraCaptureState { stopped, starting, running, failed };
struct CameraOpenResult {
  CameraFailure failure = CameraFailure::none;
  CameraProfile actual;
  bool downgraded = false;
  std::int64_t platform_error = 0;
};
class CameraSample {
 public:
  virtual ~CameraSample() = default;
  virtual bool copyBgra(std::span<std::uint8_t>) = 0;
};
struct CameraReadEvent {
  CameraFailure failure = CameraFailure::none;
  std::int64_t platform_error = 0;
  std::int64_t received_100ns = 0;
  std::unique_ptr<CameraSample> sample;
};

// All methods run on the capture worker. The implementation's callback only
// retains a bounded sample lease and signals its event; it never calls a media
// consumer. Exactly one asynchronous read can be pending. close proves callback
// retirement before reporting success and includes a finite flush deadline.
class CameraReader {
 public:
  virtual ~CameraReader() = default;
  virtual CameraOpenResult open(const CameraEndpoint&, CameraProfile requested, bool allow_downgrade) = 0;
  virtual void* eventHandle() const noexcept = 0;
  virtual CameraFailure requestSample() = 0;
  virtual std::optional<CameraReadEvent> takeCompleted() = 0;
  virtual bool close(std::chrono::steady_clock::time_point deadline) noexcept = 0;
};
std::unique_ptr<CameraReader> makeMediaFoundationCameraReader();
using CameraReaderFactory = std::function<std::unique_ptr<CameraReader>()>;

struct CameraCaptureStats {
  CameraCaptureState state = CameraCaptureState::stopped;
  CameraFailure failure = CameraFailure::none;
  CameraProfile actual;
  bool downgraded = false, thread_alive = false, reader_alive = false;
  std::uint64_t generation = 0, frames = 0, stale = 0;
  std::uint64_t maximum_copy_us = 0;
  std::int64_t platform_error = 0;
  CameraFramePortStats output;
};

// One source/reader owner. start requires three fresh converted frames. A
// timed-out driver stays contained by the utility process; never detach cleanup.
class CameraCapture final {
 public:
  CameraCapture(CameraEndpoint, CameraProfile, std::uint64_t generation, bool allow_downgrade,
                CameraReaderFactory = makeMediaFoundationCameraReader);
  ~CameraCapture();
  CameraFailure start(std::stop_token cancellation = {});
  bool stop(std::chrono::steady_clock::time_point deadline) noexcept;
  CameraCaptureStats stats() const noexcept;
  std::shared_ptr<CameraFramePort> output() const noexcept;
 private:
  struct State;
  static void run(const std::shared_ptr<State>&) noexcept;
  const std::thread::id owner_ = std::this_thread::get_id();
  std::shared_ptr<State> state_;
  std::thread worker_;
  bool started_ = false;
};
}  // namespace syrnike::windows_media::camera
