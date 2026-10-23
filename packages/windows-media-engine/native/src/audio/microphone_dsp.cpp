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
      config.input_volume < 0 || config.input_volume > 4 || !std::isfinite(config.gate_threshold_db) ||
      config.gate_threshold_db < -100 || config.gate_threshold_db > 0) return false;
  config_ = config;
  stats_.config_revision = revision;
  return true;
}
void MicrophoneDsp::process(MicrophoneFrame& frame, std::int64_t now_100ns, EchoReferencePort* port,
                            std::array<std::int16_t, kMicrophoneFrameSamples>* monitor) noexcept {
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
  // Energy activity detector with hysteresis and a hangover long enough to
  // keep word endings and pauses between syllables. It is a bounded
  // voice-activity/gate signal, not a speech-recognition classifier.
  const bool activity = rms >= threshold * (gate_hold_frames_ ? 0.75f : 1.0f);
  if (activity) gate_hold_frames_ = kGateHoldFrames;
  else if (gate_hold_frames_) --gate_hold_frames_;
  stats_.gate_open = !config_.gate_enabled || gate_hold_frames_ != 0;
  const bool effective_send = !config_.muted && (!config_.push_to_talk || config_.push_to_talk_pressed);
  // The indicator shares the hangover, so it does not flicker between frames.
  stats_.speaking = effective_send && gate_hold_frames_ != 0;
  if (config_.automatic_gain) {
    // AGC2 receives input-volume-adjusted PCM16 only after the gate measurement.
    // Keep adapting while the gate is closed; the final silence guard still wins.
    for (std::size_t index = 0; index < samples.size(); ++index)
      frame.samples[index] = static_cast<std::int16_t>(std::lround(
          (std::clamp)(samples[index] * 32768.0f, -32768.0f, 32767.0f)));
    const auto pre_gain = frame.samples;
    if (!enhancement_->processGain(frame.samples)) frame.samples = pre_gain;
    for (std::size_t index = 0; index < samples.size(); ++index)
      samples[index] = static_cast<float>(frame.samples[index]) / 32768.0f;
  }
  if (monitor) {
    const float monitor_to = stats_.gate_open ? 1.0f : 0.0f;
    const float monitor_from = (std::max)(monitor_gate_gain_, monitor_to);
    for (std::size_t index = 0; index < samples.size(); ++index) {
      const float ramp = monitor_from + (monitor_to - monitor_from) * static_cast<float>(index + 1) /
          static_cast<float>(samples.size());
      const float output = ramp > 0 ? (std::clamp)(samples[index] * ramp, -0.98f, 0.98f) : 0.0f;
      (*monitor)[index] = static_cast<std::int16_t>(std::lround(output * 32767.0f));
    }
  }
  monitor_gate_gain_ = stats_.gate_open ? 1.0f : 0.0f;
  float output_energy = 0;
  // A closing gate fades out across one frame instead of clicking; opening is
  // immediate so speech onset is not attenuated. Mute and PTT stay immediate:
  // their first closed frame is already digital silence.
  const float gate_to = effective_send && stats_.gate_open ? 1.0f : 0.0f;
  const float gate_from = effective_send ? (std::max)(gate_gain_, gate_to) : 0.0f;
  gate_gain_ = gate_to;
  for (std::size_t index = 0; index < samples.size(); ++index) {
    // Silence guard is deliberately after AGC. No amplified noise, stale sample
    // or limiter history can escape a closed gate/mute/PTT state.
    const float ramp = gate_from + (gate_to - gate_from) * static_cast<float>(index + 1) /
        static_cast<float>(samples.size());
    const float output = ramp > 0 ? (std::clamp)(samples[index] * ramp, -0.98f, 0.98f) : 0.0f;
    frame.samples[index] = static_cast<std::int16_t>(std::lround(output * 32767.0f));
    output_energy += output * output;
  }
  stats_.output_level = std::sqrt(output_energy / static_cast<float>(samples.size()));
  ++stats_.frames;
}
}  // namespace syrnike::windows_media::audio
