#pragma once

#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <cstdint>
#include <span>
#include <vector>

namespace syrnike::desktop_native::media {

enum class DxgiDesktopRotation : std::uint32_t {
  Identity = 0,
  Rotate90 = 1,
  Rotate180 = 2,
  Rotate270 = 3,
};

struct DxgiDesktopLayout {
  DxgiDesktopRotation rotation = DxgiDesktopRotation::Identity;
  std::uint32_t source_width = 0;
  std::uint32_t source_height = 0;
  std::uint32_t output_width = 0;
  std::uint32_t output_height = 0;
};

struct DxgiPixelPoint {
  std::uint32_t x = 0;
  std::uint32_t y = 0;
};

struct DxgiCursorPixels {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t type = 0;
  std::vector<std::uint8_t> rgba;
};

DxgiDesktopRotation dxgiDesktopRotation(DXGI_MODE_ROTATION rotation) noexcept;
DxgiDesktopLayout dxgiDesktopLayout(
    DXGI_MODE_ROTATION rotation,
    std::uint32_t source_width,
    std::uint32_t source_height) noexcept;
DxgiPixelPoint dxgiSourcePointForOutput(
    const DxgiDesktopLayout& layout,
    std::uint32_t output_x,
    std::uint32_t output_y) noexcept;
DxgiCursorPixels decodeDxgiCursorShape(
    const DXGI_OUTDUPL_POINTER_SHAPE_INFO& info,
    std::span<const std::uint8_t> shape);

// Desktop Duplication supplies the desktop as a GPU texture, but hardware
// cursors can arrive as separate metadata and rotated outputs arrive in an
// unrotated surface. This compositor keeps both corrections on the D3D11 GPU.
class DxgiFrameCompositor final {
 public:
  DxgiFrameCompositor(ID3D11Device* device, ID3D11DeviceContext* context);

  ID3D11Texture2D* compose(
      ID3D11Texture2D* source,
      IDXGIOutputDuplication* duplication,
      const DXGI_OUTDUPL_FRAME_INFO& frame_info,
      DXGI_MODE_ROTATION rotation);

 private:
  struct ShaderConstants {
    std::uint32_t source_width = 0;
    std::uint32_t source_height = 0;
    std::uint32_t output_width = 0;
    std::uint32_t output_height = 0;
    std::int32_t cursor_x = 0;
    std::int32_t cursor_y = 0;
    std::uint32_t cursor_width = 0;
    std::uint32_t cursor_height = 0;
    std::uint32_t rotation = 0;
    std::uint32_t cursor_type = 0;
    std::uint32_t cursor_visible = 0;
    std::uint32_t padding = 0;
  };

  void updateCursor(
      IDXGIOutputDuplication* duplication,
      const DXGI_OUTDUPL_FRAME_INFO& frame_info);
  void uploadCursorTexture();
  void ensureOutput(std::uint32_t width, std::uint32_t height);

  Microsoft::WRL::ComPtr<ID3D11Device> device_;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
  Microsoft::WRL::ComPtr<ID3D11VertexShader> vertex_shader_;
  Microsoft::WRL::ComPtr<ID3D11PixelShader> pixel_shader_;
  Microsoft::WRL::ComPtr<ID3D11Buffer> constants_;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> output_;
  Microsoft::WRL::ComPtr<ID3D11RenderTargetView> output_view_;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> cursor_texture_;
  Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> cursor_view_;
  std::vector<std::uint8_t> cursor_shape_;
  std::vector<std::uint8_t> cursor_pixels_;
  DXGI_OUTDUPL_POINTER_SHAPE_INFO cursor_info_{};
  POINT cursor_position_{};
  bool cursor_visible_ = false;
  std::uint32_t output_width_ = 0;
  std::uint32_t output_height_ = 0;
};

}  // namespace syrnike::desktop_native::media
