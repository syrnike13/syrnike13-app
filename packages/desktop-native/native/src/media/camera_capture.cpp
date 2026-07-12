#include "camera_capture.hpp"

#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <stdexcept>

namespace syrnike::desktop_native::media {
namespace {
using Microsoft::WRL::ComPtr;
constexpr DWORD video_stream = static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM);

void check(HRESULT result, const char* message) {
  if (FAILED(result)) throw std::runtime_error(message);
}

std::wstring wide(const std::string& value) {
  if (value.empty()) return {};
  const auto size = MultiByteToWideChar(CP_UTF8, 0, value.data(),
    static_cast<int>(value.size()), nullptr, 0);
  std::wstring result(static_cast<std::size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
    result.data(), size);
  return result;
}

std::string utf8(const WCHAR* value, UINT32 length) {
  if (!value || length == 0) return {};
  const auto size = WideCharToMultiByte(CP_UTF8, 0, value,
    static_cast<int>(length), nullptr, 0, nullptr, nullptr);
  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, static_cast<int>(length),
    result.data(), size, nullptr, nullptr);
  return result;
}

class MfCameraCapture final : public CameraCapture {
 public:
  MfCameraCapture(const std::string& id, std::uint32_t width, std::uint32_t height, int fps) {
    IMFActivate** devices = nullptr;
    UINT32 count = 0;
    ComPtr<IMFAttributes> attributes;
    check(MFCreateAttributes(&attributes, 1), "camera attributes creation failed");
    check(attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
      MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID), "camera source type failed");
    check(MFEnumDeviceSources(attributes.Get(), &devices, &count), "camera enumeration failed");
    const auto wanted = wide(id);
    ComPtr<IMFMediaSource> source;
    for (UINT32 index = 0; index < count && !source; ++index) {
      WCHAR* symbolic = nullptr;
      UINT32 length = 0;
      devices[index]->GetAllocatedString(
        MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &symbolic, &length);
      const bool match = wanted.empty() || (symbolic && wanted == symbolic);
      CoTaskMemFree(symbolic);
      if (match) devices[index]->ActivateObject(IID_PPV_ARGS(&source));
    }
    for (UINT32 index = 0; index < count; ++index) devices[index]->Release();
    CoTaskMemFree(devices);
    if (!source) throw std::runtime_error("camera device not found");

    check(MFCreateSourceReaderFromMediaSource(source.Get(), nullptr, &reader_),
      "camera reader creation failed");
    ComPtr<IMFMediaType> type;
    check(MFCreateMediaType(&type), "camera media type creation failed");
    check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "camera major type failed");
    check(type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32), "camera RGB32 type failed");
    check(MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, width, height),
      "camera frame size failed");
    check(MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, static_cast<UINT32>(fps), 1),
      "camera frame rate failed");
    check(reader_->SetCurrentMediaType(video_stream, nullptr, type.Get()),
      "camera format is unsupported");
  }

  bool read(CameraFrame& frame, const std::atomic_bool& running) override {
    if (!running.load()) return false;
    DWORD flags = 0;
    ComPtr<IMFSample> sample;
    check(reader_->ReadSample(video_stream, 0, nullptr,
      &flags, nullptr, &sample), "camera sample read failed");
    if (flags & MF_SOURCE_READERF_ENDOFSTREAM) {
      throw std::runtime_error("camera stream ended");
    }
    if (!sample) return true;
    ComPtr<IMFMediaBuffer> buffer;
    check(sample->ConvertToContiguousBuffer(&buffer), "camera buffer conversion failed");
    BYTE* bytes = nullptr;
    DWORD length = 0;
    check(buffer->Lock(&bytes, nullptr, &length), "camera buffer lock failed");
    frame.bgra.assign(bytes, bytes + length);
    buffer->Unlock();
    ComPtr<IMFMediaType> type;
    check(reader_->GetCurrentMediaType(video_stream, &type),
      "camera media type unavailable");
    UINT32 width = 0, height = 0;
    check(MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &width, &height),
      "camera frame dimensions unavailable");
    frame.width = width;
    frame.height = height;
    return true;
  }

 private:
  ComPtr<IMFSourceReader> reader_;
};

class MfCameraCaptureFactory final : public CameraCaptureFactory {
 public:
  std::unique_ptr<CameraCapture> create(
    const std::string& id, std::uint32_t width, std::uint32_t height, int fps
  ) override {
    return std::make_unique<MfCameraCapture>(id, width, height, fps);
  }
};
}  // namespace

std::shared_ptr<CameraCaptureFactory> createMediaFoundationCameraCaptureFactory() {
  return std::make_shared<MfCameraCaptureFactory>();
}

std::vector<DeviceInfo> listCameraDevices() {
  check(MFStartup(MF_VERSION, MFSTARTUP_LITE), "Media Foundation startup failed");
  struct Shutdown { ~Shutdown() { MFShutdown(); } } shutdown;
  ComPtr<IMFAttributes> attributes;
  check(MFCreateAttributes(&attributes, 1), "camera attributes creation failed");
  check(attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID), "camera source type failed");
  IMFActivate** devices = nullptr;
  UINT32 count = 0;
  check(MFEnumDeviceSources(attributes.Get(), &devices, &count), "camera enumeration failed");
  std::vector<DeviceInfo> result;
  for (UINT32 index = 0; index < count; ++index) {
    WCHAR* id = nullptr; UINT32 id_length = 0;
    WCHAR* name = nullptr; UINT32 name_length = 0;
    devices[index]->GetAllocatedString(
      MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, &id, &id_length);
    devices[index]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
      &name, &name_length);
    result.push_back(DeviceInfo{utf8(id, id_length), utf8(name, name_length),
      "videoinput", index == 0});
    CoTaskMemFree(id); CoTaskMemFree(name); devices[index]->Release();
  }
  CoTaskMemFree(devices);
  return result;
}
}  // namespace syrnike::desktop_native::media
