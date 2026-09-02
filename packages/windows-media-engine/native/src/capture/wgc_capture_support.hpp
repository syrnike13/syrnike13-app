#pragma once

#include <d3d11.h>
#include <windows.h>
#include <wrl/client.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>

#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include "capture/monitor_capture.hpp"

namespace syrnike::windows_media::capture::detail {

struct WgcDeviceState {
  Microsoft::WRL::ComPtr<ID3D11Device> device;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
  std::mutex context_mutex;
  Microsoft::WRL::ComPtr<ID3D11Texture2D> readback_staging;
  std::uint32_t readback_width = 0;
  std::uint32_t readback_height = 0;
};

std::string hresultText(HRESULT value);
void ensureRoInitialized();

std::shared_ptr<WgcDeviceState> createWgcDevice(bool request_debug,
                                                bool& debug_enabled);
winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice
createWinrtD3DDevice(const std::shared_ptr<WgcDeviceState>& device);

winrt::Windows::Graphics::Capture::GraphicsCaptureItem
acquireMonitorCaptureItem(std::uintptr_t platform_value,
                          const std::string& stable_identity);
winrt::Windows::Graphics::Capture::GraphicsCaptureItem
acquireWindowCaptureItem(std::uintptr_t platform_value,
                         const std::string& stable_identity);

std::shared_ptr<FrameResource> makeWgcFrameResource(
    std::shared_ptr<WgcDeviceState> device,
    std::shared_ptr<std::atomic<std::uint64_t>> live_resources,
    std::shared_ptr<std::atomic<std::uint64_t>> peak_resources,
    winrt::Windows::Graphics::Capture::Direct3D11CaptureFrame frame,
    Microsoft::WRL::ComPtr<ID3D11Texture2D> texture,
    std::uint32_t width, std::uint32_t height);

}  // namespace syrnike::windows_media::capture::detail
