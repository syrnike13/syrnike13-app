#pragma once

#include <functional>
#include <memory>

#include "camera_capture.hpp"
#include "livekit_publication_client.hpp"
#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"

namespace syrnike::desktop_native::media {

class CameraActor final {
 public:
  using InternalPost = std::function<bool(MediaCommand)>;
  using IsCurrent = std::function<bool(const std::string&, std::uint64_t)>;

  CameraActor(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitPublicationClient> livekit_client = createRealLiveKitPublicationClient(),
    std::shared_ptr<CameraCaptureFactory> capture_factory =
      createMediaFoundationCameraCaptureFactory()
  );
  ~CameraActor();

  void connect(const MediaCommand& command);
  void disconnect(const MediaCommand& command, bool emit_event = true);
  void handleTerminal(const MediaCommand& command);
  void shutdown();

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
