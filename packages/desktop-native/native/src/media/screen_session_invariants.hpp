#pragma once

#include <cstdint>
#include <string>

namespace syrnike::desktop_native::media {

inline bool canReuseActiveScreenRoom(
  bool capture_active,
  const std::string& active_session_id,
  std::uint64_t active_generation,
  const std::string& requested_session_id,
  std::uint64_t requested_generation,
  bool credentials_match
) {
  if (!capture_active) return true;
  return credentials_match &&
    active_session_id == requested_session_id &&
    active_generation == requested_generation;
}

}  // namespace syrnike::desktop_native::media
