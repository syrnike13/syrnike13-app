#include "capture/wgc_capture_support.hpp"

#include <d3d11_4.h>
#include <d3d11sdklayers.h>
#include <dxgi1_6.h>
#include <roapi.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <algorithm>
#include <cstring>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <unordered_map>
#include <utility>

#include <winrt/Windows.Foundation.h>
#include <winrt/base.h>

namespace syrnike::windows_media::capture::detail {
namespace {

using Microsoft::WRL::ComPtr;
using winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame;
using winrt::Windows::Graphics::Capture::GraphicsCaptureItem;
using winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
using DxgiInterfaceAccess =
    ::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess;

struct WgcDeviceCache {
  std::mutex mutex;
  std::shared_ptr<WgcDeviceState> device;
};

WgcDeviceCache& wgcDeviceCache() {
  static WgcDeviceCache cache;
  return cache;
}

struct CaptureItemCacheEntry {
  GraphicsCaptureItem item{nullptr};
  winrt::event_token closed_token{};
  bool closed = false;
};

struct CaptureItemCache {
  std::mutex mutex;
  std::unordered_map<std::string, CaptureItemCacheEntry> items;
};

CaptureItemCache& captureItemCache() {
  // Closed is delivered asynchronously by WGC. Keep the bounded cache alive
  // through process teardown so a late callback cannot race static teardown.
  static auto* cache = new CaptureItemCache();
  return *cache;
}

inline constexpr std::size_t kMaximumCachedCaptureItems = 64;

void pruneClosedCaptureItems(CaptureItemCache& cache) {
  for (auto iterator = cache.items.begin(); iterator != cache.items.end();) {
    if (iterator->second.closed)
      iterator = cache.items.erase(iterator);
    else
      ++iterator;
  }
}

template <typename CreateItem>
GraphicsCaptureItem acquireCachedCaptureItem(std::string key,
                                             CreateItem create_item) {
  auto& cache = captureItemCache();
  std::lock_guard lock(cache.mutex);
  pruneClosedCaptureItems(cache);
  const auto found = cache.items.find(key);
  if (found != cache.items.end()) return found->second.item;

  const auto item_factory = winrt::get_activation_factory<
      GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  GraphicsCaptureItem item{nullptr};
  winrt::check_hresult(create_item(item_factory, item));
  const auto token = item.Closed(
      [key](const GraphicsCaptureItem&,
            const winrt::Windows::Foundation::IInspectable&) {
        auto& item_cache = captureItemCache();
        std::lock_guard cache_lock(item_cache.mutex);
        const auto found = item_cache.items.find(key);
        if (found != item_cache.items.end()) found->second.closed = true;
      });
  if (cache.items.size() < kMaximumCachedCaptureItems) {
    cache.items.emplace(key, CaptureItemCacheEntry{item, token, false});
  } else {
    item.Closed(token);
  }
  return item;
}

class ScopedRoInitialization final {
 public:
  ScopedRoInitialization() {
    result_ = RoInitialize(RO_INIT_MULTITHREADED);
    if (FAILED(result_) && result_ != RPC_E_CHANGED_MODE)
      winrt::check_hresult(result_);
  }
  ~ScopedRoInitialization() {
    if (SUCCEEDED(result_)) RoUninitialize();
  }

 private:
  HRESULT result_ = E_FAIL;
};

class D3D11FrameResource final : public FrameResource {
 public:
  D3D11FrameResource(
      std::shared_ptr<WgcDeviceState> device,
      std::shared_ptr<std::atomic<std::uint64_t>> live_resources,
      std::shared_ptr<std::atomic<std::uint64_t>> peak_resources,
      Direct3D11CaptureFrame frame, ComPtr<ID3D11Texture2D> texture,
      std::uint32_t width, std::uint32_t height);
  ~D3D11FrameResource() override;

  std::uint64_t sampledHash() override;
  std::optional<D3d11FrameView> d3d11View() override;
  void copyBgraTo(std::span<std::uint8_t> destination,
                  std::size_t destination_stride) override;

 private:
  template <typename Callback>
  auto withMappedBgra(Callback callback);

