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

#include "livekit/video_decoder_factory.h"

#include <algorithm>
#include <atomic>
#include <cstdio>

#include <modules/video_coding/codecs/av1/av1_svc_config.h>
#include "api/environment/environment.h"
#include "api/video_codecs/av1_profile.h"
#include "api/video_codecs/sdp_video_format.h"
#include "livekit/objc_video_factory.h"
#include "livekit/packet_trailer_h264.h"
#include "media/base/media_constants.h"
#include "modules/video_coding/codecs/h264/include/h264.h"
#include "modules/video_coding/include/video_error_codes.h"
#include "modules/video_coding/codecs/vp8/include/vp8.h"
#include "modules/video_coding/codecs/vp9/include/vp9.h"
#include "rtc_base/logging.h"

#ifdef _WIN32
#include <windows.h>
#endif

#if defined(RTC_DAV1D_IN_INTERNAL_DECODER_FACTORY)
#include "modules/video_coding/codecs/av1/dav1d_decoder.h"  // nogncheck
#endif

#ifdef WEBRTC_ANDROID
#include "livekit/android.h"
#endif

#if defined(USE_NVIDIA_VIDEO_CODEC)
#include "nvidia/nvidia_decoder_factory.h"
#endif

namespace livekit_ffi {

namespace {

std::atomic_uint64_t g_h264_pre_keyframe_decode_inputs{0};
std::atomic_uint64_t g_h264_complete_keyframe_decode_inputs{0};
std::atomic_uint64_t g_h264_decoded_outputs{0};
std::atomic_uint64_t g_h264_decoder_gate_resets{0};

void TraceH264DecoderStartup(const char* operation,
                             uint64_t count,
                             uint32_t rtp_timestamp) {
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
  char line[256]{};
  const int length = std::snprintf(
      line, _countof(line),
      "{\"event\":\"h264_decoder_startup\",\"operation\":\"%s\","
      "\"count\":%llu,\"rtpTimestamp\":%u}\n",
      operation, static_cast<unsigned long long>(count), rtp_timestamp);
  if (length > 0) {
    DWORD written = 0;
    WriteFile(output, line,
              static_cast<DWORD>(std::min<int>(
                  length, static_cast<int>(_countof(line) - 1))),
              &written, nullptr);
  }
  CloseHandle(output);
#else
  (void)operation;
  (void)count;
  (void)rtp_timestamp;
#endif
}

class H264StartupObservingDecoder final : public webrtc::VideoDecoder {
 public:
  explicit H264StartupObservingDecoder(
      std::unique_ptr<webrtc::VideoDecoder> decoder)
      : decoder_(std::move(decoder)), callback_(this) {}

  bool Configure(const Settings& settings) override {
    first_complete_keyframe_seen_ = false;
    counted_first_complete_keyframe_ = false;
    return decoder_->Configure(settings);
  }

  int32_t Decode(const webrtc::EncodedImage& input,
                 int64_t render_time_ms) override {
    const auto gate_result = EvaluateForInnerDecoder(input);
    if (gate_result != WEBRTC_VIDEO_CODEC_OK) return gate_result;
    if (!first_complete_keyframe_seen_) return WEBRTC_VIDEO_CODEC_OK;
    ObserveForwardedInput(input);
    return decoder_->Decode(input, render_time_ms);
  }

  int32_t Decode(const webrtc::EncodedImage& input,
                 bool missing_frames,
                 int64_t render_time_ms) override {
    const auto gate_result = EvaluateForInnerDecoder(input);
    if (gate_result != WEBRTC_VIDEO_CODEC_OK) return gate_result;
    if (!first_complete_keyframe_seen_) return WEBRTC_VIDEO_CODEC_OK;
    ObserveForwardedInput(input);
    return decoder_->Decode(input, missing_frames, render_time_ms);
  }

  int32_t RegisterDecodeCompleteCallback(
      webrtc::DecodedImageCallback* callback) override {
    callback_.delegate = callback;
    return decoder_->RegisterDecodeCompleteCallback(&callback_);
  }

  int32_t Release() override { return decoder_->Release(); }

  DecoderInfo GetDecoderInfo() const override {
    return decoder_->GetDecoderInfo();
  }

 private:
  class Callback final : public webrtc::DecodedImageCallback {
   public:
    explicit Callback(H264StartupObservingDecoder* owner) : owner(owner) {}

