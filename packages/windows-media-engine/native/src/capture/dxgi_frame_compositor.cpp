#include "capture/dxgi_frame_compositor.hpp"
#include <d3dcompiler.h>
#include <algorithm>
#include <cstring>

namespace syrnike::windows_media::capture::detail {
namespace {
using Microsoft::WRL::ComPtr;
void check(HRESULT result, const char* operation) {
  if (FAILED(result)) throw DxgiApiError(operation, result);
}
constexpr char shader[] = R"hlsl(
cbuffer Config : register(b0) {
  uint rotation; uint rawWidth; uint rawHeight; uint cursorMode;
  int cursorX; int cursorY; uint cursorWidth; uint cursorHeight;
  uint cursorVisible; uint padding0; uint padding1; uint padding2;
};
Texture2D<float4> desktop : register(t0);
Texture2D<uint4> cursor : register(t1);
float4 vertex(uint id : SV_VertexID) : SV_Position {
  float2 points[3] = {float2(-1,-1), float2(-1,3), float2(3,-1)};
  return float4(points[id],0,1);
}
float4 pixel(float4 position : SV_Position) : SV_Target {
  int2 output = int2(position.xy);
  int2 source = output;
  if (rotation == 2) source = int2(output.y, int(rawHeight)-1-output.x);
  if (rotation == 3) source = int2(int(rawWidth)-1-output.x, int(rawHeight)-1-output.y);
  if (rotation == 4) source = int2(int(rawWidth)-1-output.y, output.x);
  float3 color = desktop.Load(int3(source,0)).rgb;
  int2 local = output-int2(cursorX,cursorY);
  if (cursorVisible != 0 && local.x >= 0 && local.y >= 0 && local.x < int(cursorWidth) && local.y < int(cursorHeight)) {
    uint4 shape = cursor.Load(int3(local,0));
    uint3 original = uint3(round(saturate(color)*255));
    if (cursorMode == 1) color = float3((original & shape.x) ^ shape.y)/255.0;
    else if (cursorMode == 4) color = float3(shape.w != 0 ? original ^ shape.zyx : shape.zyx)/255.0;
    else if (cursorMode == 2) color = lerp(color, float3(shape.zyx)/255.0, float(shape.w)/255.0);
  }
  return float4(color,1);
}
)hlsl";
struct Slot {
  std::atomic_bool busy{false};
  ComPtr<ID3D11Texture2D> desktop, output;
  ComPtr<ID3D11ShaderResourceView> desktop_view;
  ComPtr<ID3D11RenderTargetView> output_view;
};
struct Pool {
  std::shared_ptr<D3d11DeviceOwner> device;
  std::shared_ptr<DxgiPoolCounters> counters = std::make_shared<DxgiPoolCounters>();
  std::array<Slot, kDxgiFrameSlots> slots;
  std::uint32_t width = 0, height = 0;
  ~Pool() {
    for (auto& slot : slots) {
      if (slot.desktop) --counters->textures;
      if (slot.output) --counters->textures;
    }
  }
  void release(std::size_t index) noexcept {
    if (slots[index].busy.exchange(false)) --counters->occupied;
  }
};
class SlotFrame final : public FrameResource {
 public:
  SlotFrame(std::shared_ptr<Pool> pool, std::size_t index)
      : pool_(std::move(pool)), index_(index) {}
  ~SlotFrame() override { pool_->release(index_); }
  std::optional<D3d11FrameView> d3d11View() override {
    return D3d11FrameView{pool_->device, pool_->slots[index_].output.Get()};
  }
  void copyBgraTo(std::span<std::uint8_t> destination, std::size_t stride) override {
    if (stride < pool_->width * 4ULL || destination.size() / stride < pool_->height)
      throw std::invalid_argument("DXGI readback destination is too small");
    withReadback([&](const D3D11_MAPPED_SUBRESOURCE& mapped) {
      for (std::uint32_t row = 0; row < pool_->height; ++row)
        std::memcpy(destination.data() + row * stride,
                    static_cast<const std::uint8_t*>(mapped.pData) + row * mapped.RowPitch,
                    pool_->width * 4ULL);
    });
  }
  std::uint64_t sampledHash() override {
    std::uint64_t hash = 1469598103934665603ULL;
    withReadback([&](const D3D11_MAPPED_SUBRESOURCE& mapped) {
      for (std::uint32_t y = 0; y < pool_->height; y += (std::max)(1U, pool_->height / 64))
        for (std::uint32_t x = 0; x < pool_->width; x += (std::max)(1U, pool_->width / 64)) {
          const auto* pixel =
              static_cast<const std::uint8_t*>(mapped.pData) + y * mapped.RowPitch + x * 4ULL;
          for (unsigned channel = 0; channel < 4; ++channel)
            hash = (hash ^ pixel[channel]) * 1099511628211ULL;
        }
    });
    return hash;
  }

