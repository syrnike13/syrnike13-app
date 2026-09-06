#pragma once
#include <atomic>
#include <memory>
#include <thread>
#include <d3d11.h>
#include <wrl/client.h>
#include "capture/d3d11_device.hpp"

namespace syrnike::windows_media::lab {
// External-game analogue: a separate D3D device on the publication adapter,
// One fixed UAV and at most one outstanding compute dispatch. The dedicated
// pressure scenario additionally uses a fixed 64 MiB read texture.
class GpuContention final {
 public:
  explicit GpuContention(const std::shared_ptr<capture::D3d11DeviceOwner>&,
                        bool memory_pressure = false);
  ~GpuContention();
  void setActive(bool value) noexcept { active_ = value; }
  [[nodiscard]] std::uint64_t batches() const noexcept { return batches_; }
  [[nodiscard]] HRESULT failure() const noexcept { return failure_; }
  [[nodiscard]] std::uint64_t allocatedBytes() const noexcept { return allocated_bytes_; }
 private:
  void run() noexcept;
  Microsoft::WRL::ComPtr<ID3D11Device> device_;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> output_;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> input_;
  Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> input_view_;
  Microsoft::WRL::ComPtr<ID3D11UnorderedAccessView> view_;
  Microsoft::WRL::ComPtr<ID3D11ComputeShader> shader_;
  Microsoft::WRL::ComPtr<ID3D11Query> completion_;
  std::atomic_bool active_{false}, stop_{false};
  std::atomic_uint64_t batches_{0};
  std::atomic<HRESULT> failure_{S_OK};
  std::uint64_t allocated_bytes_ = 16ULL * 1024 * 1024;
  std::thread worker_;
};
}
