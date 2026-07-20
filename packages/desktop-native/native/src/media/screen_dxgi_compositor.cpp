#include "screen_dxgi_compositor.hpp"

#include <d3dcompiler.h>

#include <algorithm>
#include <cstring>
#include <string>

#include "screen_gpu_capture.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::desktop_native::media {
namespace {

constexpr char kVertexShader[] = R"(
float4 main(uint vertex_id : SV_VertexID) : SV_Position {
  float2 position = vertex_id == 0 ? float2(-1.0, -1.0)
      : vertex_id == 1 ? float2(-1.0, 3.0)
                       : float2(3.0, -1.0);
  return float4(position, 0.0, 1.0);
}
)";

constexpr char kPixelShader[] = R"(
cbuffer FrameConstants : register(b0) {
  uint source_width;
  uint source_height;
  uint output_width;
  uint output_height;
  int cursor_x;
  int cursor_y;
  uint cursor_width;
  uint cursor_height;
  uint rotation;
  uint cursor_type;
  uint cursor_visible;
  uint padding;
};

Texture2D<float4> desktop_texture : register(t0);
Texture2D<uint4> cursor_texture : register(t1);

int2 source_position(int2 output_position) {
  if (rotation == 1) {
    return int2(int(source_width) - 1 - output_position.y, output_position.x);
  }
  if (rotation == 2) {
    return int2(
        int(source_width) - 1 - output_position.x,
        int(source_height) - 1 - output_position.y);
  }
  if (rotation == 3) {
    return int2(output_position.y, int(source_height) - 1 - output_position.x);
  }
  return output_position;
}

float4 main(float4 pixel_position : SV_Position) : SV_Target {
  int2 output_position = int2(pixel_position.xy);
  float4 desktop = desktop_texture.Load(int3(source_position(output_position), 0));
  uint3 desktop_rgb = uint3(round(saturate(desktop.rgb) * 255.0));

  int2 cursor_position = output_position - int2(cursor_x, cursor_y);
  if (cursor_visible != 0 && cursor_position.x >= 0 && cursor_position.y >= 0 &&
      cursor_position.x < int(cursor_width) && cursor_position.y < int(cursor_height)) {
    uint4 cursor = cursor_texture.Load(int3(cursor_position, 0));
    if (cursor_type == 1) {
      desktop_rgb = (desktop_rgb & cursor.rrr) ^ cursor.ggg;
    } else if (cursor_type == 2) {
      uint alpha = cursor.a;
      desktop_rgb = (cursor.rgb * alpha + desktop_rgb * (255 - alpha) + 127) / 255;
    } else if (cursor_type == 4) {
      desktop_rgb = cursor.a == 0 ? cursor.rgb : (desktop_rgb ^ cursor.rgb);
    }
  }
  return float4(float3(desktop_rgb) / 255.0, 1.0);
}
)";

[[noreturn]] void compositorError(const char* message, HRESULT result) {
  throw ScreenGpuCaptureError(
      ScreenGpuCaptureErrorCode::InteropUnavailable,
      message,
      static_cast<long>(result));
}

void requireCompositor(HRESULT result, const char* message) {
  if (FAILED(result)) compositorError(message, result);
}

ComPtr<ID3DBlob> compileShader(
    const char* source,
    const char* target,
    const char* failure_message) {
  ComPtr<ID3DBlob> shader;
  ComPtr<ID3DBlob> errors;
  const HRESULT result = D3DCompile(
      source,
      std::strlen(source),
      nullptr,
      nullptr,
      nullptr,
      "main",
      target,
      D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3,
      0,
      &shader,
      &errors);
  if (FAILED(result)) compositorError(failure_message, result);
  return shader;
}

}  // namespace

DxgiDesktopRotation dxgiDesktopRotation(DXGI_MODE_ROTATION rotation) noexcept {
  switch (rotation) {
    case DXGI_MODE_ROTATION_ROTATE90:
      return DxgiDesktopRotation::Rotate90;
    case DXGI_MODE_ROTATION_ROTATE180:
      return DxgiDesktopRotation::Rotate180;
    case DXGI_MODE_ROTATION_ROTATE270:
      return DxgiDesktopRotation::Rotate270;
    case DXGI_MODE_ROTATION_UNSPECIFIED:
    case DXGI_MODE_ROTATION_IDENTITY:
    default:
      return DxgiDesktopRotation::Identity;
  }
}

DxgiDesktopLayout dxgiDesktopLayout(
    DXGI_MODE_ROTATION rotation,
    std::uint32_t source_width,
    std::uint32_t source_height) noexcept {
  const auto mapped = dxgiDesktopRotation(rotation);
  const bool swaps_dimensions =
      mapped == DxgiDesktopRotation::Rotate90 ||
      mapped == DxgiDesktopRotation::Rotate270;
  return {
      mapped,
      source_width,
      source_height,
      swaps_dimensions ? source_height : source_width,
      swaps_dimensions ? source_width : source_height,
  };
}

