/*
 * Copyright 2026 LiveKit
 * SPDX-License-Identifier: Apache-2.0
 */
#include "livekit/d3d11_h264_video_source.h"

#ifdef _WIN32
#include <codecapi.h>
#include <icodecapi.h>
#include <objbase.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#endif

#include "ffi.pb.h"
#include "ffi_client.h"

namespace livekit {

namespace {
#ifdef _WIN32
bool setRequiredCodecU32(
    IMFTransform* transform, const GUID& key, UINT32 value) {
  ICodecAPI* codec_api = nullptr;
  if (FAILED(transform->QueryInterface(IID_PPV_ARGS(&codec_api))))
    return false;
  VARIANT setting{};
  setting.vt = VT_UI4;
  setting.ulVal = value;
  const HRESULT result = codec_api->SetValue(&key, &setting);
  codec_api->Release();
  return result == S_OK;
}

bool configureRequiredEncoderControls(IMFTransform* transform) {
  return setRequiredCodecU32(
             transform,
             CODECAPI_AVEncCommonRateControlMode,
             eAVEncCommonRateControlMode_CBR) &&
         setRequiredCodecU32(
             transform, CODECAPI_AVEncCommonMeanBitRate, 2'500'000) &&
         setRequiredCodecU32(
             transform, CODECAPI_AVEncVideoForceKeyFrame, FALSE);
}

D3D11H264Capability queryD3D11H264CapabilityImpl(
    const std::uint64_t* adapter_luid) {
  const HRESULT com_hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool uninitialize_com = SUCCEEDED(com_hr);
  if (FAILED(com_hr) && com_hr != RPC_E_CHANGED_MODE) {
    return {false, "COM initialization failed"};
  }
  if (FAILED(MFStartup(MF_VERSION))) {
    if (uninitialize_com) CoUninitialize();
    return {false, "MFStartup failed"};
  }

  IMFAttributes* enumeration_attributes = nullptr;
  HRESULT hr = S_OK;
  if (adapter_luid) {
    hr = MFCreateAttributes(&enumeration_attributes, 1);
    if (SUCCEEDED(hr)) {
      const LUID luid{
          static_cast<DWORD>(*adapter_luid),
          static_cast<LONG>(*adapter_luid >> 32),
      };
      hr = enumeration_attributes->SetBlob(
          MFT_ENUM_ADAPTER_LUID,
          reinterpret_cast<const UINT8*>(&luid),
          sizeof(luid));
    }
  }

  MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_H264};
  IMFActivate** activations = nullptr;
  UINT32 count = 0;
  if (SUCCEEDED(hr)) {
    hr = adapter_luid
             ? MFTEnum2(
                   MFT_CATEGORY_VIDEO_ENCODER,
                   MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                   nullptr,
                   &output,
                   enumeration_attributes,
                   &activations,
                   &count)
             : MFTEnumEx(
                   MFT_CATEGORY_VIDEO_ENCODER,
                   MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                   nullptr,
                   &output,
                   &activations,
                   &count);
  }
  if (enumeration_attributes) enumeration_attributes->Release();

  bool supported_hardware = false;
  for (UINT32 i = 0; i < count; ++i) {
    IMFTransform* transform = nullptr;
    if (SUCCEEDED(activations[i]->ActivateObject(IID_PPV_ARGS(&transform)))) {
      IMFAttributes* attributes = nullptr;
      UINT32 asynchronous = FALSE;
      UINT32 d3d11_aware = FALSE;
      if (SUCCEEDED(transform->GetAttributes(&attributes))) {
        attributes->GetUINT32(MF_TRANSFORM_ASYNC, &asynchronous);
        bool usable =
            SUCCEEDED(attributes->GetUINT32(
                MF_SA_D3D11_AWARE, &d3d11_aware)) &&
            d3d11_aware;
        if (asynchronous) {
          IMFMediaEventGenerator* events = nullptr;
          IMFShutdown* shutdown = nullptr;
          usable = usable &&
                   SUCCEEDED(attributes->SetUINT32(
                       MF_TRANSFORM_ASYNC_UNLOCK, TRUE)) &&
                   SUCCEEDED(transform->QueryInterface(
                       IID_PPV_ARGS(&events))) &&
                   SUCCEEDED(transform->QueryInterface(
                       IID_PPV_ARGS(&shutdown)));
          if (events) events->Release();
          if (shutdown) shutdown->Release();
        }
        usable = usable && configureRequiredEncoderControls(transform);
        supported_hardware = supported_hardware || usable;
        attributes->Release();
      }
      transform->Release();
      activations[i]->ShutdownObject();
    }
    activations[i]->Release();
  }
  CoTaskMemFree(activations);
  MFShutdown();
  if (uninitialize_com) CoUninitialize();
  if (FAILED(hr) || count == 0 || !supported_hardware) {
    return {
        false,
        adapter_luid
            ? "no compatible Media Foundation H.264 encoder exists for the capture adapter"
            : "no supported hardware Media Foundation H.264 encoder was enumerated",
    };
  }
  return {true, {}};
}
#endif

class D3D11H264VideoSourceImpl final : public D3D11H264VideoSource {
 public:
  D3D11H264VideoSourceImpl(int width, int height)
      : D3D11H264VideoSource(width, height) {}

  bool capture(std::unique_ptr<D3D11TextureLease> lease,
               std::int64_t timestamp_us) override {
    if (!lease || !ffiHandleId()) return false;
    const auto& texture = lease->texture();
    proto::FfiRequest request;
    auto* capture = request.mutable_capture_d3d11_video_frame();
    capture->set_source_handle(ffiHandleId());
    capture->set_shared_texture_handle(texture.shared_handle);
    capture->set_adapter_luid(texture.adapter_luid);
    capture->set_acquire_key(texture.acquire_key);
    capture->set_release_key(texture.release_key);
    capture->set_width(texture.width);
    capture->set_height(texture.height);
    capture->set_timestamp_us(timestamp_us);
    const auto response = FfiClient::instance().sendRequest(request);
    if (!response.has_capture_d3d11_video_frame()) return false;
    // The encoder owns keyed-mutex synchronization after submission. The
    // producer may recycle the slot only after it observes release_key.
    lease->accepted();
    return true;
  }
};
}  // namespace

D3D11H264Capability queryD3D11H264Capability() {
#ifdef _WIN32
  return queryD3D11H264CapabilityImpl(nullptr);
#else
  return {false, "Windows D3D11 H.264 is unavailable on this platform"};
#endif
}

D3D11H264Capability queryD3D11H264CapabilityForAdapter(
    std::uint64_t adapter_luid) {
#ifdef _WIN32
  return queryD3D11H264CapabilityImpl(&adapter_luid);
#else
  (void)adapter_luid;
  return {false, "Windows D3D11 H.264 is unavailable on this platform"};
#endif
}

std::unique_ptr<D3D11H264VideoSource> createD3D11H264VideoSource(
    int width, int height) {
  if (!queryD3D11H264Capability().available || width <= 0 || height <= 0 ||
      (width & 1) || (height & 1)) {
    return nullptr;
  }
  return std::make_unique<D3D11H264VideoSourceImpl>(width, height);
}

}  // namespace livekit
