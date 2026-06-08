#include <iostream>
#include <string>

#include "audio_devices.hpp"
#include "microphone_preview.hpp"
#include "microphone_publisher.hpp"
#include "protocol.hpp"

int main() {
  using namespace syrnike::voice;

  std::string line;
  while (std::getline(std::cin, line)) {
    if (commandMatches(line, "list_devices")) {
      emitDeviceList();
      continue;
    }
    if (commandMatches(line, "start")) {
      runMicrophonePublisher(parseStartCommand(line));
      return 0;
    }
    if (commandMatches(line, "start_preview")) {
      runMicrophonePreview(parseStartCommand(line));
      return 0;
    }
    if (commandMatches(line, "stop")) {
      return 0;
    }
  }

  return 0;
}
