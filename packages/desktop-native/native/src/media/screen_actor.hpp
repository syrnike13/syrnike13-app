#pragma once

#include <chrono>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "../common/runtime_types.hpp"
#include "../common/cleanup_supervisor.hpp"
#include "../common/sequenced_emitter.hpp"
#include "livekit_voice_session.hpp"
#include "screen_gpu_capture.hpp"
#include "screen_pipeline_stall.hpp"
#include "screen_publication_controller.hpp"

namespace syrnike::desktop_native::media {

using LaunchScreenWorker =
  std::function<std::thread(std::function<void()>)>;
using PrepareOwnedScreenWork = std::function<void()> (*)(
  std::shared_ptr<void>,
  std::function<void()>
);

std::thread launchOptionalScreenStatsWorker(
  const LaunchScreenWorker& launcher,
  std::function<void()> work
) noexcept;

std::thread launchScreenCaptureWorker(
  const LaunchScreenWorker& launcher,
  std::shared_ptr<void> owner,
  std::function<void()> work,
  std::function<void()> rollback,
  PrepareOwnedScreenWork prepare_owned_work = nullptr
);

bool emitScreenBackendRestart(
  SequencedEmitter& emitter,
  const std::string& session_id,
  std::uint64_t generation,
  const ScreenGpuRecoveryTransition& transition
);
using ScreenFrameHandoffObserver = std::function<void(
  const std::string&,
  std::uint64_t,
  std::uint64_t,
  std::uint64_t
)>;
using AfterScreenVideoPublished = std::function<void(
  const MediaCommand&,
  const std::string&
)>;

class ScreenActor final {
 public:
  using InternalPost = std::function<bool(MediaCommand)>;
  using IsCurrent = std::function<bool(const std::string&, std::uint64_t)>;
  using CommitIfCurrent = std::function<bool(
    const std::string&,
    std::uint64_t,
    std::function<void()>
  )>;
  using Now = std::function<std::chrono::steady_clock::time_point()>;

  ScreenActor(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitVoiceSession> voice_session,
    CommitIfCurrent commit_if_current = {},
    Now now = {},
    CleanupStartProbe cleanup_start_probe = {},
    LaunchScreenWorker launch_stats_worker = {},
    LaunchScreenWorker launch_capture_worker = {},
    ScreenFrameHandoffObserver frame_handoff_observer = {},
    AfterScreenVideoPublished after_video_published = {},
    ScreenVideoPublicationObserver video_publication_observer = {}
  );
  ~ScreenActor();

  void connect(const MediaCommand& command);
  void startCapture(const MediaCommand& command);
  void stopCapture(const MediaCommand& command, bool emit_stopped = true);
  void disconnect(const MediaCommand& command, bool emit_stopped = true);
  void handleTerminal(const MediaCommand& command);
  void handleWorkerCommand(const MediaCommand& command);
  RuntimeEvent probe(const MediaCommand& command);
  void shutdown();
  void shutdown(std::chrono::steady_clock::time_point deadline);

 private:
  class Implementation;
  std::shared_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
