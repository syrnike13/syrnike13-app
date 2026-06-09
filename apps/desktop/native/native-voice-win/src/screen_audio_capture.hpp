#pragma once

#include <atomic>
#include <memory>
#include <string>
#include <windows.h>

#include "livekit/livekit.h"
#include "protocol.hpp"
#include "screen_video_capture.hpp"

namespace syrnike::voice {

struct ScreenAudioProbeResult {
  bool ok = false;
  DWORD target_process_id = 0;
  double peak_db = -120.0;
  double rms_db = -120.0;
};

void captureSystemLoopbackAudio(
    DWORD excluded_process_id,
    const std::string& session_id,
    const std::shared_ptr<livekit::AudioSource>& audio_source,
    const std::shared_ptr<std::atomic_bool>& running);
void captureProcessLoopbackAudio(
    DWORD process_id,
    const std::string& session_id,
    const std::shared_ptr<livekit::AudioSource>& audio_source,
    const std::shared_ptr<std::atomic_bool>& running);
void validateScreenLoopbackAudio(
    const ScreenCaptureTarget& target,
    DWORD excluded_process_id);
ScreenAudioProbeResult runScreenLoopbackAudioProbe(
    const ScreenCaptureTarget& target,
    DWORD excluded_process_id,
    int duration_ms);
void emitScreenAudioProbe(const StartCommand& command);

}  // namespace syrnike::voice
