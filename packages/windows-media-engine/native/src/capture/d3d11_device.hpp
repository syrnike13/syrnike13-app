#pragma once

#include <d3d11.h>
#include <wrl/client.h>

#include <cstdint>
#include <memory>
#include <mutex>

namespace syrnike::windows_media::capture {

struct D3d11AdapterLuid {
  std::uint32_t low_part = 0;
  std::int32_t high_part = 0;

  bool operator==(const D3d11AdapterLuid&) const = default;
};

// Process-owned D3D11 device shared by capture, conversion, and Media
// Foundation. Immediate-context access is serialized through contextMutex().
class D3d11DeviceOwner final {
 public:
  D3d11DeviceOwner(const D3d11DeviceOwner&) = delete;
  D3d11DeviceOwner& operator=(const D3d11DeviceOwner&) = delete;

  [[nodiscard]] ID3D11Device* device() const noexcept;
  [[nodiscard]] ID3D11DeviceContext* context() const noexcept;
  [[nodiscard]] std::mutex& contextMutex() noexcept;
  [[nodiscard]] D3d11AdapterLuid adapterLuid() const noexcept;
  [[nodiscard]] bool debugLayerEnabled() const noexcept;
  [[nodiscard]] HRESULT removedReason() const noexcept;

 private:
  D3d11DeviceOwner(Microsoft::WRL::ComPtr<ID3D11Device> device,
                   Microsoft::WRL::ComPtr<ID3D11DeviceContext> context,
                   D3d11AdapterLuid adapter_luid, bool debug_layer_enabled);

  Microsoft::WRL::ComPtr<ID3D11Device> device_;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
  std::mutex context_mutex_;
  D3d11AdapterLuid adapter_luid_;
  bool debug_layer_enabled_ = false;

  friend std::shared_ptr<D3d11DeviceOwner> processD3d11Device(bool);
};

// The first successful call selects the process device and adapter. Later
// callers receive the same owner; a later debug request never creates a second
// production device.
[[nodiscard]] std::shared_ptr<D3d11DeviceOwner> processD3d11Device(
    bool request_debug_layer);

}  // namespace syrnike::windows_media::capture
