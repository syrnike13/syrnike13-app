#include <d3d11.h>

#include <stdexcept>

#include "capture/d3d11_device.hpp"

namespace syrnike::windows_media::capture::tests {

void processDeviceIsSharedAndVideoCapable() {
  const auto first = processD3d11Device(false);
  const auto second = processD3d11Device(false);
  if (!first || first != second)
    throw std::runtime_error(
        "capture paths did not share the process D3D11 device");
  if (!first->device() || !first->context())
    throw std::runtime_error("process D3D11 device was incomplete");
  if (first->adapterLuid() != second->adapterLuid())
    throw std::runtime_error("shared D3D11 device changed adapters");

  ID3D11VideoDevice* video_device = nullptr;
  const HRESULT query = first->device()->QueryInterface(
      __uuidof(ID3D11VideoDevice), reinterpret_cast<void**>(&video_device));
  if (FAILED(query) || !video_device)
    throw std::runtime_error("process D3D11 device has no video interface");
  video_device->Release();
}

}  // namespace syrnike::windows_media::capture::tests
