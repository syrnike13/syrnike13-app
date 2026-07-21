#pragma once

#include <array>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <limits>
#include <mutex>
#include <optional>
#include <string>
#include <type_traits>
#include <utility>

#include "../common/runtime_types.hpp"

namespace syrnike::desktop_native::media {

enum class ActorCommandTraffic {
  Control,
  CoalescedMedia,
};

inline ActorCommandTraffic classifyActorCommand(const MediaCommand& command) {
  if (
    command.type == "__remoteVideoFrame" ||
    command.type == "__localScreenPreviewFrame" ||
    command.type == "__localCameraPreviewFrame" ||
    command.type == "__voiceActiveSpeakers"
  ) {
    return ActorCommandTraffic::CoalescedMedia;
  }
  return ActorCommandTraffic::Control;
}

inline bool sameActorMediaKey(const MediaCommand& left, const MediaCommand& right) {
  if (
    left.type != right.type ||
    left.session_id != right.session_id ||
    left.generation != right.generation
  ) {
    return false;
  }
  return left.type != "__remoteVideoFrame" || left.track_id == right.track_id;
}

class ActorCommandResourceGuard final {
 public:
  explicit ActorCommandResourceGuard(MediaCommand& command) : command_(command) {}
  ~ActorCommandResourceGuard() {
    auto on_drop = std::move(command_.on_drop);
    command_.on_drop = {};
    if (!on_drop) return;
    try {
      on_drop();
    } catch (...) {
      std::terminate();
    }
  }
  ActorCommandResourceGuard(const ActorCommandResourceGuard&) = delete;
  ActorCommandResourceGuard& operator=(const ActorCommandResourceGuard&) = delete;

 private:
  MediaCommand& command_;
};

template <std::size_t ControlCapacity = 256, std::size_t MediaKeyCapacity = 64>
class ActorMailbox {
 public:
  static_assert(ControlCapacity > 0);
  static_assert(MediaKeyCapacity > 0);
  static_assert(
    std::is_nothrow_move_constructible_v<MediaCommand>,
    "ActorMailbox fixed slots require no-throw MediaCommand ownership transfer"
  );

  bool tryPush(MediaCommand command) {
    if (classifyActorCommand(command) == ActorCommandTraffic::CoalescedMedia) {
      return tryPushLatest(std::move(command));
    }
    return tryPushControl(std::move(command));
  }

  bool tryPushControl(MediaCommand command) {
    {
      std::lock_guard lock(mutex_);
      if (closed_ || control_size_ >= ControlCapacity) return false;
      const auto tail = (control_head_ + control_size_) % ControlCapacity;
      control_[tail].emplace(std::move(command));
      ++control_size_;
    }
    ready_.notify_one();
    return true;
  }

  bool tryPushLatest(MediaCommand command) {
    std::optional<MediaCommand> dropped;
    {
      std::lock_guard lock(mutex_);
      if (closed_) return false;
      std::size_t target = MediaKeyCapacity;
      std::size_t empty = MediaKeyCapacity;
      std::size_t oldest = 0;
      auto oldest_order = std::numeric_limits<std::uint64_t>::max();
      for (std::size_t index = 0; index < MediaKeyCapacity; ++index) {
        const auto& slot = media_[index];
        if (!slot.command) {
          if (empty == MediaKeyCapacity) empty = index;
          continue;
        }
        if (sameActorMediaKey(*slot.command, command)) {
          target = index;
          break;
        }
        if (slot.order < oldest_order) {
          oldest = index;
          oldest_order = slot.order;
        }
      }
      if (target == MediaKeyCapacity) {
        target = empty != MediaKeyCapacity ? empty : oldest;
      }
      auto& slot = media_[target];
      if (slot.command) {
        dropped.emplace(std::move(*slot.command));
        slot.command.reset();
      } else {
        ++media_size_;
      }
      slot.command.emplace(std::move(command));
      slot.order = ++media_sequence_;
    }
    drop(std::move(dropped));
    ready_.notify_one();
    return true;
  }

