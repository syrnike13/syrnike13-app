/*
 * Copyright 2026 LiveKit
 * SPDX-License-Identifier: Apache-2.0
 */
#include "livekit/d3d11_h264_video_source.h"

#ifdef _WIN32
#include <objbase.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#endif

#include "ffi.pb.h"
#include "ffi_client.h"

namespace livekit {

namespace {
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
  const HRESULT com_hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool uninitialize_com = SUCCEEDED(com_hr);
  if (FAILED(com_hr) && com_hr != RPC_E_CHANGED_MODE) {
    return {false, "COM initialization failed"};
  }
  if (FAILED(MFStartup(MF_VERSION))) {
    if (uninitialize_com) CoUninitialize();
    return {false, "MFStartup failed"};
  }
  MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_H264};
  IMFActivate** activations = nullptr;
  UINT32 count = 0;
  const HRESULT hr = MFTEnumEx(
      MFT_CATEGORY_VIDEO_ENCODER,
      MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, nullptr, &output,
      &activations, &count);
  bool supported_hardware = false;
  for (UINT32 i = 0; i < count; ++i) {
    IMFTransform* transform = nullptr;
    if (SUCCEEDED(activations[i]->ActivateObject(IID_PPV_ARGS(&transform)))) {
      IMFAttributes* attributes = nullptr;
      UINT32 asynchronous = FALSE;
      if (SUCCEEDED(transform->GetAttributes(&attributes))) {
        attributes->GetUINT32(MF_TRANSFORM_ASYNC, &asynchronous);
        bool usable = true;
        if (asynchronous) {
          IMFMediaEventGenerator* events = nullptr;
          IMFShutdown* shutdown = nullptr;
          usable = SUCCEEDED(attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE)) &&
                   SUCCEEDED(transform->QueryInterface(IID_PPV_ARGS(&events))) &&
                   SUCCEEDED(transform->QueryInterface(IID_PPV_ARGS(&shutdown)));
          if (events) events->Release();
          if (shutdown) shutdown->Release();
        }
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
    return {false, "no supported hardware Media Foundation H.264 encoder was enumerated"};
  }
  return {true, {}};
#else
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
