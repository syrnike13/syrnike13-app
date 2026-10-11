#pragma once

#include <windows.h>
#include <timeapi.h>

#include <chrono>
#include <cstdint>

namespace syrnike::windows_media {
// WebRTC on Windows stamps media with timeGetTime(), not QPC (measured against
// the pinned build: about 30 ms apart after a day of uptime, and the gap is
// machine-specific). Capture times handed to the SDK must use WebRTC's clock:
// they become the RTCP sender-report mapping that receivers synchronize audio
// and video against. A QPC time WebRTC sees as future is clamped to "now",
// which hides capture and encode latency from that mapping.
inline std::int64_t webrtcTimeFromSteadyUs(std::int64_t steady_us) noexcept {
  const auto steady_now_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
  // Both counters start near boot; the 32-bit difference is wrap-safe.
  const auto offset_ms = static_cast<std::int32_t>(timeGetTime() - static_cast<DWORD>(steady_now_ms));
  return steady_us + static_cast<std::int64_t>(offset_ms) * 1000;
}
}  // namespace syrnike::windows_media
