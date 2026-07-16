#include <d3d11.h>
#include <windows.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "media/d3d11_gpu_completion.hpp"

using Microsoft::WRL::ComPtr;
using syrnike::desktop_native::media::D3d11GpuCompletion;

namespace {

void require(HRESULT result, const char* operation) {
  if (SUCCEEDED(result)) return;
  throw std::runtime_error(
      std::string(operation) + " failed (HRESULT " +
      std::to_string(static_cast<std::int32_t>(result)) + ")");
}

}  // namespace

int main() {
  try {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    D3D_FEATURE_LEVEL feature_level{};
    HRESULT result = D3D11CreateDevice(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
        &device, &feature_level, &context);
    if (FAILED(result)) {
      require(
          D3D11CreateDevice(
              nullptr, D3D_DRIVER_TYPE_WARP, nullptr,
              D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
              D3D11_SDK_VERSION, &device, &feature_level, &context),
          "D3D11 test device creation");
    }

    D3d11GpuCompletion completion(device.Get(), context.Get());
    require(completion.initializationResult(), "GPU completion query creation");

    constexpr UINT width = 320;
    constexpr UINT height = 180;
    constexpr UINT bytes_per_pixel = 4;
    std::vector<std::uint8_t> source(
        static_cast<std::size_t>(width) * height * bytes_per_pixel);
    for (UINT y = 0; y < height; ++y) {
      for (UINT x = 0; x < width; ++x) {
        const auto offset =
            (static_cast<std::size_t>(y) * width + x) * bytes_per_pixel;
        source[offset] = static_cast<std::uint8_t>((y * 17U) & 0xffU);
        source[offset + 1] = static_cast<std::uint8_t>((x * 13U) & 0xffU);
        source[offset + 2] = static_cast<std::uint8_t>((x + y) & 0xffU);
        source[offset + 3] = 0xffU;
      }
    }

    D3D11_TEXTURE2D_DESC shared_description{};
    shared_description.Width = width;
    shared_description.Height = height;
    shared_description.MipLevels = 1;
    shared_description.ArraySize = 1;
    shared_description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    shared_description.SampleDesc.Count = 1;
    shared_description.Usage = D3D11_USAGE_DEFAULT;
    shared_description.BindFlags =
        D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    shared_description.MiscFlags =
        D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;
    ComPtr<ID3D11Texture2D> shared_texture;
    require(
        device->CreateTexture2D(
            &shared_description, nullptr, &shared_texture),
        "shared BGRA texture creation");

    D3D11_TEXTURE2D_DESC staging_description = shared_description;
    staging_description.Usage = D3D11_USAGE_STAGING;
    staging_description.BindFlags = 0;
    staging_description.MiscFlags = 0;
    staging_description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging_texture;
    require(
        device->CreateTexture2D(
            &staging_description, nullptr, &staging_texture),
        "staging BGRA texture creation");

    context->UpdateSubresource(
        shared_texture.Get(), 0, nullptr, source.data(),
        width * bytes_per_pixel, 0);
    context->CopyResource(staging_texture.Get(), shared_texture.Get());
    std::uint64_t wait_microseconds = 0;
    require(
        completion.wait(std::chrono::seconds(1), &wait_microseconds),
        "GPU upload completion");

    D3D11_MAPPED_SUBRESOURCE mapped{};
    require(
        context->Map(
            staging_texture.Get(), 0, D3D11_MAP_READ, 0, &mapped),
        "staging texture mapping");
    bool matches = true;
    for (UINT y = 0; y < height; ++y) {
      const auto* actual = static_cast<const std::uint8_t*>(mapped.pData) +
          static_cast<std::size_t>(y) * mapped.RowPitch;
      const auto* expected = source.data() +
          static_cast<std::size_t>(y) * width * bytes_per_pixel;
      if (std::memcmp(actual, expected, width * bytes_per_pixel) != 0) {
        matches = false;
        break;
      }
    }
    context->Unmap(staging_texture.Get(), 0);
    if (!matches) {
      throw std::runtime_error(
          "GPU completion exposed a partially uploaded BGRA frame");
    }

    std::cout << "D3D11 GPU completion test passed; wait_us="
              << wait_microseconds << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