DxgiPixelPoint dxgiSourcePointForOutput(
    const DxgiDesktopLayout& layout,
    std::uint32_t output_x,
    std::uint32_t output_y) noexcept {
  switch (layout.rotation) {
    case DxgiDesktopRotation::Rotate90:
      return {layout.source_width - 1U - output_y, output_x};
    case DxgiDesktopRotation::Rotate180:
      return {
          layout.source_width - 1U - output_x,
          layout.source_height - 1U - output_y,
      };
    case DxgiDesktopRotation::Rotate270:
      return {output_y, layout.source_height - 1U - output_x};
    case DxgiDesktopRotation::Identity:
    default:
      return {output_x, output_y};
  }
}

DxgiCursorPixels decodeDxgiCursorShape(
    const DXGI_OUTDUPL_POINTER_SHAPE_INFO& info,
    std::span<const std::uint8_t> shape) {
  DxgiCursorPixels result;
  result.width = info.Width;
  result.height = info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME
      ? info.Height / 2U
      : info.Height;
  result.type = info.Type;
  if (result.width == 0 || result.height == 0) return result;

  const std::size_t required_rows = info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME
      ? static_cast<std::size_t>(result.height) * 2U
      : result.height;
  const std::size_t minimum_pitch =
      info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME
          ? (static_cast<std::size_t>(result.width) + 7U) / 8U
          : static_cast<std::size_t>(result.width) * 4U;
  const std::size_t required_size = required_rows * info.Pitch;
  if (info.Pitch < minimum_pitch || shape.size() < required_size) {
    throw ScreenGpuCaptureError(
        ScreenGpuCaptureErrorCode::InteropUnavailable,
        "DXGI cursor shape buffer is truncated");
  }

  result.rgba.assign(
      static_cast<std::size_t>(result.width) * result.height * 4U, 0);
  for (std::uint32_t y = 0; y < result.height; ++y) {
    for (std::uint32_t x = 0; x < result.width; ++x) {
      auto* output = result.rgba.data() +
          (static_cast<std::size_t>(y) * result.width + x) * 4U;
      if (info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME) {
        const std::size_t byte = static_cast<std::size_t>(y) * info.Pitch + x / 8U;
        const std::size_t xor_byte =
            static_cast<std::size_t>(y + result.height) * info.Pitch + x / 8U;
        const std::uint8_t mask = static_cast<std::uint8_t>(0x80U >> (x & 7U));
        output[0] = (shape[byte] & mask) != 0 ? 0xFF : 0;
        output[1] = (shape[xor_byte] & mask) != 0 ? 0xFF : 0;
      } else {
        const auto* input = shape.data() +
            static_cast<std::size_t>(y) * info.Pitch + x * 4U;
        output[0] = input[2];
        output[1] = input[1];
        output[2] = input[0];
        output[3] = input[3];
      }
    }
  }
  return result;
}

DxgiFrameCompositor::DxgiFrameCompositor(
    ID3D11Device* device,
    ID3D11DeviceContext* context)
    : device_(device), context_(context) {
  if (!device_ || !context_) compositorError("invalid DXGI compositor device", E_INVALIDARG);

  const auto vertex = compileShader(
      kVertexShader, "vs_5_0", "failed to compile DXGI compositor vertex shader");
  const auto pixel = compileShader(
      kPixelShader, "ps_5_0", "failed to compile DXGI compositor pixel shader");
  requireCompositor(
      device_->CreateVertexShader(
          vertex->GetBufferPointer(), vertex->GetBufferSize(), nullptr, &vertex_shader_),
      "failed to create DXGI compositor vertex shader");
  requireCompositor(
      device_->CreatePixelShader(
          pixel->GetBufferPointer(), pixel->GetBufferSize(), nullptr, &pixel_shader_),
      "failed to create DXGI compositor pixel shader");

  D3D11_BUFFER_DESC constants{};
  constants.ByteWidth = sizeof(ShaderConstants);
  constants.Usage = D3D11_USAGE_DYNAMIC;
  constants.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  constants.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
  requireCompositor(
      device_->CreateBuffer(&constants, nullptr, &constants_),
      "failed to create DXGI compositor constants");
}

void DxgiFrameCompositor::ensureOutput(
    std::uint32_t width,
    std::uint32_t height) {
  if (output_ && output_width_ == width && output_height_ == height) return;
  output_view_.Reset();
  output_.Reset();
  output_width_ = 0;
  output_height_ = 0;

  D3D11_TEXTURE2D_DESC description{};
  description.Width = width;
  description.Height = height;
  description.MipLevels = 1;
  description.ArraySize = 1;
  description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  description.SampleDesc.Count = 1;
  description.Usage = D3D11_USAGE_DEFAULT;
  description.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  requireCompositor(
      device_->CreateTexture2D(&description, nullptr, &output_),
      "failed to create DXGI compositor output texture");
  requireCompositor(
      device_->CreateRenderTargetView(output_.Get(), nullptr, &output_view_),
      "failed to create DXGI compositor output view");
  output_width_ = width;
  output_height_ = height;
}

