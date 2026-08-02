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

#include "livekit/audio_frame_sink.h"

#include <atomic>
#include <condition_variable>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <string>
#include <utility>

#include "direct_audio_sink_ffi.h"
#include "livekit/ffi_handle.h"
#include "livekit/track.h"

namespace livekit {
namespace {

constexpr std::uint32_t kDirectAudioSinkOk = 0;

struct ReleaseFence {
  std::mutex mutex;
  std::condition_variable changed;
  std::atomic_bool accepting{true};
  bool released = false;
};

struct CallbackState {
  std::shared_ptr<DecodedAudioFrameSink> sink;
  std::shared_ptr<ReleaseFence> release_fence;
};

void onDirectAudioFrame(void* context, const std::int16_t* data, std::uint32_t sample_rate, std::uint32_t num_channels,
                        std::uint32_t num_frames) noexcept {
  auto* state = static_cast<CallbackState*>(context);
  if (state == nullptr || !state->release_fence->accepting.load(std::memory_order_acquire) || data == nullptr ||
      num_channels == 0 || num_frames == 0) {
    return;
  }
  const auto sample_count = static_cast<std::uint64_t>(num_channels) * num_frames;
  if (sample_count > std::numeric_limits<std::size_t>::max()) {
    return;
  }
  state->sink->onAudioFrame(DecodedAudioFrameView{
      data,
      static_cast<std::size_t>(sample_count),
      sample_rate,
      num_channels,
      num_frames,
  });
}

void onDirectAudioReleased(void* context) noexcept {
  auto* state = static_cast<CallbackState*>(context);
  if (state == nullptr) {
    return;
  }
  auto fence = state->release_fence;
  delete state;
  {
    const std::lock_guard<std::mutex> lock(fence->mutex);
    fence->released = true;
  }
  fence->changed.notify_all();
}

void waitUntilReleased(const std::shared_ptr<ReleaseFence>& fence) noexcept {
  std::unique_lock<std::mutex> lock(fence->mutex);
  fence->changed.wait(lock, [&fence] { return fence->released; });
}

} // namespace

class AudioFrameSinkRegistration::Implementation final {
public:
  Implementation(FfiHandle handle, std::shared_ptr<ReleaseFence> release_fence)
      : handle_(std::move(handle)), release_fence_(std::move(release_fence)) {}

  ~Implementation() { close(); }

  void close() noexcept {
    const std::lock_guard<std::mutex> lock(close_mutex_);
    if (closed_) {
      return;
    }
    closed_ = true;
    release_fence_->accepting.store(false, std::memory_order_release);
    handle_.reset();
    waitUntilReleased(release_fence_);
  }

private:
  std::mutex close_mutex_;
  FfiHandle handle_;
  std::shared_ptr<ReleaseFence> release_fence_;
  bool closed_ = false;
};

std::unique_ptr<AudioFrameSinkRegistration> AudioFrameSinkRegistration::attach(
    const std::shared_ptr<Track>& track, std::shared_ptr<DecodedAudioFrameSink> sink,
    const DirectAudioSinkOptions& options) {
  if (!track || track->kind() != TrackKind::KIND_AUDIO || !track->hasHandle()) {
    throw std::invalid_argument("direct audio sink requires an audio track with a valid handle");
  }
  if (!sink) {
    throw std::invalid_argument("direct audio sink observer is required");
  }
  if (options.sample_rate == 0 || options.num_channels == 0 || options.num_channels > 2) {
    throw std::invalid_argument("direct audio sink format is invalid");
  }

  auto release_fence = std::make_shared<ReleaseFence>();
  auto* callback_state = new CallbackState{std::move(sink), release_fence};
  std::uint32_t status = 0;
  const auto handle = livekit_ffi_attach_direct_audio_sink(static_cast<std::uint64_t>(track->ffiHandleId()),
                                                           options.sample_rate, options.num_channels, callback_state,
                                                           &onDirectAudioFrame, &onDirectAudioReleased, &status);
  if (handle == 0 || status != kDirectAudioSinkOk) {
    waitUntilReleased(release_fence);
    throw std::runtime_error("failed to attach direct decoded-audio sink (status " + std::to_string(status) + ")");
  }

  return std::unique_ptr<AudioFrameSinkRegistration>(new AudioFrameSinkRegistration(
      std::make_unique<Implementation>(FfiHandle(static_cast<std::uintptr_t>(handle)), std::move(release_fence))));
}

AudioFrameSinkRegistration::AudioFrameSinkRegistration(std::unique_ptr<Implementation> implementation) noexcept
    : implementation_(std::move(implementation)) {}

AudioFrameSinkRegistration::~AudioFrameSinkRegistration() = default;

void AudioFrameSinkRegistration::close() noexcept {
  if (implementation_) {
    implementation_->close();
  }
}

} // namespace livekit
