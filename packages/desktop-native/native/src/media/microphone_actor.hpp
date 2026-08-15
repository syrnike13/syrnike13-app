#pragma once

#include <functional>
#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <utility>

#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"
#include "livekit_voice_session.hpp"
#include "microphone_echo_reference.hpp"
#include "microphone_publication_controller.hpp"
#include "windows_audio_session_policy.hpp"

namespace syrnike::desktop_native::media {

struct MicrophoneIdleCaptureTiming {
  std::chrono::milliseconds grace{std::chrono::seconds(30)};
  std::chrono::milliseconds post_retry{std::chrono::milliseconds(250)};
};

struct MicrophoneCaptureCandidateRequest {
  std::string device_id;
  bool bypass_system_audio_input_processing = true;
  std::chrono::milliseconds timeout{std::chrono::milliseconds(750)};
};

struct MicrophoneCaptureAttemptRequest {
  std::string device_id;
  bool bypass_system_audio_input_processing = true;
  std::uint64_t epoch = 0;
  std::shared_ptr<WindowsAudioSessionAttemptPolicy> audio_attempt_policy;
  std::function<void()> mark_ready;
  std::function<bool()> keep_running;
  // A capture driver submits exactly one mono 10 ms / 48 kHz frame. The
  // callback owns the real processor and actor handoff, and returns false once
  // its capture epoch has been retired or while shutdown is closing it.
  std::function<bool(std::span<const float>, bool)> submit_pcm;
};

using MicrophoneCaptureAttemptDriver =
    std::function<void(MicrophoneCaptureAttemptRequest)>;

struct MicrophoneCaptureAdapter {
  // A complete adapter owns both stages: candidate validation must observe
  // healthy PCM before returning, and run owns the promoted attempt until
  // keep_running becomes false. Supplying only one operation is rejected.
  std::function<void(MicrophoneCaptureCandidateRequest)> probe_candidate;
  MicrophoneCaptureAttemptDriver run;
};

struct MicrophoneEchoReferenceAdapter {
  // Control-lane operation. A device starts/replaces the render reference;
  // nullopt stops it. The operation may block and must never run on capture.
  std::function<void(std::optional<std::string>)> configure;
  // Realtime operation. Implementations must not allocate, block, or own
  // lifecycle; the returned frame is an immutable copy from the SPSC seam.
  std::function<syrnike::voice::MicrophoneEchoReferenceRealtimeFrame()> poll;
};

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
    std::shared_ptr<LiveKitVoiceSession> voice_session,
    MicrophoneIdleCaptureTiming idle_timing = {},
    std::shared_ptr<WindowsAudioSessionAttemptPolicy> audio_attempt_policy = {},
    MicrophoneCaptureAdapter capture_adapter = {},
    MicrophoneEchoReferenceAdapter echo_reference_adapter = {});
  ~MicrophoneActor();

  MicrophoneActor(const MicrophoneActor&) = delete;
  MicrophoneActor& operator=(const MicrophoneActor&) = delete;

  void warm(const MediaCommand& command);
  void connect(const MediaCommand& command);
  RuntimeEvent configure(const MediaCommand& command);
  void setMuted(const MediaCommand& command);
  void setEchoReferenceOutputDevice(std::string device_id);
  std::optional<RuntimeEvent> handlePublicationUnpublished(
    const MediaCommand& command
  );
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
