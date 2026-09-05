#include "screen/production_screen_sender.hpp"

#include <algorithm>
#include <array>
#include <condition_variable>
#include <exception>
#include <mutex>
#include <stdexcept>
#include <string_view>
#include <utility>

namespace syrnike::windows_media::screen {
namespace {

constexpr std::size_t kControlEventReserve = 4;

enum class PendingOperation { None, Publish, Submit, Unpublish };

ScreenPublicationFailure failure(std::string code, std::string message,
                                 std::string stage, bool retryable = false,
                                 bool retire_epoch = false) {
  return {std::move(code), std::move(message), std::move(stage), retryable,
          retire_epoch};
}

ScreenCommandResult commandFailure(const char* code, const char* message,
                                   const char* stage) {
  return {false, failure(code, message, stage)};
}

}  // namespace

ScreenOperationResult ScreenOperationResult::success() { return {}; }

ScreenOperationResult ScreenOperationResult::fail(
    ScreenPublicationFailure operation_failure) {
  return {false, std::move(operation_failure)};
}

namespace detail {

struct ProductionScreenSenderState final {
  ProductionScreenSenderState(
      std::shared_ptr<ScreenPublicationAdapter> owned_adapter,
      ScreenPublicationDeadlines owned_deadlines)
      : adapter(std::move(owned_adapter)), deadlines(owned_deadlines) {}

