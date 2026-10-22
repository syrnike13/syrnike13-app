#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>

namespace syrnike::windows_media::screen {
enum class KeyframeAction { none, request, exhausted };

// Owned exclusively by the sender control lane. SDK callbacks enqueue intent
// into that lane; they must not call the encoder themselves. Watermarks coalesce
// requests while preserving all intent through a confirmed encoded keyframe.
class ScreenKeyframeControl final {
 public:
  void begin(std::uint64_t generation) noexcept;
  [[nodiscard]] bool request(std::uint64_t generation) noexcept;
  [[nodiscard]] bool requestThrough(std::uint64_t generation, std::uint64_t watermark) noexcept;
  [[nodiscard]] KeyframeAction poll(std::uint64_t now_ms,
                                    std::uint64_t encoded_sequence) noexcept;
  void progress(std::uint64_t generation, std::uint64_t encoded_sequence,
                bool keyframe) noexcept;
  [[nodiscard]] std::uint64_t pending() const noexcept { return requested_ - acknowledged_; }
  [[nodiscard]] std::uint32_t attempts() const noexcept { return attempts_; }
 private:
  // A retry must not invalidate the keyframe still answering an earlier
  // attempt: with sparse input that keyframe completes after the retry.
  struct Attempt { std::uint64_t watermark = 0, after_sequence = 0; };
  static constexpr std::uint32_t kMaxAttempts = 3;
  std::uint64_t generation_ = 0, requested_ = 0, acknowledged_ = 0;
  std::uint64_t issued_after_sequence_ = 0;
  std::array<Attempt, kMaxAttempts> issued_{};
  std::uint32_t attempts_ = 0;
  std::optional<std::uint64_t> last_request_ms_;
  std::optional<std::uint64_t> last_poll_ms_;
};

// Exhausted keyframe retries first restart the encoder on the same
// publication (viewers keep the track). Past this budget in-place restarts
// are not helping: the share fails retryably and is published anew.
inline constexpr std::size_t kMaximumEncoderRecoveriesPerWindow = 2;
inline constexpr std::uint64_t kEncoderRecoveryWindowMs = 60'000;

class ScreenEncoderRecoveryBudget final {
 public:
  [[nodiscard]] bool available(std::uint64_t now_ms) const noexcept;
  void consume(std::uint64_t now_ms) noexcept;
 private:
  std::array<std::uint64_t, kMaximumEncoderRecoveriesPerWindow> recoveries_ms_{};
  std::size_t count_ = 0;
};
}
