#pragma once

#include <algorithm>
#include <array>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <functional>
#include <iterator>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

#include "common/runtime_types.hpp"
#include "common/sequenced_emitter.hpp"

namespace syrnike::desktop_native::media {

class AcceptedControlLossEscalation final {
 public:
  using Recycle = void (*)(void*) noexcept;

  AcceptedControlLossEscalation() {
    event_.type = NativeEventType::RuntimeError;
    event_.error = NativeError{
      "native_control_delivery_lost",
      "A native actor control transition exceeded its acceptance deadline",
      "nativeActorMailbox",
      false,
    };
  }

  void signal(
    SequencedEmitter& emitter,
    Recycle recycle,
    void* context
  ) noexcept {
    if (signaled_.exchange(true, std::memory_order_acq_rel)) return;
    bool emitted = false;
    try {
      emitted = emitter.emit(std::move(event_));
    } catch (...) {
    }
    if (emitted) return;
    if (recycle) recycle(context);
  }

 private:
  std::atomic_bool signaled_{false};
  RuntimeEvent event_;
};

// A bounded asynchronous acceptance adapter for terminal and other lossless
// actor commands. A typed producer incarnation remains pending until the actor
// mailbox accepts it; stale callbacks observe that pending/accepted watermark
// instead of creating another terminal. Expiry is explicit through the loss
// callback, whose key is diagnostic metadata rather than dedupe identity.
class AcceptedControlPost final {
 public:
  struct Policy {
    std::chrono::milliseconds retry_interval{10};
    std::chrono::milliseconds acceptance_deadline{2'000};
    std::size_t capacity = 16;
  };

  using Post = std::function<bool(MediaCommand)>;
  using OnLoss = std::function<void(const std::string&)>;

  AcceptedControlPost(Post post, OnLoss on_loss, Policy policy = {})
    : post_(std::move(post)),
      on_loss_(std::move(on_loss)),
      policy_(normalize(policy)) {
    worker_ = std::thread([this] {
      {
        std::lock_guard lock(mutex_);
        worker_id_ = std::this_thread::get_id();
      }
      run();
    });
  }

  AcceptedControlPost(const AcceptedControlPost&) = delete;
  AcceptedControlPost& operator=(const AcceptedControlPost&) = delete;

  ~AcceptedControlPost() { close(); }

  bool postOnce(std::string key, MediaCommand command) {
    if (key.empty() || command.terminal_incarnation == 0 ||
        !producerMatchesCommand(command)) {
      notifyLoss(key);
      return false;
    }
    bool capacity_lost = false;
    {
      std::lock_guard lock(mutex_);
      if (closed_) return false;
      if (isAcceptedOrStale(command) || containsPending(command)) {
        return true;
      }
      supersedePending(command);
      if (pending_.size() >= policy_.capacity) {
        capacity_lost = true;
      } else {
        try {
          pending_.push_back(Pending{
            key,
            std::move(command),
            std::chrono::steady_clock::now() +
              policy_.acceptance_deadline,
          });
        } catch (...) {
          capacity_lost = true;
        }
      }
    }
    if (capacity_lost) {
      notifyLoss(key);
      return false;
    }
    changed_.notify_one();
    return true;
  }

  void close() noexcept {
    bool changed = false;
    bool called_from_worker = false;
    {
      std::lock_guard lock(mutex_);
      called_from_worker = worker_id_ == std::this_thread::get_id();
      if (!closed_) {
        closed_ = true;
        pending_.clear();
        changed = true;
      }
    }
    if (changed) changed_.notify_all();
    if (called_from_worker) return;
    std::lock_guard join_lock(join_mutex_);
    if (worker_.joinable()) worker_.join();
  }

 private:
  struct Pending {
    std::string key;
    MediaCommand command;
    std::chrono::steady_clock::time_point deadline;
  };

  struct TerminalWatermark {
    std::uint64_t incarnation = 0;
    bool accepted = false;
  };

  static Policy normalize(Policy policy) noexcept {
    policy.retry_interval =
      (std::max)(policy.retry_interval, std::chrono::milliseconds(1));
    policy.acceptance_deadline =
      (std::max)(policy.acceptance_deadline, policy.retry_interval);
    policy.capacity = (std::max<std::size_t>)(1, policy.capacity);
    return policy;
  }

  void notifyLoss(const std::string& key) noexcept {
    try {
      if (on_loss_) on_loss_(key);
    } catch (...) {
    }
  }

  static std::size_t producerIndex(NativeTerminalProducer producer) noexcept {
    return static_cast<std::size_t>(producer);
  }

