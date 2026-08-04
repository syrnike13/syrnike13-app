/*
 * Copyright 2026 LiveKit
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#pragma once

#include <cstdint>

extern "C" {

using LiveKitDirectAudioFrameCallback = void (*)(void*, const std::int16_t*, std::uint32_t, std::uint32_t,
                                                 std::uint32_t);
using LiveKitDirectAudioReleaseCallback = void (*)(void*);

std::uint64_t livekit_ffi_attach_direct_audio_sink(std::uint64_t track_handle, std::uint32_t sample_rate,
                                                   std::uint32_t num_channels, void* context,
                                                   LiveKitDirectAudioFrameCallback on_frame,
                                                   LiveKitDirectAudioReleaseCallback on_release, std::uint32_t* status);

} // extern "C"
