#pragma once

#include "audio/audio_device_registry.hpp"
#include "audio/microphone_pcm.hpp"

#include <atomic>
#include <memory>
#include <thread>

namespace syrnike::windows_media::audio {
struct MicrophoneMonitorStats {
  std::uint64_t rendered_frames = 0, silent_frames = 0, dropped_frames = 0, device_opens = 0;
  // HRESULT of the last output open or render failure; 0 while none happened.
  std::int32_t device_platform_result = 0;
  bool device_open = false;
};

// Self-monitoring playback: renders the microphone pipeline's monitor port to
// one output endpoint on its own thread and device clock. It never touches the
// remote mix, so a deafened call still lets the user hear their own voice.
// A failed or lost device reopens by itself; the microphone path is unaffected.
// The owner replaces the instance when the endpoint changes.
class MicrophoneMonitor final {
 public:
  MicrophoneMonitor(AudioEndpoint endpoint, std::shared_ptr<MicrophonePcmPort> source, float volume);
  ~MicrophoneMonitor();
  MicrophoneMonitor(const MicrophoneMonitor&) = delete;
  MicrophoneMonitor& operator=(const MicrophoneMonitor&) = delete;
  const std::wstring& endpointId() const noexcept { return endpoint_.endpoint_id; }
  // Linear 0..3, the product output volume.
  void setVolume(float volume) noexcept { volume_.store(volume, std::memory_order_relaxed); }
  MicrophoneMonitorStats stats() const noexcept;
 private:
  void run() noexcept;
  const AudioEndpoint endpoint_;
  const std::shared_ptr<MicrophonePcmPort> source_;
  std::atomic<float> volume_;
  std::atomic<std::uint64_t> rendered_frames_{0}, silent_frames_{0}, dropped_frames_{0}, device_opens_{0};
  std::atomic<std::int32_t> device_platform_result_{0};
  std::atomic<bool> device_open_{false};
  void* stop_event_ = nullptr;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::audio
