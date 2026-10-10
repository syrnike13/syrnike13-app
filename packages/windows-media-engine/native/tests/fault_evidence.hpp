#pragma once

#include <string_view>

namespace syrnike::windows_media::tests {

// Runs one fault scenario. Its body owns every behavioral assertion and
// synchronization; a failure throws with the scenario's own message.
template <typename Test>
void runFault(std::string_view, Test test) {
  test();
}

}  // namespace syrnike::windows_media::tests
