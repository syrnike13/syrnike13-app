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
#include "livekit_publication_client.hpp"
#include "screen_video_capture.hpp"

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
  using StartCaptureWorkers = std::function<void(
    const MediaCommand&,
    const ScreenPublicationDescription&,
    const std::shared_ptr<livekit::D3D11H264VideoSource>&,
    const std::shared_ptr<livekit::LocalVideoTrack>&,
    const std::shared_ptr<livekit::AudioSource>&,
    const std::shared_ptr<std::atomic_bool>&,
    const std::function<bool()>&,
    std::thread&,
    std::thread&
  )>;
  using CapturePromoted = std::function<void(const std::string&, std::uint64_t)>;
  using QueryEncoderCapability = std::function<livekit::D3D11H264Capability()>;
  using CreateVideoSource = std::function<std::shared_ptr<livekit::D3D11H264VideoSource>(
    int,
    int
  )>;

  ScreenPublicationController(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitPublicationClient> livekit_client,
    CommitIfCurrent commit_if_current,
    Now now,
    DescribePublication describe_publication,
    StartCaptureWorkers start_capture_workers,
    CapturePromoted capture_promoted,
    QueryEncoderCapability query_encoder_capability = {},
    CreateVideoSource create_video_source = {}
  );
  ~ScreenPublicationController();

  ScreenPublicationController(const ScreenPublicationController&) = delete;
  ScreenPublicationController& operator=(const ScreenPublicationController&) = delete;

  void connect(const MediaCommand& command);
  void startCapture(const MediaCommand& command);
  void stopCapture(const MediaCommand& command, bool emit_stopped = true);
  void restartCaptureAfterStall(const MediaCommand& command);
  void disconnect(const MediaCommand& command, bool emit_stopped = true);
  [[nodiscard]] bool handleTerminal(
    const MediaCommand& command,
    bool livekit_terminal
  );
  void handleWorkerCommand(const MediaCommand& command);
  RuntimeEvent probe(const MediaCommand& command);
  void shutdown();

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
