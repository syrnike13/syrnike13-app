#include "screen/production_screen_pipeline.hpp"

#include <algorithm>
#include <stdexcept>

namespace syrnike::windows_media::screen {
namespace {
std::uint64_t monotonicMs() noexcept {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}
std::uint64_t delta(std::uint64_t current, std::uint64_t previous) noexcept {
  return current >= previous ? current - previous : 0;
}
bool fits(std::size_t value, std::size_t maximum) noexcept {
  const auto& a = kAdaptiveScreenProfiles[value];
  const auto& b = kAdaptiveScreenProfiles[maximum];
  return value <= maximum && a.width <= b.width && a.height <= b.height && a.fps <= b.fps;
}
}

bool ProductionScreenPipeline::enableAdaptiveQuality(
    std::uint32_t supported_profiles, std::size_t user_maximum) {
  std::scoped_lock lock(mutex_);
  if (state_ != ProductionScreenPipelineState::idle ||
      user_maximum >= kAdaptiveScreenProfiles.size()) return false;
  std::optional<std::size_t> initial;
  for (std::size_t i = 0; i < kAdaptiveScreenProfiles.size(); ++i) {
    const auto& p = kAdaptiveScreenProfiles[i];
    if (p.width == profile_.width && p.height == profile_.height &&
        p.fps == profile_.frames_per_second && p.target_bitrate == profile_.bitrate) initial = i;
  }
  if (!initial || !fits(*initial, user_maximum) ||
      (supported_profiles & (1U << *initial)) == 0) return false;
  supported_profiles_ = supported_profiles;
  user_maximum_ = user_maximum;
  stats_.adaptive_enabled = true;
  stats_.current_profile = *initial;
  stats_.desired_revision = 1;
  attempt_revision_ = 1;
  return true;
}

bool ProductionScreenPipeline::setMaximumQuality(
    std::uint64_t revision, std::size_t user_maximum) noexcept {
  std::scoped_lock lock(mutex_);
  if (!stats_.adaptive_enabled || revision <= stats_.desired_revision ||
      user_maximum >= kAdaptiveScreenProfiles.size() || stop_requested_ ||
      state_ == ProductionScreenPipelineState::failed || state_ == ProductionScreenPipelineState::stopped)
    return false;
  user_maximum_ = user_maximum;
  stats_.desired_revision = revision;
  return true;
}

void ProductionScreenPipeline::runAdaptiveControl() {
  const auto now = monotonicMs();
  std::uint64_t profile_generation;
  std::uint64_t revision;
  std::uint64_t applied_revision;
  std::size_t maximum;
  bool adaptive_enabled;
  {
    std::scoped_lock lock(mutex_);
    profile_generation = stats_.profile_generation;
    revision = stats_.desired_revision;
    applied_revision = stats_.applied_revision;
    maximum = user_maximum_;
    adaptive_enabled = stats_.adaptive_enabled;
  }
  // A request arriving after issuance cannot be acknowledged by an already
  // submitted input. Sequence numbers are assigned at encoder admission.
  (void)keyframes_.requestThrough(profile_generation, keyframe_intents_->load());
  const auto keyframe_action = keyframes_.poll(now, encoder_->stats().submitted);
  if (keyframe_action == KeyframeAction::exhausted) {
    std::scoped_lock lock(mutex_);
    failure_ = ScreenPublicationFailure{"screen_keyframe_progress_deadline",
        "Three bounded keyframe requests produced no confirmed publication progress", "screen_keyframe"};
    state_ = ProductionScreenPipelineState::failed;
    stop_requested_ = true;
    return;
  }
  if (keyframe_action == KeyframeAction::request) {
    encoder_->requestKeyFrame();
    std::scoped_lock lock(mutex_);
    ++stats_.keyframe_requests;
  }
  if (!adaptive_enabled) return;
  const bool desired_changed = revision != applied_revision;
  if (!desired_changed && now - last_policy_ms_ < 500) return;
  const auto current = stats();
  AdaptiveMeasurements m;
  m.now_ms = now;
  m.interval_ms = last_policy_ms_ ? now - last_policy_ms_ : 500;
  m.current_profile = current.current_profile;
  m.user_maximum = maximum;
  m.supported_profiles = supported_profiles_;
  m.available_outgoing_bitrate = current.network.available_outgoing_bitrate;
  m.network_measurement_fresh = current.network.measured_at_ms > 0 &&
      current.network.measured_at_ms <= now && now - current.network.measured_at_ms <= 2000;
  m.capture_age_ms = static_cast<std::uint32_t>((std::min)(current.capture_age_last_us / 1000, 60'000ULL));
  m.convert_age_ms = static_cast<std::uint32_t>((std::min)(current.converter.gpu_duration_last_us / 1000, 60'000ULL));
  m.publish_age_ms = static_cast<std::uint32_t>((std::min)(current.publish_age_last_us / 1000, 60'000ULL));
  const auto frame_interval = 1'000'000ULL / kAdaptiveScreenProfiles[current.current_profile].fps;
  m.publication_gpu_pressure_permille = static_cast<std::uint32_t>((std::min)(
      current.converter.gpu_duration_last_us * 1000 / frame_interval, 1000ULL));
  if (previous_policy_stats_) {
    const auto& previous = *previous_policy_stats_;
    m.encoder_inputs = delta(current.encoder.submitted, previous.encoder.submitted);
    m.encoder_outputs = delta(current.encoder.encoded, previous.encoder.encoded);
    const auto captures = delta(current.capture_frames, previous.capture_frames);
    // Last-value diagnostics are not fresh pressure samples during a static
    // capture. Unknown cadence must neither downgrade nor authorize recovery.
    if (captures == 0) m.capture_age_ms = 0;
    if (current.converter.converted == previous.converter.converted) {
      m.convert_age_ms = 0;
      m.publication_gpu_pressure_permille = 0;
    }
    if (current.encoder.encoded == previous.encoder.encoded) m.publish_age_ms = 0;
    const auto dropped = delta(current.conversion_drops, previous.conversion_drops) +
        delta(current.encoder_rejections, previous.encoder_rejections) +
        delta(current.stale_encoded_drops, previous.stale_encoded_drops) +
        delta(current.sender.superseded, previous.sender.superseded) +
        delta(current.encoder.output_superseded, previous.encoder.output_superseded);
    m.backpressure_permille = captures ? static_cast<std::uint32_t>(
        (std::min)(dropped * 1000 / captures, 1000ULL)) : 0;
    if (current.encoder.output_superseded > previous.encoder.output_superseded)
      keyframe_intents_->fetch_add(1);
  }
  previous_policy_stats_ = current;
  last_policy_ms_ = now;
  const auto decision = evaluateAdaptiveScreenPolicy(m, policy_state_);
  policy_state_ = decision.next;
  {
    std::scoped_lock lock(mutex_);
    stats_.decision_reason = decision.reason;
    // Re-read revision before applying a decision from the immutable sample.
    if (revision != stats_.desired_revision || stop_requested_) return;
    if (decision.action == AdaptiveAction::terminal_capability_failure) {
      failure_ = ScreenPublicationFailure{"screen_adaptive_capability_unavailable",
          "No admitted profile can satisfy the current ceiling and transition budget", "screen_adaptive_policy"};
      state_ = ProductionScreenPipelineState::failed;
      stop_requested_ = true;
      return;
    }
    if (decision.action == AdaptiveAction::keep) {
      // This also validates a late publication completion against a newer
      // setting before any frames from it can enter the encoder.
      if (fits(current.current_profile, maximum)) {
        stats_.applied_revision = revision;
        stats_.reconfiguring = false;
        state_ = ProductionScreenPipelineState::running;
      }
      return;
    }
  }
  reconfigure(decision.target_profile, revision);
}

void ProductionScreenPipeline::reconfigure(std::size_t target, std::uint64_t revision) {
  {
    std::scoped_lock lock(mutex_);
    if (stop_requested_ || revision != stats_.desired_revision) return;
    stats_.reconfiguring = true;
    state_ = ProductionScreenPipelineState::starting;
    ++stats_.profile_changes;
    policy_state_ = recordAdaptiveProfileAttempt(policy_state_, monotonicMs());
    profile_deadline_ = std::chrono::steady_clock::now() + std::chrono::seconds{10};
  }
  const auto deadline = profile_deadline_;
  if (owns_preview_) {
    LocalScreenPreview::processPreview().stopPublication();
    owns_preview_ = false;
  }
  const bool capture_stopped = capture_pipeline_->stop(deadline);
  const auto drained = drainGeneration(deadline, capture_stopped);
  if (!drained.ok) throw std::runtime_error(drained.failure
      ? drained.failure->message : "Profile transition did not drain its old generation");
  std::unique_ptr<GpuScreenConverter> old_converter;
  std::shared_ptr<HardwareH264Encoder> old_encoder;
  std::unique_ptr<ProductionScreenSender> old_sender;
  std::shared_ptr<ScreenPublicationAdapter> old_adapter;
  {
    std::scoped_lock lock(mutex_);
    if (stop_requested_) return;
    // A newer setting supersedes this pending attempt. Recompute a safe
    // ceiling before creating resources; an increase still needs policy health.
    revision = stats_.desired_revision;
    while (target > 0 && (!fits(target, user_maximum_) ||
        (supported_profiles_ & (1U << target)) == 0)) --target;
    if (!fits(target, user_maximum_) || (supported_profiles_ & (1U << target)) == 0)
      throw std::runtime_error("No admitted replacement profile remains");
    retired_publication_consumed_ += sender_->stats().consumed;
    old_converter = std::move(converter_);
    old_encoder = std::move(encoder_);
    old_sender = std::move(sender_);
    old_adapter = std::move(adapter_);
    keyframe_intents_.reset();
    ++stats_.profile_generation;
    stats_.current_profile = target;
    attempt_revision_ = revision;
    published_ = false;
    last_encoder_timestamp_us_ = 0;
  }
  // No second generation is allocated until the drained generation is gone.
  old_sender.reset(); old_adapter.reset(); old_encoder.reset(); old_converter.reset();
  const auto& p = kAdaptiveScreenProfiles[target];
  createGeneration({p.width, p.height, p.fps, p.target_bitrate});
  minimum_capture_timestamp_100ns_ = screenSteadyTimestamp100ns();
  if (!capture_pipeline_->restart()) throw std::runtime_error("Capture frame generation did not restart after drain");
  const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
      deadline - std::chrono::steady_clock::now());
  if (remaining.count() <= 0) throw std::runtime_error("Profile transition deadline exceeded");
  const auto started = startGeneration(remaining);
  if (!started.ok) throw std::runtime_error(started.failure
      ? started.failure->message : "Replacement profile could not start");
  previous_policy_stats_.reset();
  last_policy_ms_ = 0;
}
}
