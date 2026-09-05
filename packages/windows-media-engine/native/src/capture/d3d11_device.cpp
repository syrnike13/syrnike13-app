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

DeviceCreation createDevice(UINT flags) {
  DeviceCreation creation;
  constexpr std::array levels{D3D_FEATURE_LEVEL_11_1,
                              D3D_FEATURE_LEVEL_11_0};
  D3D_FEATURE_LEVEL selected_level{};
  creation.result = D3D11CreateDevice(
      nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
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

}  // namespace syrnike::windows_media::capture
