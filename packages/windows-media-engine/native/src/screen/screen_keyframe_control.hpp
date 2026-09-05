#pragma once

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
  std::uint64_t generation_ = 0, requested_ = 0, issued_ = 0, acknowledged_ = 0;
  std::uint64_t issued_after_sequence_ = 0;
  std::uint32_t attempts_ = 0;
  std::optional<std::uint64_t> last_request_ms_;
  std::optional<std::uint64_t> last_poll_ms_;
};
}