    int32_t Decoded(webrtc::VideoFrame& frame) override {
      owner->ObserveOutput();
      return delegate ? delegate->Decoded(frame) : 0;
    }

    int32_t Decoded(webrtc::VideoFrame& frame,
                    int64_t decode_time_ms) override {
      owner->ObserveOutput();
      return delegate ? delegate->Decoded(frame, decode_time_ms) : 0;
    }

    void Decoded(webrtc::VideoFrame& frame,
                 std::optional<int32_t> decode_time_ms,
                 std::optional<uint8_t> qp) override {
      owner->ObserveOutput();
      if (delegate) delegate->Decoded(frame, decode_time_ms, qp);
    }

    H264StartupObservingDecoder* owner;
    webrtc::DecodedImageCallback* delegate = nullptr;
  };

  int32_t EvaluateForInnerDecoder(const webrtc::EncodedImage& input) {
    const auto decision = h264::EvaluateAccessUnitForDecoder(
        webrtc::ArrayView<const uint8_t>(input.data(), input.size()),
        input.FrameType() == webrtc::VideoFrameType::kVideoFrameKey,
        first_complete_keyframe_seen_);
    if (decision == h264::DecoderGateDecision::Forward) {
      return WEBRTC_VIDEO_CODEC_OK;
    }
    if (decision == h264::DecoderGateDecision::AwaitCompleteKeyframe) {
      return WEBRTC_VIDEO_CODEC_OK;
    }
    counted_first_complete_keyframe_ = false;
    const auto count = ++g_h264_decoder_gate_resets;
    const char* operation = "gate_reset_invalid_slice_header";
    if (decision == h264::DecoderGateDecision::ResetParameterSetAfterSlice) {
      operation = "gate_reset_parameter_set_after_slice";
    } else if (decision ==
               h264::DecoderGateDecision::ResetMixedPictureParameterSet) {
      operation = "gate_reset_mixed_picture_parameter_set";
    }
    TraceH264DecoderStartup(operation, count, input.RtpTimestamp());
    // A successful return suppresses WebRTC's keyframe request. Signal a
    // decode error after a post-startup gate reset so the receiver asks the
    // sender for a fresh SPS/PPS/IDR access unit.
    return WEBRTC_VIDEO_CODEC_ERROR;
  }

  void ObserveForwardedInput(const webrtc::EncodedImage& input) {
    if (counted_first_complete_keyframe_) return;
    counted_first_complete_keyframe_ = true;
    const auto count = ++g_h264_complete_keyframe_decode_inputs;
    TraceH264DecoderStartup("complete_keyframe_input", count,
                            input.RtpTimestamp());
  }

  void ObserveOutput() {
    const auto count = ++g_h264_decoded_outputs;
    if (count <= 3 || count % 300 == 0) {
      TraceH264DecoderStartup("decoded_output", count, 0);
    }
  }

