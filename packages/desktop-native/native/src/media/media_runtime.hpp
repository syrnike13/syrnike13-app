#pragma once

#include <chrono>
#include <functional>
#include <memory>

#include "../common/async_cleanup_dispatcher.hpp"
#include "../common/bounded_queue.hpp"
#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"
#include "livekit_voice_session.hpp"

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
    AsyncCleanupLauncher subsystem_cleanup_launcher = {},
    AfterSubsystemCleanup after_subsystem_cleanup = {}
  );
  ~MediaRuntime();

  MediaRuntime(const MediaRuntime&) = delete;
  MediaRuntime& operator=(const MediaRuntime&) = delete;

  void waitUntilReady();
  bool dispatch(MediaCommand command);
  void requestShutdown();
  void shutdownAndWait();

 private:
  class Implementation;
  std::shared_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
