#include "screen/hardware_h264_capability.hpp"

#include <strmif.h>
#include <codecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstdint>
#include <sstream>
#include <utility>

namespace syrnike::windows_media::screen {
namespace {

using Microsoft::WRL::ComPtr;

class MediaFoundationScope final {
 public:
  MediaFoundationScope() {
    const HRESULT com_result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    uninitialize_com_ = SUCCEEDED(com_result);
    if (FAILED(com_result) && com_result != RPC_E_CHANGED_MODE) return;
    started_ = SUCCEEDED(MFStartup(MF_VERSION, MFSTARTUP_FULL));
  }

  ~MediaFoundationScope() {
    if (started_) (void)MFShutdown();
    if (uninitialize_com_) CoUninitialize();
  }

  explicit operator bool() const noexcept { return started_; }

 private:
  bool started_ = false;
  bool uninitialize_com_ = false;
};

std::string hresultMessage(const char* operation, HRESULT result) {
  std::ostringstream message;
  message << operation << " failed with HRESULT 0x" << std::hex
          << static_cast<std::uint32_t>(result);
  return message.str();
}

std::string utf8Name(IMFActivate* activation) {
  WCHAR* wide = nullptr;
  UINT32 length = 0;
  if (FAILED(activation->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &wide,
                                             &length)) ||
      !wide)
    return "hardware H.264 MFT";
  const int required = WideCharToMultiByte(CP_UTF8, 0, wide,
                                            static_cast<int>(length), nullptr,
                                            0, nullptr, nullptr);
  std::string result(static_cast<std::size_t>((std::max)(required, 0)), '\0');
  if (required > 0) {
    (void)WideCharToMultiByte(CP_UTF8, 0, wide, static_cast<int>(length),
                              result.data(), required, nullptr, nullptr);
  }
  CoTaskMemFree(wide);
  return result.empty() ? "hardware H.264 MFT" : result;
}

bool setCodecU32(IMFTransform* transform, const GUID& key,
                 std::uint32_t value) {
  ComPtr<ICodecAPI> codec;
  if (FAILED(transform->QueryInterface(IID_PPV_ARGS(&codec)))) return false;
  VARIANT setting{};
  setting.vt = VT_UI4;
  setting.ulVal = value;
  return SUCCEEDED(codec->SetValue(&key, &setting));
}

HRESULT setOutputType(IMFTransform* transform,
                      const ScreenVideoProfile& profile) {
  ComPtr<IMFMediaType> output;
  HRESULT result = MFCreateMediaType(&output);
  if (SUCCEEDED(result))
    result = output->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  if (SUCCEEDED(result))
    result = output->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
  if (SUCCEEDED(result))
    result = MFSetAttributeSize(output.Get(), MF_MT_FRAME_SIZE, profile.width,
                                profile.height);
  if (SUCCEEDED(result))
    result = MFSetAttributeRatio(output.Get(), MF_MT_FRAME_RATE,
                                 profile.frames_per_second, 1);
  if (SUCCEEDED(result))
    result = MFSetAttributeRatio(output.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
  if (SUCCEEDED(result))
    result = output->SetUINT32(MF_MT_AVG_BITRATE, profile.bitrate);
  if (SUCCEEDED(result))
    result = output->SetUINT32(MF_MT_MPEG2_PROFILE,
                               eAVEncH264VProfile_ConstrainedBase);
  if (SUCCEEDED(result))
    result = output->SetUINT32(MF_MT_INTERLACE_MODE,
                               MFVideoInterlace_Progressive);
  if (SUCCEEDED(result))
    result = output->SetUINT32(MF_MT_YUV_MATRIX,
                               MFVideoTransferMatrix_BT709);
  if (SUCCEEDED(result))
    result = output->SetUINT32(MF_MT_VIDEO_PRIMARIES,
                               MFVideoPrimaries_BT709);
  if (SUCCEEDED(result))
    result = output->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
  if (SUCCEEDED(result))
    result = output->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE,
                               MFNominalRange_16_235);
  if (SUCCEEDED(result)) result = transform->SetOutputType(0, output.Get(), 0);
  return result;
}

HRESULT setInputType(IMFTransform* transform,
                     const ScreenVideoProfile& profile) {
  ComPtr<IMFMediaType> input;
  HRESULT result = MFCreateMediaType(&input);
  if (SUCCEEDED(result))
    result = input->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  if (SUCCEEDED(result))
    result = input->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
  if (SUCCEEDED(result))
    result = MFSetAttributeSize(input.Get(), MF_MT_FRAME_SIZE, profile.width,
                                profile.height);
  if (SUCCEEDED(result))
    result = MFSetAttributeRatio(input.Get(), MF_MT_FRAME_RATE,
                                 profile.frames_per_second, 1);
  if (SUCCEEDED(result))
    result = input->SetUINT32(MF_MT_INTERLACE_MODE,
                              MFVideoInterlace_Progressive);
  if (SUCCEEDED(result))
    result = input->SetUINT32(MF_MT_YUV_MATRIX,
                              MFVideoTransferMatrix_BT709);
  if (SUCCEEDED(result))
    result = input->SetUINT32(MF_MT_VIDEO_PRIMARIES,
                              MFVideoPrimaries_BT709);
  if (SUCCEEDED(result))
    result = input->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
  if (SUCCEEDED(result))
    result = input->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE,
                              MFNominalRange_16_235);
  if (SUCCEEDED(result)) result = transform->SetInputType(0, input.Get(), 0);
  return result;
}

