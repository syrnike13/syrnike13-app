#pragma once

#include <audioclient.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <string>
#include <vector>

#include "../common/runtime_types.hpp"

namespace syrnike::desktop_native::media {

Microsoft::WRL::ComPtr<IMMDevice> captureDevice(const std::string& device_id);
Microsoft::WRL::ComPtr<IMMDevice> renderDevice();
std::vector<DeviceInfo> listAudioDevices();
WAVEFORMATEX desiredCaptureFormat();
WAVEFORMATEX desiredRenderFormat();

}  // namespace syrnike::desktop_native::media

namespace syrnike::voice {

Microsoft::WRL::ComPtr<IMMDevice> getCaptureDevice(const std::string& device_id);
Microsoft::WRL::ComPtr<IMMDevice> getRenderDevice();

}  // namespace syrnike::voice