 private:
  template <class Callback>
  void withReadback(Callback callback) {
    // Opt-in hash/readback only; the production path returns a GPU view.
    D3D11_TEXTURE2D_DESC description{};
    pool_->slots[index_].output->GetDesc(&description);
    description.BindFlags = 0;
    description.Usage = D3D11_USAGE_STAGING;
    description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    ComPtr<ID3D11Texture2D> staging;
    check(pool_->device->device()->CreateTexture2D(&description, nullptr, &staging),
          "DXGI readback allocation");
    std::scoped_lock lock(pool_->device->contextMutex());
    auto* context = pool_->device->context();
    context->CopyResource(staging.Get(), pool_->slots[index_].output.Get());
    D3D11_MAPPED_SUBRESOURCE mapped{};
    check(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped), "DXGI readback map");
    try {
      callback(mapped);
    } catch (...) {
      context->Unmap(staging.Get(), 0);
      throw;
    }
    context->Unmap(staging.Get(), 0);
  }
  std::shared_ptr<Pool> pool_;
  std::size_t index_;
};
struct alignas(16) Config {
  std::uint32_t rotation, raw_width, raw_height, cursor_mode = 0;
  std::int32_t cursor_x = 0, cursor_y = 0;
  std::uint32_t cursor_width = 0, cursor_height = 0, visible = 0;
  std::uint32_t padding[3]{};
};
}  // namespace
struct DxgiFrameCompositor::Impl {
  std::shared_ptr<Pool> pool = std::make_shared<Pool>();
  Config config{};
  ComPtr<ID3D11VertexShader> vertex;
  ComPtr<ID3D11PixelShader> pixel;
  ComPtr<ID3D11Buffer> constant;
  ComPtr<ID3D11Texture2D> cursor;
  ComPtr<ID3D11ShaderResourceView> cursor_view;
  ComPtr<ID3D11RasterizerState> rasterizer;
  ComPtr<ID3D11DepthStencilState> depth;
  std::array<std::uint32_t, kDxgiMaximumCursorDimension * kDxgiMaximumCursorDimension>
      cursor_pixels{};
  ~Impl() {
    if (cursor) --pool->counters->textures;
  }
};
DxgiFrameCompositor::DxgiFrameCompositor(std::shared_ptr<D3d11DeviceOwner> device,
                                         std::uint32_t raw_width, std::uint32_t raw_height,
                                         DXGI_MODE_ROTATION rotation)
    : impl_(std::make_unique<Impl>()) {
  if (!device || !raw_width || !raw_height || raw_width > 16384 || raw_height > 16384 ||
      rotation > DXGI_MODE_ROTATION_ROTATE270)
    throw std::invalid_argument("Invalid DXGI compositor dimensions/rotation");
  auto& state = *impl_;
  state.pool->device = std::move(device);
  state.config.rotation = rotation;
  state.config.raw_width = raw_width;
  state.config.raw_height = raw_height;
  const bool portrait =
      rotation == DXGI_MODE_ROTATION_ROTATE90 || rotation == DXGI_MODE_ROTATION_ROTATE270;
  state.pool->width = portrait ? raw_height : raw_width;
  state.pool->height = portrait ? raw_width : raw_height;
  auto* gpu = state.pool->device->device();
  D3D11_TEXTURE2D_DESC description{};
  description.Width = raw_width;
  description.Height = raw_height;
  description.MipLevels = description.ArraySize = 1;
  description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  description.SampleDesc.Count = 1;
  description.Usage = D3D11_USAGE_DEFAULT;
  description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
  for (auto& slot : state.pool->slots) {
    check(gpu->CreateTexture2D(&description, nullptr, &slot.desktop),
          "DXGI desktop slot allocation");
    ++state.pool->counters->textures;
    check(gpu->CreateShaderResourceView(slot.desktop.Get(), nullptr, &slot.desktop_view),
          "DXGI desktop SRV");
    auto output = description;
    output.Width = state.pool->width;
    output.Height = state.pool->height;
    output.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    check(gpu->CreateTexture2D(&output, nullptr, &slot.output), "DXGI output slot allocation");
    ++state.pool->counters->textures;
    check(gpu->CreateRenderTargetView(slot.output.Get(), nullptr, &slot.output_view),
          "DXGI output RTV");
  }
  description.Width = description.Height = kDxgiMaximumCursorDimension;
  description.Format = DXGI_FORMAT_R8G8B8A8_UINT;
  check(gpu->CreateTexture2D(&description, nullptr, &state.cursor), "DXGI cursor allocation");
  ++state.pool->counters->textures;
  check(gpu->CreateShaderResourceView(state.cursor.Get(), nullptr, &state.cursor_view),
        "DXGI cursor SRV");
  ComPtr<ID3DBlob> vertex, pixel, errors;
  check(D3DCompile(shader, sizeof(shader) - 1, "dxgi_capture", nullptr, nullptr, "vertex", "vs_5_0",
                   D3DCOMPILE_ENABLE_STRICTNESS, 0, &vertex, &errors),
        "DXGI vertex shader compile");
  errors.Reset();
  check(D3DCompile(shader, sizeof(shader) - 1, "dxgi_capture", nullptr, nullptr, "pixel", "ps_5_0",
                   D3DCOMPILE_ENABLE_STRICTNESS, 0, &pixel, &errors),
        "DXGI pixel shader compile");
  check(gpu->CreateVertexShader(vertex->GetBufferPointer(), vertex->GetBufferSize(), nullptr,
                                &state.vertex),
        "DXGI vertex shader");
  check(gpu->CreatePixelShader(pixel->GetBufferPointer(), pixel->GetBufferSize(), nullptr,
                               &state.pixel),
        "DXGI pixel shader");
  D3D11_BUFFER_DESC buffer{};
  buffer.ByteWidth = sizeof(Config);
  buffer.Usage = D3D11_USAGE_DEFAULT;
  buffer.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
  check(gpu->CreateBuffer(&buffer, nullptr, &state.constant), "DXGI compositor constants");
  D3D11_RASTERIZER_DESC rasterizer{};
  rasterizer.FillMode = D3D11_FILL_SOLID;
  rasterizer.CullMode = D3D11_CULL_NONE;
  rasterizer.DepthClipEnable = TRUE;
  check(gpu->CreateRasterizerState(&rasterizer, &state.rasterizer), "DXGI compositor rasterizer");
  D3D11_DEPTH_STENCIL_DESC depth{};
  depth.DepthEnable = FALSE;
  depth.StencilEnable = FALSE;
  check(gpu->CreateDepthStencilState(&depth, &state.depth), "DXGI compositor depth state");
}
DxgiFrameCompositor::~DxgiFrameCompositor() = default;
std::optional<std::size_t> DxgiFrameCompositor::reserve() {
  for (std::size_t i = 0; i < kDxgiFrameSlots; ++i)
    if (!impl_->pool->slots[i].busy.exchange(true)) {
      const auto occupied = ++impl_->pool->counters->occupied;
      auto peak = impl_->pool->counters->peak.load();
      while (peak < occupied &&
             !impl_->pool->counters->peak.compare_exchange_weak(peak, occupied)) {
      }
      return i;
    }
  return {};
}
void DxgiFrameCompositor::release(std::size_t index) noexcept { impl_->pool->release(index); }
void DxgiFrameCompositor::copyDesktop(std::size_t index, ID3D11Texture2D* source,
                                      const std::unique_lock<std::mutex>& lock) {
  if (!lock.owns_lock() || lock.mutex() != &impl_->pool->device->contextMutex())
    throw std::logic_error("DXGI copy requires the engine context lock");
  D3D11_TEXTURE2D_DESC description{};
  source->GetDesc(&description);
  if (description.Width != impl_->config.raw_width ||
      description.Height != impl_->config.raw_height ||
      description.Format != DXGI_FORMAT_B8G8R8A8_UNORM || description.MipLevels != 1 ||
      description.ArraySize != 1 || description.SampleDesc.Count != 1)
    throw DxgiApiError("DXGI output dimensions/format changed", DXGI_ERROR_ACCESS_LOST);
  impl_->pool->device->context()->CopyResource(impl_->pool->slots[index].desktop.Get(), source);
}
void DxgiFrameCompositor::pointerPosition(POINT position, bool visible) noexcept {
  impl_->config.cursor_x = position.x;
  impl_->config.cursor_y = position.y;
  impl_->config.visible = visible;
}
void DxgiFrameCompositor::pointerShape(std::span<const std::uint8_t> data,
                                       const DXGI_OUTDUPL_POINTER_SHAPE_INFO& shape) {
  const bool mono = shape.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME;
  const auto height = mono ? shape.Height / 2 : shape.Height;
  if (!shape.Width || !height || shape.Width > kDxgiMaximumCursorDimension ||
      height > kDxgiMaximumCursorDimension || (mono && shape.Height % 2) ||
      static_cast<std::uint64_t>(shape.Pitch) * shape.Height > data.size() ||
      shape.Pitch < (mono ? (shape.Width + 7) / 8 : shape.Width * 4) ||
      (!mono && shape.Type != DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR &&
       shape.Type != DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR))
    throw DxgiApiError("DXGI cursor shape exceeds fixed bounds", DXGI_ERROR_UNSUPPORTED);
  for (std::uint32_t y = 0; y < height; ++y)
    for (std::uint32_t x = 0; x < shape.Width; ++x) {
      auto& output = impl_->cursor_pixels[y * shape.Width + x];
      if (mono) {
        const auto bit = 0x80U >> (x % 8);
        const auto and_mask = (data[y * shape.Pitch + x / 8] & bit) ? 255U : 0U;
        const auto xor_mask = (data[(y + height) * shape.Pitch + x / 8] & bit) ? 255U : 0U;
        output = and_mask | (xor_mask << 8);
      } else
        std::memcpy(&output, data.data() + y * shape.Pitch + x * 4ULL, sizeof(output));
    }
  impl_->config.cursor_mode = shape.Type;
  impl_->config.cursor_width = shape.Width;
  impl_->config.cursor_height = height;
  const D3D11_BOX box{0, 0, 0, shape.Width, height, 1};
  std::scoped_lock lock(impl_->pool->device->contextMutex());
  impl_->pool->device->context()->UpdateSubresource(
      impl_->cursor.Get(), 0, &box, impl_->cursor_pixels.data(), shape.Width * 4, 0);
}
std::shared_ptr<FrameResource> DxgiFrameCompositor::compose(std::size_t index) {
  auto& state = *impl_;
  std::scoped_lock lock(state.pool->device->contextMutex());
  auto* context = state.pool->device->context();
  auto* target = state.pool->slots[index].output_view.Get();
  context->UpdateSubresource(state.constant.Get(), 0, nullptr, &state.config, 0, 0);
  context->IASetInputLayout(nullptr);
  context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  context->VSSetShader(state.vertex.Get(), nullptr, 0);
  context->PSSetShader(state.pixel.Get(), nullptr, 0);
  context->GSSetShader(nullptr, nullptr, 0);
  context->HSSetShader(nullptr, nullptr, 0);
  context->DSSetShader(nullptr, nullptr, 0);
  auto* constants = state.constant.Get();
  context->PSSetConstantBuffers(0, 1, &constants);
  ID3D11ShaderResourceView* views[]{state.pool->slots[index].desktop_view.Get(),
                                    state.cursor_view.Get()};
  context->PSSetShaderResources(0, 2, views);
  context->OMSetRenderTargets(1, &target, nullptr);
  context->OMSetBlendState(nullptr, nullptr, 0xffffffff);
  context->OMSetDepthStencilState(state.depth.Get(), 0);
  context->RSSetState(state.rasterizer.Get());
  const D3D11_VIEWPORT viewport{
      0, 0, static_cast<float>(state.pool->width), static_cast<float>(state.pool->height), 0, 1};
  context->RSSetViewports(1, &viewport);
  context->Draw(3, 0);
  ID3D11ShaderResourceView* empty[2]{};
  context->PSSetShaderResources(0, 2, empty);
  context->OMSetRenderTargets(0, nullptr, nullptr);
  // This offscreen path never Presents. Submit the copy/composition commands
  // before the frame crosses into the Media Foundation device-manager path.
  // Flush submits work; it does not wait for GPU completion or hold DXGI input.
  context->Flush();
  return std::make_shared<SlotFrame>(state.pool, index);
}
std::shared_ptr<DxgiPoolCounters> DxgiFrameCompositor::counters() const {
  return impl_->pool->counters;
}
std::uint32_t DxgiFrameCompositor::width() const noexcept { return impl_->pool->width; }
std::uint32_t DxgiFrameCompositor::height() const noexcept { return impl_->pool->height; }
}  // namespace syrnike::windows_media::capture::detail
