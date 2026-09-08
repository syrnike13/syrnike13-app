#pragma once

#include "audio/remote_audio_pcm.hpp"

#include <chrono>
#include <memory>
#include <thread>

namespace syrnike::windows_media::audio {
struct RemoteAudioInput {
  std::shared_ptr<RemoteAudioPcmPort> port;
  float volume = 1;
  bool muted = false;
};

// Independent 10 ms frame owner. The subscription owner configures inputs;
// the output owner binds a renderer port. Each has a separate bounded command
// slot and acknowledgement. Commands retain old/new ports until acknowledged,
// or until shutdown after timeout; no PCM reference can dangle across a switch.
class RemoteAudioMixerWorker final {
 public:
  RemoteAudioMixerWorker();
  ~RemoteAudioMixerWorker();
  RemoteAudioMixerWorker(const RemoteAudioMixerWorker&) = delete;
  RemoteAudioMixerWorker& operator=(const RemoteAudioMixerWorker&) = delete;
  bool configure(std::span<const RemoteAudioInput>, bool deafened);
  bool bindOutput(std::shared_ptr<RemoteAudioPcmPort>, std::int64_t minimum_timestamp_100ns);
  bool stop(std::chrono::steady_clock::time_point deadline) noexcept;
  bool retired() const noexcept;
  RemoteAudioMixStats stats() const noexcept;
 private:
  struct State;
  static void run(const std::shared_ptr<State>&) noexcept;
  std::shared_ptr<State> state_;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::audio
