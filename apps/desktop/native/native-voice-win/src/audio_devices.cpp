#include "audio_devices.hpp"

#include <functiondiscoverykeys_devpkey.h>
#include <propsys.h>

#include <stdexcept>

#include "audio_constants.hpp"
#include "protocol.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::voice {
namespace {

std::wstring widen(const std::string& value) {
  if (value.empty()) return {};
  const int count = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(count), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), count);
  return out;
}

std::string narrow(const std::wstring& value) {
  if (value.empty()) return {};
  const int count = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(count), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), count, nullptr, nullptr);
  return out;
}

std::string deviceFriendlyName(const ComPtr<IMMDevice>& device, const std::string& fallback) {
  ComPtr<IPropertyStore> store;
  HRESULT hr = device->OpenPropertyStore(STGM_READ, &store);
  if (FAILED(hr) || !store) return fallback;

  PROPVARIANT name;
  PropVariantInit(&name);
  hr = store->GetValue(PKEY_Device_FriendlyName, &name);
  if (SUCCEEDED(hr) && name.vt == VT_LPWSTR && name.pwszVal) {
    const std::string label = narrow(name.pwszVal);
    PropVariantClear(&name);
    if (!label.empty()) return label;
    return fallback;
  }

  PropVariantClear(&name);
  return fallback;
}

}  // namespace

ComPtr<IMMDevice> getCaptureDevice(const std::string& device_id) {
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
  if (FAILED(hr)) throw std::runtime_error("failed to create MMDeviceEnumerator");

  ComPtr<IMMDevice> device;
  if (!device_id.empty() && device_id != "default") {
    const std::wstring wide_id = widen(device_id);
    hr = enumerator->GetDevice(wide_id.c_str(), &device);
  } else {
    hr = enumerator->GetDefaultAudioEndpoint(eCapture, eCommunications, &device);
  }
  if (FAILED(hr) || !device) throw std::runtime_error("failed to open capture device");
  return device;
}

ComPtr<IMMDevice> getRenderDevice() {
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
  if (FAILED(hr)) throw std::runtime_error("failed to create MMDeviceEnumerator");

  ComPtr<IMMDevice> device;
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  if (FAILED(hr) || !device) throw std::runtime_error("failed to open render device");
  return device;
}

void emitDeviceList() {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool com_initialized = SUCCEEDED(hr);

  try {
    ComPtr<IMMDeviceEnumerator> enumerator;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
    if (FAILED(hr) || !enumerator) {
      throw std::runtime_error("failed to create MMDeviceEnumerator");
    }

    ComPtr<IMMDeviceCollection> collection;
    hr = enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection);
    if (FAILED(hr) || !collection) {
      throw std::runtime_error("failed to enumerate capture devices");
    }

    UINT count = 0;
    hr = collection->GetCount(&count);
    if (FAILED(hr)) {
      throw std::runtime_error("failed to read capture device count");
    }

    std::string json = "{\"type\":\"device_list\",\"devices\":[";
    bool first = true;
    for (UINT index = 0; index < count; ++index) {
      ComPtr<IMMDevice> device;
      hr = collection->Item(index, &device);
      if (FAILED(hr) || !device) continue;

      LPWSTR raw_id = nullptr;
      hr = device->GetId(&raw_id);
      if (FAILED(hr) || !raw_id) continue;

      const std::string id = narrow(raw_id);
      CoTaskMemFree(raw_id);

      const std::string label = deviceFriendlyName(
        device,
        "Microphone " + std::to_string(index + 1)
      );

      if (!first) json += ",";
      first = false;
      json += "{\"deviceId\":\"" + jsonEscape(id) +
              "\",\"kind\":\"audioinput\",\"label\":\"" +
              jsonEscape(label) + "\"}";
    }
    json += "]}";
    emit(json);
  } catch (const std::exception& error) {
    emitError("device_list_failed", error.what());
  }

  if (com_initialized) CoUninitialize();
}

WAVEFORMATEX desiredCaptureFormat() {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = kChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = 32;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  return format;
}

WAVEFORMATEX desiredRenderFormat() {
  return desiredCaptureFormat();
}

}  // namespace syrnike::voice
