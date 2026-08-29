#pragma once

#include <chrono>
#include <functional>
#include <memory>

#include "../common/cleanup_supervisor.hpp"
#include "../common/bounded_queue.hpp"
#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"
#include "livekit_voice_session.hpp"
#include "microphone_actor.hpp"
#include "preview_actor.hpp"
#include "screen_actor.hpp"

namespace syrnike::desktop_native::media {

class MediaRuntime final {
 public:
  using SteadyNow = std::function<std::chrono::steady_clock::time_point()>;
  using BeforeMicrophoneOperation = std::function<void(const MediaCommand&)>;
  using BeforeVoiceShutdown = std::function<void()>;
  using AfterSubsystemCleanup = std::function<void()>;

  explicit MediaRuntime(
    EventSinkPtr sink,
    std::shared_ptr<LiveKitVoiceSession> voice_session = {},
    SteadyNow screen_now = {},
    BeforeMicrophoneOperation before_microphone_operation = {},
    BeforeVoiceShutdown before_voice_shutdown = {},
    std::shared_ptr<LiveKitRuntimeLifetime> livekit_lifetime = {},
    CleanupStartProbe subsystem_cleanup_start_probe = {},
    AfterSubsystemCleanup after_subsystem_cleanup = {},
    MicrophoneCaptureAdapter microphone_capture_adapter = {},
    MicrophoneIdleCaptureTiming microphone_idle_timing = {},
    ScreenFrameHandoffObserver screen_frame_handoff_observer = {},
    AfterScreenVideoPublished after_screen_video_published = {},
    ScreenVideoPublicationObserver screen_video_publication_observer = {}
  );
  ~MediaRuntime();

  MediaRuntime(const MediaRuntime&) = delete;
  MediaRuntime& operator=(const MediaRuntime&) = delete;

  void waitUntilReady();
  bool dispatch(MediaCommand command);
  void requestShutdown();
  void shutdownAndWait();
  [[nodiscard]] PreviewQueueMetrics microphonePreviewQueueMetrics() const noexcept;

 private:
  class Implementation;
  std::shared_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
