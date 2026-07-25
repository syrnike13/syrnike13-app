#pragma once

#include <chrono>
#include <functional>
#include <memory>
#include <thread>

#include "camera_capture.hpp"
#include "livekit_publication_client.hpp"
#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"

namespace livekit {
class D3D11H264VideoSource;
}

namespace syrnike::desktop_native::media {

class CameraActor final {
 public:
  using InternalPost = std::function<bool(MediaCommand)>;
  using IsCurrent = std::function<bool(const std::string&, std::uint64_t)>;
  using CreateGpuVideoSource = std::function<
    std::shared_ptr<livekit::D3D11H264VideoSource>(int, int)>;
  using LaunchRetireWorker =
    std::function<std::thread(std::function<void()>)>;
  using BeforeTerminalPost = std::function<void()>;
  using BeforeCleanupEnqueue = std::function<void()>;

  CameraActor(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitPublicationClient> livekit_client,
    std::shared_ptr<CameraCaptureFactory> capture_factory =
      createMediaFoundationCameraCaptureFactory(),
    CreateGpuVideoSource create_gpu_video_source = {},
    LaunchRetireWorker launch_retire_worker = {},
    BeforeTerminalPost before_terminal_post = {},
    BeforeCleanupEnqueue before_cleanup_enqueue = {}
  );
  ~CameraActor();

  void connect(const MediaCommand& command);
  RuntimeEvent probe(const MediaCommand& command);
  void disconnect(const MediaCommand& command, bool emit_event = true);
  void releasePreviewFrame(const MediaCommand& command);
  void handleTerminal(const MediaCommand& command);
  void shutdown();
  void shutdown(std::chrono::steady_clock::time_point deadline);

 private:
  class Implementation;
  std::shared_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
