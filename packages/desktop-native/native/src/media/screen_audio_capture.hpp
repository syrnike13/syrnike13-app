#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <windows.h>

#include "livekit/livekit.h"
#include "livekit/operation_cancellation.h"
#include "screen_video_capture.hpp"
#include "windows_audio_session_policy.hpp"

namespace syrnike::voice {

constexpr int kScreenAudioSampleRate = 48'000;
constexpr int kScreenAudioChannels = 2;
constexpr int kScreenAudioFramesPerPacket = kScreenAudioSampleRate / 100;

using ScreenAudioFailure = std::function<void(std::string)>;
struct ScreenAudioPacketView {
  const std::uint8_t* data = nullptr;
  std::uint32_t frames = 0;
  bool silent = false;
  bool discontinuity = false;
};

using ScreenAudioPacketConsumer =
    std::function<void(const ScreenAudioPacketView&)>;
using ScreenAudioPacketReader =
    std::function<bool(const ScreenAudioPacketConsumer&)>;

struct ScreenAudioWakeDrain {
  std::uint64_t frames = 0;
  std::uint64_t packets = 0;
  std::uint64_t backlog_packets = 0;
  std::uint64_t discontinuities = 0;
};

[[nodiscard]] ScreenAudioWakeDrain drainScreenAudioWake(
    const ScreenAudioPacketReader& read_packet,
    const ScreenAudioPacketConsumer& consume_packet);

using ScreenAudioStats = std::function<void(
    std::uint64_t frames,
    std::uint64_t packets,
    std::uint64_t backlog_packets,
    std::uint64_t discontinuities,
    double peak_db,
    double rms_db)>;

[[nodiscard]] syrnike::desktop_native::media::WindowsAudioSessionAttemptResult
initializeScreenAudioCaptureAttempt(
    IAudioClient *audio_client,
    const std::function<HRESULT()> &initialize,
    const std::shared_ptr<
        syrnike::desktop_native::media::WindowsAudioSessionAttemptPolicy>
        &policy = {});

class ScreenAudioStopSignal final {
 public:
  ScreenAudioStopSignal();
  ~ScreenAudioStopSignal();
  ScreenAudioStopSignal(const ScreenAudioStopSignal&) = delete;
  ScreenAudioStopSignal& operator=(const ScreenAudioStopSignal&) = delete;

  void signal() noexcept;
  [[nodiscard]] const livekit::OperationCancellation& cancellation() const noexcept {
    return cancellation_;
  }
  [[nodiscard]] HANDLE handle() const noexcept { return event_; }
  [[nodiscard]] bool isSignaled() const noexcept {
    return event_ && WaitForSingleObject(event_, 0) == WAIT_OBJECT_0;
  }

 private:
  HANDLE event_ = nullptr;
  livekit::OperationCancellation cancellation_;
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
