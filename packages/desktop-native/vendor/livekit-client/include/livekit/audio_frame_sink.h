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

#include <cstddef>
#include <cstdint>
#include <memory>

#include "livekit/visibility.h"

namespace livekit {

class Track;

/// @brief Borrowed decoded PCM delivered synchronously by WebRTC.
struct DecodedAudioFrameView {
  const std::int16_t* data = nullptr;
  std::size_t sample_count = 0;
  std::uint32_t sample_rate = 0;
  std::uint32_t num_channels = 0;
  std::uint32_t num_frames = 0;
};

/// @brief Realtime observer for decoded remote audio.
class LIVEKIT_API DecodedAudioFrameSink {
public:
  virtual ~DecodedAudioFrameSink() = default;

  /// @brief Receives one borrowed decoded frame on a WebRTC audio thread.
  /// @param frame Frame view valid only for this call.
  virtual void onAudioFrame(const DecodedAudioFrameView& frame) noexcept = 0;
};

/// @brief Requested decoded format for a direct audio sink.
struct DirectAudioSinkOptions {
  std::uint32_t sample_rate = 48'000;
  std::uint32_t num_channels = 2;
};

/// @brief RAII registration of a direct decoded-audio sink.
class LIVEKIT_API AudioFrameSinkRegistration final {
public:
  /// @brief Attaches a sink to an audio track.
  /// @param track Remote audio track with a valid FFI handle.
  /// @param sink Realtime observer retained until the registration closes.
  /// @param options Required decoded output format.
  /// @return Owning registration.
  /// @throws std::invalid_argument if an argument is invalid.
  /// @throws std::runtime_error if the Rust/WebRTC sink cannot be attached.
  static std::unique_ptr<AudioFrameSinkRegistration> attach(const std::shared_ptr<Track>& track,
                                                            std::shared_ptr<DecodedAudioFrameSink> sink,
                                                            const DirectAudioSinkOptions& options = {});

  ~AudioFrameSinkRegistration();
  AudioFrameSinkRegistration(const AudioFrameSinkRegistration&) = delete;
  AudioFrameSinkRegistration& operator=(const AudioFrameSinkRegistration&) = delete;

  /// @brief Detaches the sink and waits until its callback context is released.
  void close() noexcept;

private:
  class Implementation;
  explicit AudioFrameSinkRegistration(std::unique_ptr<Implementation> implementation) noexcept;

  std::unique_ptr<Implementation> implementation_;
};

} // namespace livekit
