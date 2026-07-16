#pragma once

#include <livekit/livekit.h>
#include <livekit/local_audio_track.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"
#include "livekit_publication_client.hpp"

namespace syrnike::desktop_native::media {

enum class MicrophonePublicationCapacityStatus {
  Available,
  ActorBusy,
  ActorUnresponsive,
};

struct MicrophonePipelineSnapshot {
  std::string device_id;
  std::uint64_t revision = 0;
  bool noise_suppression_enabled = true;
  bool echo_cancellation_enabled = false;
};

void validateMicrophonePublicationCommand(const MediaCommand &command);

class MicrophonePublicationController final {
 public:
  using InternalPost = std::function<bool(MediaCommand)>;
  using IsCurrent = std::function<bool(const std::string &, std::uint64_t)>;
  using AddSink =
      std::function<void(const std::shared_ptr<livekit::AudioSource> &)>;
  using RemoveSink =
      std::function<void(const std::shared_ptr<livekit::AudioSource> &)>;
  using CaptureHealthy = std::function<bool()>;
  using ApplyMute = std::function<void(
      const std::shared_ptr<livekit::LocalAudioTrack> &, bool)>;

  MicrophonePublicationController(
      SequencedEmitter &emitter, InternalPost post, IsCurrent is_current,
      AddSink add_sink, RemoveSink remove_sink, CaptureHealthy capture_healthy,
      std::shared_ptr<LiveKitPublicationClient> livekit_client,
      ApplyMute apply_mute = {});
  ~MicrophonePublicationController();

  MicrophonePublicationController(const MicrophonePublicationController &) =
      delete;
  MicrophonePublicationController &operator=(
      const MicrophonePublicationController &) = delete;

  void start(const MediaCommand &command,
             const MicrophonePipelineSnapshot &pipeline);
  void setMuted(const MediaCommand &command);
  void disconnect(const MediaCommand &command, bool emit_stopped = true);
  void handleTerminal(const MediaCommand &command);
  void handleWorkerCommand(const MediaCommand &command);
  void shutdown();

  std::string activeSessionId() const;
  std::uint64_t activeGeneration() const;
  [[nodiscard]] MicrophonePublicationCapacityStatus capacityStatus(
      std::chrono::steady_clock::time_point now =
          std::chrono::steady_clock::now()) const;
  [[nodiscard]] bool hasBlockedCapacity() const;

 private:
  struct PublishedRoom;
  struct AttemptState;
  struct RetiringState;

  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
