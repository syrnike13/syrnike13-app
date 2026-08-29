#pragma once

#include <array>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>

#include "../common/runtime_types.hpp"
#include "renderer_texture_lease_registry.hpp"

namespace syrnike::desktop_native::media {

enum class VoiceControlAdmission {
  Accepted,
  Duplicate,
  Full,
  Closed,
};

struct VoiceControlLaneSnapshot {
  std::uint64_t host_epoch = 0;
  std::size_t queue_depth = 0;
  std::size_t queue_capacity = 0;
  std::uint64_t oldest_queue_wait_ms = 0;
  std::uint64_t last_queue_wait_ms = 0;
  std::string current_operation;
  std::uint64_t current_operation_age_ms = 0;
  std::uint64_t duplicate_commands = 0;
  std::uint64_t rejected_commands = 0;
  std::string worker_state;
  std::string retirement_state;
  std::size_t outstanding_renderer_leases = 0;
  std::size_t outstanding_renderer_generations = 0;
  std::string worker_owner = "voice-control-worker";
  std::string retirement_owner = "renderer-texture-lease-registry";
};

// Fixed-capacity actor mailbox for independent Native Media Session controls.
// Renderer releases use a bounded completed ledger, so a delayed or duplicate
// Electron acknowledgement cannot consume another slot or release a newer
// generation. The caller owns the worker thread and must close, drain, and join
// it through MediaRuntime's CleanupSupervisor-owned shutdown job.
class VoiceControlLane final {
 public:
  static constexpr std::size_t kCapacity = 64;
  static constexpr std::size_t kCompletedReleaseCapacity = 128;
  using Now = std::function<std::uint64_t()>;

  explicit VoiceControlLane(Now now = {})
      : now_(now ? std::move(now) : Now{defaultNow}),
        discard_storage_(std::make_unique<DiscardStorage>()) {}

  VoiceControlLane(const VoiceControlLane&) = delete;
  VoiceControlLane& operator=(const VoiceControlLane&) = delete;

  VoiceControlAdmission tryPush(MediaCommand command) {
    std::lock_guard lock(mutex_);
    if (closed_) return VoiceControlAdmission::Closed;
    if (isDuplicateLocked(command)) {
      ++duplicate_commands_;
      return VoiceControlAdmission::Duplicate;
    }
    if (size_ >= kCapacity) {
      ++rejected_commands_;
      return VoiceControlAdmission::Full;
    }
    pushLocked(std::move(command));
    ready_.notify_one();
    return VoiceControlAdmission::Accepted;
  }

  template <typename Rep, typename Period>
  bool tryPushFor(
      MediaCommand command,
      const std::chrono::duration<Rep, Period>& timeout) {
    std::unique_lock lock(mutex_);
    if (closed_) return false;
    if (isDuplicateLocked(command)) {
      ++duplicate_commands_;
      return true;
    }
    if (!space_available_.wait_for(lock, timeout, [&] {
          return closed_ || size_ < kCapacity || isDuplicateLocked(command);
        })) {
      ++rejected_commands_;
      return false;
    }
    if (closed_) return false;
    if (isDuplicateLocked(command)) {
      ++duplicate_commands_;
      return true;
    }
    pushLocked(std::move(command));
    lock.unlock();
    ready_.notify_one();
    return true;
  }

  std::optional<MediaCommand> waitPop() {
    std::unique_lock lock(mutex_);
    ready_.wait(lock, [&] { return closed_ || size_ != 0; });
    if (closed_) return std::nullopt;
    auto command = std::move(*commands_[head_]);
    commands_[head_].reset();
    head_ = (head_ + 1) % kCapacity;
    --size_;
    current_key_ = keyFor(command);
    current_operation_ = nativeCommandName(command.type);
    current_started_ms_ = now_();
    last_queue_wait_ms_ = command.internal_enqueued_steady_ms == 0
        ? 0
        : current_started_ms_ - command.internal_enqueued_steady_ms;
    lock.unlock();
    space_available_.notify_one();
    return command;
  }

  void complete(const MediaCommand& command) noexcept {
    try {
      std::lock_guard lock(mutex_);
      const auto key = keyFor(command);
      if (key && isRelease(key->type)) {
        completed_releases_[completed_release_cursor_] = *key;
        completed_release_cursor_ =
            (completed_release_cursor_ + 1) % kCompletedReleaseCapacity;
        if (completed_release_size_ < kCompletedReleaseCapacity) {
          ++completed_release_size_;
        }
      }
      current_key_.reset();
      current_operation_.clear();
      current_started_ms_ = 0;
    } catch (...) {
      // Completion is an actor cleanup boundary and must remain noexcept.
    }
  }

  std::size_t closeAndDiscard() noexcept {
    auto& discarded = *discard_storage_;
    std::size_t discarded_size = 0;
    {
      std::lock_guard lock(mutex_);
      if (closed_) return 0;
      closed_ = true;
      while (size_ != 0) {
        discarded[discarded_size++] = std::move(commands_[head_]);
        commands_[head_].reset();
        head_ = (head_ + 1) % kCapacity;
        --size_;
      }
      head_ = 0;
    }
    for (std::size_t index = 0; index < discarded_size; ++index) {
      drop(std::move(discarded[index]));
      discarded[index].reset();
    }
    ready_.notify_all();
    space_available_.notify_all();
    return discarded_size;
  }

