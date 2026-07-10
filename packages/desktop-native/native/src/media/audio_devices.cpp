#include "audio_devices.hpp"

#include <functiondiscoverykeys_devpkey.h>
#include <propsys.h>
#include <windows.h>

#include <stdexcept>

using Microsoft::WRL::ComPtr;

namespace syrnike::desktop_native::media {
namespace {

std::string utf8(const wchar_t* value) {
  if (!value || *value == L'\0') return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) return {};
  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), size, nullptr, nullptr);
  result.resize(static_cast<std::size_t>(size - 1));
  return result;
}

ComPtr<IMMDeviceEnumerator> enumerator() {
  ComPtr<IMMDeviceEnumerator> value;
  const auto result = CoCreateInstance(
    __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&value)
  );
  if (FAILED(result)) throw std::runtime_error("failed to create MMDeviceEnumerator");
  return value;
}

ComPtr<IMMDevice> defaultDevice(EDataFlow flow) {
  ComPtr<IMMDevice> device;
  const auto result = enumerator()->GetDefaultAudioEndpoint(flow, eCommunications, &device);
  if (FAILED(result)) throw std::runtime_error("default audio endpoint is unavailable");
  return device;
}

std::string deviceId(IMMDevice* device) {
  LPWSTR raw = nullptr;
  if (!device || FAILED(device->GetId(&raw)) || !raw) return {};
  const auto result = utf8(raw);
  CoTaskMemFree(raw);
  return result;
}

std::string deviceLabel(IMMDevice* device) {
  ComPtr<IPropertyStore> properties;
  if (!device || FAILED(device->OpenPropertyStore(STGM_READ, &properties))) return {};
  PROPVARIANT value;
  PropVariantInit(&value);
  const auto result = properties->GetValue(PKEY_Device_FriendlyName, &value);
  const auto label = SUCCEEDED(result) && value.vt == VT_LPWSTR ? utf8(value.pwszVal) : std::string{};
  PropVariantClear(&value);
  return label;
}

void appendDevices(
  EDataFlow flow,
  const char* kind,
  const std::string& default_id,
  std::vector<DeviceInfo>& output
) {
  ComPtr<IMMDeviceCollection> collection;
  if (FAILED(enumerator()->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &collection))) return;
  UINT count = 0;
  if (FAILED(collection->GetCount(&count))) return;
  for (UINT index = 0; index < count; ++index) {
    ComPtr<IMMDevice> device;
    if (FAILED(collection->Item(index, &device))) continue;
    auto id = deviceId(device.Get());
    if (id.empty()) continue;
    output.push_back(DeviceInfo{
      std::move(id),
      deviceLabel(device.Get()),
      kind,
      output.empty() ? false : false,
    });
    output.back().is_default = output.back().device_id == default_id;
  }
}

}  // namespace

ComPtr<IMMDevice> captureDevice(const std::string& device_id) {
  if (device_id.empty() || device_id == "default") return defaultDevice(eCapture);
  const int length = MultiByteToWideChar(
    CP_UTF8, 0, device_id.data(), static_cast<int>(device_id.size()), nullptr, 0
  );
  std::wstring wide(static_cast<std::size_t>(length), L'\0');
  MultiByteToWideChar(
    CP_UTF8, 0, device_id.data(), static_cast<int>(device_id.size()), wide.data(), length
  );
  ComPtr<IMMDevice> device;
  if (FAILED(enumerator()->GetDevice(wide.c_str(), &device))) {
    throw std::runtime_error("selected microphone is unavailable");
  }
  return device;
}

ComPtr<IMMDevice> renderDevice() {
  return defaultDevice(eRender);
}

std::vector<DeviceInfo> listAudioDevices() {
  std::vector<DeviceInfo> result;
  std::string default_capture;
  std::string default_render;
  try { default_capture = deviceId(defaultDevice(eCapture).Get()); } catch (...) {}
  try { default_render = deviceId(defaultDevice(eRender).Get()); } catch (...) {}
  appendDevices(eCapture, "audioinput", default_capture, result);
  appendDevices(eRender, "audiooutput", default_render, result);
  return result;
}

WAVEFORMATEX desiredCaptureFormat() {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = 1;
  format.nSamplesPerSec = 48'000;
  format.wBitsPerSample = 32;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  return format;
}

WAVEFORMATEX desiredRenderFormat() {
  return desiredCaptureFormat();
}

}  // namespace syrnike::desktop_native::media

namespace syrnike::voice {

Microsoft::WRL::ComPtr<IMMDevice> getCaptureDevice(const std::string& device_id) {
  return desktop_native::media::captureDevice(device_id);
}

Microsoft::WRL::ComPtr<IMMDevice> getRenderDevice() {
  return desktop_native::media::renderDevice();
}

}  // namespace syrnike::voice
