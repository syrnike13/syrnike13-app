/*
 * Copyright 2025 LiveKit
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an “AS IS” BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include "livekit/audio_source.h"
#include "livekit/operation_cancellation.h"

#include <algorithm>
#include <chrono>
#include <stdexcept>
#include <thread>

#include "audio_frame.pb.h"
#include "ffi.pb.h"
#include "ffi_client.h"
#include "livekit/audio_frame.h"
#include "lk_log.h"

namespace livekit {

using Clock = std::chrono::steady_clock;

namespace {

using namespace std::chrono_literals;
constexpr auto kCaptureOperationSafetyMargin = 100ms;
constexpr auto kMaximumCaptureOperationTimeout = 2min;

std::chrono::milliseconds captureOperationTimeout(int timeout_ms, int queue_size_ms) {
  if (timeout_ms > 0) {
    return std::chrono::milliseconds(timeout_ms);
  }
  const auto queue_budget = std::chrono::milliseconds(std::max(queue_size_ms, 0));
  return std::min(queue_budget + kCaptureOperationSafetyMargin,
                  std::chrono::duration_cast<std::chrono::milliseconds>(kMaximumCaptureOperationTimeout));
}

} // namespace

// Helper to get monotonic time in seconds (similar to time.monotonic()).
static double now_seconds() {
  auto now = Clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::duration<double>>(now).count();
}

// ============================================================================
// AudioSource
// ============================================================================

AudioSource::AudioSource(int sample_rate, int num_channels, int queue_size_ms)
    : sample_rate_(sample_rate), num_channels_(num_channels), queue_size_ms_(queue_size_ms) {
  proto::FfiRequest req;
  auto* msg = req.mutable_new_audio_source();
  msg->set_type(proto::AudioSourceType::AUDIO_SOURCE_NATIVE);
  msg->set_sample_rate(static_cast<std::uint32_t>(sample_rate_));
  msg->set_num_channels(static_cast<std::uint32_t>(num_channels_));
  msg->set_queue_size_ms(static_cast<std::uint32_t>(queue_size_ms_));

  const proto::FfiResponse resp = FfiClient::instance().sendRequest(req);

  const auto& source_info = resp.new_audio_source().source();
  // Wrap FFI handle in RAII FfiHandle
  handle_ = FfiHandle(static_cast<uintptr_t>(source_info.handle().id()));
}

double AudioSource::queuedDuration() const noexcept {
  if (last_capture_ == 0.0) {
    return 0.0;
  }

  const double now = now_seconds();
  const double elapsed = now - last_capture_;
  const double remaining = q_size_ - elapsed;
  return remaining > 0.0 ? remaining : 0.0;
}

void AudioSource::resetQueueTracking() noexcept {
  last_capture_ = 0.0;
  q_size_ = 0.0;
}

void AudioSource::clearQueue() {
  if (!handle_) {
    resetQueueTracking();
    return;
  }

  proto::FfiRequest req;
  auto* msg = req.mutable_clear_audio_buffer();
  msg->set_source_handle(static_cast<std::uint64_t>(handle_.get()));

  (void)FfiClient::instance().sendRequest(req);

  // Reset local queue tracking.
  resetQueueTracking();
}

void AudioSource::captureFrame(const AudioFrame& frame, int timeout_ms) {
  captureFrameImpl(frame, timeout_ms, nullptr);
}

void AudioSource::captureFrame(
    const AudioFrame& frame,
    int timeout_ms,
    const OperationCancellation& cancellation) {
  captureFrameImpl(frame, timeout_ms, &cancellation);
}

void AudioSource::captureFrameImpl(
    const AudioFrame& frame,
    int timeout_ms,
    const OperationCancellation* cancellation) {
  using namespace std::chrono_literals;
  if (!handle_) {
    return;
  }

  if (frame.samplesPerChannel() == 0) {
    return;
  }

  // Queue tracking, same logic as before
  const double now = now_seconds();
  const double elapsed = (last_capture_ == 0.0) ? 0.0 : (now - last_capture_);
  const double frame_duration = static_cast<double>(frame.samplesPerChannel()) / static_cast<double>(sample_rate_);
  q_size_ += frame_duration - elapsed;
  if (q_size_ < 0.0) {
    q_size_ = 0.0; // clamp
  }
  last_capture_ = now;

  // Build AudioFrameBufferInfo from the wrapper
  const proto::AudioFrameBufferInfo buf = frame.toProto();
  auto operation = FfiClient::instance().captureAudioFrameAsync(handle_.get(), buf);
  if (!cancellation) {
    const auto result = timeout_ms == 0
        ? operation.wait()
        : operation.waitFor(std::chrono::milliseconds(timeout_ms));
    if (result.hasError() && result.error().code == FfiOperationErrorCode::Timeout) {
      LK_LOG_WARN("captureAudioFrameAsync timed out after {} ms", timeout_ms);
      return;
    }
    if (result.hasError()) {
      throw std::runtime_error("AudioSource::captureFrame FFI operation failed: " + result.error().message);
    }
    return;
  }

  const auto timeout = captureOperationTimeout(timeout_ms, queue_size_ms_);
  const auto result = operation.waitFor(timeout, *cancellation);
  if (result.hasError()) {
    throw std::runtime_error("AudioSource::captureFrame FFI operation failed: " + result.error().message);
  }
}

} // namespace livekit