void DxgiFrameCompositor::updateCursor(
    IDXGIOutputDuplication* duplication,
    const DXGI_OUTDUPL_FRAME_INFO& frame_info) {
  if (frame_info.LastMouseUpdateTime.QuadPart == 0) return;
  cursor_visible_ = frame_info.PointerPosition.Visible != FALSE;
  cursor_position_ = frame_info.PointerPosition.Position;
  if (frame_info.PointerShapeBufferSize == 0 || !duplication) return;

  cursor_shape_.resize(frame_info.PointerShapeBufferSize);
  UINT required_size = 0;
  requireCompositor(
      duplication->GetFramePointerShape(
          static_cast<UINT>(cursor_shape_.size()),
          cursor_shape_.data(),
          &required_size,
          &cursor_info_),
      "failed to read DXGI cursor shape");
  cursor_shape_.resize(required_size);
  uploadCursorTexture();
}

void DxgiFrameCompositor::uploadCursorTexture() {
  const auto decoded = decodeDxgiCursorShape(cursor_info_, cursor_shape_);
  const std::uint32_t width = decoded.width;
  const std::uint32_t height = decoded.height;
  if (width == 0 || height == 0) {
    cursor_texture_.Reset();
    cursor_view_.Reset();
    cursor_pixels_.clear();
    return;
  }

  cursor_pixels_ = decoded.rgba;

  D3D11_TEXTURE2D_DESC description{};
  description.Width = width;
  description.Height = height;
  description.MipLevels = 1;
  description.ArraySize = 1;
  description.Format = DXGI_FORMAT_R8G8B8A8_UINT;
  description.SampleDesc.Count = 1;
  description.Usage = D3D11_USAGE_DEFAULT;
  description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  D3D11_SUBRESOURCE_DATA initial{};
  initial.pSysMem = cursor_pixels_.data();
  initial.SysMemPitch = width * 4U;
  cursor_view_.Reset();
  cursor_texture_.Reset();
  requireCompositor(
      device_->CreateTexture2D(&description, &initial, &cursor_texture_),
      "failed to create DXGI cursor texture");
  requireCompositor(
      device_->CreateShaderResourceView(cursor_texture_.Get(), nullptr, &cursor_view_),
      "failed to create DXGI cursor view");
}

ID3D11Texture2D* DxgiFrameCompositor::compose(
    ID3D11Texture2D* source,
    IDXGIOutputDuplication* duplication,
    const DXGI_OUTDUPL_FRAME_INFO& frame_info,
    DXGI_MODE_ROTATION rotation) {
  if (!source) compositorError("invalid DXGI compositor source texture", E_INVALIDARG);
  updateCursor(duplication, frame_info);

  D3D11_TEXTURE2D_DESC source_description{};
  source->GetDesc(&source_description);
  const auto layout = dxgiDesktopLayout(
      rotation, source_description.Width, source_description.Height);
  ensureOutput(layout.output_width, layout.output_height);

  ComPtr<ID3D11ShaderResourceView> source_view;
  requireCompositor(
      device_->CreateShaderResourceView(source, nullptr, &source_view),
      "failed to create DXGI desktop source view");

  D3D11_MAPPED_SUBRESOURCE mapped{};
  requireCompositor(
      context_->Map(constants_.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped),
      "failed to update DXGI compositor constants");
  const ShaderConstants values{
      layout.source_width,
      layout.source_height,
      layout.output_width,
      layout.output_height,
      cursor_position_.x,
      cursor_position_.y,
      cursor_info_.Width,
      cursor_info_.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME
          ? cursor_info_.Height / 2U
          : cursor_info_.Height,
      static_cast<std::uint32_t>(layout.rotation),
      cursor_info_.Type,
      cursor_visible_ && cursor_view_ ? 1U : 0U,
      0,
  };
  std::memcpy(mapped.pData, &values, sizeof(values));
  context_->Unmap(constants_.Get(), 0);

  const D3D11_VIEWPORT viewport{
      0.0F,
      0.0F,
      static_cast<float>(layout.output_width),
      static_cast<float>(layout.output_height),
      0.0F,
      1.0F,
  };
  ID3D11RenderTargetView* render_target = output_view_.Get();
  ID3D11Buffer* constants = constants_.Get();
  ID3D11ShaderResourceView* resources[] = {source_view.Get(), cursor_view_.Get()};
  context_->RSSetViewports(1, &viewport);
  context_->OMSetRenderTargets(1, &render_target, nullptr);
  context_->IASetInputLayout(nullptr);
  context_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  context_->VSSetShader(vertex_shader_.Get(), nullptr, 0);
  context_->PSSetShader(pixel_shader_.Get(), nullptr, 0);
  context_->PSSetConstantBuffers(0, 1, &constants);
  context_->PSSetShaderResources(0, 2, resources);
  context_->Draw(3, 0);

  ID3D11ShaderResourceView* empty_resources[] = {nullptr, nullptr};
  context_->PSSetShaderResources(0, 2, empty_resources);
  context_->OMSetRenderTargets(0, nullptr, nullptr);
  return output_.Get();
}

}  // namespace syrnike::desktop_native::media
