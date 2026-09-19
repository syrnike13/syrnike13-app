#pragma once

#include "core/engine.hpp"

namespace syrnike::windows_media {

struct MediaRuntimeSnapshot {
  MediaPathsSnapshot paths;
  // True only after all publication consumers and SDK publication operations
  // have acknowledged release. Capture warmth/renderer demand may remain.
  bool publications_stopped = true;
  // Includes capture, playback, preview and decoder owners during shutdown.
  bool stopped = true;
  // An owner with unresolved SDK work cannot accept a new session in this
  // process. Escalate that condition through the supervised engine boundary.
  std::optional<EngineFailure> failure;
  // Fixed numeric telemetry, without device identities or audio contents.
  std::optional<std::array<DiagnosticMetric, 12>> screen_audio_metrics;
  std::optional<std::array<DiagnosticMetric, 13>> camera_metrics;
  std::optional<std::array<DiagnosticMetric, 7>> microphone_metrics;
  std::optional<std::array<DiagnosticMetric, 10>> remote_video_metrics;
};

// Native media composition port. The Engine control thread calls these
// methods; implementations only replace bounded command slots/read cached
// values. Device/SDK start, stop and waits belong to independent media owners.
// No SDK, COM, N-API, Electron or renderer object crosses this core boundary.
class MediaRuntime {
 public:
  virtual ~MediaRuntime() = default;
  // A generation is present only for the connected, currently desired Room.
  // Revocation stops publication consumers before publications_stopped is true.
  virtual void apply(const EngineDesiredState&, std::optional<std::uint64_t> room_generation) = 0;
  virtual void beginStop() = 0;
  virtual MediaRuntimeSnapshot snapshot() const = 0;
};

}  // namespace syrnike::windows_media
