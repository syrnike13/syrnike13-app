/*
 * Copyright 2025 LiveKit, Inc.
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

#include "livekit/video_track.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <iostream>
#include <memory>

#ifdef _WIN32
#include <windows.h>
#endif

#include "api/media_stream_interface.h"
#include "api/video/video_frame.h"
#include "api/video/video_rotation.h"
#include "audio/remix_resample.h"
#include "common_audio/include/audio_util.h"
#include "livekit/dmabuf_video_frame_buffer.h"
#ifdef _WIN32
#include "livekit/windows_d3d11_h264_encoder.h"
#endif
#include "livekit/media_stream.h"
#include "livekit/packet_trailer.h"
#include "livekit/video_track.h"
#include "rtc_base/logging.h"
#include "rtc_base/ref_counted_object.h"
#include "rtc_base/synchronization/mutex.h"
#include "rtc_base/time_utils.h"
#include "webrtc-sys/src/packet_trailer.rs.h"
#include "webrtc-sys/src/video_track.rs.h"

namespace livekit_ffi {

namespace {

void TraceVideoSource(const char* operation, uint64_t count,
                      int64_t input_timestamp_us,
                      int64_t aligned_timestamp_us) {
#ifdef _WIN32
  wchar_t log_path[32768]{};
  const DWORD path_length = GetEnvironmentVariableW(
      L"SYRNIKE_NATIVE_MEDIA_LOG_PATH", log_path,
      static_cast<DWORD>(_countof(log_path)));
  if (path_length == 0 || path_length >= _countof(log_path)) return;
  HANDLE output = CreateFileW(log_path, FILE_APPEND_DATA,
                              FILE_SHARE_READ | FILE_SHARE_WRITE |
                                  FILE_SHARE_DELETE,
                              nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                              nullptr);
  if (output == INVALID_HANDLE_VALUE) return;
  char line[320]{};
  const int length = std::snprintf(
      line, _countof(line),
      "{\"event\":\"d3d11_video_source_trace\",\"operation\":\"%s\"," 
      "\"count\":%llu,\"inputTimestampUs\":%lld,"
      "\"alignedTimestampUs\":%lld}\n",
      operation, static_cast<unsigned long long>(count),
      static_cast<long long>(input_timestamp_us),
      static_cast<long long>(aligned_timestamp_us));
  if (length > 0) {
    DWORD written = 0;
    const DWORD bytes_to_write = static_cast<DWORD>(
        std::min<int>(length, static_cast<int>(_countof(line) - 1)));
    WriteFile(output, line, bytes_to_write, &written, nullptr);
  }
  CloseHandle(output);
#endif
}

}  // namespace

VideoTrack::VideoTrack(std::shared_ptr<RtcRuntime> rtc_runtime,
                       webrtc::scoped_refptr<webrtc::VideoTrackInterface> track)
    : MediaStreamTrack(rtc_runtime, std::move(track)) {}

VideoTrack::~VideoTrack() {
  webrtc::MutexLock lock(&mutex_);
  for (auto& sink : sinks_) {
    track()->RemoveSink(sink.get());
  }
}

void VideoTrack::add_sink(const std::shared_ptr<NativeVideoSink>& sink) const {
  webrtc::MutexLock lock(&mutex_);
  track()->AddOrUpdateSink(sink.get(),
                           webrtc::VideoSinkWants());  // TODO(theomonnom): Expose
                                                    // VideoSinkWants to Rust?
  sinks_.push_back(sink);
}

void VideoTrack::remove_sink(
    const std::shared_ptr<NativeVideoSink>& sink) const {
  webrtc::MutexLock lock(&mutex_);
  track()->RemoveSink(sink.get());
  sinks_.erase(std::remove(sinks_.begin(), sinks_.end(), sink), sinks_.end());
}

void VideoTrack::set_should_receive(bool should_receive) const {
  track()->set_should_receive(should_receive);
}

bool VideoTrack::should_receive() const {
  return track()->should_receive();
}

ContentHint VideoTrack::content_hint() const {
  return static_cast<ContentHint>(track()->content_hint());
}

void VideoTrack::set_content_hint(ContentHint hint) const {
  track()->set_content_hint(
      static_cast<webrtc::VideoTrackInterface::ContentHint>(hint));
}

NativeVideoSink::NativeVideoSink(rust::Box<VideoSinkWrapper> observer)
    : observer_(std::move(observer)) {}

void NativeVideoSink::OnFrame(const webrtc::VideoFrame& frame) {
  observer_->on_frame(std::make_unique<VideoFrame>(frame));
}

void NativeVideoSink::OnDiscardedFrame() {
  observer_->on_discarded_frame();
}

void NativeVideoSink::OnConstraintsChanged(
    const webrtc::VideoTrackSourceConstraints& constraints) {
  VideoTrackSourceConstraints cst;
  cst.has_min_fps = constraints.min_fps.has_value();
  cst.min_fps = constraints.min_fps.value_or(0);
  cst.has_max_fps = constraints.max_fps.has_value();
  cst.max_fps = constraints.max_fps.value_or(0);
  observer_->on_constraints_changed(cst);
}

std::shared_ptr<NativeVideoSink> new_native_video_sink(
    rust::Box<VideoSinkWrapper> observer) {
  return std::make_shared<NativeVideoSink>(std::move(observer));
}

VideoTrackSource::InternalSource::InternalSource(
    const VideoResolution& resolution, bool is_screencast)
    : webrtc::AdaptedVideoTrackSource(4), resolution_(resolution), is_screencast_(is_screencast) {}

VideoTrackSource::InternalSource::~InternalSource() {}

bool VideoTrackSource::InternalSource::is_screencast() const {
  return is_screencast_;
}

std::optional<bool> VideoTrackSource::InternalSource::needs_denoising() const {
  return false;
}

webrtc::MediaSourceInterface::SourceState
VideoTrackSource::InternalSource::state() const {
  return SourceState::kLive;
}

bool VideoTrackSource::InternalSource::remote() const {
  return false;
}

VideoResolution VideoTrackSource::InternalSource::video_resolution() const {
  webrtc::MutexLock lock(&mutex_);
  return resolution_;
}

bool VideoTrackSource::InternalSource::on_captured_frame(
    const webrtc::VideoFrame& frame,
    const FrameMetadata& frame_metadata) {
  webrtc::MutexLock lock(&mutex_);

  int64_t aligned_timestamp_us = timestamp_aligner_.TranslateTimestamp(
      frame.timestamp_us(), webrtc::TimeMicros());

  // If a packet trailer was provided on this frame and we have a handler,
  // store the mapping keyed by the aligned timestamp.  This is the value
  // that CaptureTime() will return in TransformSend, so the lookup will
  // succeed.
  if (frame_metadata.has_packet_trailer && packet_trailer_handler_) {
    packet_trailer_handler_->store_frame_metadata(
        aligned_timestamp_us, frame_metadata.user_timestamp,
        frame_metadata.frame_id,
        rust::Slice<const uint8_t>(frame_metadata.user_data.data(),
                                   frame_metadata.user_data.size()));
  }

  webrtc::scoped_refptr<webrtc::VideoFrameBuffer> buffer =
      frame.video_frame_buffer();

  if (resolution_.height == 0 || resolution_.width == 0) {
    resolution_ = VideoResolution{static_cast<uint32_t>(buffer->width()),
                                  static_cast<uint32_t>(buffer->height())};
  }

  int adapted_width, adapted_height, crop_width, crop_height, crop_x, crop_y;
  if (!AdaptFrame(buffer->width(), buffer->height(), aligned_timestamp_us,
                  &adapted_width, &adapted_height, &crop_width, &crop_height,
                  &crop_x, &crop_y)) {
    static std::atomic_uint64_t dropped_frames{0};
    const auto dropped = ++dropped_frames;
    if (dropped <= 3 || dropped % 300 == 0) {
      TraceVideoSource("adapted_drop", dropped, frame.timestamp_us(),
                       aligned_timestamp_us);
      RTC_LOG(LS_WARNING) << "[syrnike-d3d11-source] adapted_drop=" << dropped
                          << " input_timestamp_us=" << frame.timestamp_us()
                          << " aligned_timestamp_us=" << aligned_timestamp_us;
    }
    return false;
  }

  if (adapted_width != frame.width() || adapted_height != frame.height()) {
    buffer = buffer->CropAndScale(crop_x, crop_y, crop_width, crop_height,
                                  adapted_width, adapted_height);
  }

  webrtc::VideoRotation rotation = frame.rotation();
  if (apply_rotation() && rotation != webrtc::kVideoRotation_0) {
    // If the buffer is I420, webrtc::AdaptedVideoTrackSource will handle the
    // rotation for us.
    buffer = buffer->ToI420();
  }

  if (packet_trailer_handler_) {
    packet_trailer_handler_->emit_publish_timing(
        VideoPublishTimingStage::EncoderUpload,
        frame_metadata.has_packet_trailer ? frame_metadata.user_timestamp : 0,
        frame_metadata.has_packet_trailer ? frame_metadata.frame_id : 0);
  }

  static std::atomic_uint64_t forwarded_frames{0};
  const auto forwarded = ++forwarded_frames;
  if (forwarded <= 3 || forwarded % 300 == 0) {
    TraceVideoSource("forwarded", forwarded, frame.timestamp_us(),
                     aligned_timestamp_us);
    RTC_LOG(LS_WARNING) << "[syrnike-d3d11-source] forwarded=" << forwarded
                        << " input_timestamp_us=" << frame.timestamp_us()
                        << " aligned_timestamp_us=" << aligned_timestamp_us
                        << " adapted=" << adapted_width << 'x' << adapted_height;
  }

  OnFrame(webrtc::VideoFrame::Builder()
              .set_video_frame_buffer(buffer)
              .set_rotation(rotation)
              .set_timestamp_us(aligned_timestamp_us)
              .build());

  return true;
}

void VideoTrackSource::InternalSource::set_packet_trailer_handler(
    std::shared_ptr<PacketTrailerHandler> handler) {
  webrtc::MutexLock lock(&mutex_);
  packet_trailer_handler_ = std::move(handler);
}

VideoTrackSource::VideoTrackSource(const VideoResolution& resolution, bool is_screencast) {
  source_ = webrtc::make_ref_counted<InternalSource>(resolution, is_screencast);
}

VideoResolution VideoTrackSource::video_resolution() const {
  return source_->video_resolution();
}

bool VideoTrackSource::on_captured_frame(
    const std::unique_ptr<VideoFrame>& frame,
    const FrameMetadata& frame_metadata) const {
  auto rtc_frame = frame->get();
  return source_->on_captured_frame(rtc_frame, frame_metadata);
}

bool VideoTrackSource::capture_dmabuf_frame(int dmabuf_fd,
                                            int width,
                                            int height,
                                            int pixel_format,
                                            int64_t timestamp_us,
                                            const FrameMetadata& frame_metadata) const {
  auto dmabuf_pixel_format =
      static_cast<livekit::DmaBufPixelFormat>(pixel_format);
  auto buffer = webrtc::make_ref_counted<livekit::DmaBufVideoFrameBuffer>(
      dmabuf_fd, width, height, dmabuf_pixel_format);

  int64_t ts = timestamp_us;
  if (ts == 0) {
    auto now = std::chrono::system_clock::now().time_since_epoch();
    ts = std::chrono::duration_cast<std::chrono::microseconds>(now).count();
  }

  auto frame = webrtc::VideoFrame::Builder()
                   .set_video_frame_buffer(std::move(buffer))
                   .set_rotation(webrtc::kVideoRotation_0)
                   .set_timestamp_us(ts)
                   .build();

  return source_->on_captured_frame(frame, frame_metadata);
}

bool VideoTrackSource::capture_d3d11_frame(
    uint64_t shared_texture_handle, uint64_t adapter_luid,
    uint64_t acquire_key, uint64_t release_key, int width, int height,
    int64_t timestamp_us) const {
#ifdef _WIN32
  auto buffer = webrtc::make_ref_counted<D3D11TextureFrameBuffer>(
      reinterpret_cast<HANDLE>(static_cast<uintptr_t>(shared_texture_handle)),
      adapter_luid, acquire_key, release_key, width, height, [] {});
  if (!buffer->owns_shared_handle()) return false;
  auto frame = webrtc::VideoFrame::Builder()
                   .set_video_frame_buffer(std::move(buffer))
                   .set_rotation(webrtc::kVideoRotation_0)
                   .set_timestamp_us(timestamp_us)
                   .build();
  // Propagate the actual source decision. A rejected frame is reclaimed by
  // D3D11TextureFrameBuffer destruction and must not be acknowledged to the
  // producer as accepted encoder ingress.
  return source_->on_captured_frame(frame, FrameMetadata{});
#else
  return false;
#endif
}

void VideoTrackSource::set_packet_trailer_handler(
    std::shared_ptr<PacketTrailerHandler> handler) const {
  source_->set_packet_trailer_handler(std::move(handler));
}

webrtc::scoped_refptr<VideoTrackSource::InternalSource> VideoTrackSource::get()
    const {
  return source_;
}

std::shared_ptr<VideoTrackSource> new_video_track_source(
    const VideoResolution& resolution, bool is_screencast) {
  return std::make_shared<VideoTrackSource>(resolution, is_screencast);
}

}  // namespace livekit_ffi
