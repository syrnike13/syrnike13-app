#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <span>

#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"

namespace syrnike::desktop_native::media {

class PreviewActor final {
 public:
  using BeforeRenderOperation = std::function<void()>;

  explicit PreviewActor(
    SequencedEmitter& emitter,
    BeforeRenderOperation before_render_operation = {}
  );
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
  void shutdown(std::chrono::steady_clock::time_point deadline);

 private:
  class Implementation;
  std::shared_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
