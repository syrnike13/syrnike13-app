#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <windows.h>

#include "livekit/livekit.h"
#include "screen_video_capture.hpp"

namespace syrnike::voice {

constexpr int kScreenAudioSampleRate = 48'000;
constexpr int kScreenAudioChannels = 2;
constexpr int kScreenAudioFramesPerPacket = kScreenAudioSampleRate / 100;

using ScreenAudioFailure = std::function<void(std::string)>;
using ScreenAudioStats = std::function<void(
    std::uint64_t frames,
    std::uint64_t packets,
    double peak_db,
    double rms_db)>;

class ScreenAudioStopSignal final {
 public:
  ScreenAudioStopSignal();
  ~ScreenAudioStopSignal();
  ScreenAudioStopSignal(const ScreenAudioStopSignal&) = delete;
  ScreenAudioStopSignal& operator=(const ScreenAudioStopSignal&) = delete;

  void signal() noexcept;
  [[nodiscard]] HANDLE handle() const noexcept { return event_; }
  [[nodiscard]] bool isSignaled() const noexcept {
    return event_ && WaitForSingleObject(event_, 0) == WAIT_OBJECT_0;
  }

 private:
  HANDLE event_ = nullptr;
};

void captureSystemLoopbackAudio(
    DWORD excluded_process_id,
    const std::string& session_id,
    const std::shared_ptr<livekit::AudioSource>& audio_source,
    const std::shared_ptr<std::atomic_bool>& running,
    const std::shared_ptr<ScreenAudioStopSignal>& stop_signal,
    ScreenAudioFailure on_failure,
    ScreenAudioStats on_stats);
void captureProcessLoopbackAudio(
    DWORD process_id,
    const std::string& session_id,
    const std::shared_ptr<livekit::AudioSource>& audio_source,
    const std::shared_ptr<std::atomic_bool>& running,
    const std::shared_ptr<ScreenAudioStopSignal>& stop_signal,
    ScreenAudioFailure on_failure,
    ScreenAudioStats on_stats);
void validateScreenLoopbackAudio(
    const ScreenCaptureTarget& target,
    DWORD excluded_process_id);
}  // namespace syrnike::voice
