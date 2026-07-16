#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>

#include "media/remote_audio_output.hpp"

int main() try {
  std::mutex mutex;
  std::condition_variable changed;
  std::string failure;
  syrnike::desktop_native::media::RemoteAudioOutput output(
    [&](std::string message, std::string) {
      {
        std::lock_guard lock(mutex);
        failure = std::move(message);
      }
      changed.notify_all();
    }
  );

  output.setOutputDevice("__syrnike_missing_audio_output__");
  std::unique_lock lock(mutex);
  if (!changed.wait_for(lock, std::chrono::seconds(2), [&] {
        return !failure.empty();
      })) {
    throw std::runtime_error("renderer failure was not surfaced");
  }
  if (failure.find("unavailable") == std::string::npos) {
    throw std::runtime_error("renderer failure lost its diagnostic message");
  }
  lock.unlock();
  output.stop();
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