  mutable std::mutex mutex;
  std::condition_variable changed;
  std::shared_ptr<ScreenPublicationAdapter> adapter;
  ScreenPublicationDeadlines deadlines;
  ScreenPublicationState publication_state = ScreenPublicationState::Idle;
  std::uint64_t generation = 0;
  std::optional<EncodedScreenFrame> active;
  std::optional<EncodedScreenFrame> pending;
  PendingOperation operation = PendingOperation::None;
  std::optional<std::chrono::steady_clock::time_point> deadline;
  std::array<std::optional<ScreenPublicationEvent>,
             kScreenPublicationEventCapacity>
      events;
  std::size_t event_head = 0;
  std::size_t event_size = 0;
  bool stop_requested = false;
  bool stopping_watchdog = false;
  ProductionScreenSenderStats stats;
};

}  // namespace detail

namespace {

void pushEventLocked(detail::ProductionScreenSenderState& state,
                     ScreenPublicationEvent event) {
  if (state.event_size == kScreenPublicationEventCapacity) {
    throw std::logic_error("screen publication event reservation was violated");
  }
  const auto index =
      (state.event_head + state.event_size) % kScreenPublicationEventCapacity;
  state.events[index] = std::move(event);
  ++state.event_size;
  state.changed.notify_all();
}

void releaseSlotLocked(detail::ProductionScreenSenderState& state,
                       const EncodedScreenFrame& frame,
                       ScreenSlotReleaseReason reason) {
  if (reason == ScreenSlotReleaseReason::Consumed) ++state.stats.consumed;
  if (reason == ScreenSlotReleaseReason::Superseded) ++state.stats.superseded;
  pushEventLocked(state,
                  {ScreenPublicationEventKind::SlotReleased, frame.generation,
                   frame.slot, reason, std::nullopt});
}

void failLocked(detail::ProductionScreenSenderState& state,
                ScreenPublicationFailure operation_failure) {
  state.publication_state = ScreenPublicationState::Failed;
  state.operation = PendingOperation::None;
  state.deadline.reset();
  if (state.pending) {
    releaseSlotLocked(state, *state.pending, ScreenSlotReleaseReason::Aborted);
    state.pending.reset();
  }
  ++state.stats.terminal_failures;
  pushEventLocked(state,
                  {ScreenPublicationEventKind::TerminalFailure,
                   state.generation, 0, ScreenSlotReleaseReason::Failed,
                   std::move(operation_failure)});
}

void completeAdapterStartFailure(
    const std::shared_ptr<detail::ProductionScreenSenderState>& state,
    std::uint64_t generation, const char* stage, const char* message) noexcept {
  std::lock_guard lock(state->mutex);
  if (state->generation != generation ||
      state->publication_state == ScreenPublicationState::Idle)
    return;
  if (std::string_view(stage) == "screen_submit" && state->active &&
      state->active->generation == generation) {
    releaseSlotLocked(*state, *state->active,
                      ScreenSlotReleaseReason::Failed);
    state->active.reset();
  }
  failLocked(*state,
             failure("screen_adapter_start_failed", message, stage, true));
  state->changed.notify_all();
}

void startUnpublish(
    const std::shared_ptr<detail::ProductionScreenSenderState>& state);

void startSubmit(const std::shared_ptr<detail::ProductionScreenSenderState>& state,
                 EncodedScreenFrame frame) {
  const std::weak_ptr weak_state(state);
  try {
    state->adapter->startSubmit(
        frame.generation, frame,
        [weak_state](std::uint64_t completed_generation,
                     ScreenOperationResult result) {
          const auto shared = weak_state.lock();
          if (!shared) return;
          std::optional<EncodedScreenFrame> next;
          bool unpublish = false;
          {
            std::lock_guard lock(shared->mutex);
            if (shared->generation != completed_generation ||
                !shared->active ||
                shared->active->generation != completed_generation)
              return;
            const auto completed = *shared->active;
            shared->active.reset();
            shared->operation = PendingOperation::None;
            shared->deadline.reset();
            releaseSlotLocked(*shared, completed,
                              result.ok ? ScreenSlotReleaseReason::Consumed
                                        : ScreenSlotReleaseReason::Failed);
            if (shared->publication_state ==
                ScreenPublicationState::Failed) {
              shared->changed.notify_all();
              return;
            }
            if (!result.ok) {
              failLocked(*shared,
                         result.failure.value_or(failure(
                             "screen_submit_failed",
                             "Encoded frame submission failed",
                             "screen_submit", true)));
            } else if (shared->stop_requested) {
              if (shared->pending) {
                releaseSlotLocked(*shared, *shared->pending,
                                  ScreenSlotReleaseReason::Aborted);
                shared->pending.reset();
              }
              unpublish = true;
            } else if (shared->pending) {
              next = *shared->pending;
              shared->pending.reset();
              shared->active = next;
              shared->operation = PendingOperation::Submit;
              shared->deadline =
                  std::chrono::steady_clock::now() + shared->deadlines.submit;
            }
          }
          shared->changed.notify_all();
          if (next) startSubmit(shared, *next);
          if (unpublish) startUnpublish(shared);
        });
  } catch (const std::exception& error) {
    completeAdapterStartFailure(state, frame.generation, "screen_submit",
                                error.what());
  } catch (...) {
    completeAdapterStartFailure(state, frame.generation, "screen_submit",
                                "Unknown publication adapter failure");
  }
}

void startUnpublish(
    const std::shared_ptr<detail::ProductionScreenSenderState>& state) {
  std::uint64_t generation = 0;
  {
    std::lock_guard lock(state->mutex);
    if (state->publication_state != ScreenPublicationState::Stopping ||
        state->active || state->operation == PendingOperation::Unpublish)
      return;
    generation = state->generation;
    state->operation = PendingOperation::Unpublish;
    state->deadline =
        std::chrono::steady_clock::now() + state->deadlines.unpublish;
  }
  const std::weak_ptr weak_state(state);
  try {
    state->adapter->startUnpublish(
        generation,
        [weak_state](std::uint64_t completed_generation,
                     ScreenOperationResult result) {
          const auto shared = weak_state.lock();
          if (!shared) return;
          {
            std::lock_guard lock(shared->mutex);
            if (shared->generation != completed_generation ||
                shared->publication_state != ScreenPublicationState::Stopping ||
                shared->operation != PendingOperation::Unpublish)
              return;
            shared->operation = PendingOperation::None;
            shared->deadline.reset();
            if (!result.ok) {
              failLocked(*shared,
                         result.failure.value_or(failure(
                             "screen_unpublish_failed",
                             "Screen track unpublication failed",
                             "screen_unpublish", true)));
            } else {
              shared->publication_state = ScreenPublicationState::Idle;
              shared->stop_requested = false;
              pushEventLocked(*shared,
                              {ScreenPublicationEventKind::Unpublished,
                               completed_generation});
            }
          }
          shared->changed.notify_all();
        });
  } catch (const std::exception& error) {
    completeAdapterStartFailure(state, generation, "screen_unpublish",
                                error.what());
  } catch (...) {
    completeAdapterStartFailure(state, generation, "screen_unpublish",
                                "Unknown publication adapter failure");
  }
}

}  // namespace

ProductionScreenSender::ProductionScreenSender(
    std::shared_ptr<ScreenPublicationAdapter> adapter,
    ScreenPublicationDeadlines deadlines)
    : state_(std::make_shared<detail::ProductionScreenSenderState>(
          std::move(adapter), deadlines)),
      deadlines_(deadlines) {
  if (!state_->adapter)
    throw std::invalid_argument("ProductionScreenSender adapter is required");
  if (deadlines_.publish <= std::chrono::milliseconds::zero() ||
      deadlines_.submit <= std::chrono::milliseconds::zero() ||
      deadlines_.unpublish <= std::chrono::milliseconds::zero())
    throw std::invalid_argument("Screen publication deadlines must be positive");
  deadline_watchdog_ = std::thread([this] { runDeadlineWatchdog(); });
}

ProductionScreenSender::~ProductionScreenSender() {
  {
    std::lock_guard lock(state_->mutex);
    state_->stopping_watchdog = true;
    state_->deadline.reset();
  }
  state_->changed.notify_all();
  if (deadline_watchdog_.joinable()) deadline_watchdog_.join();
}

ScreenStartResult ProductionScreenSender::start(
    ScreenTrackDescriptor descriptor) {
  std::uint64_t generation = 0;
  {
    std::lock_guard lock(state_->mutex);
    if (state_->publication_state != ScreenPublicationState::Idle) {
      return {false, state_->generation,
              failure("screen_invalid_state",
                      "Screen publication is not idle", "screen_publish")};
    }
    if (descriptor.name.empty() || descriptor.width == 0 ||
        descriptor.height == 0 || (descriptor.width % 2) != 0 ||
        (descriptor.height % 2) != 0 || descriptor.frames_per_second == 0 ||
        descriptor.frames_per_second > 60 || descriptor.bitrate == 0) {
      return {false, state_->generation,
              failure("screen_profile_invalid",
                      "Screen publication profile is invalid",
                      "screen_publish")};
    }
    if (state_->event_size >= kScreenPublicationEventCapacity - 1) {
      return {false, state_->generation,
              failure("screen_event_backpressure",
                      "Screen publication events must be drained",
                      "screen_publish", true)};
    }
    generation = ++state_->generation;
    state_->publication_state = ScreenPublicationState::Publishing;
    state_->operation = PendingOperation::Publish;
    state_->deadline = std::chrono::steady_clock::now() + deadlines_.publish;
  }
  state_->changed.notify_all();

  const std::weak_ptr weak_state(state_);
  try {
    state_->adapter->startPublish(
        generation, std::move(descriptor),
        [weak_state](std::uint64_t completed_generation,
                     ScreenOperationResult result) {
          const auto shared = weak_state.lock();
          if (!shared) return;
          bool unpublish = false;
          {
            std::lock_guard lock(shared->mutex);
            if (shared->generation != completed_generation ||
                shared->publication_state !=
                    ScreenPublicationState::Publishing ||
                shared->operation != PendingOperation::Publish)
              return;
            shared->operation = PendingOperation::None;
            shared->deadline.reset();
            if (!result.ok) {
              failLocked(*shared,
                         result.failure.value_or(failure(
                             "screen_publish_failed",
                             "Screen track publication failed",
                             "screen_publish", true)));
            } else {
              pushEventLocked(*shared,
                              {ScreenPublicationEventKind::Published,
                               completed_generation});
              if (shared->stop_requested) {
                shared->publication_state = ScreenPublicationState::Stopping;
                unpublish = true;
              } else {
                shared->publication_state = ScreenPublicationState::Published;
              }
            }
          }
          shared->changed.notify_all();
          if (unpublish) startUnpublish(shared);
        });
  } catch (const std::exception& error) {
    completeAdapterStartFailure(state_, generation, "screen_publish",
                                error.what());
    return {false, generation,
            failure("screen_adapter_start_failed", error.what(),
                    "screen_publish", true)};
  } catch (...) {
    completeAdapterStartFailure(state_, generation, "screen_publish",
                                "Unknown publication adapter failure");
    return {false, generation,
            failure("screen_adapter_start_failed",
                    "Unknown publication adapter failure", "screen_publish",
                    true)};
  }
  return {true, generation, std::nullopt};
}

ScreenSubmitResult ProductionScreenSender::submit(EncodedScreenFrame frame) {
  std::optional<EncodedScreenFrame> begin;
  {
    std::lock_guard lock(state_->mutex);
    if (frame.generation != state_->generation) {
      ++state_->stats.rejected;
      return ScreenSubmitResult::StaleGeneration;
    }
    if (state_->publication_state != ScreenPublicationState::Published ||
        state_->stop_requested) {
      ++state_->stats.rejected;
      return ScreenSubmitResult::InvalidState;
    }
    if (!frame.data || frame.size == 0 || frame.timestamp_us == 0) {
      ++state_->stats.rejected;
      return ScreenSubmitResult::InvalidFrame;
    }
    const auto video_depth = static_cast<std::size_t>(state_->active.has_value()) +
                             static_cast<std::size_t>(state_->pending.has_value());
    const auto reserved_events = state_->event_size + video_depth;
    if (reserved_events >=
        kScreenPublicationEventCapacity - kControlEventReserve) {
      ++state_->stats.rejected;
      return ScreenSubmitResult::EventBackpressure;
    }
    if (state_->active && state_->pending) {
      ++state_->stats.rejected;
      return ScreenSubmitResult::VideoBackpressure;
    }
    ++state_->stats.accepted;
    if (!state_->active) {
      state_->active = frame;
      state_->operation = PendingOperation::Submit;
      state_->deadline =
          std::chrono::steady_clock::now() + deadlines_.submit;
      begin = frame;
    } else if (!state_->pending) {
      state_->pending = frame;
    }
    const auto depth = static_cast<std::size_t>(state_->active.has_value()) +
                       static_cast<std::size_t>(state_->pending.has_value());
    state_->stats.maximum_video_depth =
        std::max(state_->stats.maximum_video_depth, depth);
  }
  if (begin) startSubmit(state_, *begin);
  return ScreenSubmitResult::Accepted;
}

ScreenCommandResult ProductionScreenSender::stop(std::uint64_t generation) {
  bool unpublish = false;
  {
    std::lock_guard lock(state_->mutex);
    if (generation != state_->generation) {
      return commandFailure("screen_generation_stale",
                            "Screen generation is stale", "screen_stop");
    }
    if (state_->publication_state == ScreenPublicationState::Idle)
      return {true, std::nullopt};
    if (state_->publication_state == ScreenPublicationState::Failed) {
      return commandFailure("screen_generation_failed",
                            "Screen generation already failed", "screen_stop");
    }
    state_->stop_requested = true;
    if (state_->pending) {
      releaseSlotLocked(*state_, *state_->pending,
                        ScreenSlotReleaseReason::Aborted);
      state_->pending.reset();
    }
    if (state_->publication_state == ScreenPublicationState::Published) {
      state_->publication_state = ScreenPublicationState::Stopping;
      unpublish = !state_->active;
    }
  }
  state_->changed.notify_all();
  if (unpublish) startUnpublish(state_);
  return {true, std::nullopt};
}

std::optional<ScreenPublicationEvent> ProductionScreenSender::waitForEvent(
    std::chrono::milliseconds timeout) {
  std::unique_lock lock(state_->mutex);
  if (!state_->changed.wait_for(lock, timeout, [this] {
        return state_->event_size != 0 || state_->stopping_watchdog;
      }))
    return std::nullopt;
  if (state_->event_size == 0) return std::nullopt;
  auto event = std::move(state_->events[state_->event_head]);
  state_->events[state_->event_head].reset();
  state_->event_head =
      (state_->event_head + 1) % kScreenPublicationEventCapacity;
  --state_->event_size;
  return event;
}

ScreenPublicationState ProductionScreenSender::state() const noexcept {
  std::lock_guard lock(state_->mutex);
  return state_->publication_state;
}

std::uint64_t ProductionScreenSender::generation() const noexcept {
  std::lock_guard lock(state_->mutex);
  return state_->generation;
}

ProductionScreenSenderStats ProductionScreenSender::stats() const noexcept {
  std::lock_guard lock(state_->mutex);
  auto result = state_->stats;
  result.video_depth = static_cast<std::size_t>(state_->active.has_value()) +
                       static_cast<std::size_t>(state_->pending.has_value());
  result.event_depth = state_->event_size;
  return result;
}

void ProductionScreenSender::runDeadlineWatchdog() noexcept {
  while (true) {
    {
      std::unique_lock lock(state_->mutex);
      state_->changed.wait(lock, [this] {
        return state_->stopping_watchdog || state_->deadline.has_value();
      });
      if (state_->stopping_watchdog) return;
      const auto deadline = *state_->deadline;
      const auto generation = state_->generation;
      const auto operation = state_->operation;
      if (state_->changed.wait_until(lock, deadline, [this, deadline, generation,
                                                      operation] {
            return state_->stopping_watchdog || !state_->deadline ||
                   *state_->deadline != deadline ||
                   state_->generation != generation ||
                   state_->operation != operation;
          })) {
        if (state_->stopping_watchdog) return;
        continue;
      }
      const char* stage = operation == PendingOperation::Publish
                              ? "screen_publish"
                              : operation == PendingOperation::Submit
                                    ? "screen_submit"
                                    : "screen_unpublish";
      failLocked(*state_,
                 failure("screen_operation_unresponsive",
                         "Screen publication operation exceeded its deadline",
                         stage, true, true));
    }
    state_->changed.notify_all();
  }
}

}  // namespace syrnike::windows_media::screen
