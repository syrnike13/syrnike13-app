#pragma once

#include "audio/audio_device_registry.hpp"
#include <condition_variable>
#include <future>

namespace syrnike::windows_media::audio {
// Owns the sole Windows audio enumerator and opaque identity registry. The
// registry is destroyed here after its borrowing media owners have joined.
class AudioDeviceCatalog final {
 public:
  AudioDeviceCatalog();
  ~AudioDeviceCatalog();
  AudioDeviceRegistry& registry() const { return *registry_; }
  AudioDeviceSnapshot snapshot() const;
 private:
  struct State;
  static void run(const std::shared_ptr<State>&) noexcept;
  std::shared_ptr<State> state_;
  AudioDeviceRegistry* registry_ = nullptr;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::audio