  static bool producerMatchesCommand(const MediaCommand& command) noexcept {
    switch (command.type) {
      case NativeCommandType::VoiceTerminal:
        return command.terminal_producer == NativeTerminalProducer::VoiceRoom;
      case NativeCommandType::MicrophoneTerminal:
        return command.terminal_producer ==
            NativeTerminalProducer::MicrophoneCapture ||
          command.terminal_producer ==
            NativeTerminalProducer::MicrophonePublication;
      case NativeCommandType::ScreenTerminal:
        return command.terminal_producer ==
          NativeTerminalProducer::ScreenCapture;
      case NativeCommandType::ScreenAudioTerminal:
        return command.terminal_producer == NativeTerminalProducer::ScreenAudio;
      case NativeCommandType::CameraTerminal:
        return command.terminal_producer ==
          NativeTerminalProducer::CameraCapture;
      default:
        return false;
    }
  }

  static bool isSameOrNewerTerminal(
    const MediaCommand& left,
    const MediaCommand& right
  ) noexcept {
    return left.terminal_producer == right.terminal_producer &&
      left.terminal_incarnation >= right.terminal_incarnation;
  }

  bool isAcceptedOrStale(const MediaCommand& command) const noexcept {
    if (!producerMatchesCommand(command)) return false;
    const auto& watermark =
      accepted_watermarks_[producerIndex(command.terminal_producer)];
    return watermark.accepted &&
      command.terminal_incarnation <= watermark.incarnation;
  }

  void markAccepted(MediaCommand& command) noexcept {
    if (!producerMatchesCommand(command)) return;
    auto& watermark =
      accepted_watermarks_[producerIndex(command.terminal_producer)];
    watermark.incarnation = command.terminal_incarnation;
    watermark.accepted = true;
  }

  bool containsPending(const MediaCommand& command) const {
    return std::find_if(
      pending_.begin(),
      pending_.end(),
      [&](const Pending& pending) {
        return isSameOrNewerTerminal(pending.command, command);
      }
    ) != pending_.end();
  }

  void supersedePending(const MediaCommand& command) {
    auto begin = pending_.begin();
    if (posting_ && begin != pending_.end()) ++begin;
    pending_.erase(
      std::remove_if(
        begin,
        pending_.end(),
        [&](const Pending& pending) {
          return pending.command.terminal_producer ==
              command.terminal_producer &&
            pending.command.terminal_incarnation <
              command.terminal_incarnation;
        }
      ),
      pending_.end()
    );
  }

  bool hasNewerPendingThanFront() const noexcept {
    if (pending_.size() < 2) return false;
    const auto& front = pending_.front().command;
    return std::find_if(
      std::next(pending_.begin()),
      pending_.end(),
      [&](const Pending& pending) {
        return pending.command.terminal_producer == front.terminal_producer &&
          pending.command.terminal_incarnation > front.terminal_incarnation;
      }
    ) != pending_.end();
  }

  void run() noexcept {
    std::unique_lock lock(mutex_);
    while (!closed_) {
      changed_.wait(lock, [&] { return closed_ || !pending_.empty(); });
      if (closed_) break;
      if (isAcceptedOrStale(pending_.front().command) ||
          hasNewerPendingThanFront()) {
        pending_.pop_front();
        continue;
      }

      std::string key;
      MediaCommand command;
      try {
        key = pending_.front().key;
        command = pending_.front().command;
      } catch (...) {
        pending_.pop_front();
        lock.unlock();
        notifyLoss(key);
        lock.lock();
        continue;
      }
      const auto deadline = pending_.front().deadline;
      posting_ = true;
      lock.unlock();
      bool accepted = false;
      try {
        accepted = post_ && post_(std::move(command));
      } catch (...) {
      }
      lock.lock();
      posting_ = false;
      if (closed_) break;
      if (accepted) {
        markAccepted(pending_.front().command);
        pending_.pop_front();
        continue;
      }

      if (hasNewerPendingThanFront()) {
        pending_.pop_front();
        continue;
      }
      if (std::chrono::steady_clock::now() >= deadline) {
        pending_.pop_front();
        lock.unlock();
        notifyLoss(key);
        lock.lock();
        continue;
      }
      changed_.wait_for(lock, policy_.retry_interval, [&] { return closed_; });
    }
  }

  Post post_;
  OnLoss on_loss_;
  Policy policy_;
  std::mutex mutex_;
  std::condition_variable changed_;
  std::deque<Pending> pending_;
  std::array<
    TerminalWatermark,
    static_cast<std::size_t>(NativeTerminalProducer::Count)>
    accepted_watermarks_{};
  std::thread worker_;
  std::thread::id worker_id_;
  std::mutex join_mutex_;
  bool posting_ = false;
  bool closed_ = false;
};

}  // namespace syrnike::desktop_native::media