  std::shared_ptr<WgcDeviceState> device_;
  std::shared_ptr<std::atomic<std::uint64_t>> live_resources_;
  std::shared_ptr<std::atomic<std::uint64_t>> peak_resources_;
  Direct3D11CaptureFrame frame_{nullptr};
  ComPtr<ID3D11Texture2D> texture_;
  std::uint32_t width_ = 0;
  std::uint32_t height_ = 0;
};

}  // namespace

std::string hresultText(HRESULT value) {
  std::ostringstream output;
  output << "HRESULT 0x" << std::hex << static_cast<std::uint32_t>(value);
  return output.str();
}

void ensureRoInitialized() {
  thread_local ScopedRoInitialization apartment;
  (void)apartment;
}

std::shared_ptr<WgcDeviceState> createWgcDevice(bool request_debug,
                                                bool& debug_enabled) {
  auto& cache = wgcDeviceCache();
  std::lock_guard lock(cache.mutex);
  if (!cache.device) {
    cache.device = std::make_shared<WgcDeviceState>();
    cache.device->owner = processD3d11Device(request_debug);
  }
  debug_enabled = cache.device->owner->debugLayerEnabled();
  return cache.device;
}

IDirect3DDevice createWinrtD3DDevice(
    const std::shared_ptr<WgcDeviceState>& device) {
  ComPtr<IDXGIDevice> dxgi_device;
  winrt::check_hresult(device->owner->device()->QueryInterface(
      IID_PPV_ARGS(&dxgi_device)));
  winrt::com_ptr<::IInspectable> inspectable;
  winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(
      dxgi_device.Get(), inspectable.put()));
  return inspectable.as<IDirect3DDevice>();
}

GraphicsCaptureItem acquireMonitorCaptureItem(
    std::uintptr_t platform_value, const std::string& stable_identity) {
  return acquireCachedCaptureItem(
      "monitor:" + stable_identity + "@" + std::to_string(platform_value),
      [platform_value](const auto& factory, GraphicsCaptureItem& item) {
        return factory->CreateForMonitor(
            reinterpret_cast<HMONITOR>(platform_value),
            winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item));
      });
}

GraphicsCaptureItem acquireWindowCaptureItem(
    std::uintptr_t platform_value, const std::string& stable_identity) {
  return acquireCachedCaptureItem(
      "window:" + stable_identity + "@" + std::to_string(platform_value),
      [platform_value](const auto& factory, GraphicsCaptureItem& item) {
        return factory->CreateForWindow(
            reinterpret_cast<HWND>(platform_value),
            winrt::guid_of<GraphicsCaptureItem>(), winrt::put_abi(item));
      });
}

D3D11FrameResource::D3D11FrameResource(
    std::shared_ptr<WgcDeviceState> device,
    std::shared_ptr<std::atomic<std::uint64_t>> live_resources,
    std::shared_ptr<std::atomic<std::uint64_t>> peak_resources,
    Direct3D11CaptureFrame frame, ComPtr<ID3D11Texture2D> texture,
    std::uint32_t width, std::uint32_t height)
    : device_(std::move(device)),
      live_resources_(std::move(live_resources)),
      peak_resources_(std::move(peak_resources)),
      frame_(std::move(frame)),
      texture_(std::move(texture)),
      width_(width),
      height_(height) {
  const auto current = live_resources_->fetch_add(1) + 1;
  auto peak = peak_resources_->load();
  while (peak < current &&
         !peak_resources_->compare_exchange_weak(peak, current)) {
  }
}

D3D11FrameResource::~D3D11FrameResource() { live_resources_->fetch_sub(1); }

std::optional<D3d11FrameView> D3D11FrameResource::d3d11View() {
  return D3d11FrameView{device_->owner, texture_.Get()};
}

std::uint64_t D3D11FrameResource::sampledHash() {
  D3D11_TEXTURE2D_DESC description{};
  texture_->GetDesc(&description);
  D3D11_TEXTURE2D_DESC staging_description = description;
  staging_description.Width = (std::min)(description.Width, width_);
  staging_description.Height = (std::min)(description.Height, height_);
  staging_description.Usage = D3D11_USAGE_STAGING;
  staging_description.BindFlags = 0;
  staging_description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  staging_description.MiscFlags = 0;
  staging_description.MipLevels = 1;
  staging_description.ArraySize = 1;
  staging_description.SampleDesc = {1, 0};
  ComPtr<ID3D11Texture2D> staging;
  winrt::check_hresult(device_->owner->device()->CreateTexture2D(
      &staging_description, nullptr, &staging));
  constexpr char staging_name[] = "SyrnikeMonitorHashStaging";
  (void)staging->SetPrivateData(WKPDID_D3DDebugObjectName,
                                sizeof(staging_name) - 1, staging_name);

  D3D11_MAPPED_SUBRESOURCE mapped{};
  {
    std::lock_guard lock(device_->owner->contextMutex());
    const D3D11_BOX source_box{0, 0, 0, staging_description.Width,
                               staging_description.Height, 1};
    device_->owner->context()->CopySubresourceRegion(staging.Get(), 0, 0, 0, 0,
                                            texture_.Get(), 0, &source_box);
    winrt::check_hresult(device_->owner->context()->Map(
        staging.Get(), 0, D3D11_MAP_READ, 0, &mapped));
  }
  struct Unmapper {
    std::shared_ptr<WgcDeviceState> device;
    ID3D11Texture2D* texture;
    ~Unmapper() {
      std::lock_guard lock(device->owner->contextMutex());
      device->owner->context()->Unmap(texture, 0);
    }
  } unmapper{device_, staging.Get()};

  constexpr std::uint64_t offset_basis = 1469598103934665603ULL;
  constexpr std::uint64_t prime = 1099511628211ULL;
  std::uint64_t hash = offset_basis;
  const auto* bytes = static_cast<const std::uint8_t*>(mapped.pData);
  const auto sample_width = (std::min)(staging_description.Width, 64U);
  const auto sample_height = (std::min)(staging_description.Height, 64U);
  for (std::uint32_t sample_y = 0; sample_y < sample_height; ++sample_y) {
    const auto y = static_cast<std::uint64_t>(sample_y) *
                   staging_description.Height / sample_height;
    const auto* row = bytes + y * mapped.RowPitch;
    for (std::uint32_t sample_x = 0; sample_x < sample_width; ++sample_x) {
      const auto x = static_cast<std::uint64_t>(sample_x) *
                     staging_description.Width / sample_width;
      const auto* pixel = row + x * 4U;
      for (std::uint32_t channel = 0; channel < 4; ++channel)
        hash = (hash ^ pixel[channel]) * prime;
    }
  }
  hash = (hash ^ staging_description.Width) * prime;
  return (hash ^ staging_description.Height) * prime;
}

