#pragma once

#include <cstdint>
#include <memory>
#include <span>

#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"

namespace syrnike::desktop_native::media {

class PreviewActor final {
 public:
  explicit PreviewActor(SequencedEmitter& emitter);
  ~PreviewActor();

  RuntimeEvent start(const MediaCommand& command);
  void pushFrame(std::span<const std::int16_t> pcm);
  bool failFromCapture(
    const std::string& session_id,
    std::uint64_t generation,
    const std::string& message
  );
  void stop(const MediaCommand& command, bool emit_stopped = true);
  void shutdown();

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
