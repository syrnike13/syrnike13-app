#pragma once

#include <functional>
#include <memory>

#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"
#include "livekit_publication_client.hpp"

namespace syrnike::desktop_native::media {

class VoiceActor final {
 public:
  using InternalPost = std::function<bool(MediaCommand)>;
  using IsCurrent = std::function<bool(const std::string&, std::uint64_t)>;

  VoiceActor(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitPublicationClient> client
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
