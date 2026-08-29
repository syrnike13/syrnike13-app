#pragma once

#include <atomic>

namespace syrnike::desktop_native::media {

// Capture ownership and publication mute are separate decisions. Keeping this
// state in one small object makes it impossible for mute to masquerade as an
// idle capture pipeline while still preventing muted PCM from reaching LiveKit.
class MicrophoneCaptureDemand final {
 public:
  void setPublication(bool connected, bool muted) noexcept {
    if (connected) {
      publication_muted_.store(muted, std::memory_order_release);
      publication_connected_.store(true, std::memory_order_release);
      return;
    }
    publication_connected_.store(false, std::memory_order_release);
    publication_muted_.store(false, std::memory_order_release);
  }

  void setMuted(bool muted) noexcept {
    publication_muted_.store(muted, std::memory_order_release);
  }

  void setPreview(bool demanded) noexcept {
    preview_demanded_.store(demanded, std::memory_order_release);
  }

  [[nodiscard]] bool captureRequired() const noexcept {
    return publication_connected_.load(std::memory_order_acquire) ||
      preview_demanded_.load(std::memory_order_acquire);
  }

  [[nodiscard]] bool shouldSendPublicationSamples() const noexcept {
    return publication_connected_.load(std::memory_order_acquire) &&
      !publication_muted_.load(std::memory_order_acquire);
  }

  void reset() noexcept {
    publication_connected_.store(false, std::memory_order_release);
    preview_demanded_.store(false, std::memory_order_release);
    publication_muted_.store(false, std::memory_order_release);
  }

 private:
  std::atomic_bool publication_connected_{false};
  std::atomic_bool publication_muted_{false};
  std::atomic_bool preview_demanded_{false};
};

}  // namespace syrnike::desktop_native::media
