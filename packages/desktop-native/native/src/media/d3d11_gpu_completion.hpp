#pragma once

#ifdef _WIN32

#include <d3d11.h>
#include <dxgi.h>
#include <windows.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdint>

namespace syrnike::desktop_native::media {

// D3D11 Flush only submits queued work. This reusable event query establishes
// the missing producer-completion boundary before a shared texture is exposed
// to a D3D device owned by another process.
class D3d11GpuCompletion final {
 public:
  D3d11GpuCompletion(ID3D11Device* device, ID3D11DeviceContext* context)
      : device_(device), context_(context) {
    if (!device_ || !context_) {
      initialization_result_ = E_INVALIDARG;
      return;
    }
    D3D11_QUERY_DESC description{};
    description.Query = D3D11_QUERY_EVENT;
    initialization_result_ = device_->CreateQuery(&description, &query_);
  }

  [[nodiscard]] HRESULT initializationResult() const noexcept {
    return initialization_result_;
  }

  HRESULT wait(
      std::chrono::milliseconds timeout,
      std::uint64_t* elapsed_microseconds = nullptr) noexcept {
    if (FAILED(initialization_result_)) return initialization_result_;

    const auto started_at = std::chrono::steady_clock::now();
    const auto deadline = started_at + timeout;
    context_->End(query_.Get());
    context_->Flush();
    for (;;) {
      const HRESULT result = context_->GetData(
          query_.Get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
      if (result == S_OK) {
        if (elapsed_microseconds) {
          *elapsed_microseconds = static_cast<std::uint64_t>(
              std::chrono::duration_cast<std::chrono::microseconds>(
                  std::chrono::steady_clock::now() - started_at)
                  .count());
        }
        return S_OK;
      }
      if (FAILED(result)) return result;
      if (std::chrono::steady_clock::now() >= deadline) {
        const HRESULT removed = device_->GetDeviceRemovedReason();
        return FAILED(removed) ? removed : DXGI_ERROR_WAIT_TIMEOUT;
      }
      SwitchToThread();
    }
  }

 private:
  Microsoft::WRL::ComPtr<ID3D11Device> device_;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
  Microsoft::WRL::ComPtr<ID3D11Query> query_;
  HRESULT initialization_result_ = E_FAIL;
};

}  // namespace syrnike::desktop_native::media

#endif
