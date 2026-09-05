#pragma once

#include <memory>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include "capture/d3d11_device.hpp"
#include "screen/gpu_screen_converter.hpp"

namespace syrnike::windows_media::screen {

struct HardwareH264Failure {
  std::string code;
  std::string message;
  std::string stage;
  bool utility_epoch_retirement_required = false;
};

struct HardwareH264ProfileCapability {
  ScreenVideoProfile profile;
  bool available = false;
  std::string transform_name;
};

struct HardwareH264Capability {
  bool available = false;
  capture::D3d11AdapterLuid adapter_luid;
  std::vector<HardwareH264ProfileCapability> profiles;
  std::optional<HardwareH264Failure> failure;
};

// Enumerates only hardware Media Foundation H.264 encoders and fully configures
// each fixed profile against the process D3D11 device. No software activation
// is queried or accepted.
[[nodiscard]] HardwareH264Capability probeHardwareH264(
    const std::shared_ptr<capture::D3d11DeviceOwner>& device_owner,
    std::span<const ScreenVideoProfile> profiles);

}  // namespace syrnike::windows_media::screen
