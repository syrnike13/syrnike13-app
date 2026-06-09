#pragma once

#include <audioclient.h>
#include <mmdeviceapi.h>
#include <windows.h>
#include <wrl/client.h>

#include <string>

namespace syrnike::voice {

Microsoft::WRL::ComPtr<IMMDevice> getCaptureDevice(const std::string& device_id);
Microsoft::WRL::ComPtr<IMMDevice> getRenderDevice();
void emitDeviceList();
WAVEFORMATEX desiredCaptureFormat();
WAVEFORMATEX desiredRenderFormat();

}  // namespace syrnike::voice