  std::optional<MediaCommand> waitPop() {
    std::unique_lock lock(mutex_);
    ready_.wait(lock, [&] {
      return closed_ || control_size_ != 0 || media_size_ != 0;
    });
    if (control_size_ != 0) {
      auto command = std::move(*control_[control_head_]);
      control_[control_head_].reset();
      control_head_ = (control_head_ + 1) % ControlCapacity;
      --control_size_;
      return command;
    }
    if (media_size_ != 0) {
      std::size_t oldest = 0;
      auto oldest_order = std::numeric_limits<std::uint64_t>::max();
      for (std::size_t index = 0; index < MediaKeyCapacity; ++index) {
        if (media_[index].command && media_[index].order < oldest_order) {
          oldest = index;
          oldest_order = media_[index].order;
        }
      }
      auto command = std::move(*media_[oldest].command);
      media_[oldest].command.reset();
      media_[oldest].order = 0;
      --media_size_;
      return command;
    }
    return std::nullopt;
  }

  std::size_t closeAndDiscard() {
    std::array<std::optional<MediaCommand>, MediaKeyCapacity> dropped;
    std::size_t discarded = 0;
    {
      std::lock_guard lock(mutex_);
      if (closed_) return 0;
      closed_ = true;
      discarded = control_size_ + media_size_;
      for (auto& command : control_) command.reset();
      control_head_ = 0;
      control_size_ = 0;
      for (std::size_t index = 0; index < MediaKeyCapacity; ++index) {
        if (media_[index].command) {
          dropped[index].emplace(std::move(*media_[index].command));
          media_[index].command.reset();
          media_[index].order = 0;
        }
      }
      media_size_ = 0;
    }
    for (auto& command : dropped) drop(std::move(command));
    ready_.notify_all();
    return discarded;
  }

  std::size_t discardMedia(
    const std::string& session_id,
    std::uint64_t generation
  ) {
    std::array<std::optional<MediaCommand>, MediaKeyCapacity> dropped;
    std::size_t dropped_count = 0;
    {
      std::lock_guard lock(mutex_);
      for (std::size_t index = 0; index < MediaKeyCapacity; ++index) {
        auto& slot = media_[index];
        if (
          !slot.command ||
          slot.command->session_id != session_id ||
          slot.command->generation != generation
        ) {
          continue;
        }
        dropped[index].emplace(std::move(*slot.command));
        slot.command.reset();
        slot.order = 0;
        ++dropped_count;
        --media_size_;
      }
    }
    for (auto& command : dropped) drop(std::move(command));
    return dropped_count;
  }

  bool closed() const {
    std::lock_guard lock(mutex_);
    return closed_;
  }

  std::size_t size() const {
    std::lock_guard lock(mutex_);
    return control_size_ + media_size_;
  }

 private:
  static void drop(std::optional<MediaCommand> command) noexcept {
    if (!command || !command->on_drop) return;
    try {
      command->on_drop();
    } catch (...) {
      std::terminate();
    }
  }

  static void drop(MediaCommand command) noexcept {
    if (!command.on_drop) return;
    try {
      command.on_drop();
    } catch (...) {
      std::terminate();
    }
  }

  mutable std::mutex mutex_;
  std::condition_variable ready_;
  std::array<std::optional<MediaCommand>, ControlCapacity> control_;
  struct MediaSlot {
    std::optional<MediaCommand> command;
    std::uint64_t order = 0;
  };
  std::array<MediaSlot, MediaKeyCapacity> media_;
  std::size_t control_head_ = 0;
  std::size_t control_size_ = 0;
  std::size_t media_size_ = 0;
  std::uint64_t media_sequence_ = 0;
  bool closed_ = false;
};

}  // namespace syrnike::desktop_native::media
