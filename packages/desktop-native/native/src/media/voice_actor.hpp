#pragma once

#include <functional>
#include <memory>

#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"
#include "../common/async_cleanup_dispatcher.hpp"
#include "livekit_voice_session.hpp"

namespace syrnike::desktop_native::media {

class VoiceActor final {
 public:
  using InternalPost = std::function<bool(MediaCommand)>;
  using IsCurrent = std::function<bool(const std::string&, std::uint64_t)>;

  VoiceActor(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitVoiceSession> voice_session,
    AsyncCleanupLauncher async_cleanup_launcher = {},
    AsyncCleanupEnqueueProbe async_cleanup_enqueue_probe = {}
  );
  ~VoiceActor();

  void connect(const MediaCommand& command);
  void disconnect(const MediaCommand& command, bool emit_events = true);
  void handleWorkerCommand(const MediaCommand& command);
  void shutdown();

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
