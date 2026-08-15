#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <span>

#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"

namespace syrnike::desktop_native::media {

struct PreviewQueueMetrics {
  std::uint64_t accepted_frames = 0;
  std::uint64_t dropped_frames = 0;
  std::uint64_t invalid_frames = 0;
  std::size_t queued_frames = 0;
};

class PreviewActor final {
 public:
  using BeforeRenderOperation = std::function<void()>;
  using BeforeFrameOperation = std::function<void()>;

  explicit PreviewActor(
    SequencedEmitter& emitter,
    BeforeRenderOperation before_render_operation = {},
    BeforeFrameOperation before_frame_operation = {}
  );
  ~PreviewActor();

  RuntimeEvent start(const MediaCommand& command);
  void pushFrame(
    const std::string& session_id,
    std::uint64_t generation,
    std::span<const std::int16_t> pcm
  );
  bool failFromCapture(
    const std::string& session_id,
    std::uint64_t generation,
    const std::string& message
  );
  void stop(const MediaCommand& command, bool emit_stopped = true);
  void shutdown();
  void shutdown(std::chrono::steady_clock::time_point deadline);
  [[nodiscard]] PreviewQueueMetrics queueMetrics() const noexcept;

 private:
  class Implementation;
  std::shared_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
