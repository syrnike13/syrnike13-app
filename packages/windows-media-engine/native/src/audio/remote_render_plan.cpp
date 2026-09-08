#include "audio/remote_render_plan.hpp"

#include <algorithm>
#include <limits>

namespace syrnike::windows_media::audio {
RemoteRenderDecision RemoteRenderPlan::observe(const RemoteRenderObservation& value) noexcept {
  RemoteRenderDecision result;
  permitted_write_ = 0;
  if (value.buffer_frames < kRemoteAudioFrames || value.buffer_frames > kRemoteAudioRate ||
      value.padding_frames > value.buffer_frames || value.padding_frames > stats_.submitted_frames ||
      value.now_100ns <= 0 || (last_wake_100ns_ && value.now_100ns < last_wake_100ns_) ||
      value.clock_position < last_clock_) {
    result.invalid = true;
    return result;
  }
  ++stats_.wakes;
  if (!last_wake_100ns_) last_progress_100ns_ = value.now_100ns;
  else {
    const auto gap = value.now_100ns - last_wake_100ns_;
    stats_.maximum_wake_gap_100ns = (std::max)(stats_.maximum_wake_gap_100ns, gap);
    result.delayed_wake = gap > kRemoteAudioDelayedWake100ns;
    if (result.delayed_wake) ++stats_.delayed_wakes;
  }
  const auto consumed = stats_.submitted_frames - value.padding_frames;
  const bool progressed = consumed > stats_.consumed_frames && value.clock_position > last_clock_;
  if (progressed) {
    last_progress_100ns_ = value.now_100ns;
    if (value.padding_frames && !result.delayed_wake) {
      if (stats_.healthy_observations < 3) ++stats_.healthy_observations;
    } else stats_.healthy_observations = 0;
  }
  result.underrun = stats_.submitted_frames != 0 && value.padding_frames == 0;
  if (result.underrun) ++stats_.underruns;
  result.no_progress = value.now_100ns - last_progress_100ns_ >= kRemoteAudioNoProgress100ns;
  result.healthy = stats_.healthy_observations >= 3 && !result.no_progress;
  stats_.consumed_frames = consumed;
  last_clock_ = value.clock_position;
  last_wake_100ns_ = value.now_100ns;
  const auto target = (std::min)(kRemoteAudioTargetPadding, value.buffer_frames);
  if (!result.no_progress && value.padding_frames < target)
    result.writable_frames = target - value.padding_frames;
  permitted_write_ = result.writable_frames;
  return result;
}

bool RemoteRenderPlan::released(std::uint32_t frames) noexcept {
  if (!frames || frames > permitted_write_ ||
      stats_.submitted_frames > (std::numeric_limits<std::uint64_t>::max)() - frames)
    return false;
  stats_.submitted_frames += frames;
  permitted_write_ = 0;
  return true;
}
}  // namespace syrnike::windows_media::audio
