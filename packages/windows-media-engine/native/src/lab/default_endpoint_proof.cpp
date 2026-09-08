#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <propsys.h>
#include <wrl/client.h>
#include <array>
#include <iostream>
#include <string>
#include <string_view>
#include <thread>
#include <chrono>
// Standalone, opt-in lab helper; never part of the product. Windows exposes
// default-endpoint mutation only through this undocumented policy interface.
// ABI reference: xenolightning/AudioSwitcher POLICY_CONFIG_7_IID.
struct __declspec(uuid("f8679f50-850a-41cf-9c72-430f290290c8")) Policy : IUnknown {
  virtual HRESULT STDMETHODCALLTYPE GetMixFormat(PCWSTR, WAVEFORMATEX**) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetDeviceFormat(PCWSTR, INT, WAVEFORMATEX**) = 0;
  virtual HRESULT STDMETHODCALLTYPE ResetDeviceFormat(PCWSTR) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetDeviceFormat(PCWSTR, WAVEFORMATEX*, WAVEFORMATEX*) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetProcessingPeriod(PCWSTR, INT, PINT64, PINT64) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetProcessingPeriod(PCWSTR, PINT64) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetShareMode(PCWSTR, void*) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetShareMode(PCWSTR, void*) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetPropertyValue(PCWSTR, const PROPERTYKEY&, PROPVARIANT*) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetPropertyValue(PCWSTR, const PROPERTYKEY&, PROPVARIANT*) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetDefaultEndpoint(PCWSTR, ERole) = 0;
  virtual HRESULT STDMETHODCALLTYPE SetEndpointVisibility(PCWSTR, INT) = 0;
};
using Microsoft::WRL::ComPtr;
void check(HRESULT result) {
  if (FAILED(result)) throw std::runtime_error("Default endpoint helper API failed");
}
std::wstring current(IMMDeviceEnumerator* enumerator, EDataFlow flow, ERole role) {
  ComPtr<IMMDevice> device;
  check(enumerator->GetDefaultAudioEndpoint(flow, role, &device));
  LPWSTR id = nullptr;
  check(device->GetId(&id));
  std::wstring value(id);
  CoTaskMemFree(id);
  return value;
}
int wmain(int argc, wchar_t** argv) {
  const bool input = argc == 3 && std::wstring_view(argv[1]) == L"--input";
  if (argc != 2 && !input) return 1;
  const auto flow = input ? eCapture : eRender;
  const auto* endpoint = argv[input ? 2 : 1];
  check(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
  int result = 0;
  {
    ComPtr<IMMDeviceEnumerator> enumerator;
    ComPtr<Policy> policy;
    std::array<std::wstring, 2> original;
    unsigned changed = 0;
    try {
      check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                             IID_PPV_ARGS(&enumerator)));
      CLSID clsid;
      check(CLSIDFromString(L"{870af99c-171d-4f9e-af0d-e63df40c2bc9}", &clsid));
      check(CoCreateInstance(clsid, nullptr, CLSCTX_ALL, IID_PPV_ARGS(&policy)));
      ComPtr<IMMDevice> target;
      check(enumerator->GetDevice(endpoint, &target));
      ComPtr<IMMEndpoint> endpoint_info;
      check(target.As(&endpoint_info));
      EDataFlow actual_flow;
      check(endpoint_info->GetDataFlow(&actual_flow));
      if (actual_flow != flow) throw std::runtime_error("Wrong endpoint direction");
      DWORD state = 0;
      check(target->GetState(&state));
      if (state != DEVICE_STATE_ACTIVE) throw std::runtime_error("Target endpoint inactive");
      for (unsigned role = 0; role < 2; ++role)
        original[role] = current(enumerator.Get(), flow, static_cast<ERole>(role));
      for (unsigned role = 0; role < 2; ++role) {
        if (_wcsicmp(original[role].c_str(), endpoint) == 0)
          throw std::runtime_error("Proof requires a different endpoint");
        ++changed;
        check(policy->SetDefaultEndpoint(endpoint, static_cast<ERole>(role)));
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds{2};
        while (_wcsicmp(current(enumerator.Get(), flow, static_cast<ERole>(role)).c_str(), endpoint) !=
                   0 &&
               std::chrono::steady_clock::now() < deadline)
          std::this_thread::sleep_for(std::chrono::milliseconds{20});
        if (_wcsicmp(current(enumerator.Get(), flow, static_cast<ERole>(role)).c_str(), endpoint) != 0)
          throw std::runtime_error("Default did not switch");
      }
      std::cout << "DEFAULT_ENDPOINT_CHANGED" << std::endl;
      std::this_thread::sleep_for(std::chrono::seconds{5});
    } catch (const std::exception& error) {
      std::cerr << error.what() << std::endl;
      result = 1;
    }
    for (unsigned role = 0; role < changed; ++role) {
      const auto restored =
          policy->SetDefaultEndpoint(original[role].c_str(), static_cast<ERole>(role));
      if (FAILED(restored) || current(enumerator.Get(), flow, static_cast<ERole>(role)) != original[role])
        result = 2;
    }
    if (changed && result != 2) std::cout << "DEFAULT_ENDPOINT_RESTORED" << std::endl;
  }
  CoUninitialize();
  return result;
}
