#include <iostream>
#include <stdexcept>
#include <string>

#include "common/bounded_queue.hpp"
#include "hooks/input_state.hpp"
#include "hooks/key_codes.hpp"
#include "media/generation_fence.hpp"
#include "media/capture_lifecycle_invariants.hpp"
#include "media/runtime_config.hpp"
#include "media/runtime_config_patch.hpp"
#include "media/screen_session_invariants.hpp"

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main() try {
  using syrnike::desktop_native::BoundedQueue;

  BoundedQueue<std::string, 2> queue;
  require(queue.tryPush("first"), "queue rejected first item");
  require(queue.tryPush("second"), "queue rejected second item");
  require(!queue.tryPush("overflow"), "queue exceeded capacity");
  require(queue.waitPop() == "first", "queue lost FIFO ordering");
  queue.close();
  require(!queue.tryPush("closed"), "closed queue accepted an item");
  require(queue.waitPop() == "second", "close should drain by default");
  require(!queue.waitPop().has_value(), "closed queue did not finish draining");

  BoundedQueue<std::string, 2> cancelled;
  require(cancelled.tryPush("first"), "cancel queue rejected first item");
  require(cancelled.tryPush("second"), "cancel queue rejected second item");
  require(cancelled.closeAndDiscard() == 2, "cancel queue did not report discarded items");
  require(!cancelled.waitPop().has_value(), "cancel queue executed discarded work");

  syrnike::hotkeys::InputState input;
  require(input.applyDown("keyboard", "ControlLeft", "Left Ctrl").has_value(), "key down missing");
  require(!input.applyDown("keyboard", "ControlLeft", "Left Ctrl").has_value(), "duplicate key down emitted");
  const auto released = input.applyUp("keyboard", "ControlLeft", "Left Ctrl");
  require(released.has_value(), "key up missing");
  require(released->pressed_codes.empty(), "released key stayed pressed");
  require(syrnike::hotkeys::isInjectedKeyEvent(syrnike::hotkeys::kLlkhfInjected), "injected key flag missed");

  input.applyDown("keyboard", "ShiftLeft", "Left Shift");
  input.reset();
  require(!input.applyUp("keyboard", "ShiftLeft", "Left Shift").has_value(), "reset retained pressed key");
  require(input.applyDown("keyboard", "ShiftLeft", "Left Shift").has_value(), "reset blocked fresh key down");

  syrnike::desktop_native::media::GenerationFence fence;
  fence.set("committed", 4);
  const auto committed = fence.current();
  fence.set("candidate", 5);
  fence.restoreIfCurrent("candidate", 5, committed.first, committed.second);
  require(fence.isCurrent("committed", 4), "candidate rollback lost committed generation");
  fence.set("newer", 6);
  fence.restoreIfCurrent("candidate", 5, committed.first, committed.second);
  require(fence.isCurrent("newer", 6), "stale rollback overwrote newer generation");

  syrnike::desktop_native::media::GenerationFence desired;
  require(desired.advance("active", 7), "initial generation was rejected");
  require(!desired.advance("stale", 6), "generation fence regressed");
  require(desired.isCurrent("active", 7), "stale generation changed current intent");
  require(!desired.advance("collision", 7), "same-generation session collision was accepted");
  require(desired.advance("active", 7), "idempotent generation update was rejected");
  require(desired.advance("next", 8), "newer generation was rejected");

  syrnike::voice::RuntimeConfig config;
  config.input_volume = 0.75f;
  config.voice_gate_enabled = true;
  config.noise_suppression_enabled = true;
  syrnike::desktop_native::MediaCommand partial;
  partial.voice_gate_enabled = false;
  partial.has_voice_gate_enabled = true;
  const auto merged = syrnike::desktop_native::media::mergeRuntimeConfig(config, partial);
  require(merged.input_volume == 0.75f, "partial config reset input volume");
  require(!merged.voice_gate_enabled, "partial config did not apply voice gate");
  require(merged.noise_suppression_enabled, "partial config reset noise suppression");

  using syrnike::desktop_native::media::canReuseActiveScreenRoom;
  require(canReuseActiveScreenRoom(false, "prepared", 1, "other", 2, false), "idle room connect rejected");
  require(canReuseActiveScreenRoom(true, "active", 7, "active", 7, true), "active owner reuse rejected");
  require(!canReuseActiveScreenRoom(true, "active", 7, "prepared", 8, true), "preconnect stole active room");
  require(!canReuseActiveScreenRoom(true, "active", 7, "active", 8, true), "new generation retagged active room");
  require(!canReuseActiveScreenRoom(true, "active", 7, "active", 7, false), "credentials replaced active room");

  using syrnike::desktop_native::media::isCurrentCaptureFailure;
  require(isCurrentCaptureFailure(4, 4, false, false), "current stopped capture failure ignored");
  require(isCurrentCaptureFailure(4, 4, true, false), "unready capture failure ignored");
  require(!isCurrentCaptureFailure(3, 4, false, false), "old capture failure killed restarted pipeline");
  require(!isCurrentCaptureFailure(4, 4, true, true), "healthy pipeline treated as failed");
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
