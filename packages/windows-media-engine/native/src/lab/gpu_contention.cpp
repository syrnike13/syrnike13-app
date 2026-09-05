#include "lab/gpu_contention.hpp"
#include <d3dcompiler.h>
#include <dxgi.h>
#include <stdexcept>

namespace syrnike::windows_media::lab {
namespace {
void checked(HRESULT result) {
  if (FAILED(result)) throw std::runtime_error("GPU contention fixture initialization failed");
}
constexpr char source[] = R"(
RWTexture2D<float4> outputTexture : register(u0);
[numthreads(8, 8, 1)]
void main(uint3 position : SV_DispatchThreadID) {
  float4 value = float4(position.xy, position.xy + 1) * 0.001;
  [loop] for (uint i = 0; i < 128; ++i)
    value = sin(value * 1.0001 + float4(0.11, 0.23, 0.37, 0.49));
  outputTexture[position.xy] = value;
})";
}
GpuContention::GpuContention(const std::shared_ptr<capture::D3d11DeviceOwner>& owner) {
  Microsoft::WRL::ComPtr<IDXGIDevice> dxgi;
  Microsoft::WRL::ComPtr<IDXGIAdapter> adapter;
  checked(owner->device()->QueryInterface(IID_PPV_ARGS(&dxgi)));
  checked(dxgi->GetAdapter(&adapter));
  checked(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, 0,
      nullptr, 0, D3D11_SDK_VERSION, &device_, nullptr, &context_));
  D3D11_TEXTURE2D_DESC texture{};
  texture.Width = texture.Height = 1024;
  texture.MipLevels = texture.ArraySize = 1;
  texture.Format = DXGI_FORMAT_R32G32B32A32_FLOAT;
  texture.SampleDesc.Count = 1;
  texture.Usage = D3D11_USAGE_DEFAULT;
  texture.BindFlags = D3D11_BIND_UNORDERED_ACCESS;
  checked(device_->CreateTexture2D(&texture, nullptr, &output_));
  checked(device_->CreateUnorderedAccessView(output_.Get(), nullptr, &view_));
  Microsoft::WRL::ComPtr<ID3DBlob> bytecode, errors;
  checked(D3DCompile(source, sizeof(source) - 1, "contention", nullptr, nullptr,
      "main", "cs_5_0", D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &bytecode, &errors));
  checked(device_->CreateComputeShader(bytecode->GetBufferPointer(), bytecode->GetBufferSize(), nullptr, &shader_));
  D3D11_QUERY_DESC query{D3D11_QUERY_EVENT, 0};
  checked(device_->CreateQuery(&query, &completion_));
  worker_ = std::thread([this] { run(); });
}
GpuContention::~GpuContention() {
  stop_ = true;
  if (worker_.joinable()) worker_.join();
}
void GpuContention::run() noexcept {
  bool pending = false;
  context_->CSSetShader(shader_.Get(), nullptr, 0);
  auto* view = view_.Get();
  context_->CSSetUnorderedAccessViews(0, 1, &view, nullptr);
  while (!stop_) {
    if (pending) {
      BOOL done = FALSE;
      const auto result = context_->GetData(completion_.Get(), &done, sizeof(done), D3D11_ASYNC_GETDATA_DONOTFLUSH);
      if (FAILED(result)) { failure_ = result; return; }
      if (result == S_OK && done) { pending = false; ++batches_; }
    }
    if (!pending && active_) {
      context_->Dispatch(128, 128, 1);
      context_->End(completion_.Get());
      context_->Flush();
      pending = true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds{1});
  }
}
}
