#include <cmath>
#include <iostream>
#include <stdexcept>

#include "media_contention_screen_cadence.hpp"

namespace {

using syrnike::desktop_native::tests::contentionScreenCadence;
using syrnike::desktop_native::tests::ContentionRecoveryIntervals;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void exactBackendRecoveryIsSeparatedFromOrdinaryCadence() {
  const auto cadence = contentionScreenCadence(95, 10'000.0, 952.380952);
  require(
      std::abs(cadence.total_fps - 9.5) < 0.001,
      "total cadence did not retain the complete observation interval");
  require(
      std::abs(cadence.ordinary_fps - 10.5) < 0.001,
      "ordinary cadence did not exclude only exact backend recovery time");
}

void invalidRecoveryIntervalCannotCreateAnInfiniteCadence() {
  const auto cadence = contentionScreenCadence(10, 1'000.0, 1'500.0);
  require(
      cadence.total_fps == 10.0 && cadence.ordinary_fps == 0.0,
      "a fully consumed observation interval produced invalid cadence");
}

void overlappingRecoveryIntervalsAreCountedOnce() {
  ContentionRecoveryIntervals intervals;
  require(intervals.record(100.0, 1'100.0), "first interval was rejected");
  require(intervals.record(600.0, 1'600.0), "overlap was rejected");
  require(
      intervals.totalMs() == 1'500.0,
      "overlapping recovery time was counted twice");
  require(
      intervals.maximumMs() == 1'000.0,
      "the exact longest lifecycle interval was not retained");
  require(
      !intervals.record(1'700.0, 1'600.0),
      "an inverted lifecycle interval was accepted");
}

}  // namespace

int main() try {
  exactBackendRecoveryIsSeparatedFromOrdinaryCadence();
  invalidRecoveryIntervalCannotCreateAnInfiniteCadence();
  overlappingRecoveryIntervalsAreCountedOnce();
  std::cout << "media contention screen cadence tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
