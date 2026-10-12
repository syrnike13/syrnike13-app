#include "camera/camera_device_registry.hpp"

#include <windows.h>
#include <cfgmgr32.h>
#include <initguid.h>
#include <devpkey.h>
#include <mfapi.h>
#include <mfidl.h>
#include <ks.h>
#include <ksmedia.h>
#include <setupapi.h>
#include <wdmguid.h>
#include <wrl/client.h>

#include <array>
#include <atomic>
#include <stdexcept>

namespace syrnike::windows_media::camera {
namespace {
using Microsoft::WRL::ComPtr;
std::wstring attributeString(IMFAttributes* attributes, REFGUID key, UINT32 limit) {
  UINT32 length = 0;
  if (FAILED(attributes->GetStringLength(key, &length)) || !length || length > limit)
    throw std::runtime_error("Camera attribute is invalid");
  std::wstring value(length + 1, L'\0');
  if (FAILED(attributes->GetString(key, value.data(), length + 1, &length)))
    throw std::runtime_error("Camera attribute unavailable");
  value.resize(length);
  return value;
}
std::string utf8(const std::wstring& value) {
  const auto length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (length <= 0 || length > 1024) throw std::runtime_error("Camera label is invalid");
  std::string result(static_cast<std::size_t>(length), '\0');
  if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
                          result.data(), length, nullptr, nullptr)) throw std::runtime_error("Camera label unavailable");
  return result;
}
struct DeviceInfoSet {
  HDEVINFO value = SetupDiCreateDeviceInfoList(nullptr, nullptr);
  ~DeviceInfoSet() { if (value != INVALID_HANDLE_VALUE) SetupDiDestroyDeviceInfoList(value); }
};
void inspectDevice(CameraEndpoint& endpoint, bool software_source) {
  if (software_source) endpoint.kind = CameraDeviceKind::virtual_camera;
  DeviceInfoSet devices;
  if (devices.value == INVALID_HANDLE_VALUE) return;
  SP_DEVICE_INTERFACE_DATA device_interface{};
  device_interface.cbSize = sizeof(device_interface);
  if (!SetupDiOpenDeviceInterfaceW(devices.value, endpoint.symbolic_link.c_str(), 0, &device_interface)) return;
  DWORD required = 0;
  SP_DEVINFO_DATA device{};
  device.cbSize = sizeof(device);
  (void)SetupDiGetDeviceInterfaceDetailW(devices.value, &device_interface, nullptr, 0, &required, nullptr);
  if (required < sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W) || required > 16'384) return;
  std::vector<std::uint8_t> detail_bytes(required);
  auto* detail = reinterpret_cast<SP_DEVICE_INTERFACE_DETAIL_DATA_W*>(detail_bytes.data());
  detail->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W);
  if (!SetupDiGetDeviceInterfaceDetailW(devices.value, &device_interface, detail, required, nullptr, &device)) return;
  ULONG status = 0, problem = 0;
  if (CM_Get_DevNode_Status(&status, &problem, device.DevInst, 0) == CR_SUCCESS)
    endpoint.available = (status & DN_HAS_PROBLEM) == 0;
  std::array<WCHAR, 128> enumerator{};
  DEVPROPTYPE type = 0;
  DWORD bytes = static_cast<DWORD>(sizeof(enumerator));
  if (SetupDiGetDevicePropertyW(devices.value, &device, &DEVPKEY_Device_EnumeratorName, &type,
      reinterpret_cast<PBYTE>(enumerator.data()), bytes, &bytes, 0) && type == DEVPROP_TYPE_STRING &&
      bytes >= sizeof(WCHAR) && enumerator.back() == L'\0' && _wcsicmp(enumerator.data(), L"SWD") == 0) {
    endpoint.kind = CameraDeviceKind::virtual_camera;
    return;
  }
  if (software_source) return;
  GUID bus{};
  bytes = sizeof(bus);
  if (SetupDiGetDevicePropertyW(devices.value, &device, &DEVPKEY_Device_BusTypeGuid, &type,
      reinterpret_cast<PBYTE>(&bus), bytes, &bytes, 0) && type == DEVPROP_TYPE_GUID && bytes == sizeof(bus)) {
    if (bus == GUID_BUS_TYPE_USB) endpoint.kind = CameraDeviceKind::physical_usb;
    else if (bus == GUID_BUS_TYPE_ACPI) endpoint.kind = CameraDeviceKind::integrated;
  }
}
class WindowsCameraEnumerator final : public CameraDeviceEnumerator {
 public:
  WindowsCameraEnumerator() {
    const auto result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(result)) throw std::runtime_error("Camera registry requires an MTA owner");
    if (FAILED(MFStartup(MF_VERSION))) { CoUninitialize(); throw std::runtime_error("Media Foundation unavailable"); }
    CM_NOTIFY_FILTER filter{};
    filter.cbSize = sizeof(filter);
    filter.FilterType = CM_NOTIFY_FILTER_TYPE_DEVICEINTERFACE;
    filter.u.DeviceInterface.ClassGuid = KSCATEGORY_VIDEO_CAMERA;
    if (CM_Register_Notification(&filter, &changed_, notify, &notification_) != CR_SUCCESS) {
      MFShutdown();
      CoUninitialize();
      throw std::runtime_error("Camera device notifications unavailable");
    }
  }
  ~WindowsCameraEnumerator() override {
    CM_Unregister_Notification(notification_);
    MFShutdown();
    CoUninitialize();
  }
  bool changed() const noexcept override { return changed_.load(std::memory_order_acquire); }
  std::optional<std::vector<CameraEndpoint>> enumerate() override {
    changed_.store(false, std::memory_order_release);
    struct Activations {
      IMFActivate** values = nullptr;
      UINT32 count = 0;
      ~Activations() {
        for (UINT32 index = 0; index < count; ++index) values[index]->Release();
        CoTaskMemFree(values);
      }
    } devices;
    try {
      ComPtr<IMFAttributes> attributes;
      if (FAILED(MFCreateAttributes(&attributes, 1)) || FAILED(attributes->SetGUID(
          MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID)) ||
          FAILED(MFEnumDeviceSources(attributes.Get(), &devices.values, &devices.count)) || devices.count > 64)
        return {};
      std::vector<CameraEndpoint> endpoints;
      endpoints.reserve(devices.count);
      for (UINT32 index = 0; index < devices.count; ++index) {
        auto* value = devices.values[index];
        CameraEndpoint endpoint;
        endpoint.symbolic_link = attributeString(value, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK, 4096);
        endpoint.label = utf8(attributeString(value, MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, 1024));
        UINT32 hardware = 1;
        const bool software = SUCCEEDED(value->GetUINT32(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_HW_SOURCE, &hardware)) && !hardware;
        inspectDevice(endpoint, software);
        endpoints.push_back(std::move(endpoint));
      }
      return endpoints;
    } catch (...) { return {}; }
  }
 private:
  static DWORD CALLBACK notify(HCMNOTIFICATION, PVOID context, CM_NOTIFY_ACTION,
                               PCM_NOTIFY_EVENT_DATA, DWORD) noexcept {
    static_cast<std::atomic_bool*>(context)->store(true, std::memory_order_release);
    return ERROR_SUCCESS;
  }
  std::atomic_bool changed_{true};
  HCMNOTIFICATION notification_ = nullptr;
};
}  // namespace
std::unique_ptr<CameraDeviceEnumerator> makeWindowsCameraDeviceEnumerator() {
  return std::make_unique<WindowsCameraEnumerator>();
}
}  // namespace syrnike::windows_media::camera