struct ActivationArray {
  IMFActivate** values = nullptr;
  UINT32 count = 0;
  ~ActivationArray() {
    for (UINT32 index = 0; index < count; ++index) values[index]->Release();
    CoTaskMemFree(values);
  }
};

bool configureActivation(
    IMFActivate* activation,
    const std::shared_ptr<capture::D3d11DeviceOwner>& owner,
    const ScreenVideoProfile& profile, std::string& transform_name) {
  ComPtr<IMFTransform> transform;
  if (FAILED(activation->ActivateObject(IID_PPV_ARGS(&transform)))) return false;
  const auto shutdown = [&] {
    ComPtr<IMFShutdown> shutdown_interface;
    if (SUCCEEDED(transform.As(&shutdown_interface)))
      (void)shutdown_interface->Shutdown();
    (void)activation->ShutdownObject();
  };

  ComPtr<IMFAttributes> attributes;
  UINT32 asynchronous = FALSE;
  bool usable = SUCCEEDED(transform->GetAttributes(&attributes));
  if (usable) {
    (void)attributes->GetUINT32(MF_TRANSFORM_ASYNC, &asynchronous);
    usable = SUCCEEDED(attributes->SetUINT32(MF_LOW_LATENCY, TRUE));
  }
  if (usable && asynchronous) {
    ComPtr<IMFMediaEventGenerator> events;
    ComPtr<IMFShutdown> shutdown_interface;
    usable = SUCCEEDED(attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE)) &&
             SUCCEEDED(transform.As(&events)) &&
             SUCCEEDED(transform.As(&shutdown_interface));
  }

  UINT manager_token = 0;
  ComPtr<IMFDXGIDeviceManager> manager;
  if (usable)
    usable = SUCCEEDED(MFCreateDXGIDeviceManager(&manager_token, &manager)) &&
             SUCCEEDED(manager->ResetDevice(owner->device(), manager_token)) &&
             SUCCEEDED(transform->ProcessMessage(
                 MFT_MESSAGE_SET_D3D_MANAGER,
                 reinterpret_cast<ULONG_PTR>(manager.Get())));
  if (usable) usable = SUCCEEDED(setOutputType(transform.Get(), profile));
  if (usable) usable = SUCCEEDED(setInputType(transform.Get(), profile));
  if (usable)
    usable = setCodecU32(transform.Get(), CODECAPI_AVLowLatencyMode, TRUE) &&
             setCodecU32(transform.Get(), CODECAPI_AVEncCommonRateControlMode,
                         eAVEncCommonRateControlMode_CBR) &&
             setCodecU32(transform.Get(), CODECAPI_AVEncCommonMeanBitRate,
                         profile.bitrate);
  if (usable) {
    (void)setCodecU32(transform.Get(), CODECAPI_AVEncMPVDefaultBPictureCount,
                      0);
    MFT_OUTPUT_STREAM_INFO output_info{};
    usable = SUCCEEDED(transform->GetOutputStreamInfo(0, &output_info)) &&
             SUCCEEDED(transform->ProcessMessage(
                 MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)) &&
             SUCCEEDED(transform->ProcessMessage(
                 MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0));
  }
  if (usable) transform_name = utf8Name(activation);
  shutdown();
  return usable;
}

HardwareH264ProfileCapability probeProfile(
    const std::shared_ptr<capture::D3d11DeviceOwner>& owner,
    ScreenVideoProfile profile) {
  HardwareH264ProfileCapability result{profile};
  MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_NV12};
  MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_H264};
  ActivationArray activations;
  const HRESULT enumeration = MFTEnumEx(
      MFT_CATEGORY_VIDEO_ENCODER,
      MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, &input, &output,
      &activations.values, &activations.count);
  if (FAILED(enumeration)) return result;
  for (UINT32 index = 0; index < activations.count; ++index) {
    if (configureActivation(activations.values[index], owner, profile,
                            result.transform_name)) {
      result.available = true;
      break;
    }
  }
  return result;
}

}  // namespace

HardwareH264Capability probeHardwareH264(
    const std::shared_ptr<capture::D3d11DeviceOwner>& device_owner,
    std::span<const ScreenVideoProfile> profiles) {
  HardwareH264Capability result;
  if (!device_owner || profiles.empty()) {
    result.failure = HardwareH264Failure{
        "screen_hardware_h264_probe_invalid",
        "Hardware H.264 probe requires a D3D11 device and fixed profiles",
        "encoder_probe"};
    return result;
  }
  result.adapter_luid = device_owner->adapterLuid();
  MediaFoundationScope media_foundation;
  if (!media_foundation) {
    result.failure = HardwareH264Failure{
        "screen_media_foundation_unavailable",
        hresultMessage("MFStartup", E_FAIL), "encoder_probe"};
    return result;
  }
  result.profiles.reserve(profiles.size());
  for (const auto profile : profiles)
    result.profiles.push_back(probeProfile(device_owner, profile));
  result.available = std::all_of(
      result.profiles.begin(), result.profiles.end(),
      [](const auto& profile) { return profile.available; });
  if (!result.available) {
    result.failure = HardwareH264Failure{
        "screen_hardware_h264_profile_unsupported",
        "No hardware Media Foundation H.264 encoder supports every fixed profile",
        "encoder_probe"};
  }
  return result;
}

}  // namespace syrnike::windows_media::screen
