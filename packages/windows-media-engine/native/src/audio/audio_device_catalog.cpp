#include "audio/audio_device_catalog.hpp"
#include "core/engine.hpp"

namespace syrnike::windows_media::audio {
struct AudioDeviceCatalog::State {
  mutable std::mutex mutex;
  std::condition_variable changed;
  std::promise<AudioDeviceRegistry*> ready;
  AudioDeviceSnapshot snapshot;
  bool stopping = false, done = false;
};
AudioDeviceCatalog::AudioDeviceCatalog() : state_(std::make_shared<State>()) {
  auto ready = state_->ready.get_future();
  worker_ = std::thread([state = state_] { run(state); });
  if (ready.wait_for(kStartDeadline) != std::future_status::ready) std::terminate();
  registry_ = ready.get();
  if (!registry_) {
    worker_.join();
    throw std::runtime_error("Audio catalog initialization failed");
  }
}
AudioDeviceCatalog::~AudioDeviceCatalog() {
  {
    std::unique_lock lock(state_->mutex);
    state_->stopping = true;
    state_->changed.notify_all();
    if (!state_->changed.wait_for(lock, kShutdownDeadline, [&] { return state_->done; })) std::terminate();
  }
  if (worker_.joinable()) worker_.join();
}
AudioDeviceSnapshot AudioDeviceCatalog::snapshot() const {
  std::lock_guard lock(state_->mutex);
  return state_->snapshot;
}
void AudioDeviceCatalog::run(const std::shared_ptr<State>& state) noexcept {
  std::unique_ptr<AudioDeviceRegistry> registry;
  bool initialized = false;
  try {
    registry = std::make_unique<AudioDeviceRegistry>(makeWindowsAudioDeviceEnumerator());
    state->ready.set_value(registry.get());
    initialized = true;
    bool first = true;
    for (;;) {
      if (first || registry->changed()) {
        first = false;
        auto snapshot = registry->refresh();
        std::lock_guard lock(state->mutex);
        state->snapshot = std::move(snapshot);
      }
      std::unique_lock lock(state->mutex);
      if (state->changed.wait_for(lock, std::chrono::milliseconds(200), [&] { return state->stopping; })) break;
    }
  } catch (...) {
    if (!initialized) state->ready.set_value(nullptr);
    else std::terminate(); // Unexpected owner failure cannot leave a borrowed stale registry live.
  }
  registry.reset();
  {
    std::lock_guard lock(state->mutex);
    state->done = true;
  }
  state->changed.notify_all();
}
}  // namespace syrnike::windows_media::audio
