#include "media/screen_dxgi_compositor.hpp"
#include "media/screen_gpu_capture.hpp"

#include <d3d11.h>
#include <wrl/client.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>

using Microsoft::WRL::ComPtr;
using namespace syrnike::desktop_native::media;

namespace {

void expect(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

template <typename Action>
void expectThrows(Action&& action, const char* message) {
  try {
    action();
  } catch (const ScreenGpuCaptureError&) {
    return;
  }
  throw std::runtime_error(message);
}

void testLayouts() {
  const auto identity = dxgiDesktopLayout(DXGI_MODE_ROTATION_IDENTITY, 3, 2);
  expect(identity.output_width == 3 && identity.output_height == 2,
         "identity layout dimensions are wrong");
  const auto rotate90 = dxgiDesktopLayout(DXGI_MODE_ROTATION_ROTATE90, 3, 2);
  expect(rotate90.output_width == 2 && rotate90.output_height == 3,
         "90-degree layout dimensions are wrong");
  const auto top_left = dxgiSourcePointForOutput(rotate90, 0, 0);
  const auto bottom_right = dxgiSourcePointForOutput(rotate90, 1, 2);
  expect(top_left.x == 2 && top_left.y == 0,
         "90-degree top-left mapping is wrong");
  expect(bottom_right.x == 0 && bottom_right.y == 1,
         "90-degree bottom-right mapping is wrong");

  const auto rotate270 = dxgiDesktopLayout(DXGI_MODE_ROTATION_ROTATE270, 3, 2);
  const auto mapped270 = dxgiSourcePointForOutput(rotate270, 1, 2);
  expect(mapped270.x == 2 && mapped270.y == 0,
         "270-degree mapping is wrong");
}

void testCursorDecoding() {
  DXGI_OUTDUPL_POINTER_SHAPE_INFO color{};
  color.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR;
  color.Width = 1;
  color.Height = 1;
  color.Pitch = 4;
  const std::array<std::uint8_t, 4> bgra{3, 2, 1, 128};
  const auto decoded_color = decodeDxgiCursorShape(color, bgra);
  expect(decoded_color.rgba == std::vector<std::uint8_t>({1, 2, 3, 128}),
         "color cursor BGRA conversion is wrong");

  DXGI_OUTDUPL_POINTER_SHAPE_INFO monochrome{};
  monochrome.Type = DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME;
  monochrome.Width = 2;
  monochrome.Height = 2;
  monochrome.Pitch = 1;
  const std::array<std::uint8_t, 2> masks{0b10000000, 0b01000000};
  const auto decoded_monochrome = decodeDxgiCursorShape(monochrome, masks);
  expect(decoded_monochrome.width == 2 && decoded_monochrome.height == 1,
         "monochrome cursor dimensions are wrong");
  expect(decoded_monochrome.rgba[0] == 0xFF && decoded_monochrome.rgba[1] == 0,
         "monochrome AND mask is wrong");
  expect(decoded_monochrome.rgba[4] == 0 && decoded_monochrome.rgba[5] == 0xFF,
         "monochrome XOR mask is wrong");

  color.Width = 2;
  color.Pitch = 4;
  const std::array<std::uint8_t, 8> invalid_pitch{};
  expectThrows(
      [&] { static_cast<void>(decodeDxgiCursorShape(color, invalid_pitch)); },
      "color cursor with a short pitch was accepted");
}

void testDxgiFallbackPolicy() {
  DxgiFallbackPolicy policy;
  expect(!policy.shouldFallback(ScreenGpuFrameStatus::RecoverableLost),
         "DXGI fallback happened after one recoverable loss");
  expect(!policy.shouldFallback(ScreenGpuFrameStatus::NoFrame),
         "normal DXGI state requested fallback");
  expect(!policy.shouldFallback(ScreenGpuFrameStatus::RecoverableLost),
         "DXGI recovery counter did not reset");
  expect(!policy.shouldFallback(ScreenGpuFrameStatus::RecoverableLost),
         "DXGI fallback happened before the recovery threshold");
  expect(policy.shouldFallback(ScreenGpuFrameStatus::RecoverableLost),
         "DXGI fallback did not happen after repeated recovery failures");

  DxgiFallbackPolicy fatal_policy;
  expect(fatal_policy.shouldFallback(ScreenGpuFrameStatus::FatalError),
         "fatal DXGI error did not request immediate fallback");
}

void testGpuRotation() {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  D3D_FEATURE_LEVEL feature_level{};
  const HRESULT device_result = D3D11CreateDevice(
      nullptr,
      D3D_DRIVER_TYPE_WARP,
      nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      nullptr,
      0,
      D3D11_SDK_VERSION,
      &device,
      &feature_level,
      &context);
  expect(SUCCEEDED(device_result) && feature_level >= D3D_FEATURE_LEVEL_11_0,
         "failed to create WARP D3D11 test device");

  const std::array<std::uint8_t, 24> pixels{
      10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255,
      40, 40, 40, 255, 50, 50, 50, 255, 60, 60, 60, 255,
  };
  D3D11_TEXTURE2D_DESC source_description{};
  source_description.Width = 3;
  source_description.Height = 2;
  source_description.MipLevels = 1;
  source_description.ArraySize = 1;
  source_description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  source_description.SampleDesc.Count = 1;
  source_description.Usage = D3D11_USAGE_DEFAULT;
  source_description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  D3D11_SUBRESOURCE_DATA initial{};
  initial.pSysMem = pixels.data();
  initial.SysMemPitch = 12;
  ComPtr<ID3D11Texture2D> source;
  expect(SUCCEEDED(device->CreateTexture2D(&source_description, &initial, &source)),
         "failed to create rotation source texture");

  DxgiFrameCompositor compositor(device.Get(), context.Get());
  DXGI_OUTDUPL_FRAME_INFO frame_info{};
  auto* rotated = compositor.compose(
      source.Get(), nullptr, frame_info, DXGI_MODE_ROTATION_ROTATE90);
  D3D11_TEXTURE2D_DESC rotated_description{};
  rotated->GetDesc(&rotated_description);
  expect(rotated_description.Width == 2 && rotated_description.Height == 3,
         "GPU rotation output dimensions are wrong");

  D3D11_TEXTURE2D_DESC staging_description = rotated_description;
  staging_description.Usage = D3D11_USAGE_STAGING;
  staging_description.BindFlags = 0;
  staging_description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> staging;
  expect(SUCCEEDED(device->CreateTexture2D(&staging_description, nullptr, &staging)),
         "failed to create rotation staging texture");
  context->CopyResource(staging.Get(), rotated);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  expect(SUCCEEDED(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped)),
         "failed to map rotation result");
  const std::array<std::uint8_t, 6> expected{30, 60, 20, 50, 10, 40};
  for (std::uint32_t y = 0; y < 3; ++y) {
    const auto* row = static_cast<const std::uint8_t*>(mapped.pData) +
        static_cast<std::size_t>(y) * mapped.RowPitch;
    for (std::uint32_t x = 0; x < 2; ++x) {
      expect(row[x * 4U] == expected[y * 2U + x],
             "GPU rotation pixel mapping is wrong");
    }
  }
  context->Unmap(staging.Get(), 0);
}

}  // namespace

int main() {
  try {
    testLayouts();
    testCursorDecoding();
    testDxgiFallbackPolicy();
    testGpuRotation();
    std::cout << "screen DXGI compositor tests passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
