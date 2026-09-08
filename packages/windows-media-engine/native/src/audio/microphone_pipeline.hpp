#pragma once

#include "audio/microphone_capture.hpp"
#include "audio/microphone_dsp.hpp"

namespace syrnike::windows_media::audio {
struct MicrophoneDemand {
  bool warm = false;
  bool publication = false;
  bool meter = false;
  bool needed() const noexcept { return warm || publication || meter; }
};
enum class MicrophonePipelineFailure {
  none, invalid_state, input_unavailable, capture_failed, command_timeout, stop_timeout
};
struct MicrophonePipelineStats {
  MicrophoneDemand demand;
  MicrophoneCaptureStats capture;
  MicrophoneDspStats meter;
  MicrophoneCaptureFailure candidate_failure = MicrophoneCaptureFailure::none;
  std::uint64_t capture_opens = 0;
  std::uint64_t committed_switches = 0;
  std::uint64_t output_frames = 0;
  std::uint64_t stale_frames = 0;
  bool retired = false;
};

// Serialized control-thread owner. Device start/stop never runs on the DSP
// worker. A single immutable command slot is acknowledged before reuse; timed
// out commands retire this pipeline and retain both captures until joined.
class MicrophonePipeline final {
 public:
  using EnhancementFactory = std::unique_ptr<MicrophoneEnhancement> (*)();
  explicit MicrophonePipeline(EnhancementFactory);
  ~MicrophonePipeline();
  MicrophonePipeline(const MicrophonePipeline&) = delete;
  MicrophonePipeline& operator=(const MicrophonePipeline&) = delete;
  // Registry is the shared engine registry. Refresh notifications on its
  // control cadence, then call reconcileInput; follow-default and explicit
  // selections use exactly the same healthy-candidate transaction.
  MicrophonePipelineFailure selectInput(AudioDeviceRegistry&, AudioDeviceIntent);
  MicrophonePipelineFailure reconcileInput(AudioDeviceRegistry&);
  MicrophonePipelineFailure setDemand(MicrophoneDemand);
  MicrophonePipelineFailure configure(const MicrophoneDspConfig&);
  // Commit between DSP frames. This retains the projection, never its renderer.
  // A null/retired port makes AEC unavailable without changing capture/sender.
  MicrophonePipelineFailure setEchoReference(std::shared_ptr<EchoReferencePort>);
  MicrophonePipelineStats stats();
  bool stop(std::chrono::steady_clock::time_point) noexcept;
  // One independent publication consumer; it never owns the capture device.
  // Retain this pipeline until that consumer has stopped using both handles.
  std::shared_ptr<MicrophonePcmPort> output() const noexcept;
  void* outputEvent() const noexcept;
 private:
  struct State;
  static void run(const std::shared_ptr<State>&, EnhancementFactory) noexcept;
  MicrophonePipelineFailure selectInput(AudioEndpoint);
  MicrophonePipelineFailure switchCapture(const AudioEndpoint&);
  bool commitInput(MicrophoneCapture*) noexcept;
  bool submit() noexcept;
  bool onOwner() const noexcept;
  const std::thread::id owner_ = std::this_thread::get_id();
  std::shared_ptr<State> state_;
  std::thread worker_;
  std::optional<AudioEndpoint> selected_;
  AudioDeviceIntent input_intent_;
  std::unique_ptr<MicrophoneCapture> active_;
  std::unique_ptr<MicrophoneCapture> candidate_;
  std::shared_ptr<EchoReferencePort> echo_reference_;
  std::shared_ptr<EchoReferencePort> pending_echo_reference_;
  MicrophonePipelineStats stats_;
  std::uint64_t generation_ = 0;
  std::uint64_t command_revision_ = 0;
};
}  // namespace syrnike::windows_media::audio
