#pragma once

#include <cstddef>
#include <cstdint>

namespace syrnike::desktop_native::tests {

enum class ContentionAudioAgeLane {
  Normal,
  InjectedRecovery,
};

struct ContentionAudioAgeObservation {
  ContentionAudioAgeLane lane = ContentionAudioAgeLane::Normal;
  bool settled = false;
};

template <std::uint64_t OrdinaryAgeLimitUs>
class ContentionAudioRecoveryWindow final {
  static_assert(OrdinaryAgeLimitUs > 0);

 public:
  void enterInjectedGap() noexcept {
    state_ = State::GapActive;
  }

  void markRendererRecovered() noexcept {
    if (state_ == State::GapActive) state_ = State::AwaitingHealthySample;
  }

  [[nodiscard]] ContentionAudioAgeObservation observe(
      std::uint64_t scheduled_playout_age_us) noexcept {
    if (state_ == State::Normal) return {};
    if (state_ == State::AwaitingHealthySample &&
        scheduled_playout_age_us <= OrdinaryAgeLimitUs) {
      state_ = State::Normal;
      ++settled_recoveries_;
      return {ContentionAudioAgeLane::Normal, true};
    }
    return {ContentionAudioAgeLane::InjectedRecovery, false};
  }

  [[nodiscard]] bool recoveryPending() const noexcept {
    return state_ != State::Normal;
  }

  [[nodiscard]] std::size_t settledRecoveries() const noexcept {
    return settled_recoveries_;
  }

 private:
  enum class State {
    Normal,
    GapActive,
    AwaitingHealthySample,
  };

  State state_ = State::Normal;
  std::size_t settled_recoveries_ = 0;
};

}  // namespace syrnike::desktop_native::tests