  [[nodiscard]] std::size_t size() const noexcept {
    std::lock_guard lock(mutex_);
    return size_;
  }

  [[nodiscard]] VoiceControlLaneSnapshot snapshot(
      std::uint64_t host_epoch,
      const RendererTextureLeaseStats& renderer) const {
    std::lock_guard lock(mutex_);
    const auto now = now_();
    std::uint64_t oldest_wait = 0;
    if (size_ != 0 && commands_[head_] &&
        commands_[head_]->internal_enqueued_steady_ms != 0) {
      oldest_wait = now - commands_[head_]->internal_enqueued_steady_ms;
    }
    return VoiceControlLaneSnapshot{
        host_epoch,
        size_,
        kCapacity,
        oldest_wait,
        last_queue_wait_ms_,
        current_operation_,
        current_started_ms_ == 0 ? 0 : now - current_started_ms_,
        duplicate_commands_,
        rejected_commands_,
        closed_
            ? "closed"
            : (current_operation_.empty() && size_ == 0 ? "available" : "busy"),
        renderer.outstanding_leases == 0 ? "idle" : "retiring",
        renderer.outstanding_leases,
        renderer.outstanding_generations,
        "voice-control-worker",
        "renderer-texture-lease-registry",
    };
  }

 private:
  using DiscardStorage =
      std::array<std::optional<MediaCommand>, kCapacity>;
  static_assert(
      sizeof(std::unique_ptr<DiscardStorage>) <= 2 * sizeof(void*),
      "voice-control discard storage must remain a heap-owned handle");

  struct OperationKey {
    NativeCommandType type = NativeCommandType::Count;
    std::string session_id;
    std::uint64_t generation = 0;
    std::string track_id;
    std::uint64_t sequence = 0;
    std::uint64_t revision = 0;
    bool demanded = false;

    friend bool operator==(const OperationKey&, const OperationKey&) = default;
  };

  static std::uint64_t defaultNow() {
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch())
            .count());
  }

  static bool isRelease(NativeCommandType type) noexcept {
    return type == NativeCommandType::ReleaseRemoteVideoFrame ||
        type == NativeCommandType::ReleaseLocalScreenPreviewFrame ||
        type == NativeCommandType::ReleaseLocalCameraPreviewFrame;
  }

  static std::optional<OperationKey> keyFor(const MediaCommand& command) {
    const auto type = command.type;
    if (isRelease(type)) {
      return OperationKey{type, command.session_id, command.generation,
                          command.track_id, command.frame_sequence};
    }
    if (type == NativeCommandType::ReconcileRemotePublication) {
      return OperationKey{type, command.session_id, command.generation,
                          command.track_id, 0, command.internal_epoch};
    }
    if (type == NativeCommandType::SetLocalCameraPreviewDemand) {
      return OperationKey{type, command.session_id, command.generation,
                          {}, 0, 0, command.demanded};
    }
    if (type == NativeCommandType::RetryLocalCameraPreview) {
      return OperationKey{type, command.session_id, command.generation};
    }
    return std::nullopt;
  }

  bool isDuplicateLocked(const MediaCommand& command) const {
    const auto key = keyFor(command);
    if (!key) return false;
    if (current_key_ && *current_key_ == *key) return true;
    for (std::size_t offset = 0; offset < size_; ++offset) {
      const auto index = (head_ + offset) % kCapacity;
      if (!commands_[index]) continue;
      const auto queued_key = keyFor(*commands_[index]);
      if (queued_key && *queued_key == *key) return true;
    }
    if (!isRelease(key->type)) return false;
    for (std::size_t index = 0; index < completed_release_size_; ++index) {
      if (completed_releases_[index] &&
          *completed_releases_[index] == *key) {
        return true;
      }
    }
    return false;
  }

  void pushLocked(MediaCommand command) {
    if (command.internal_enqueued_steady_ms == 0) {
      command.internal_enqueued_steady_ms = now_();
    }
    const auto tail = (head_ + size_) % kCapacity;
    commands_[tail] = std::move(command);
    ++size_;
  }

  static void drop(std::optional<MediaCommand> command) noexcept {
    if (!command || !command->on_drop) return;
    try {
      command->on_drop();
    } catch (...) {
    }
  }

  Now now_;
  mutable std::mutex mutex_;
  std::condition_variable ready_;
  std::condition_variable space_available_;
  std::array<std::optional<MediaCommand>, kCapacity> commands_;
  // Constructed once with the lane and reused by its terminal close. Moving
  // the full queue here keeps resource callbacks outside mutex_ without
  // reserving the bounded mailbox again on the caller's stack.
  std::unique_ptr<DiscardStorage> discard_storage_;
  std::array<std::optional<OperationKey>, kCompletedReleaseCapacity>
      completed_releases_;
  std::size_t head_ = 0;
  std::size_t size_ = 0;
  std::size_t completed_release_cursor_ = 0;
  std::size_t completed_release_size_ = 0;
  std::optional<OperationKey> current_key_;
  std::string current_operation_;
  std::uint64_t current_started_ms_ = 0;
  std::uint64_t last_queue_wait_ms_ = 0;
  std::uint64_t duplicate_commands_ = 0;
  std::uint64_t rejected_commands_ = 0;
  bool closed_ = false;
};

}  // namespace syrnike::desktop_native::media