  std::unique_ptr<webrtc::VideoDecoder> decoder_;
  Callback callback_;
  bool first_complete_keyframe_seen_ = false;
  bool counted_first_complete_keyframe_ = false;
};

std::unique_ptr<webrtc::VideoDecoder> ObserveH264Startup(
    const webrtc::SdpVideoFormat& format,
    std::unique_ptr<webrtc::VideoDecoder> decoder) {
  if (!decoder ||
      !absl::EqualsIgnoreCase(format.name, webrtc::kH264CodecName)) {
    return decoder;
  }
  return std::make_unique<H264StartupObservingDecoder>(std::move(decoder));
}

}  // namespace

void reset_h264_decode_startup_observations() {
  g_h264_pre_keyframe_decode_inputs.store(0);
  g_h264_complete_keyframe_decode_inputs.store(0);
  g_h264_decoded_outputs.store(0);
  g_h264_decoder_gate_resets.store(0);
}

uint64_t h264_pre_keyframe_decode_inputs() {
  return g_h264_pre_keyframe_decode_inputs.load();
}

uint64_t h264_complete_keyframe_decode_inputs() {
  return g_h264_complete_keyframe_decode_inputs.load();
}

uint64_t h264_decoded_outputs() {
  return g_h264_decoded_outputs.load();
}

VideoDecoderFactory::VideoDecoderFactory() {
#ifdef __APPLE__
  factories_.push_back(livekit_ffi::CreateObjCVideoDecoderFactory());
#endif

#ifdef WEBRTC_ANDROID
  factories_.push_back(CreateAndroidVideoDecoderFactory());
#endif

#if defined(USE_NVIDIA_VIDEO_CODEC)
  if (webrtc::NvidiaVideoDecoderFactory::IsSupported()) {
    factories_.push_back(std::make_unique<webrtc::NvidiaVideoDecoderFactory>());
  }
#endif
}

std::vector<webrtc::SdpVideoFormat> VideoDecoderFactory::GetSupportedFormats()
    const {
  std::vector<webrtc::SdpVideoFormat> formats;

  for (const auto& factory : factories_) {
    auto supported_formats = factory->GetSupportedFormats();
    formats.insert(formats.end(), supported_formats.begin(),
                   supported_formats.end());
  }

  formats.push_back(webrtc::SdpVideoFormat(webrtc::kVp8CodecName));
  for (const webrtc::SdpVideoFormat& format :
       webrtc::SupportedVP9DecoderCodecs())
    formats.push_back(format);
  for (const webrtc::SdpVideoFormat& h264_format :
       webrtc::SupportedH264DecoderCodecs())
    formats.push_back(h264_format);

  formats.push_back(webrtc::SdpVideoFormat(
      webrtc::SdpVideoFormat::AV1Profile0(),
      webrtc::LibaomAv1EncoderSupportedScalabilityModes()));
  return formats;
}

VideoDecoderFactory::CodecSupport VideoDecoderFactory::QueryCodecSupport(
    const webrtc::SdpVideoFormat& format,
    bool reference_scaling) const {
  if (reference_scaling) {
    webrtc::VideoCodecType codec =
        webrtc::PayloadStringToCodecType(format.name);
    if (codec != webrtc::kVideoCodecVP9 && codec != webrtc::kVideoCodecAV1) {
      return {/*is_supported=*/false, /*is_power_efficient=*/false};
    }
  }

  CodecSupport codec_support;
  codec_support.is_supported = format.IsCodecInList(GetSupportedFormats());
  return codec_support;
}

std::unique_ptr<webrtc::VideoDecoder> VideoDecoderFactory::Create(
    const webrtc::Environment& env, const webrtc::SdpVideoFormat& format) {
  for (const auto& factory : factories_) {
    for (const auto& supported_format : factory->GetSupportedFormats()) {
      if (supported_format.IsSameCodec(format))
        return ObserveH264Startup(format, factory->Create(env, format));
    }
  }

  // IsSameCodec treats H.264 packetization-modes as distinct codecs, so when
  // the SFU sends mode=0 but the platform factory only advertises mode=1 the
  // strict match above fails. Retry with the factory's packetization-mode so
  // only that parameter is relaxed while the profile-level-id check is kept.
  if (absl::EqualsIgnoreCase(format.name, webrtc::kH264CodecName)) {
    for (const auto& factory : factories_) {
      for (const auto& sf : factory->GetSupportedFormats()) {
        if (!absl::EqualsIgnoreCase(sf.name, webrtc::kH264CodecName))
          continue;
        auto adjusted = format;
        auto it = sf.parameters.find("packetization-mode");
        if (it != sf.parameters.end())
          adjusted.parameters["packetization-mode"] = it->second;
        else
          adjusted.parameters.erase("packetization-mode");
        if (sf.IsSameCodec(adjusted))
          return ObserveH264Startup(adjusted,
                                    factory->Create(env, adjusted));
      }
    }
  }

  if (absl::EqualsIgnoreCase(format.name, webrtc::kVp8CodecName))
    return webrtc::CreateVp8Decoder(env);
  if (absl::EqualsIgnoreCase(format.name, webrtc::kVp9CodecName))
    return webrtc::VP9Decoder::Create();
  if (absl::EqualsIgnoreCase(format.name, webrtc::kH264CodecName))
    return ObserveH264Startup(format, webrtc::H264Decoder::Create());


#if defined(RTC_DAV1D_IN_INTERNAL_DECODER_FACTORY)
  if (absl::EqualsIgnoreCase(format.name, webrtc::kAv1CodecName)) {
    return webrtc::CreateDav1dDecoder();
  }
#endif


  RTC_LOG(LS_ERROR) << "No VideoDecoder found for " << format.name;
  return nullptr;
}

}  // namespace livekit_ffi
