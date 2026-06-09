#include <iostream>
#include <string>

#include "audio_devices.hpp"
#include "microphone_preview.hpp"
#include "microphone_publisher.hpp"
#include "microphone_warmup.hpp"
#include "protocol.hpp"
#include "runtime_config.hpp"
#include "screen_audio_capture.hpp"
#include "screen_publisher.hpp"
#include "screen_preflight.hpp"
#include "screen_sources.hpp"
#include "screen_video_capture.hpp"

int main() {
  using namespace syrnike::voice;

  std::string line;
  while (std::getline(std::cin, line)) {
    if (commandMatches(line, "list_devices")) {
      emitDeviceList();
      continue;
    }
    if (commandMatches(line, "warm_microphone")) {
      const auto command = parseStartCommand(line);
      updateRuntimeConfig(command);
      startMicrophoneWarmup(command.device_id, command.session_id);
      continue;
    }
    if (commandMatches(line, "configure")) {
      updateRuntimeConfig(parseStartCommand(line));
      continue;
    }
    if (commandMatches(line, "list_screen_sources")) {
      emitScreenSourceList(parseStartCommand(line).self_window_hwnd);
      continue;
    }
    if (commandMatches(line, "probe_screen_capture")) {
      emitScreenCaptureProbe(parseStartCommand(line));
      continue;
    }
    if (commandMatches(line, "probe_screen_audio")) {
      emitScreenAudioProbe(parseStartCommand(line));
      continue;
    }
    if (commandMatches(line, "probe_screen_share")) {
      emitScreenSharePreflight(parseStartCommand(line));
      continue;
    }
    if (commandMatches(line, "connect_microphone")) {
      const auto command = parseStartCommand(line);
      updateRuntimeConfig(command);
      runMicrophonePublisher(command);
      return 0;
    }
    if (commandMatches(line, "connect_screen")) {
      stopMicrophoneWarmup();
      runScreenPublisher(parseStartCommand(line));
      return 0;
    }
    if (commandMatches(line, "start")) {
      const auto command = parseStartCommand(line);
      if (command.session_kind == "screen") {
        stopMicrophoneWarmup();
        runScreenPublisher(command);
      } else {
        runMicrophonePublisher(command);
      }
      return 0;
    }
    if (commandMatches(line, "start_preview")) {
      stopMicrophoneWarmup();
      runMicrophonePreview(parseStartCommand(line));
      return 0;
    }
    if (commandMatches(line, "stop")) {
      stopMicrophoneWarmup();
      return 0;
    }
  }

  stopMicrophoneWarmup();

  return 0;
}
