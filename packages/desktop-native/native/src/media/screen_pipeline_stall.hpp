#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>

namespace syrnike::desktop_native::media {

enum class ScreenPipelineStall {
  EncoderBackpressure,
  EncoderOutput,
  RtpOutput,
};

inline std::string_view screenPipelineStallReason(
  ScreenPipelineStall stall
) noexcept {
  switch (stall) {
    case ScreenPipelineStall::EncoderBackpressure:
      return "encoder_backpressure_stalled";
    case ScreenPipelineStall::EncoderOutput:
      return "encoder_output_stalled";
    case ScreenPipelineStall::RtpOutput:
      return "rtp_output_stalled";
  }
  return "screen_pipeline_stalled";
}

inline bool isScreenPipelineStallReason(std::string_view reason) noexcept {
  return reason == screenPipelineStallReason(
      ScreenPipelineStall::EncoderBackpressure) ||
    reason == screenPipelineStallReason(ScreenPipelineStall::EncoderOutput) ||
    reason == screenPipelineStallReason(ScreenPipelineStall::RtpOutput);
}

class ScreenPipelineStallError final : public std::runtime_error {
 public:
  explicit ScreenPipelineStallError(ScreenPipelineStall stall)
    : std::runtime_error(std::string(screenPipelineStallReason(stall))),
      stall_(stall) {}

  [[nodiscard]] ScreenPipelineStall stall() const noexcept {
    return stall_;
  }

 private:
  ScreenPipelineStall stall_;
};

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
    if (reported_ || now - *started_at_ < timeout) return false;
    reported_ = true;
    return true;
  }

  void noteProgress() noexcept {
    started_at_.reset();
    reported_ = false;
  }

 private:
  std::optional<std::chrono::steady_clock::time_point> started_at_;
  bool reported_ = false;
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
    std::uint64_t frames_submitted,
    std::uint64_t frames_encoded,
    std::uint64_t frames_sent,
    std::chrono::steady_clock::duration timeout
  ) {
    if (!active) {
      reset();
      return ScreenOutputStall::None;
    }

    const bool first_sample = !last_frames_submitted_;
    const bool source_progress =
      first_sample || frames_submitted > *last_frames_submitted_;
    const bool encoder_progress =
      first_sample || frames_encoded > *last_frames_encoded_;
    const bool transport_progress =
      first_sample || frames_sent > *last_frames_sent_;
    if (frames_submitted > 0) has_seen_source_frame_ = true;
    last_frames_submitted_ = frames_submitted;
    last_frames_encoded_ = frames_encoded;
    last_frames_sent_ = frames_sent;

    if (first_sample) {
      if (!has_seen_source_frame_ ||
          (frames_submitted > 0 && frames_encoded == 0)) {
        encoder_stall_started_at_ = now;
      }
      if (frames_encoded > frames_sent) {
        transport_stall_started_at_ = now;
      }
      return ScreenOutputStall::None;
    }

    if (!has_seen_source_frame_) {
      if (!encoder_stall_started_at_) encoder_stall_started_at_ = now;
    } else if (frames_submitted > 0 && frames_encoded == 0) {
      if (!encoder_stall_started_at_) encoder_stall_started_at_ = now;
    } else if (encoder_progress) {
      encoder_stall_started_at_.reset();
    } else if (source_progress) {
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
    last_frames_submitted_.reset();
    last_frames_encoded_.reset();
    last_frames_sent_.reset();
    encoder_stall_started_at_.reset();
    transport_stall_started_at_.reset();
    has_seen_source_frame_ = false;
  }

 private:
  std::optional<std::uint64_t> last_frames_submitted_;
  std::optional<std::uint64_t> last_frames_encoded_;
  std::optional<std::uint64_t> last_frames_sent_;
  std::optional<std::chrono::steady_clock::time_point>
    encoder_stall_started_at_;
  std::optional<std::chrono::steady_clock::time_point>
    transport_stall_started_at_;
  bool has_seen_source_frame_ = false;
};

}  // namespace syrnike::desktop_native::media
