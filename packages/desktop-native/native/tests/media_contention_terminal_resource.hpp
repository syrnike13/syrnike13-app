#pragma once

#include <cstddef>
#include <string_view>

namespace syrnike::desktop_native::tests {

struct ContentionTerminalResourceState {
  std::size_t native_pending = 0;
  std::size_t held_leases = 0;
  std::size_t renderer_leases = 0;
  std::size_t gpu_generations = 0;
  std::size_t cleanup_owned = 0;
  std::size_t cleanup_active = 0;
  std::size_t cleanup_backlog = 0;
  bool livekit_shutdown_complete = false;
};

class ContentionTerminalResourceGate final {
 public:
  [[nodiscard]] bool ready(
      const ContentionTerminalResourceState& state) const noexcept {
    return blocker(state).empty();
  }

  [[nodiscard]] std::string_view blocker(
      const ContentionTerminalResourceState& state) const noexcept {
    if (state.native_pending != 0) return "native-pending";
    if (state.held_leases != 0) return "held-leases";
    if (state.renderer_leases != 0) return "renderer-leases";
    if (state.gpu_generations != 0) return "gpu-generations";
    if (state.cleanup_owned != 0) return "cleanup-owned";
    if (state.cleanup_active != 0) return "cleanup-active";
    if (state.cleanup_backlog != 0) return "cleanup-backlog";
    if (!state.livekit_shutdown_complete) return "livekit-shutdown";
    return {};
  }
};

}  // namespace syrnike::desktop_native::tests
