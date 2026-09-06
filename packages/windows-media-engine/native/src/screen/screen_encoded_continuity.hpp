#pragma once
#include <cstdint>

namespace syrnike::windows_media::screen {
enum class EncodedFrameAdmission { publish, stale, missing_reference };

// Dropping an encoded reference breaks the rest of its GOP. Requesting a
// keyframe alone does not make already-queued dependent frames decodable.
class ScreenEncodedContinuity final {
 public:
  EncodedFrameAdmission admit(bool keyframe, std::uint64_t age_us) noexcept {
    if (age_us > 150'000) {
      waiting_for_keyframe_ = true;
      return EncodedFrameAdmission::stale;
    }
    if (waiting_for_keyframe_ && !keyframe) return EncodedFrameAdmission::missing_reference;
    waiting_for_keyframe_ = false;
    return EncodedFrameAdmission::publish;
  }

 private:
  bool waiting_for_keyframe_ = true;
};
}  // namespace syrnike::windows_media::screen
