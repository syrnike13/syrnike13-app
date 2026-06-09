#pragma once

#include <string>

namespace syrnike::voice {

void startMicrophoneWarmup(
  const std::string& device_id,
  const std::string& session_id
);
void stopMicrophoneWarmup();

}  // namespace syrnike::voice
