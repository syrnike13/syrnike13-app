#pragma once

#include <chrono>
#include <functional>
#include <memory>
#include <optional>

#include "../common/runtime_types.hpp"
#include "../common/sequenced_emitter.hpp"
#include "livekit_publication_client.hpp"
#include "screen_publication_controller.hpp"

namespace syrnike::desktop_native::media {

class EncoderBackpressureStallDetector final {
 public:
  bool observe(
    std::chrono::steady_clock::time_point now,
    std::chrono::steady_clock::duration timeout
  ) {
    if (!started_at_) {
      started_at_ = now;
      return false;
    }
    return now - *started_at_ >= timeout;
  }

  void noteProgress() noexcept { started_at_.reset(); }

 private:
  std::optional<std::chrono::steady_clock::time_point> started_at_;
};

class ScreenActor final {
 public:
  using InternalPost = std::function<bool(MediaCommand)>;
  using IsCurrent = std::function<bool(const std::string&, std::uint64_t)>;
  using CommitIfCurrent = std::function<bool(
    const std::string&,
    std::uint64_t,
    std::function<void()>
  )>;
  using Now = std::function<std::chrono::steady_clock::time_point()>;

  ScreenActor(
    SequencedEmitter& emitter,
    InternalPost post,
    IsCurrent is_current,
    std::shared_ptr<LiveKitPublicationClient> livekit_client = createRealLiveKitPublicationClient(),
    CommitIfCurrent commit_if_current = {},
    Now now = {}
  );
  ~ScreenActor();

  void connect(const MediaCommand& command);
  void startCapture(const MediaCommand& command);
  void stopCapture(const MediaCommand& command, bool emit_stopped = true);
  void disconnect(const MediaCommand& command, bool emit_stopped = true);
  void handleTerminal(const MediaCommand& command);
  void handleWorkerCommand(const MediaCommand& command);
  RuntimeEvent probe(const MediaCommand& command);
  void shutdown();

 private:
  class Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace syrnike::desktop_native::media
