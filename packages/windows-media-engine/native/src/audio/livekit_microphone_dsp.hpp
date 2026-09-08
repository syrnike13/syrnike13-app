#pragma once
#include "audio/microphone_dsp.hpp"

namespace syrnike::windows_media::audio {
// Must be constructed/destroyed on the DSP owner. Initialization prewarms the
// WebRTC state; no source, track, Room, or device is created by this factory.
std::unique_ptr<MicrophoneEnhancement> makeLiveKitMicrophoneEnhancement();
}  // namespace syrnike::windows_media::audio
