#include "screen/screen_keyframe_control.hpp"

#include <algorithm>
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
  if (attempts_ == kMaxAttempts) return KeyframeAction::exhausted;
  issued_[attempts_] = Attempt{requested_, sequence};
  issued_after_sequence_ = sequence;
  last_request_ms_ = now;
  ++attempts_;
  return KeyframeAction::request;
}
bool ScreenEncoderRecoveryBudget::available(std::uint64_t now) const noexcept {
  std::size_t recent = 0;
  for (std::size_t i = 0; i < count_; ++i)
    if (now >= recoveries_ms_[i] && now - recoveries_ms_[i] < kEncoderRecoveryWindowMs) ++recent;
  return recent < kMaximumEncoderRecoveriesPerWindow;
}
void ScreenEncoderRecoveryBudget::consume(std::uint64_t now) noexcept {
  // Keep the newest entries: the oldest one leaves the window first.
  if (count_ == recoveries_ms_.size()) {
    for (std::size_t i = 1; i < count_; ++i) recoveries_ms_[i - 1] = recoveries_ms_[i];
    --count_;
  }
  recoveries_ms_[count_++] = now;
}
void ScreenKeyframeControl::progress(std::uint64_t generation,
    std::uint64_t sequence, bool keyframe) noexcept {
  if (generation != generation_ || !keyframe) return;
  // The newest attempt this keyframe's input followed is the one it answers.
  // Later attempts stay outstanding: their keyframes may still be in flight.
  for (auto i = attempts_; i-- > 0;) {
    if (sequence <= issued_[i].after_sequence) continue;
    acknowledged_ = (std::max)(acknowledged_, issued_[i].watermark);
    std::copy(issued_.begin() + i + 1, issued_.begin() + attempts_, issued_.begin());
    attempts_ -= i + 1;
    break;
  }
  // Keep last_request_ms_: new requests cannot create a keyframe storm even
  // when the encoder acknowledges the preceding keyframe immediately.
}
}
