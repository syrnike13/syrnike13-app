#pragma once

#include <cstddef>
#include <cstdint>

namespace syrnike::desktop_native::tests {

[[nodiscard]] constexpr bool contentionResourceBaselineReady(
    bool linked_video_delivered,
    std::uint64_t audio_ingress_frames,
    std::uint64_t audio_renderer_fills,
    std::size_t pending_posted_commands) noexcept {
  return linked_video_delivered && audio_ingress_frames > 0 &&
      audio_renderer_fills > 0 && pending_posted_commands == 0;
}

template <std::size_t StableSamples>
class ContentionResourceBaselineGate final {
  static_assert(StableSamples > 0);

 public:
  [[nodiscard]] bool observe(
      bool linked_video_delivered,
      std::uint64_t audio_ingress_frames,
      std::uint64_t audio_renderer_fills,
      std::size_t pending_posted_commands) noexcept {
    if (!contentionResourceBaselineReady(
            linked_video_delivered,
            audio_ingress_frames,
            audio_renderer_fills,
            pending_posted_commands)) {
      stable_samples_ = 0;
      return false;
    }
    if (stable_samples_ < StableSamples) ++stable_samples_;
    return stable_samples_ == StableSamples;
  }

  [[nodiscard]] std::size_t stableSamples() const noexcept {
    return stable_samples_;
  }

 private:
  std::size_t stable_samples_ = 0;
};

}  // namespace syrnike::desktop_native::tests
