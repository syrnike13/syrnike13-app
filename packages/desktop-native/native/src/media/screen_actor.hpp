#pragma once

#include <functional>
#include <memory>

#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"

namespace syrnike::desktop_native::media {

class ScreenActor final {
 public:
  using InternalPost = std::function<bool(MediaCommand)>;
  using IsCurrent = std::function<bool(const std::string&, std::uint64_t)>;

  ScreenActor(SequencedEmitter& emitter, InternalPost post, IsCurrent is_current);
  ~ScreenActor();

  RuntimeEvent connect(const MediaCommand& command);
  RuntimeEvent startCapture(const MediaCommand& command);
  void stopCapture(const MediaCommand& command, bool emit_stopped = true);
  void disconnect(const MediaCommand& command, bool emit_stopped = true);
  void handleTerminal(const MediaCommand& command);
  void shutdown();

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
