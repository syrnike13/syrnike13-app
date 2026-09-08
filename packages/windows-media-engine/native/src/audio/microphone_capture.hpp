#pragma once

#include "audio/audio_device_registry.hpp"
#include "audio/microphone_pcm.hpp"
#include <chrono>

namespace syrnike::windows_media::audio {
enum class MicrophoneCaptureState { idle, starting, healthy, stopped, failed };
enum class MicrophoneCaptureFailure {
  none, invalid_state, cancelled, activation_failed, format_unavailable, policy_unavailable,
  device_lost, capture_failed, no_progress, start_timeout, stop_timeout
};
struct MicrophoneCaptureStats {
  MicrophoneCaptureState state = MicrophoneCaptureState::idle;
  MicrophoneCaptureFailure failure = MicrophoneCaptureFailure::none;
  std::int32_t platform_result = 0;
  std::uint64_t generation = 0;
  std::uint64_t frames = 0;
  std::uint64_t discontinuities = 0;
  std::uint64_t invalid_timestamps = 0;
  std::uint64_t invalid_buffers = 0;
  std::uint64_t platform_discontinuities = 0;
  std::uint64_t first_position_step = 0;
  std::uint32_t first_packet_frames = 0;
  std::uint64_t callback_count = 0;
  std::uint64_t callback_total_us = 0;
  std::uint64_t callback_max_us = 0;
  std::array<std::uint64_t, 8> callback_histogram{};
  bool client_alive = false;
  bool thread_alive = false;
  bool mmcss_registered = false;
};
// One-shot capture owner, driven by the ordered microphone control owner.
// All Windows resources live and die on one joined worker. start() succeeds
// only after three healthy 10 ms frames, making this usable as a candidate.
// Failure/stop has no Room, publication, DSP, meter or UI operation.
class MicrophoneCapture final {
 public:
  MicrophoneCapture();
  ~MicrophoneCapture();
  MicrophoneCapture(const MicrophoneCapture&) = delete;
  MicrophoneCapture& operator=(const MicrophoneCapture&) = delete;
  MicrophoneCaptureFailure start(AudioEndpoint, std::uint64_t generation, bool bypass_system_processing = true);
  bool stop(std::chrono::steady_clock::time_point deadline) noexcept;
  MicrophoneCaptureStats stats() const noexcept;
  // Exactly one downstream DSP consumer uses this port.
  std::shared_ptr<MicrophonePcmPort> pcm() const noexcept;
  // Borrowed auto-reset Windows event for the one DSP consumer. Signals a new
  // frame or terminal state. The control owner must retain this capture until
  // the consumer acknowledges switching away; the consumer must not close it.
  void* frameEvent() const noexcept;
 private:
  struct State;
  static void run(const std::shared_ptr<State>&, AudioEndpoint, bool bypass_system_processing) noexcept;
  std::shared_ptr<State> state_;
  const std::thread::id owner_ = std::this_thread::get_id();
  std::thread worker_;
};
}  // namespace syrnike::windows_media::audio
