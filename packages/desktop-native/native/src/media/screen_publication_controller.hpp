#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>

#include <livekit/livekit.h>
#include <livekit/d3d11_h264_video_source.h>

#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"
#include "livekit_voice_session.hpp"
#include "../common/cleanup_supervisor.hpp"
#include "screen_gpu_capture.hpp"
#include "screen_video_capture.hpp"
#include "screen_audio_capture.hpp"

namespace syrnike::desktop_native::media {

class ScreenActorUnresponsiveError final : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

class ScreenActorBusyError final : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

struct ScreenPublicationDescription {
  syrnike::voice::ScreenCaptureTarget target;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  int fps = 0;
  int bitrate = 0;
  bool publish_audio = false;
  std::string audio_mode = "none";
  std::string loopback_mode;
  std::uint32_t audio_target_process_id = 0;
};

enum class ScreenVideoPublicationPhase {
  Started,
  Published,
  Failed,
};

using ScreenVideoPublicationObserver = std::function<void(
  const MediaCommand&,
  ScreenVideoPublicationPhase
)>;

class ScreenPublicationController final {
 public:
  using InternalPost = std::function<bool(MediaCommand)>;
  using IsCurrent = std::function<bool(const std::string&, std::uint64_t)>;
  using CommitIfCurrent = std::function<bool(
    const std::string&,
    std::uint64_t,
    std::function<void()>
  )>;
  using Now = std::function<std::chrono::steady_clock::time_point()>;
  using DescribePublication =
    std::function<ScreenPublicationDescription(const MediaCommand&)>;
  using PrepareCapture = std::function<std::shared_ptr<ScreenGpuCapturer>(
    const MediaCommand&,
    const ScreenPublicationDescription&
  )>;
  using StartVideoCaptureWorker = std::function<void(
    const MediaCommand&,
    const ScreenPublicationDescription&,
    const std::shared_ptr<livekit::D3D11H264VideoSource>&,
    const std::shared_ptr<livekit::LocalVideoTrack>&,
    const std::shared_ptr<ScreenGpuCapturer>&,
    const std::shared_ptr<std::atomic_bool>&,
    const std::function<bool()>&,
    std::thread&
  )>;
  using StartAudioCaptureWorker = std::function<void(
    const MediaCommand&,
    const ScreenPublicationDescription&,
    const std::shared_ptr<livekit::AudioSource>&,
    const std::shared_ptr<std::atomic_bool>&,
    const std::shared_ptr<syrnike::voice::ScreenAudioStopSignal>&,
    std::thread&
  )>;
  using CapturePromoted = std::function<void(const std::string&, std::uint64_t)>;
  using AfterVideoPublished = std::function<void(
    const MediaCommand&,
    const std::string&
  )>;
  using QueryEncoderCapability = std::function<livekit::D3D11H264Capability()>;
  using CreateVideoSource = std::function<std::shared_ptr<livekit::D3D11H264VideoSource>(
    int,
    int
  )>;
  using BeforeResourceCleanup = std::function<void()>;

  ScreenPublicationController(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitVoiceSession> voice_session,
    CommitIfCurrent commit_if_current,
    Now now,
    DescribePublication describe_publication,
    PrepareCapture prepare_capture,
    StartVideoCaptureWorker start_video_capture_worker,
    StartAudioCaptureWorker start_audio_capture_worker,
    CapturePromoted capture_promoted,
    QueryEncoderCapability query_encoder_capability = {},
    CreateVideoSource create_video_source = {},
    CleanupStartProbe cleanup_start_probe = {},
    CleanupEnqueueProbe cleanup_enqueue_probe = {},
    BeforeResourceCleanup before_resource_cleanup = {},
    VideoResourceAdmissionBudget* resource_budget = nullptr,
    AfterVideoPublished after_video_published = {},
    ScreenVideoPublicationObserver video_publication_observer = {}
  );
  ~ScreenPublicationController();

  ScreenPublicationController(const ScreenPublicationController&) = delete;
  ScreenPublicationController& operator=(const ScreenPublicationController&) = delete;

  void connect(const MediaCommand& command);
  void startCapture(const MediaCommand& command);
  void stopCapture(const MediaCommand& command, bool emit_stopped = true);
  void disconnect(const MediaCommand& command, bool emit_stopped = true);
  [[nodiscard]] bool handleTerminal(
    const MediaCommand& command,
    bool livekit_terminal
  );
  void handleWorkerCommand(const MediaCommand& command);
  RuntimeEvent probe(const MediaCommand& command);
  void shutdown();
  void shutdown(std::chrono::steady_clock::time_point deadline);

 private:
  class Implementation;
  std::shared_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
