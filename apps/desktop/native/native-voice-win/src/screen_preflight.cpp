#include "screen_preflight.hpp"

#include <windows.h>

#include <algorithm>
#include <string>

#include "screen_audio_capture.hpp"
#include "screen_video_capture.hpp"

namespace syrnike::voice {

void emitScreenSharePreflight(const StartCommand& command) {
  try {
    const ScreenCaptureTarget target = resolveScreenCaptureTarget(command.source_id);
    const auto video = runScreenCaptureProbe(command);
    const bool audio_supported = !target.window || target.process_id != 0;
    const bool audio_requested = command.audio_requested;
    bool audio_ok = !audio_requested;
    std::string audio_mode = "none";
    std::string loopback_mode = "none";
    DWORD target_process_id = 0;
    double audio_peak_db = -120.0;
    double audio_rms_db = -120.0;

    if (audio_requested && audio_supported) {
      audio_mode = target.window ? "process" : "system_exclude";
      loopback_mode = target.window
          ? "include_target_process_tree"
          : "exclude_target_process_tree";
      target_process_id = target.window
          ? target.process_id
          : static_cast<DWORD>(command.exclude_process_id);
      const auto audio = runScreenLoopbackAudioProbe(
          target,
          static_cast<DWORD>(command.exclude_process_id),
          std::min(std::max(50, command.duration_ms), 250));
      audio_peak_db = audio.peak_db;
      audio_rms_db = audio.rms_db;
      audio_ok = true;
    }
    const std::string source_type =
        command.source_id.rfind("game:", 0) == 0
            ? "game"
            : (target.window ? "window" : "screen");

    emit("{\"type\":\"screen_share_preflight\",\"sourceId\":\"" +
         jsonEscape(command.source_id) +
         "\",\"source_type\":\"" + source_type +
         "\",\"ok\":" + ((video.captured && audio_ok) ? "true" : "false") +
         ",\"video\":{\"method\":\"" + jsonEscape(video.method) +
         "\",\"captured\":" + (video.captured ? "true" : "false") +
         ",\"width\":" + std::to_string(video.width) +
         ",\"height\":" + std::to_string(video.height) +
         ",\"fps\":" + std::to_string(video.fps) +
         ",\"duration_ms\":" + std::to_string(video.duration_ms) +
         ",\"attempts\":" + std::to_string(video.attempts) +
         ",\"captured_frames\":" + std::to_string(video.captured_frames) +
         ",\"late_frames\":" + std::to_string(video.late_frames) +
         ",\"avg_capture_us\":" + std::to_string(video.avg_capture_us) +
         ",\"bytes\":" + std::to_string(video.bytes) + "}" +
         ",\"audio\":{\"requested\":" + (audio_requested ? "true" : "false") +
         ",\"ok\":" + (audio_ok ? "true" : "false") +
         ",\"mode\":\"" + audio_mode +
         "\",\"loopback_mode\":\"" + loopback_mode +
         "\",\"target_process_id\":" + std::to_string(target_process_id) +
         ",\"peak_db\":" + std::to_string(audio_peak_db) +
         ",\"rms_db\":" + std::to_string(audio_rms_db) +
         ",\"sample_rate\":48000,\"channels\":2}}");
  } catch (const std::exception& error) {
    emit("{\"type\":\"screen_share_preflight\",\"sourceId\":\"" +
         jsonEscape(command.source_id) +
         "\",\"ok\":false,\"message\":\"" + jsonEscape(error.what()) + "\"}");
  }
}

}  // namespace syrnike::voice
