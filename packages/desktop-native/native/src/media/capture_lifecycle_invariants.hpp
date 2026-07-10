#pragma once

#include <cstdint>

namespace syrnike::desktop_native::media {

inline bool isCurrentCaptureFailure(
  std::uint64_t failure_epoch,
  std::uint64_t current_epoch,
  bool capture_running,
  bool capture_ready
) {
  return failure_epoch != 0 &&
    failure_epoch == current_epoch &&
    (!capture_running || !capture_ready);
}

}  // namespace syrnike::desktop_native::media
