#pragma once

#include "audio/remote_audio_pcm.hpp"

namespace syrnike::windows_media::audio {
inline constexpr std::uint32_t kRemoteAudioTargetPadding = 960; // 20 ms
inline constexpr std::int64_t kRemoteAudioDelayedWake100ns = 300'000; // 30 ms
inline constexpr std::int64_t kRemoteAudioNoProgress100ns = 5'000'000; // 500 ms

struct RemoteRenderObservation {
  std::uint32_t buffer_frames = 0;
  std::uint32_t padding_frames = 0;
  std::uint64_t clock_position = 0;
  std::int64_t now_100ns = 0;
};
struct RemoteRenderDecision {
  std::uint32_t writable_frames = 0;
  bool healthy = false;
  bool delayed_wake = false;
  bool underrun = false;
  bool invalid = false;
  bool no_progress = false;
};
struct RemoteRenderPlanStats {
  std::uint64_t submitted_frames = 0;
  std::uint64_t consumed_frames = 0;
  std::uint64_t wakes = 0;
  std::uint64_t delayed_wakes = 0;
  std::uint64_t underruns = 0;
  std::int64_t maximum_wake_gap_100ns = 0;
  std::uint32_t healthy_observations = 0;
};

// One instance per IAudioClient lifetime, used exclusively by its render owner.
// Observe padding AND audio-clock movement before writing. Call released only
// after a successful ReleaseBuffer. Repeated successful writes alone cannot
// make a candidate healthy. A delayed wake fills the target, never all capacity.
class RemoteRenderPlan final {
 public:
  RemoteRenderDecision observe(const RemoteRenderObservation&) noexcept;
  bool released(std::uint32_t frames) noexcept;
  RemoteRenderPlanStats stats() const noexcept { return stats_; }
 private:
  RemoteRenderPlanStats stats_;
  std::int64_t last_wake_100ns_ = 0;
  std::int64_t last_progress_100ns_ = 0;
  std::uint64_t last_clock_ = 0;
  std::uint32_t permitted_write_ = 0;
};
}  // namespace syrnike::windows_media::audio
