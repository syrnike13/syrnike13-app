#pragma once

#include <functional>
#include <cstdint>
#include <memory>
#include <span>
#include <utility>

#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"
#include "livekit_publication_client.hpp"
#include "microphone_publication_controller.hpp"

namespace syrnike::desktop_native::media {

class MicrophoneActor final {
 public:
  using InternalPost = std::function<bool(MediaCommand)>;
  using IsCurrent = std::function<bool(const std::string&, std::uint64_t)>;
  using PreviewConsumer = std::function<void(
    std::span<const std::int16_t> pcm)>;

  MicrophoneActor(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitPublicationClient> livekit_client = createRealLiveKitPublicationClient());
  ~MicrophoneActor();

  MicrophoneActor(const MicrophoneActor&) = delete;
  MicrophoneActor& operator=(const MicrophoneActor&) = delete;

  void warm(const MediaCommand& command);
  void connect(const MediaCommand& command);
  RuntimeEvent configure(const MediaCommand& command);
  void setMuted(const MediaCommand& command);
  void setPreviewConsumer(
    const std::string& session_id,
    std::uint64_t generation,
    PreviewConsumer consumer
  );
  void clearPreviewConsumer(const std::string& session_id, std::uint64_t generation);
  bool isCurrentCaptureFailure(const MediaCommand& command);
  void disconnect(const MediaCommand& command, bool emit_stopped = true);
  // Returns true only when a current capture failure could not be recovered,
  // allowing the owning runtime to fail a standalone preview as well.
  bool handleTerminal(const MediaCommand& command);
  void handleWorkerCommand(const MediaCommand& command);
  RuntimeEvent probe(const MediaCommand& command);
  void shutdown();

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