template <typename Callback>
auto D3D11FrameResource::withMappedBgra(Callback callback) {
  D3D11_TEXTURE2D_DESC source_description{};
  texture_->GetDesc(&source_description);
  const auto copy_width = (std::min)(source_description.Width, width_);
  const auto copy_height = (std::min)(source_description.Height, height_);
  if (copy_width != width_ || copy_height != height_) {
    throw std::runtime_error(
        "WGC texture is smaller than its immutable frame metadata");
  }
  std::lock_guard lock(device_->owner->contextMutex());
  if (!device_->readback_staging || device_->readback_width != copy_width ||
      device_->readback_height != copy_height) {
    D3D11_TEXTURE2D_DESC staging_description = source_description;
    staging_description.Width = copy_width;
    staging_description.Height = copy_height;
    staging_description.Usage = D3D11_USAGE_STAGING;
    staging_description.BindFlags = 0;
    staging_description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    staging_description.MiscFlags = 0;
    staging_description.MipLevels = 1;
    staging_description.ArraySize = 1;
    staging_description.SampleDesc = {1, 0};
    ComPtr<ID3D11Texture2D> staging;
    winrt::check_hresult(device_->owner->device()->CreateTexture2D(
        &staging_description, nullptr, &staging));
    constexpr char staging_name[] = "SyrnikeCpuReferenceReadback";
    (void)staging->SetPrivateData(WKPDID_D3DDebugObjectName,
                                  sizeof(staging_name) - 1, staging_name);
    device_->readback_staging = std::move(staging);
    device_->readback_width = copy_width;
    device_->readback_height = copy_height;
  }

  const D3D11_BOX source_box{0, 0, 0, copy_width, copy_height, 1};
  device_->owner->context()->CopySubresourceRegion(device_->readback_staging.Get(), 0,
                                          0, 0, 0, texture_.Get(), 0,
                                          &source_box);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  winrt::check_hresult(device_->owner->context()->Map(device_->readback_staging.Get(), 0,
                                             D3D11_MAP_READ, 0, &mapped));
  try {
    auto result = callback(mapped, copy_width, copy_height);
    device_->owner->context()->Unmap(device_->readback_staging.Get(), 0);
    return result;
  } catch (...) {
    device_->owner->context()->Unmap(device_->readback_staging.Get(), 0);
    throw;
  }
}

void D3D11FrameResource::copyBgraTo(
    std::span<std::uint8_t> destination,
    std::size_t destination_stride) {
  const auto required_stride = static_cast<std::size_t>(width_) * 4U;
  if (destination_stride < required_stride ||
      destination.size() < destination_stride * height_) {
    throw std::invalid_argument("CPU readback destination is too small");
  }
  withMappedBgra([&](const D3D11_MAPPED_SUBRESOURCE& mapped,
                     std::uint32_t width, std::uint32_t height) {
    const auto* source = static_cast<const std::uint8_t*>(mapped.pData);
    for (std::uint32_t y = 0; y < height; ++y) {
      std::memcpy(destination.data() + y * destination_stride,
                  source + y * mapped.RowPitch,
                  static_cast<std::size_t>(width) * 4U);
    }
    return 0;
  });
}

std::shared_ptr<FrameResource> makeWgcFrameResource(
    std::shared_ptr<WgcDeviceState> device,
    std::shared_ptr<std::atomic<std::uint64_t>> live_resources,
    std::shared_ptr<std::atomic<std::uint64_t>> peak_resources,
    Direct3D11CaptureFrame frame, ComPtr<ID3D11Texture2D> texture,
    std::uint32_t width, std::uint32_t height) {
  return std::make_shared<D3D11FrameResource>(
      std::move(device), std::move(live_resources),
      std::move(peak_resources), std::move(frame), std::move(texture), width,
      height);
}

}  // namespace syrnike::windows_media::capture::detail
