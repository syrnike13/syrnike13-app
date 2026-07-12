#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <windows.h>

#include "livekit/livekit.h"
#include "screen_video_capture.hpp"

namespace syrnike::voice {

using ScreenAudioFailure = std::function<void(std::string)>;
using ScreenAudioStats = std::function<void(
    std::uint64_t frames,
    std::uint64_t packets,
    double peak_db,
    double rms_db)>;

void captureSystemLoopbackAudio(
    DWORD excluded_process_id,
    const std::string& session_id,
    const std::shared_ptr<livekit::AudioSource>& audio_source,
    const std::shared_ptr<std::atomic_bool>& running,
    ScreenAudioFailure on_failure,
    ScreenAudioStats on_stats);
void captureProcessLoopbackAudio(
    DWORD process_id,
    const std::string& session_id,
    const std::shared_ptr<livekit::AudioSource>& audio_source,
    const std::shared_ptr<std::atomic_bool>& running,
    ScreenAudioFailure on_failure,
    ScreenAudioStats on_stats);
void validateScreenLoopbackAudio(
    const ScreenCaptureTarget& target,
    DWORD excluded_process_id);
}  // namespace syrnike::voice
