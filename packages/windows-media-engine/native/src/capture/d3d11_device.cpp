#include "capture/d3d11_device.hpp"

#include <d3d11_4.h>
#include <dxgi1_6.h>

#include <array>
#include <stdexcept>
#include <utility>

namespace syrnike::windows_media::capture {
namespace {

using Microsoft::WRL::ComPtr;

struct ProcessDeviceState {
  std::mutex mutex;
  std::shared_ptr<D3d11DeviceOwner> owner;
};

ProcessDeviceState& processDeviceState() {
  static ProcessDeviceState state;
  return state;
}

struct DeviceCreation {
  HRESULT result = E_FAIL;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
};

DeviceCreation createDevice(UINT flags, IDXGIAdapter* adapter = nullptr) {
  DeviceCreation creation;
  constexpr std::array levels{D3D_FEATURE_LEVEL_11_1,
                              D3D_FEATURE_LEVEL_11_0};
  D3D_FEATURE_LEVEL selected_level{};
  creation.result = D3D11CreateDevice(
      adapter, adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE, nullptr,
      flags | D3D11_CREATE_DEVICE_BGRA_SUPPORT |
          D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
      levels.data(), static_cast<UINT>(levels.size()), D3D11_SDK_VERSION,
      &creation.device, &selected_level, &creation.context);
  (void)selected_level;
  return creation;
}

}  // namespace

D3d11DeviceOwner::D3d11DeviceOwner(ComPtr<ID3D11Device> device,
                                   ComPtr<ID3D11DeviceContext> context,
                                   D3d11AdapterLuid adapter_luid,
                                   bool debug_layer_enabled)
    : device_(std::move(device)),
      context_(std::move(context)),
      adapter_luid_(adapter_luid),
      debug_layer_enabled_(debug_layer_enabled) {}

ID3D11Device* D3d11DeviceOwner::device() const noexcept { return device_.Get(); }

ID3D11DeviceContext* D3d11DeviceOwner::context() const noexcept {
  return context_.Get();
}

std::mutex& D3d11DeviceOwner::contextMutex() noexcept { return context_mutex_; }

D3d11AdapterLuid D3d11DeviceOwner::adapterLuid() const noexcept {
  return adapter_luid_;
}

bool D3d11DeviceOwner::debugLayerEnabled() const noexcept {
  return debug_layer_enabled_;
}

HRESULT D3d11DeviceOwner::removedReason() const noexcept {
  return device_ ? device_->GetDeviceRemovedReason() : E_POINTER;
}

std::shared_ptr<D3d11DeviceOwner> processD3d11Device(
    bool request_debug_layer) {
  auto& process = processDeviceState();
  std::lock_guard lock(process.mutex);
  if (process.owner) return process.owner;

  bool debug_enabled = false;
  DeviceCreation creation;
  if (request_debug_layer) {
    creation = createDevice(D3D11_CREATE_DEVICE_DEBUG);
    debug_enabled = SUCCEEDED(creation.result);
  }
  if (!debug_enabled) creation = createDevice(0);
  if (FAILED(creation.result))
    throw std::runtime_error("D3D11 hardware video device creation failed");

  ComPtr<ID3D10Multithread> multithread;
  if (FAILED(creation.device.As(&multithread))) {
    throw std::runtime_error("D3D11 multithread protection is unavailable");
  }
  (void)multithread->SetMultithreadProtected(TRUE);

  ComPtr<IDXGIDevice> dxgi_device;
  ComPtr<IDXGIAdapter> adapter;
  DXGI_ADAPTER_DESC description{};
  if (FAILED(creation.device.As(&dxgi_device)) ||
      FAILED(dxgi_device->GetAdapter(&adapter)) ||
      FAILED(adapter->GetDesc(&description))) {
    throw std::runtime_error("D3D11 adapter identity is unavailable");
  }
  const D3d11AdapterLuid luid{
      description.AdapterLuid.LowPart, description.AdapterLuid.HighPart};
  process.owner = std::shared_ptr<D3d11DeviceOwner>(new D3d11DeviceOwner(
      std::move(creation.device), std::move(creation.context), luid,
      debug_enabled));
  return process.owner;
}

std::shared_ptr<D3d11DeviceOwner> monitorD3d11Device(
    HMONITOR monitor, bool request_debug_layer) {
  if (!monitor) throw std::runtime_error("D3D11 monitor is unavailable");
  const auto process = processD3d11Device(false);
  ComPtr<IDXGIFactory1> factory;
  if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))))
    throw std::runtime_error("DXGI adapter enumeration failed");
  for (UINT adapter_index = 0;; ++adapter_index) {
    ComPtr<IDXGIAdapter1> adapter;
    const auto enumerated = factory->EnumAdapters1(adapter_index, &adapter);
    if (enumerated == DXGI_ERROR_NOT_FOUND) break;
    if (FAILED(enumerated)) throw std::runtime_error("DXGI adapter enumeration failed");
    bool owns_monitor = false;
    for (UINT output_index = 0;; ++output_index) {
      ComPtr<IDXGIOutput> output;
      const auto output_result = adapter->EnumOutputs(output_index, &output);
      if (output_result == DXGI_ERROR_NOT_FOUND) break;
      if (FAILED(output_result)) throw std::runtime_error("DXGI output enumeration failed");
      DXGI_OUTPUT_DESC description{};
      if (FAILED(output->GetDesc(&description)))
        throw std::runtime_error("DXGI output description failed");
      if (description.Monitor == monitor && description.AttachedToDesktop) {
        owns_monitor = true;
        break;
      }
    }
    if (!owns_monitor) continue;

    DXGI_ADAPTER_DESC1 description{};
    if (FAILED(adapter->GetDesc1(&description)))
      throw std::runtime_error("DXGI adapter identity failed");
    const D3d11AdapterLuid luid{
        description.AdapterLuid.LowPart, description.AdapterLuid.HighPart};
    if (luid == process->adapterLuid()) return process;

    bool debug_enabled = false;
    DeviceCreation creation;
    if (request_debug_layer) {
      creation = createDevice(D3D11_CREATE_DEVICE_DEBUG, adapter.Get());
      debug_enabled = SUCCEEDED(creation.result);
    }
    if (!debug_enabled) creation = createDevice(0, adapter.Get());
    if (FAILED(creation.result))
      throw std::runtime_error("D3D11 monitor adapter device creation failed");
    ComPtr<ID3D10Multithread> multithread;
    if (FAILED(creation.device.As(&multithread)))
      throw std::runtime_error("D3D11 monitor multithread protection is unavailable");
    (void)multithread->SetMultithreadProtected(TRUE);
    return std::shared_ptr<D3d11DeviceOwner>(new D3d11DeviceOwner(
        std::move(creation.device), std::move(creation.context), luid, debug_enabled));
  }
  throw std::runtime_error("Selected monitor has no DXGI output");
}

}  // namespace syrnike::windows_media::capture
