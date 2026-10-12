#include "audio/audio_device_registry.hpp"

#include <windows.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <atomic>
#include <stdexcept>

namespace syrnike::windows_media::audio {
namespace {
using Microsoft::WRL::ComPtr;
struct NotificationState { std::atomic<std::uint64_t> revision{1}; };
class Notifications final
    : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                                         IMMNotificationClient> {
 public:
  explicit Notifications(std::shared_ptr<NotificationState> state) : state_(std::move(state)) {}
  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR, DWORD) override { return signal(); }
  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { return signal(); }
  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) override { return signal(); }
  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow, ERole role, LPCWSTR) override {
    return role == eMultimedia ? signal() : S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return signal(); }
 private:
  HRESULT signal() noexcept {
    state_->revision.fetch_add(1, std::memory_order_relaxed);
    return S_OK;
  }
  std::shared_ptr<NotificationState> state_;
};
struct Apartment {
  HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
};
std::wstring endpointId(IMMDevice* device) {
  LPWSTR raw = nullptr;
  if (FAILED(device->GetId(&raw))) throw std::runtime_error("Audio endpoint identity unavailable");
  const std::unique_ptr<wchar_t, decltype(&CoTaskMemFree)> owned(raw, CoTaskMemFree);
  const auto size = wcsnlen_s(raw, 4097);
  if (!size || size > 4096) throw std::runtime_error("Invalid audio endpoint identity");
  return std::wstring(raw, size);
}
std::string endpointLabel(IMMDevice* device) {
  ComPtr<IPropertyStore> properties;
  if (FAILED(device->OpenPropertyStore(STGM_READ, &properties))) return {};
  struct Property {
    PROPVARIANT value{};
    ~Property() { PropVariantClear(&value); }
  } property;
  if (FAILED(properties->GetValue(PKEY_Device_FriendlyName, &property.value)) ||
      property.value.vt != VT_LPWSTR || !property.value.pwszVal) return {};
  const auto length = wcsnlen_s(property.value.pwszVal, 257);
  if (length > 256) return {};
  const auto size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, property.value.pwszVal,
                                       static_cast<int>(length), nullptr, 0, nullptr, nullptr);
  if (size <= 0 || size > 1024) return {};
  std::string label(static_cast<std::size_t>(size), '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, property.value.pwszVal,
                           static_cast<int>(length), label.data(), size, nullptr, nullptr)) return {};
  return label;
}
class WindowsAudioDeviceEnumerator final : public AudioDeviceEnumerator {
 public:
  WindowsAudioDeviceEnumerator() {
    if (FAILED(apartment_.result) ||
        FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                IID_PPV_ARGS(&enumerator_))))
      throw std::runtime_error("Windows audio registry initialization failed");
    notifications_ = Microsoft::WRL::Make<Notifications>(state_);
    if (!notifications_ || FAILED(enumerator_->RegisterEndpointNotificationCallback(notifications_.Get())))
      throw std::runtime_error("Windows audio notifications unavailable");
  }
  ~WindowsAudioDeviceEnumerator() override {
    if (owner_ != std::this_thread::get_id()) std::terminate();
    // Retain the callback through unregistration. Any in-flight callback holds
    // only its own atomic state, never a raw registry/COM owner pointer.
    if (FAILED(enumerator_->UnregisterEndpointNotificationCallback(notifications_.Get())))
      std::terminate();
  }
  bool changed() const noexcept override {
    return state_->revision.load(std::memory_order_relaxed) != observed_revision_;
  }
  std::optional<std::vector<AudioEndpoint>> enumerate() override {
    if (owner_ != std::this_thread::get_id()) throw std::logic_error("Wrong audio enumeration owner");
    const auto revision = state_->revision.load(std::memory_order_relaxed);
    try {
      std::vector<AudioEndpoint> result;
      result.reserve(kAudioDeviceCapacity);
      for (const auto direction : {AudioDirection::input, AudioDirection::output}) {
        const auto flow = direction == AudioDirection::input ? eCapture : eRender;
        ComPtr<IMMDevice> default_device;
        std::wstring default_id;
        const auto default_result = enumerator_->GetDefaultAudioEndpoint(flow, eMultimedia, &default_device);
        if (SUCCEEDED(default_result)) default_id = endpointId(default_device.Get());
        else if (default_result != E_NOTFOUND) return {};
        ComPtr<IMMDeviceCollection> devices;
        if (FAILED(enumerator_->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &devices))) return {};
        UINT count = 0;
        if (FAILED(devices->GetCount(&count))) return {};
        if (result.size() + count > kAudioDeviceCapacity) {
          // The registry translates this bounded sentinel into capacity_exceeded.
          return std::vector<AudioEndpoint>(kAudioDeviceCapacity + 1);
        }
        for (UINT index = 0; index < count; ++index) {
          ComPtr<IMMDevice> device;
          if (FAILED(devices->Item(index, &device))) return {};
          auto id = endpointId(device.Get());
          const bool is_default = id == default_id;
          result.push_back({std::move(id), direction, endpointLabel(device.Get()), is_default});
        }
      }
      observed_revision_ = revision;
      return result;
    } catch (...) {
      return {};
    }
  }
 private:
  const std::thread::id owner_ = std::this_thread::get_id();
  Apartment apartment_; // Outlives every COM member.
  ComPtr<IMMDeviceEnumerator> enumerator_;
  std::shared_ptr<NotificationState> state_ = std::make_shared<NotificationState>();
  ComPtr<Notifications> notifications_;
  std::uint64_t observed_revision_ = 0;
};
}  // namespace
std::unique_ptr<AudioDeviceEnumerator> makeWindowsAudioDeviceEnumerator() {
  return std::make_unique<WindowsAudioDeviceEnumerator>();
}
}  // namespace syrnike::windows_media::audio
