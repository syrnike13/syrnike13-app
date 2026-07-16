#pragma once

#include <audioclient.h>

namespace syrnike::voice {

constexpr int kSampleRate = 48000;
constexpr int kChannels = 1;
constexpr int kSamplesPer10Ms = kSampleRate / 100;
constexpr REFERENCE_TIME kBufferDurationHns = 10000000;

}  // namespace syrnike::voice
