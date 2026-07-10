#pragma once

#include <functional>
#include <cstdint>
#include <memory>
#include <span>
#include <utility>

#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"

namespace syrnike::desktop_native::media {

class MicrophoneActor final {
 public:
  using InternalPost = std::function<bool(MediaCommand)>;
  using IsCurrent = std::function<bool(const std::string&, std::uint64_t)>;
  using PreviewConsumer = std::function<void(
    std::span<const std::int16_t> pcm,
    double input_db,
    double threshold_db,
    bool gate_open)>;

  MicrophoneActor(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current);
  ~MicrophoneActor();

  MicrophoneActor(const MicrophoneActor&) = delete;
  MicrophoneActor& operator=(const MicrophoneActor&) = delete;

  void warm(const MediaCommand& command);
  RuntimeEvent connect(const MediaCommand& command);
  void configure(const MediaCommand& command);
  void setMuted(const MediaCommand& command);
  void setPreviewConsumer(
    const std::string& session_id,
    std::uint64_t generation,
    PreviewConsumer consumer
  );
  void clearPreviewConsumer(const std::string& session_id, std::uint64_t generation);
  std::pair<std::string, std::uint64_t> currentMetricIdentity();
  void restoreMetricIdentityIfCurrent(
    const std::string& candidate_session,
    std::uint64_t candidate_generation,
    const std::string& previous_session,
    std::uint64_t previous_generation
  );
  bool isCurrentCaptureFailure(const MediaCommand& command);
  void disconnect(const MediaCommand& command, bool emit_stopped = true);
  void handleTerminal(const MediaCommand& command);
  void shutdown();

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
