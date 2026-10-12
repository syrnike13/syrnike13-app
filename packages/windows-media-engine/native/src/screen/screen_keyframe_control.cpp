#include "screen/screen_keyframe_control.hpp"

#include <limits>

namespace syrnike::windows_media::screen {
void ScreenKeyframeControl::begin(std::uint64_t generation) noexcept {
  *this = ScreenKeyframeControl{};
  generation_ = generation;
  if (generation) requested_ = 1;  // Each new profile starts decodably.
}
bool ScreenKeyframeControl::request(std::uint64_t generation) noexcept {
  if (!generation || generation != generation_ ||
      requested_ == std::numeric_limits<std::uint64_t>::max()) return false;
  ++requested_;
  return true;
}
bool ScreenKeyframeControl::requestThrough(std::uint64_t generation, std::uint64_t watermark) noexcept {
  if (!generation || generation != generation_ || watermark < requested_) return false;
  requested_ = watermark;
  return true;
}
KeyframeAction ScreenKeyframeControl::poll(
    std::uint64_t now, std::uint64_t sequence) noexcept {
  if (last_poll_ms_ && now < *last_poll_ms_) return KeyframeAction::none;
  last_poll_ms_ = now;
  if (requested_ == acknowledged_) return KeyframeAction::none;
  if (last_request_ms_ && now - *last_request_ms_ < 1000) return KeyframeAction::none;
  // A static or paused capture has no new input to satisfy a request. Keep
  // its intent pending without consuming retries or declaring encoder loss.
  if (last_request_ms_ && sequence <= issued_after_sequence_) return KeyframeAction::none;
  if (attempts_ == 3) return KeyframeAction::exhausted;
  issued_ = requested_;
  issued_after_sequence_ = sequence;
  last_request_ms_ = now;
  ++attempts_;
  return KeyframeAction::request;
}
void ScreenKeyframeControl::progress(std::uint64_t generation,
    std::uint64_t sequence, bool keyframe) noexcept {
  if (generation != generation_ || !keyframe || !last_request_ms_ ||
      sequence <= issued_after_sequence_ || issued_ <= acknowledged_) return;
  acknowledged_ = issued_;
  attempts_ = 0;
  // Keep last_request_ms_: new requests cannot create a keyframe storm even
  // when the encoder acknowledges the preceding keyframe immediately.
}
}
