#include "media_contention_terminal_resource.hpp"

#include <stdexcept>
#include <string>

using syrnike::desktop_native::tests::ContentionTerminalResourceGate;
using syrnike::desktop_native::tests::ContentionTerminalResourceState;

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main() {
  ContentionTerminalResourceGate gate;
  const ContentionTerminalResourceState drained{
      .native_pending = 0,
      .held_leases = 0,
      .renderer_leases = 0,
      .gpu_generations = 0,
      .cleanup_owned = 0,
      .cleanup_active = 0,
      .cleanup_backlog = 0,
      .livekit_shutdown_complete = true,
  };
  require(gate.ready(drained), "fully drained terminal state was rejected");

  const ContentionTerminalResourceState premature_epoch_two{
      .native_pending = 2,
      .held_leases = 2,
      .renderer_leases = 2,
      .gpu_generations = 1,
      .cleanup_owned = 0,
      .cleanup_active = 0,
      .cleanup_backlog = 0,
      .livekit_shutdown_complete = false,
  };
  require(
      !gate.ready(premature_epoch_two),
      "the premature epoch-two summary was accepted as terminal");

  const std::string expected[] = {
      "native-pending",
      "held-leases",
      "renderer-leases",
      "gpu-generations",
      "cleanup-owned",
      "cleanup-active",
      "cleanup-backlog",
      "livekit-shutdown",
  };
  for (std::size_t index = 0; index < std::size(expected); ++index) {
    auto state = drained;
    switch (index) {
      case 0: state.native_pending = 1; break;
      case 1: state.held_leases = 1; break;
      case 2: state.renderer_leases = 1; break;
      case 3: state.gpu_generations = 1; break;
      case 4: state.cleanup_owned = 1; break;
      case 5: state.cleanup_active = 1; break;
      case 6: state.cleanup_backlog = 1; break;
      case 7: state.livekit_shutdown_complete = false; break;
    }
    require(!gate.ready(state), "a terminal resource blocker was ignored");
    require(
        gate.blocker(state) == expected[index],
        "terminal resource blocker lost its typed reason");
  }
}
