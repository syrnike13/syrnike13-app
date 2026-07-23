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

enum class ScreenOutputStall {
  None,
  Encoder,
  Transport,
};

class ScreenOutputStallDetector final {
 public:
  ScreenOutputStall observe(
    std::chrono::steady_clock::time_point now,
    bool active,
    std::uint64_t frames_captured,
    std::uint64_t frames_encoded,
    std::uint64_t frames_sent,
    std::chrono::steady_clock::duration timeout
  ) {
    if (!active) {
      reset();
      return ScreenOutputStall::None;
    }

    const bool first_sample = !last_frames_captured_;
    const bool capture_progress =
      first_sample || frames_captured > *last_frames_captured_;
    const bool encoder_progress =
      first_sample || frames_encoded > *last_frames_encoded_;
    const bool transport_progress =
      first_sample || frames_sent > *last_frames_sent_;
    last_frames_captured_ = frames_captured;
    last_frames_encoded_ = frames_encoded;
    last_frames_sent_ = frames_sent;

    if (first_sample) {
      if (frames_captured > 0 && frames_encoded == 0) {
        encoder_stall_started_at_ = now;
      }
      if (frames_encoded > frames_sent) {
        transport_stall_started_at_ = now;
      }
      return ScreenOutputStall::None;
    }

    if (frames_captured > 0 && frames_encoded == 0) {
      if (!encoder_stall_started_at_) encoder_stall_started_at_ = now;
    } else if (encoder_progress) {
      encoder_stall_started_at_.reset();
    } else if (capture_progress) {
      if (!encoder_stall_started_at_) encoder_stall_started_at_ = now;
    } else {
      // A static screen legitimately produces no new encoder output.
      encoder_stall_started_at_.reset();
    }

    if (transport_progress) {
      transport_stall_started_at_.reset();
    } else if (frames_encoded > frames_sent) {
      if (!transport_stall_started_at_) transport_stall_started_at_ = now;
    } else {
      transport_stall_started_at_.reset();
    }

    if (encoder_stall_started_at_ &&
        now - *encoder_stall_started_at_ >= timeout) {
      return ScreenOutputStall::Encoder;
    }
    if (transport_stall_started_at_ &&
        now - *transport_stall_started_at_ >= timeout) {
      return ScreenOutputStall::Transport;
    }
    return ScreenOutputStall::None;
  }

  void reset() noexcept {
    last_frames_captured_.reset();
    last_frames_encoded_.reset();
    last_frames_sent_.reset();
    encoder_stall_started_at_.reset();
    transport_stall_started_at_.reset();
  }

 private:
  std::optional<std::uint64_t> last_frames_captured_;
  std::optional<std::uint64_t> last_frames_encoded_;
  std::optional<std::uint64_t> last_frames_sent_;
  std::optional<std::chrono::steady_clock::time_point>
    encoder_stall_started_at_;
  std::optional<std::chrono::steady_clock::time_point>
    transport_stall_started_at_;
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
