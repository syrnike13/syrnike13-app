#include "audio/microphone_dsp.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace syrnike::windows_media::audio {
MicrophoneDsp::MicrophoneDsp(std::unique_ptr<MicrophoneEnhancement> enhancement)
    : enhancement_(std::move(enhancement)) {
  if (!enhancement_) throw std::invalid_argument("Microphone DSP requires an enhancement adapter");
}
bool MicrophoneDsp::configure(std::uint64_t revision, const MicrophoneDspConfig& config) noexcept {
  if (revision <= stats_.config_revision || !std::isfinite(config.input_volume) ||
      config.input_volume < 0 || config.input_volume > 2 || !std::isfinite(config.gate_threshold_db) ||
      config.gate_threshold_db < -80 || config.gate_threshold_db > -10) return false;
  config_ = config;
  stats_.config_revision = revision;
  return true;
}
void MicrophoneDsp::process(MicrophoneFrame& frame, std::int64_t now_100ns, EchoReferencePort* port) noexcept {
  std::optional<EchoReferenceFrame> reference = port ? port->take() : std::nullopt;
  bool unsupported_reference = false;
  if (reference) {
    if (!reference->renderer_epoch || reference->renderer_epoch < stats_.echo_epoch ||
        reference->rendered_timestamp_100ns <= 0 || now_100ns < reference->rendered_timestamp_100ns ||
        now_100ns - reference->rendered_timestamp_100ns > kMicrophoneMaximumAge100ns || reference->stream_delay_ms > 500 ||
        (reference->renderer_epoch == stats_.echo_epoch && reference->sequence <= reference_sequence_)) {
      ++stats_.rejected_references;
      reference.reset();
    } else {
      if (reference->renderer_epoch != stats_.echo_epoch) {
        echo_reset_failed_ = stats_.echo_epoch != 0 && !enhancement_->resetEcho();
        stats_.echo_epoch = reference->renderer_epoch;
      }
      reference_sequence_ = reference->sequence;
      if (echo_reset_failed_) {
        unsupported_reference = true;
        reference.reset();
      }
    }
  }
  stats_.echo = enhancement_->process(frame.samples, reference ? &*reference : nullptr,
                                      config_.noise_suppression, config_.echo_cancellation);
  if (config_.echo_cancellation && unsupported_reference) stats_.echo = EchoAvailability::unsupported;
  std::array<float, kMicrophoneFrameSamples> samples{};
  float energy = 0;
  for (std::size_t index = 0; index < samples.size(); ++index) {
    samples[index] = static_cast<float>(frame.samples[index]) / 32768.0f * config_.input_volume;
    energy += samples[index] * samples[index];
  }
  const float rms = std::sqrt(energy / static_cast<float>(samples.size()));
  stats_.input_level = (std::min)(1.0f, rms);
  // Track the quiet envelope; speech increases the floor slowly. State is
  // clamped so sustained speech or silence cannot push the auto gate unbounded.
  const float floor_coefficient = rms < noise_floor_ ? 0.05f : 0.0005f;
  noise_floor_ = (std::clamp)(noise_floor_ + floor_coefficient * (rms - noise_floor_), 0.0001f, 0.03f);
  const float manual_threshold = std::pow(10.0f, config_.gate_threshold_db / 20.0f);
  const float threshold = config_.automatic_threshold ?
      (std::clamp)(noise_floor_ * 2.5f, 0.001f, 0.08f) : manual_threshold;
  stats_.gate_threshold = threshold;
  // Energy activity detector with hysteresis and 100 ms hangover. It is a
  // bounded voice-activity/gate signal, not a speech-recognition classifier.
  const bool activity = rms >= threshold * (stats_.gate_open ? 0.75f : 1.0f);
  if (activity) gate_hold_frames_ = 10;
  else if (gate_hold_frames_) --gate_hold_frames_;
  stats_.gate_open = !config_.gate_enabled || gate_hold_frames_ != 0;
  const bool effective_send = !config_.muted && (!config_.push_to_talk || config_.push_to_talk_pressed);
  stats_.speaking = effective_send && stats_.gate_open && activity;
  if (config_.automatic_gain && stats_.gate_open && rms > 0.0001f) {
    const float target = (std::clamp)(0.1f / rms, 0.25f, 6.0f);
    gain_ += (target < gain_ ? 0.3f : 0.01f) * (target - gain_);
  } else if (!config_.automatic_gain) gain_ = 1.0f;
  stats_.automatic_gain = gain_;
  float output_energy = 0;
  for (std::size_t index = 0; index < samples.size(); ++index) {
    // Silence guard is deliberately after AGC. No amplified noise, stale sample
    // or limiter history can escape a closed gate/mute/PTT state.
    const float output = stats_.gate_open && effective_send ?
        (std::clamp)(samples[index] * gain_, -0.98f, 0.98f) : 0.0f;
    frame.samples[index] = static_cast<std::int16_t>(std::lround(output * 32767.0f));
    output_energy += output * output;
  }
  stats_.output_level = std::sqrt(output_energy / static_cast<float>(samples.size()));
  ++stats_.frames;
}
}  // namespace syrnike::windows_media::audio
