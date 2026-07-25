#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "wasapi_event.hpp"

namespace syrnike::voice {

struct MicrophoneEchoReferenceStatus {
  bool available = false;
  std::string reason;
  int render_latency_ms = 0;
  std::uint64_t discontinuities = 0;
  std::uint64_t device_position = 0;
  std::uint64_t qpc_position_100ns = 0;
  bool timing_valid = false;
};

struct MicrophoneEchoReferenceFrame {
  std::vector<std::int16_t> pcm;
  bool discontinuity = false;
};

class MicrophoneEchoReferenceBuffer {
public:
  explicit MicrophoneEchoReferenceBuffer(std::size_t max_frames);

  void pushInterleavedFloatStereo(const float* samples, std::size_t frames, bool silent);
  void markDiscontinuity();
  std::optional<MicrophoneEchoReferenceFrame> popFrame();
  std::size_t queuedFrames() const;
  std::uint64_t discontinuities() const;

private:
  std::size_t max_frames_;
  std::vector<float> pending_mono_;
  std::vector<MicrophoneEchoReferenceFrame> frames_;
  bool discontinuity_pending_ = false;
  std::uint64_t discontinuities_ = 0;
  mutable std::mutex mutex_;
};

class MicrophoneEchoReference {
public:
  using CaptureAttempt = std::function<void(std::size_t)>;

  explicit MicrophoneEchoReference(CaptureAttempt capture_attempt = {});
  ~MicrophoneEchoReference();

  void start(std::string render_device_id = "default");
  void stop();
  std::optional<MicrophoneEchoReferenceFrame> popFrame();
  std::size_t queuedFrames() const;
  MicrophoneEchoReferenceStatus status() const;
  bool waitForAvailable(std::chrono::milliseconds timeout) const;

private:
  void captureLoop(
    std::string render_device_id,
    std::shared_ptr<syrnike::desktop_native::media::WasapiEventPair> events
  );
  void setStatus(bool available, std::string reason, int render_latency_ms = 0);
  void updateTiming(std::uint64_t device_position, std::uint64_t qpc_position);

  mutable std::mutex lifecycle_mutex_;
  std::atomic_bool running_{false};
  std::thread thread_;
  std::shared_ptr<syrnike::desktop_native::media::WasapiEventPair> events_;
  MicrophoneEchoReferenceBuffer buffer_;
  mutable std::mutex status_mutex_;
  mutable std::condition_variable status_changed_;
  MicrophoneEchoReferenceStatus status_;
  CaptureAttempt capture_attempt_;
};

}  // namespace syrnike::voice
