#pragma once
#include "capture/dxgi_monitor_capture.hpp"
#include <dxgi1_2.h>
#include <atomic>
#include <array>
#include <stdexcept>

namespace syrnike::windows_media::capture::detail {
class DxgiApiError final : public std::runtime_error {
 public:
  DxgiApiError(const char* operation, HRESULT value)
      : std::runtime_error(operation), result(value) {}
  HRESULT result;
};
struct DxgiPoolCounters {
  std::atomic_size_t occupied{0}, peak{0}, textures{0};
};
// Three immutable output slots. Rotation/cursor composition runs only after
// duplication ReleaseFrame, entirely on the engine's existing GPU device.
class DxgiFrameCompositor final {
 public:
  DxgiFrameCompositor(std::shared_ptr<D3d11DeviceOwner>, std::uint32_t raw_width,
                      std::uint32_t raw_height, DXGI_MODE_ROTATION rotation);
  ~DxgiFrameCompositor();
  std::optional<std::size_t> reserve();
  void release(std::size_t) noexcept;
  void copyDesktop(std::size_t, ID3D11Texture2D*, const std::unique_lock<std::mutex>&);
  void pointerPosition(POINT, bool visible) noexcept;
  void pointerShape(std::span<const std::uint8_t>, const DXGI_OUTDUPL_POINTER_SHAPE_INFO&);
  std::shared_ptr<FrameResource> compose(std::size_t);
  std::shared_ptr<DxgiPoolCounters> counters() const;
  std::uint32_t width() const noexcept;
  std::uint32_t height() const noexcept;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
}  // namespace syrnike::windows_media::capture::detail
