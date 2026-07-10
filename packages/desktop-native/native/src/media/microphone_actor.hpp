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
    std::span<const std::int16_t> pcm)>;

  MicrophoneActor(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current);
  ~MicrophoneActor();

  MicrophoneActor(const MicrophoneActor&) = delete;
  MicrophoneActor& operator=(const MicrophoneActor&) = delete;

  void warm(const MediaCommand& command);
  RuntimeEvent connect(const MediaCommand& command);
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
  void handleTerminal(const MediaCommand& command);
  void shutdown();

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
