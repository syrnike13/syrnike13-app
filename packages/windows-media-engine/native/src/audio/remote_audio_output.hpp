#pragma once

#include "audio/remote_audio_mixer_worker.hpp"
#include "audio/wasapi_output.hpp"

namespace syrnike::windows_media::audio {
enum class RemoteOutputState { stopped, starting, running, recovering, failed };
enum class RemoteOutputFailure { none, invalid_state, unavailable, candidate_failed, mixer_failed, stop_timeout, cancelled };
struct RemoteOutputStats {
  RemoteOutputState state = RemoteOutputState::stopped;
  WasapiOutputStats active;
  WasapiOutputFailure candidate_failure = WasapiOutputFailure::none;
  std::uint64_t candidates = 0;
  std::uint64_t commits = 0;
  std::uint32_t recovery_attempts = 0;
  bool retired = false;
};

// Main audio control owner, sharing the engine's device registry. The separate
// SDK reader and mixer workers keep running while a candidate opens. This owner
// never controls Room membership, microphone capture, or any publication.
class RemoteAudioOutput final {
 public:
  explicit RemoteAudioOutput(RemoteAudioMixerWorker&);
  ~RemoteAudioOutput();
  RemoteAudioOutput(const RemoteAudioOutput&) = delete;
  RemoteAudioOutput& operator=(const RemoteAudioOutput&) = delete;
  RemoteOutputFailure selectOutput(AudioDeviceRegistry&, AudioDeviceIntent, std::stop_token cancellation = {});
  // Caller refreshes the shared registry first. A new device revision or
  // explicit selection restarts the finite three-attempt local recovery budget.
  // A successful replacement does not reset it: repeated active-device loss
  // must reach manual retry instead of creating an unlimited recovery loop.
  RemoteOutputFailure reconcile(AudioDeviceRegistry&, std::uint64_t registry_revision, std::stop_token cancellation = {});
  bool setDeafened(bool);
  bool stop(std::chrono::steady_clock::time_point deadline) noexcept;
  RemoteOutputStats stats();
  std::shared_ptr<RenderedEchoReference> echoReference() const;
 private:
  RemoteOutputFailure selectEndpoint(const AudioEndpoint&, std::stop_token);
  bool onOwner() const noexcept;
  const std::thread::id owner_ = std::this_thread::get_id();
  RemoteAudioMixerWorker& mixer_;
  std::unique_ptr<WasapiOutput> active_, candidate_;
  std::optional<AudioEndpoint> selected_;
  AudioDeviceIntent intent_{AudioDirection::output, {}};
  RemoteOutputStats stats_;
  std::uint64_t epoch_ = 0, registry_revision_ = 0;
  std::chrono::steady_clock::time_point retry_after_{};
  bool deafened_ = false;
};
}  // namespace syrnike::windows_media::audio
