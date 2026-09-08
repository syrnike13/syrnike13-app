#pragma once

#include "audio/microphone_pcm.hpp"
#include <memory>

namespace syrnike::windows_media::audio {
enum class EchoAvailability { disabled, unavailable, active, unsupported, failed };
struct EchoReferenceFrame {
  std::array<std::int16_t, kMicrophoneFrameSamples> samples{};
  std::uint64_t renderer_epoch = 0;
  std::uint64_t sequence = 0;
  std::int64_t rendered_timestamp_100ns = 0;
  std::uint32_t stream_delay_ms = 0;
};
class EchoReferencePort {
 public:
  virtual ~EchoReferencePort() = default;
  // Single DSP consumer, nonblocking. No reference is repeated after take.
  virtual std::optional<EchoReferenceFrame> take() noexcept = 0;
};
class MicrophoneEnhancement {
 public:
  virtual ~MicrophoneEnhancement() = default;
  // Fixed 48 kHz mono/10 ms input; one DSP owner. AEC and NS are independent.
  virtual EchoAvailability process(std::array<std::int16_t, kMicrophoneFrameSamples>&,
                                  const EchoReferenceFrame*, bool noise_suppression,
                                  bool echo_cancellation) noexcept = 0;
  // Called on the DSP owner before a new renderer epoch can be processed.
  virtual bool resetEcho() noexcept = 0;
};
struct MicrophoneDspConfig {
  float input_volume = 1.0f; // 0..4, linear; matches Voice Director controls
  float gate_threshold_db = -50.0f; // -100..0 dBFS
  bool automatic_threshold = false;
  bool noise_suppression = true;
  bool echo_cancellation = true;
  bool automatic_gain = true;
  bool gate_enabled = true;
  bool muted = false;
  bool push_to_talk = false;
  bool push_to_talk_pressed = false;
};
struct MicrophoneDspStats {
  std::uint64_t frames = 0;
  std::uint64_t config_revision = 0;
  std::uint64_t echo_epoch = 0;
  std::uint64_t rejected_references = 0;
  float input_level = 0;
  float output_level = 0;
  float gate_threshold = 0;
  float automatic_gain = 1;
  bool gate_open = false;
  bool speaking = false;
  EchoAvailability echo = EchoAvailability::unavailable;
};

// Pure frame owner: no device, Room, queue, clock wait, callback registration or
// telemetry allocation. The warm worker commits immutable config values before
// calling process(), then projects this stats value at at most 10 Hz.
class MicrophoneDsp final {
 public:
  explicit MicrophoneDsp(std::unique_ptr<MicrophoneEnhancement>);
  bool configure(std::uint64_t revision, const MicrophoneDspConfig&) noexcept;
  void process(MicrophoneFrame&, std::int64_t now_100ns, EchoReferencePort*) noexcept;
  MicrophoneDspStats stats() const noexcept { return stats_; }
 private:
  std::unique_ptr<MicrophoneEnhancement> enhancement_;
  MicrophoneDspConfig config_;
  MicrophoneDspStats stats_;
  float noise_floor_ = 0.001f;
  float gain_ = 1.0f;
  std::uint32_t gate_hold_frames_ = 0;
  std::uint64_t reference_sequence_ = 0;
  bool echo_reset_failed_ = false;
};
}  // namespace syrnike::windows_media::audio
