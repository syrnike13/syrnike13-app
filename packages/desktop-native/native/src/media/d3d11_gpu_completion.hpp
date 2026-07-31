#pragma once

#ifdef _WIN32

#include <d3d11.h>
#include <dxgi.h>
#include <windows.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdint>
#include <thread>

namespace syrnike::desktop_native::media {

struct D3d11GpuCompletionPollDecision {
  HRESULT result = E_FAIL;
  bool pending = false;
};

inline D3d11GpuCompletionPollDecision decideD3d11GpuCompletionPoll(
    HRESULT query_result,
    bool deadline_reached,
    HRESULT device_removed_result = S_OK) noexcept {
  if (query_result == S_OK) return {S_OK, false};
  if (FAILED(query_result)) return {query_result, false};
  if (!deadline_reached) return {S_FALSE, true};
  if (FAILED(device_removed_result)) return {device_removed_result, false};
  // A deadline is not a device-loss signal. Keep the query pending so callers
  // can quarantine its resources and observe a late completion safely.
  return {DXGI_ERROR_WAIT_TIMEOUT, true};
}

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

  [[nodiscard]] bool pending() const noexcept { return pending_; }

  HRESULT begin(std::chrono::milliseconds timeout) noexcept {
    if (FAILED(initialization_result_)) return initialization_result_;
    if (pending_) return E_PENDING;

    started_at_ = std::chrono::steady_clock::now();
    deadline_ = started_at_ + timeout;
    pending_ = true;
    context_->End(query_.Get());
    context_->Flush();
    return S_OK;
  }

  HRESULT poll(std::uint64_t* elapsed_microseconds = nullptr) noexcept {
    if (FAILED(initialization_result_)) return initialization_result_;
    if (!pending_) return E_UNEXPECTED;

    const HRESULT result = context_->GetData(
        query_.Get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
    const bool deadline_reached =
        std::chrono::steady_clock::now() >= deadline_;
    const HRESULT removed = deadline_reached
        ? device_->GetDeviceRemovedReason()
        : S_OK;
    const auto decision = decideD3d11GpuCompletionPoll(
        result, deadline_reached, removed);
    if (elapsed_microseconds && decision.result != S_FALSE) {
      *elapsed_microseconds = elapsedMicroseconds();
    }
    pending_ = decision.pending;
    return decision.result;
  }

  HRESULT wait(
      std::chrono::milliseconds timeout,
      std::uint64_t* elapsed_microseconds = nullptr) noexcept {
    const HRESULT begin_result = begin(timeout);
    if (FAILED(begin_result)) return begin_result;

    return waitPending(elapsed_microseconds);
  }

  HRESULT continueWait(
      std::chrono::milliseconds timeout,
      std::uint64_t* elapsed_microseconds = nullptr) noexcept {
    if (!pending_) return E_UNEXPECTED;
    deadline_ = std::chrono::steady_clock::now() + timeout;
    return waitPending(elapsed_microseconds);
  }

 private:
  HRESULT waitPending(std::uint64_t* elapsed_microseconds) noexcept {
    std::uint32_t polls = 0;
    for (;;) {
      const HRESULT result = poll(elapsed_microseconds);
      if (result == S_OK) return S_OK;
      if (FAILED(result)) return result;
      // A short yield keeps sub-frame completions cheap. Longer GPU work must
      // relinquish the core instead of spinning an MMCSS capture thread.
      if (++polls <= 8) {
        std::this_thread::yield();
      } else {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
    }
  }
  [[nodiscard]] std::uint64_t elapsedMicroseconds() const noexcept {
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - started_at_)
            .count());
  }

  Microsoft::WRL::ComPtr<ID3D11Device> device_;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
  Microsoft::WRL::ComPtr<ID3D11Query> query_;
  HRESULT initialization_result_ = E_FAIL;
  std::chrono::steady_clock::time_point started_at_{};
  std::chrono::steady_clock::time_point deadline_{};
  bool pending_ = false;
};

}  // namespace syrnike::desktop_native::media

#endif
