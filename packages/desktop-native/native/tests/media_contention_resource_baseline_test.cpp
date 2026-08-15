#include <iostream>
#include <stdexcept>

#include "media_contention_resource_baseline.hpp"

namespace {

using syrnike::desktop_native::tests::contentionResourceBaselineReady;
using syrnike::desktop_native::tests::ContentionResourceBaselineGate;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void baselineRequiresTenStableHundredMillisecondSamples() {
  ContentionResourceBaselineGate<10> gate;
  require(
      !gate.observe(true, 1, 1, 0) && gate.stableSamples() == 1,
      "baseline gate did not expose its first stable observation");
  for (std::size_t sample = 1; sample < 9; ++sample) {
    require(
        !gate.observe(true, 1, 1, 0),
        "baseline settled before one second of stable media");
  }
  require(
      gate.observe(true, 1, 1, 0),
      "baseline did not settle after ten stable samples");

  ContentionResourceBaselineGate<10> reset_gate;
  for (std::size_t sample = 0; sample < 9; ++sample) {
    static_cast<void>(reset_gate.observe(true, 1, 1, 0));
  }
  require(
      !reset_gate.observe(true, 1, 1, 1),
      "a pending command did not reset baseline settling");
  require(
      reset_gate.stableSamples() == 0,
      "a failed readiness sample did not expose the reset");
  for (std::size_t sample = 0; sample < 9; ++sample) {
    require(
        !reset_gate.observe(true, 1, 1, 0),
        "baseline retained stable samples across pending work");
  }
  require(
      reset_gate.observe(true, 1, 1, 0),
      "baseline did not settle after the reset window");
}

void baselineWaitsForEveryLongLivedWorkerAndAQuiescentCommandLane() {
  require(
      !contentionResourceBaselineReady(false, 1, 1, 0),
      "baseline was captured before linked video delivery");
  require(
      !contentionResourceBaselineReady(true, 0, 1, 0),
      "baseline was captured before remote audio ingress");
  require(
      !contentionResourceBaselineReady(true, 1, 0, 0),
      "baseline was captured before the WASAPI fill callback");
  require(
      !contentionResourceBaselineReady(true, 1, 1, 1),
      "baseline was captured with a pending posted command");
  require(
      contentionResourceBaselineReady(true, 1, 1, 0),
      "stable linked media did not establish the resource baseline");
}

}  // namespace

int main() try {
  baselineWaitsForEveryLongLivedWorkerAndAQuiescentCommandLane();
  baselineRequiresTenStableHundredMillisecondSamples();
  std::cout << "media contention resource baseline tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
