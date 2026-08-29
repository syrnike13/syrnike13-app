#pragma once

#include <atomic>
#include <array>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <memory>
#include <string>
#include <thread>

#include "wasapi_event.hpp"
#include "audio_constants.hpp"

namespace syrnike::voice {

struct MicrophoneEchoReferenceStatus {
  bool available = false;
  std::string reason;
  int render_latency_ms = 0;
  std::uint64_t discontinuities = 0;
  std::uint64_t dropped_frames = 0;
  std::uint64_t device_position = 0;
  std::uint64_t qpc_position_100ns = 0;
  bool timing_valid = false;
};

struct MicrophoneEchoReferenceFrame {
  std::array<std::int16_t, kSamplesPer10Ms> pcm{};
  bool discontinuity = false;
  std::uint64_t sequence = 0;
  std::uint64_t timestamp_us = 0;
};

class MicrophoneEchoReferenceBuffer {
public:
  explicit MicrophoneEchoReferenceBuffer(std::size_t max_frames);

  void pushInterleavedFloatStereo(const float* samples, std::size_t frames, bool silent);
  void markDiscontinuity();
  std::optional<MicrophoneEchoReferenceFrame> popFrame();
  std::size_t queuedFrames() const;
  std::uint64_t discontinuities() const;
  std::uint64_t droppedFrames() const;

private:
  static constexpr std::size_t kSlotCapacity = 50;
  enum class SlotState : std::uint8_t { Empty, Writing, Ready, Reading };
  struct Slot {
    std::atomic<SlotState> state{SlotState::Empty};
    std::atomic_uint64_t sequence{0};
    MicrophoneEchoReferenceFrame frame;
    std::uint64_t generation = 0;
  };

  std::size_t max_frames_;
  std::array<float, kSamplesPer10Ms> pending_mono_{};
  std::size_t pending_samples_ = 0;
  std::array<Slot, kSlotCapacity> slots_{};
  bool discontinuity_pending_ = false;
  std::atomic_bool consumer_discontinuity_pending_{false};
  std::atomic_size_t queued_frames_{0};
  std::atomic_uint64_t generation_{1};
  std::atomic_uint64_t discontinuities_{0};
  std::atomic_uint64_t dropped_frames_{0};
  std::uint64_t next_sequence_ = 0;
  std::uint64_t last_timestamp_us_ = 0;
};

struct MicrophoneEchoReferenceRealtimeFrame {
  std::optional<MicrophoneEchoReferenceFrame> frame;
  std::size_t queued_frames = 0;
  bool available = false;
  int render_latency_ms = 0;
  std::uint64_t device_position = 0;
  std::uint64_t qpc_position_100ns = 0;
  bool timing_valid = false;
};

class MicrophoneEchoReference {
public:
  using CaptureAttempt = std::function<void(std::size_t)>;

  explicit MicrophoneEchoReference(CaptureAttempt capture_attempt = {});
  ~MicrophoneEchoReference();

  void start(std::string render_device_id = "default");
  void stop();
  std::optional<MicrophoneEchoReferenceFrame> popFrame();
  MicrophoneEchoReferenceRealtimeFrame pollRealtimeFrame();
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
  std::atomic_bool realtime_available_{false};
  std::atomic_int realtime_render_latency_ms_{0};
  std::atomic_uint64_t realtime_device_position_{0};
  std::atomic_uint64_t realtime_qpc_position_100ns_{0};
  std::atomic_bool realtime_timing_valid_{false};
  CaptureAttempt capture_attempt_;
};

}  // namespace syrnike::voice
