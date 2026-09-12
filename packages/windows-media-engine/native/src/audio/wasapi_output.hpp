#pragma once

#include "audio/audio_device_registry.hpp"
#include "audio/remote_render_plan.hpp"
#include "audio/rendered_echo_reference.hpp"

#include <chrono>
#include <memory>
#include <stop_token>
#include <thread>

namespace syrnike::windows_media::audio {
enum class WasapiOutputState { stopped, starting, running, failed };
enum class WasapiOutputFailure {
  none, invalid_state, activation_failed, format_unavailable, policy_unavailable,
  device_lost, render_failed, no_progress, start_timeout, stop_timeout, cancelled
};
struct WasapiOutputStats {
  WasapiOutputState state = WasapiOutputState::stopped;
  WasapiOutputFailure failure = WasapiOutputFailure::none;
  std::int32_t platform_error = 0;
  std::uint64_t epoch = 0;
  std::uint64_t submitted_frames = 0;
  std::uint64_t consumed_frames = 0;
  std::uint64_t echo_frames = 0;
  std::uint64_t stale_fragments = 0;
  std::uint64_t underruns = 0;
  std::uint64_t delayed_wakes = 0;
  std::int64_t maximum_wake_gap_100ns = 0;
  std::int64_t maximum_scheduled_age_100ns = 0;
  std::uint32_t padding_frames = 0;
  std::uint32_t buffer_frames = 0;
  bool committed = false;
  bool client_alive = false;
  bool thread_alive = false;
  // Sample-weighted scheduled age, buckets <=10/20/30/40/50/60 ms and overflow.
  std::array<std::uint64_t, 7> scheduled_age_histogram{};
};

// One endpoint and worker, independent of Room/microphone/mixer ownership.
// start() primes silence and waits for three observed consumption advances.
// The output transaction keeps the old instance alive until this candidate is
// healthy and the mixer has committed this instance's fresh generation port.
class WasapiOutput final {
 public:
  WasapiOutput();
  ~WasapiOutput();
  WasapiOutput(const WasapiOutput&) = delete;
  WasapiOutput& operator=(const WasapiOutput&) = delete;
  WasapiOutputFailure start(AudioEndpoint, std::uint64_t epoch, std::stop_token cancellation = {});
  bool commit(std::int64_t minimum_decoded_timestamp_100ns) noexcept;
  bool setDeafened(bool) noexcept;
  bool stop(std::chrono::steady_clock::time_point deadline) noexcept;
  WasapiOutputStats stats() const noexcept;
  std::shared_ptr<RemoteAudioPcmPort> input() const noexcept;
  std::shared_ptr<RenderedEchoReference> echoReference() const noexcept;
 private:
  struct State;
  static void run(const std::shared_ptr<State>&, AudioEndpoint) noexcept;
  const std::thread::id owner_ = std::this_thread::get_id();
  std::shared_ptr<State> state_;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::audio
