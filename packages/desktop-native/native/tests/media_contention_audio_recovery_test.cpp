#include <cstdint>
#include <iostream>
#include <stdexcept>

#include "media_contention_audio_recovery.hpp"

namespace {

using syrnike::desktop_native::tests::ContentionAudioAgeLane;
using syrnike::desktop_native::tests::ContentionAudioRecoveryWindow;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void injectedRecoveryDoesNotWeakenTheOrdinaryAgeLimit() {
  ContentionAudioRecoveryWindow<80'000> window;
  require(
      window.observe(79'000).lane == ContentionAudioAgeLane::Normal,
      "an ordinary healthy sample was not classified as normal");

  window.enterInjectedGap();
  require(
      window.observe(30'000).lane ==
          ContentionAudioAgeLane::InjectedRecovery,
      "an active injected gap leaked into the ordinary lane");
  window.markRendererRecovered();
  const auto residual = window.observe(81'000);
  require(
      residual.lane == ContentionAudioAgeLane::InjectedRecovery &&
          !residual.settled,
      "a residual recovery sample weakened the 80 ms ordinary limit");

  const auto settled = window.observe(80'000);
  require(
      settled.lane == ContentionAudioAgeLane::Normal && settled.settled,
      "the first sample within the ordinary limit did not settle recovery");
  require(
      window.settledRecoveries() == 1 && !window.recoveryPending(),
      "settled recovery state was not retained");
}

void sustainedRecoveryAgeCannotBeHidden() {
  ContentionAudioRecoveryWindow<80'000> window;
  window.enterInjectedGap();
  window.markRendererRecovered();
  for (std::uint64_t age : {81'000ULL, 120'000ULL, 160'000ULL}) {
    require(
        window.observe(age).lane ==
            ContentionAudioAgeLane::InjectedRecovery,
        "an unsettled recovery sample entered the ordinary lane");
  }
  require(
      window.recoveryPending() && window.settledRecoveries() == 0,
      "sustained recovery was incorrectly reported as settled");
}

}  // namespace

int main() try {
  injectedRecoveryDoesNotWeakenTheOrdinaryAgeLimit();
  sustainedRecoveryAgeCannotBeHidden();
  std::cout << "media contention audio recovery tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
