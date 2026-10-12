#include <array>
#include <stdexcept>

#include "capture/d3d11_device.hpp"
#include "screen/hardware_h264_capability.hpp"

namespace syrnike::windows_media::screen::tests {

void hardwareH264ProbeCoversFixedProfiles() {
  constexpr std::array profiles{kScreenProfile1080p60,
                                kScreenProfile1440p30,
                                kScreenProfile720p30};
  const auto invalid = probeHardwareH264({}, profiles);
  if (invalid.available || !invalid.failure ||
      invalid.failure->code != "screen_hardware_h264_probe_invalid")
    throw std::runtime_error("invalid hardware probe was not typed");

  const auto owner = capture::processD3d11Device(false);
  const auto result = probeHardwareH264(owner, profiles);
  if (!result.available || result.adapter_luid != owner->adapterLuid() ||
      result.profiles.size() != profiles.size()) {
    throw std::runtime_error(
        result.failure ? result.failure->message
                       : "hardware H.264 probe was incomplete");
  }
  for (const auto& profile : result.profiles) {
    if (!profile.available || profile.transform_name.empty())
      throw std::runtime_error("fixed profile has no hardware H.264 MFT");
  }
}

}  // namespace syrnike::windows_media::screen::tests
