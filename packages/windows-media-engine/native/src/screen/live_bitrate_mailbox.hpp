#pragma once
#include <cstdint>
#include <optional>
#include <utility>

namespace syrnike::windows_media::screen {
enum class BitrateUpdateOutcome { idle, pending, applied, unsupported, rejected, unsafe };
struct BitrateUpdateResult {
  std::uint64_t revision = 0;
  std::uint32_t requested_bitrate = 0;
  std::uint32_t applied_bitrate = 0;
  BitrateUpdateOutcome outcome = BitrateUpdateOutcome::idle;
  std::int32_t platform_result = 0;
  bool available = true;
};

// State of the existing encoder owner's control slot. Caller serializes access.
// There is no worker, callback, clock or resource ownership in this mailbox.
class LiveBitrateMailbox final {
 public:
  static constexpr std::uint64_t kDeadlineMs = 2000;
  static constexpr std::uint32_t kRejectionBudget = 3;
  explicit LiveBitrateMailbox(std::uint32_t initial) : maximum_(initial) {
    result_.applied_bitrate = initial;
  }
  bool request(std::uint64_t revision, std::uint32_t bitrate) noexcept {
    if (stopped_ || !result_.available || revision <= latest_revision_ ||
        bitrate == 0 || bitrate > maximum_) return false;
    latest_revision_ = revision;
    desired_ = BitrateUpdateResult{revision, bitrate};
    return true;
  }
  std::optional<BitrateUpdateResult> take(std::uint64_t now_ms) noexcept {
    if (stopped_ || active_ || !desired_ || !result_.available) return std::nullopt;
    auto command = std::exchange(desired_, std::nullopt);
    command->applied_bitrate = result_.applied_bitrate;
    command->outcome = BitrateUpdateOutcome::pending;
    result_ = *command;
    active_ = command->revision;
    began_ms_ = now_ms;
    return command;
  }
  void complete(std::uint64_t revision, BitrateUpdateOutcome outcome,
                std::int32_t platform_result, std::uint64_t now_ms) noexcept {
    if (stopped_ || !active_ || *active_ != revision) return;
    if (outcome == BitrateUpdateOutcome::idle || outcome == BitrateUpdateOutcome::pending) return;
    if (now_ms < began_ms_ || now_ms - began_ms_ >= kDeadlineMs)
      outcome = BitrateUpdateOutcome::unsafe;
    result_.outcome = outcome;
    result_.platform_result = platform_result;
    if (outcome == BitrateUpdateOutcome::applied)
      result_.applied_bitrate = result_.requested_bitrate;
    if (outcome == BitrateUpdateOutcome::rejected) ++rejections_;
    if (outcome == BitrateUpdateOutcome::unsupported || outcome == BitrateUpdateOutcome::unsafe ||
        rejections_ >= kRejectionBudget) {
      result_.available = false;
      desired_.reset();
    }
    active_.reset();
  }
  BitrateUpdateResult snapshot(std::uint64_t now_ms) const noexcept {
    auto result = result_;
    if (active_ && (now_ms < began_ms_ || now_ms - began_ms_ >= kDeadlineMs)) {
      result.outcome = BitrateUpdateOutcome::unsafe;
      result.available = false;
    }
    return result;
  }
  void stop() noexcept {
    stopped_ = true;
    active_.reset();
    desired_.reset();
    result_.available = false;
  }
 private:
  std::uint32_t maximum_;
  std::uint32_t rejections_ = 0;
  std::uint64_t latest_revision_ = 0, began_ms_ = 0;
  bool stopped_ = false;
  BitrateUpdateResult result_;
  std::optional<BitrateUpdateResult> desired_;
  std::optional<std::uint64_t> active_;
};
}  // namespace syrnike::windows_media::screen
