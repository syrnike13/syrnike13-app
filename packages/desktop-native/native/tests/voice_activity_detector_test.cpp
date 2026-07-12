#include "../src/media/voice_activity_detector.hpp"

#include <chrono>
#include <stdexcept>

namespace {

using namespace std::chrono_literals;
using syrnike::desktop_native::media::VoiceActivityDetector;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

}  // namespace

int main() try {
  VoiceActivityDetector detector;
  const auto start = std::chrono::steady_clock::time_point{};

  require(
    detector.updateRms(VoiceActivityDetector::kThresholdRms, true, start),
    "detector did not open at threshold"
  );
  require(detector.speaking(), "detector lost open state");
  require(
    !detector.updateRms(0.0F, true, start + 100ms),
    "detector closed before release hold"
  );
  require(
    detector.updateRms(0.0F, true, start + 181ms),
    "detector did not close after release hold"
  );
  require(
    detector.updateRms(VoiceActivityDetector::kThresholdRms, true, start + 200ms),
    "detector did not reopen"
  );
  require(
    detector.updateRms(VoiceActivityDetector::kThresholdRms, false, start + 201ms),
    "disabled detector did not close immediately"
  );
  require(detector.reset() == false, "reset reported an inactive detector");
  return 0;
} catch (...) {
  return 1;
}
