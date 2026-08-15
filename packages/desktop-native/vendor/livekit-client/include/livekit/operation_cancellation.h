/*
 * Copyright 2026 LiveKit
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#pragma once

#include <algorithm>
#include <condition_variable>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

namespace livekit {

/// @brief Provides cooperative cancellation for bounded SDK operations.
///
/// Copies share cancellation state and may be used concurrently from different
/// threads. The first cancellation request synchronously invokes each active
/// subscription on the requesting thread, outside the state lock; later
/// requests are harmless. Callback exceptions are ignored so every active
/// subscriber is notified. A subscription owns only its callback registration,
/// while every handle copy shares ownership of the cancellation state.
class OperationCancellation {
private:
  struct CallbackSlot {
    explicit CallbackSlot(std::function<void()> value) : callback(std::move(value)) {}

    void deactivate() noexcept {
      std::function<void()> released_callback;
      {
        std::unique_lock<std::mutex> guard(mutex);
        active = false;
        if (running && invocation_thread != std::this_thread::get_id()) {
          changed.wait(guard, [this] { return !running; });
        }
        if (!running) {
          released_callback = std::move(callback);
        }
      }
    }

    void invoke() noexcept {
      std::function<void()> claimed_callback;
      {
        const std::scoped_lock<std::mutex> guard(mutex);
        if (!active) {
          return;
        }
        active = false;
        running = true;
        invocation_thread = std::this_thread::get_id();
        claimed_callback = std::move(callback);
      }
      if (claimed_callback) {
        try {
          claimed_callback();
        } catch (...) {
          // Cancellation is best effort per callback. One observer must not
          // prevent the remaining operation waiters from being released.
        }
      }
      claimed_callback = {};
      {
        const std::scoped_lock<std::mutex> guard(mutex);
        running = false;
        invocation_thread = {};
      }
      changed.notify_all();
    }

    std::mutex mutex;
    std::condition_variable changed;
    bool active = true;
    bool running = false;
    std::thread::id invocation_thread;
    std::function<void()> callback;
  };

  struct State {
    std::mutex mutex;
    bool requested = false;
    std::vector<std::weak_ptr<CallbackSlot>> callbacks;
  };

public:
  /// @brief Owns a move-only, scoped cancellation callback registration.
  ///
  /// Destroying or replacing the subscription releases its callback. The
  /// cancellation state keeps only a weak reference, so an operation that has
  /// completed cannot be retained by a long-lived cancellation handle.
  /// Destruction on another thread waits for an in-flight callback to return;
  /// a callback may destroy its own subscription without waiting on itself.
  class Subscription {
  public:
    /// @brief Constructs an inactive subscription.
    Subscription() = default;

    /// @brief Disables copying because one object owns one registration.
    /// @param other Subscription that would otherwise be copied.
    Subscription(const Subscription& other) = delete;

    /// @brief Disables copy assignment because registrations have one owner.
    /// @param other Subscription that would otherwise be copied.
    /// @return This subscription.
    Subscription& operator=(const Subscription& other) = delete;

    /// @brief Transfers ownership of a callback registration.
    /// @param other Subscription whose registration is transferred.
    Subscription(Subscription&&) noexcept = default;

    /// @brief Replaces this registration with the one owned by @p other.
    /// @param other Subscription whose registration is transferred.
    /// @return This subscription.
    Subscription& operator=(Subscription&& other) noexcept {
      if (this != &other) {
        reset();
        slot_ = std::move(other.slot_);
      }
      return *this;
    }

    /// @brief Releases the registration after any concurrent callback returns.
    ~Subscription() { reset(); }

  private:
    explicit Subscription(std::shared_ptr<CallbackSlot> slot) : slot_(std::move(slot)) {}

    void reset() noexcept {
      if (slot_) {
        slot_->deactivate();
        slot_.reset();
      }
    }

    std::shared_ptr<CallbackSlot> slot_;
    friend class OperationCancellation;
  };

  /// @brief Constructs a new uncancelled shared state.
  /// @throws std::bad_alloc If the shared cancellation state cannot be allocated.
  OperationCancellation() : state_(std::make_shared<State>()) {}

  /// @brief Requests cancellation and notifies active subscriptions.
  ///
  /// Callbacks run on the calling thread, outside the internal mutex, and may
  /// subscribe to or inspect this handle. Callback exceptions are ignored.
  ///
  /// @return `true` for the request that changed the state, or `false` if
  /// cancellation had already been requested.
  bool requestCancel() const {
    std::vector<std::weak_ptr<CallbackSlot>> callbacks;
    {
      const std::scoped_lock<std::mutex> guard(state_->mutex);
      if (state_->requested) {
        return false;
      }
      state_->requested = true;
      callbacks.swap(state_->callbacks);
    }
    for (const auto& callback : callbacks) {
      if (auto slot = callback.lock()) slot->invoke();
    }
    return true;
  }

  /// @brief Checks whether cancellation has been requested.
  ///
  /// This method is safe to call concurrently with @ref requestCancel().
  ///
  /// @return `true` after the first cancellation request.
  bool isCancellationRequested() const {
    const std::scoped_lock<std::mutex> guard(state_->mutex);
    return state_->requested;
  }

  /// @brief Registers a callback for the first cancellation request.
  ///
  /// The returned subscription owns the registration and must remain alive
  /// while notification is required. If cancellation was already requested,
  /// @p callback is invoked synchronously on the calling thread before this
  /// method returns. Otherwise it is invoked at most once by the thread that
  /// wins @ref requestCancel(). Callback exceptions are ignored.
  ///
  /// @param callback Callback to invoke; an empty callback is permitted.
  /// @return A scoped owner for the callback registration.
  /// @throws std::bad_alloc If the callback registration cannot be allocated.
  [[nodiscard]] Subscription subscribe(std::function<void()> callback) const {
    auto slot = std::make_shared<CallbackSlot>(std::move(callback));
    bool invoke_now = false;
    {
      const std::scoped_lock<std::mutex> guard(state_->mutex);
      if (state_->requested) {
        invoke_now = true;
      } else {
        state_->callbacks.erase(std::remove_if(state_->callbacks.begin(), state_->callbacks.end(),
                                               [](const auto& item) { return item.expired(); }),
                                state_->callbacks.end());
        state_->callbacks.emplace_back(slot);
      }
    }
    if (invoke_now) slot->invoke();
    return Subscription(std::move(slot));
  }

private:
  std::shared_ptr<State> state_;
};

} // namespace livekit
