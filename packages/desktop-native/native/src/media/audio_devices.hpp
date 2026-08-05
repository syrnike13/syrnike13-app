#pragma once

#include <audioclient.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>

#include <chrono>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "../common/runtime_types.hpp"

namespace syrnike::desktop_native::media {

Microsoft::WRL::ComPtr<IMMDevice> captureDevice(const std::string& device_id);
Microsoft::WRL::ComPtr<IMMDevice> renderDevice();
Microsoft::WRL::ComPtr<IMMDevice> renderDevice(const std::string& device_id);
std::string audioEndpointId(IMMDevice* device);
std::string resolvedRenderDeviceId(const std::string& device_id);
std::vector<DeviceInfo> listAudioDevices();
WAVEFORMATEX desiredCaptureFormat();
WAVEFORMATEX desiredRenderFormat();

enum class AudioEndpointChangeKind {
  DefaultChanged,
  Added,
  Active,
  Removed,
  Disabled,
};

struct AudioEndpointChange {
  EDataFlow flow = eAll;
  AudioEndpointChangeKind kind = AudioEndpointChangeKind::Disabled;
  std::string device_id;
  ERole role = eConsole;
};

bool audioEndpointChangeRequiresDefaultRetry(
  std::string_view selected_device_id,
  bool fallback_pending,
  const AudioEndpointChange& change
) noexcept;

class AudioEndpointMonitor final {
 public:
  using Handler = std::function<void(AudioEndpointChange)>;

  AudioEndpointMonitor(EDataFlow flow, Handler handler);
  ~AudioEndpointMonitor();
  AudioEndpointMonitor(const AudioEndpointMonitor&) = delete;
  AudioEndpointMonitor& operator=(const AudioEndpointMonitor&) = delete;

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

void probeCaptureDevice(
  const std::string& device_id,
  const WAVEFORMATEX& format,
  std::chrono::milliseconds timeout
);
void probeRenderDevice(
  const std::string& device_id,
  const WAVEFORMATEX& format,
  std::chrono::milliseconds timeout
);

}  // namespace syrnike::desktop_native::media

namespace syrnike::voice {

Microsoft::WRL::ComPtr<IMMDevice> getCaptureDevice(const std::string& device_id);
Microsoft::WRL::ComPtr<IMMDevice> getRenderDevice();

}  // namespace syrnike::voice
