#include <iostream>

#include <windows.h>

#include <atomic>
#include <chrono>
#include <exception>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "common/bounded_queue.hpp"
#include "common/bounded_release_ledger.hpp"
#include "common/coalescing_event_lane.hpp"
#include "common/control_event_lane.hpp"
#include "common/diagnostic_log.hpp"
#include "common/sequenced_emitter.hpp"
#include "hooks/input_state.hpp"
#include "hooks/key_codes.hpp"
#include "media/accepted_control_post.hpp"
#include "media/generation_fence.hpp"
#include "media/capture_lifecycle_invariants.hpp"
#include "media/microphone_capture_demand.hpp"
#include "media/runtime_config.hpp"
#include "media/runtime_config_patch.hpp"
#include "media/screen_session_invariants.hpp"

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

class ConcurrencyDetectingSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent event) override {
    if (active_calls.fetch_add(1) != 0) concurrent_entry.store(true);
    if (block_next_emit.exchange(false)) {
      blocked_emit_entered.store(true);
      while (!release_blocked_emit.load()) std::this_thread::yield();
    }
    if ((event.sequence & 1U) != 0) {
      std::this_thread::sleep_for(std::chrono::microseconds(50));
    }
    {
      std::lock_guard lock(events_mutex);
      observed_sequences.push_back(event.sequence);
    }
    active_calls.fetch_sub(1);
    return true;
  }

  void close() override {
    if (active_calls.load() != 0) concurrent_close.store(true);
  }

  std::atomic_int active_calls{0};
  std::atomic_bool concurrent_entry{false};
  std::atomic_bool concurrent_close{false};
  std::atomic_bool block_next_emit{false};
  std::atomic_bool blocked_emit_entered{false};
  std::atomic_bool release_blocked_emit{false};
  std::mutex events_mutex;
  std::vector<std::uint64_t> observed_sequences;
};

class ThrowingSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent) override {
    throw std::runtime_error("injected control delivery failure");
  }
  void close() override {}
};

class RejectingSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent) override { return false; }
  void close() override {}
};

class ReentrantCloseSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent) override { return true; }
  void close() override {
    if (!dispatch_during_close) return;
    syrnike::desktop_native::RuntimeEvent event;
    event.type = syrnike::desktop_native::NativeEventType::SessionLifecycle;
    dispatch_result = dispatch_during_close(std::move(event));
  }

  std::function<bool(syrnike::desktop_native::RuntimeEvent)> dispatch_during_close;
  bool dispatch_result = true;
};

class BlockingControlLaneSink final
  : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent event) override {
    active_emits.fetch_add(1);
    const auto pushed = lane_.push(std::move(event));
    active_emits.fetch_sub(1);
    if (pushed.accepted) return true;
    // Returning false keeps release ownership in SequencedEmitter's fallback
    // guard. The rejected moved copy must not release the same resource.
    if (pushed.rejected) pushed.rejected->on_drop = {};
    return false;
  }

  void close() override {
    close_raced_with_emit.store(active_emits.load() != 0);
    lane_.closeAndDiscard();
  }

  std::atomic_int active_emits{0};
  std::atomic_bool close_raced_with_emit{false};

 private:
  syrnike::desktop_native::ControlEventLane lane_{
    1,
    std::chrono::seconds(10)
  };
};

class AllocationFailingSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent) override {
    throw std::bad_alloc();
  }
  void close() override {}
};

class CrossLaneBlockingSink final
  : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent event) override {
    if (syrnike::desktop_native::eventLane(event) ==
        syrnike::desktop_native::EventLane::control) {
      control_entered.store(true);
      while (!release_control.load()) std::this_thread::yield();
      return true;
    }
    realtime_entered.store(true);
    return true;
  }

  void close() override { release_control.store(true); }

  std::atomic_bool control_entered{false};
  std::atomic_bool realtime_entered{false};
  std::atomic_bool release_control{false};
};

}  // namespace

int main() try {
  using syrnike::desktop_native::BoundedQueue;

  auto throwing_sink = std::make_shared<ThrowingSink>();
  syrnike::desktop_native::SequencedEmitter throwing_emitter(throwing_sink);
  syrnike::desktop_native::RuntimeEvent throwing_event;
  throwing_event.type = syrnike::desktop_native::NativeEventType::SessionLifecycle;
  require(
    !throwing_emitter.emit(std::move(throwing_event)),
    "throwing control sink was not reported as a bounded rejection"
  );
  auto rejecting_sink = std::make_shared<RejectingSink>();
  syrnike::desktop_native::SequencedEmitter rejecting_emitter(rejecting_sink);
  int rejected_releases = 0;
  syrnike::desktop_native::RuntimeEvent rejected_event;
  rejected_event.type = syrnike::desktop_native::NativeEventType::SessionLifecycle;
  rejected_event.on_drop = [&] { ++rejected_releases; };
  require(
    !rejecting_emitter.emit(std::move(rejected_event)) &&
      rejected_releases == 1,
    "rejected event resource was not released exactly once"
  );
  auto reentrant_close_sink = std::make_shared<ReentrantCloseSink>();
  syrnike::desktop_native::SequencedEmitter reentrant_close_emitter(
    reentrant_close_sink
  );
  reentrant_close_sink->dispatch_during_close = [&](auto event) {
    return reentrant_close_emitter.emit(std::move(event));
  };
  reentrant_close_emitter.close();
  require(
    !reentrant_close_sink->dispatch_result,
    "shutdown callback did not observe the emitter's closed state"
  );

  BoundedQueue<std::string, 2> queue;
  require(queue.tryPush("first"), "queue rejected first item");
  require(queue.tryPush("second"), "queue rejected second item");
  require(!queue.tryPush("overflow"), "queue exceeded capacity");
  require(queue.waitPop() == "first", "queue lost FIFO ordering");
  queue.close();
  require(!queue.tryPush("closed"), "closed queue accepted an item");
  require(queue.waitPop() == "second", "close should drain by default");
  require(!queue.waitPop().has_value(), "closed queue did not finish draining");

  BoundedQueue<std::string, 2> cancelled;
  require(cancelled.tryPush("first"), "cancel queue rejected first item");
  require(cancelled.tryPush("second"), "cancel queue rejected second item");
  require(cancelled.closeAndDiscard() == 2, "cancel queue did not report discarded items");
  require(!cancelled.waitPop().has_value(), "cancel queue executed discarded work");

  auto event_sink = std::make_shared<ConcurrencyDetectingSink>();
  syrnike::desktop_native::SequencedEmitter emitter(event_sink);
  constexpr int emitter_thread_count = 8;
  constexpr int events_per_thread = 100;
  std::vector<std::thread> emitter_threads;
  emitter_threads.reserve(emitter_thread_count);
  for (int thread_index = 0; thread_index < emitter_thread_count; ++thread_index) {
    emitter_threads.emplace_back([&] {
      for (int event_index = 0; event_index < events_per_thread; ++event_index) {
        syrnike::desktop_native::RuntimeEvent event;
        event.type = syrnike::desktop_native::NativeEventType::Test;
        emitter.emit(std::move(event));
      }
    });
  }
  for (auto& thread : emitter_threads) thread.join();
  require(!event_sink->concurrent_entry.load(), "event sink emit entered concurrently");
  require(
    event_sink->observed_sequences.size() == emitter_thread_count * events_per_thread,
    "sequenced emitter lost events"
  );
  for (std::size_t index = 1; index < event_sink->observed_sequences.size(); ++index) {
    require(
      event_sink->observed_sequences[index - 1] < event_sink->observed_sequences[index],
      "event sink observed a non-increasing sequence"
    );
  }

  auto cross_lane_sink = std::make_shared<CrossLaneBlockingSink>();
  syrnike::desktop_native::SequencedEmitter cross_lane_emitter(cross_lane_sink);
  std::thread blocked_control_emit([&] {
    syrnike::desktop_native::RuntimeEvent event;
    event.type = syrnike::desktop_native::NativeEventType::SessionLifecycle;
    static_cast<void>(cross_lane_emitter.emit(std::move(event)));
  });
  while (!cross_lane_sink->control_entered.load()) std::this_thread::yield();
  std::thread realtime_emit([&] {
    syrnike::desktop_native::RuntimeEvent event;
    event.type = syrnike::desktop_native::NativeEventType::Input;
    static_cast<void>(cross_lane_emitter.emit(std::move(event)));
  });
  const auto realtime_deadline =
    std::chrono::steady_clock::now() + std::chrono::milliseconds(100);
  while (
    !cross_lane_sink->realtime_entered.load() &&
    std::chrono::steady_clock::now() < realtime_deadline
  ) {
    std::this_thread::yield();
  }
  const bool realtime_was_independent =
    cross_lane_sink->realtime_entered.load();
  cross_lane_sink->release_control.store(true);
  blocked_control_emit.join();
  realtime_emit.join();
  require(
    realtime_was_independent,
    "real-time ingress waited behind a blocked control delivery"
  );

  event_sink->block_next_emit.store(true);
  std::thread final_emit([&] {
    syrnike::desktop_native::RuntimeEvent event;
    event.type = syrnike::desktop_native::NativeEventType::Test;
    emitter.emit(std::move(event));
  });
  while (!event_sink->blocked_emit_entered.load()) std::this_thread::yield();
  std::thread close_thread([&] { emitter.close(); });
  std::this_thread::sleep_for(std::chrono::milliseconds(1));
  event_sink->release_blocked_emit.store(true);
  final_emit.join();
  close_thread.join();
  require(
    event_sink->concurrent_close.load(),
    "emitter close did not reach a sink while its producer was blocked"
  );
  for (int iteration = 0; iteration < 1'000; ++iteration) {
    auto race_sink = std::make_shared<ConcurrencyDetectingSink>();
    syrnike::desktop_native::SequencedEmitter race_emitter(race_sink);
    std::thread dispatching([&] {
      syrnike::desktop_native::RuntimeEvent event;
      event.type = syrnike::desktop_native::NativeEventType::SessionLifecycle;
      static_cast<void>(race_emitter.emit(std::move(event)));
    });
    std::thread closing([&] { race_emitter.close(); });
    dispatching.join();
    closing.join();
    require(
      race_sink->active_calls.load() == 0,
      "dispatch/close stress left an in-flight sink call"
    );
  }

  auto blocking_sink = std::make_shared<BlockingControlLaneSink>();
  syrnike::desktop_native::SequencedEmitter blocking_emitter(blocking_sink);
  int first_blocked_release_count = 0;
  syrnike::desktop_native::RuntimeEvent first_blocked_event;
  first_blocked_event.type = syrnike::desktop_native::NativeEventType::Reply;
  first_blocked_event.on_drop = [&] { ++first_blocked_release_count; };
  require(
    blocking_emitter.emit(std::move(first_blocked_event)),
    "blocking sink rejected its lane-filling event"
  );
  int waiting_release_count = 0;
  std::atomic_bool waiting_emit_finished{false};
  std::atomic_bool waiting_emit_rejected{false};
  std::thread waiting_emit([&] {
    syrnike::desktop_native::RuntimeEvent event;
    event.type = syrnike::desktop_native::NativeEventType::Reply;
    event.on_drop = [&] { ++waiting_release_count; };
    waiting_emit_rejected = !blocking_emitter.emit(std::move(event));
    waiting_emit_finished = true;
  });
  const auto wait_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (
    blocking_sink->active_emits.load() == 0 &&
    std::chrono::steady_clock::now() < wait_deadline
  ) {
    std::this_thread::yield();
  }
  const bool producer_blocked = blocking_sink->active_emits.load() == 1;
  const auto close_started = std::chrono::steady_clock::now();
  blocking_emitter.close();
  const auto close_elapsed = std::chrono::steady_clock::now() - close_started;
  waiting_emit.join();
  require(
    producer_blocked,
    "control producer did not block on the full lane"
  );
  require(
    close_elapsed < std::chrono::milliseconds(250) &&
      waiting_emit_finished.load() && waiting_emit_rejected.load(),
    "close did not promptly wake the blocked control producer"
  );
  require(
    blocking_sink->close_raced_with_emit.load(),
    "blocking sink close did not exercise concurrent emit shutdown"
  );
  require(
    first_blocked_release_count == 1 && waiting_release_count == 1,
    "blocked-producer shutdown did not release both events exactly once"
  );

  syrnike::desktop_native::RuntimeEvent control_event;
  control_event.type = syrnike::desktop_native::NativeEventType::SessionLifecycle;
  require(
    syrnike::desktop_native::eventLane(control_event) ==
      syrnike::desktop_native::EventLane::control,
    "lifecycle event did not use the lossless control lane"
  );
  syrnike::desktop_native::RuntimeEvent media_event;
  media_event.type = syrnike::desktop_native::NativeEventType::RemoteVideoFrame;
  require(
    syrnike::desktop_native::eventLane(media_event) ==
      syrnike::desktop_native::EventLane::media,
    "video frame did not use the lossy media lane"
  );
  syrnike::desktop_native::RuntimeEvent active_speakers_event;
  active_speakers_event.type = syrnike::desktop_native::NativeEventType::ActiveSpeakers;
  require(
    syrnike::desktop_native::eventLane(active_speakers_event) ==
      syrnike::desktop_native::EventLane::media,
    "active speakers did not use the latest-wins media lane"
  );
  bool media_resource_released = false;
  media_event.on_drop = [&] { media_resource_released = true; };
  syrnike::desktop_native::discardEvent(media_event);
  syrnike::desktop_native::discardEvent(media_event);
  require(media_resource_released, "dropped media event did not release its resource");
  require(!media_event.on_drop, "media resource release was not exactly once");

  syrnike::desktop_native::RuntimeEvent delivered_event;
  bool delivered_event_released = false;
  delivered_event.on_drop = [&] { delivered_event_released = true; };
  require(
    syrnike::desktop_native::transferEventToConsumer(
      delivered_event,
      [](const auto&) {}
    ),
    "successful event ownership transfer failed"
  );
  require(
    !delivered_event_released && !delivered_event.on_drop,
    "successful event ownership transfer retained its drop fallback"
  );

  std::vector<std::unique_ptr<syrnike::desktop_native::RuntimeEvent>> failing_batch;
  std::vector<int> batch_release_counts(3, 0);
  for (std::size_t index = 0; index < batch_release_counts.size(); ++index) {
    auto event = std::make_unique<syrnike::desktop_native::RuntimeEvent>();
    event->sequence = index + 1;
    event->on_drop = [&, index] { ++batch_release_counts[index]; };
    failing_batch.push_back(std::move(event));
  }
  require(
    !syrnike::desktop_native::transferEventBatchToConsumer(
      failing_batch,
      [](const auto& event) {
        if (event.sequence == 2) throw std::runtime_error("consumer failed");
      }
    ),
    "failing event batch reported a successful ownership transfer"
  );
  require(
    batch_release_counts[0] == 0 &&
      batch_release_counts[1] == 1 &&
      batch_release_counts[2] == 1,
    "failing event batch did not release the current and remaining resources exactly once"
  );
  syrnike::desktop_native::discardEventBatch(failing_batch);
  require(
    batch_release_counts[0] == 0 &&
      batch_release_counts[1] == 1 &&
      batch_release_counts[2] == 1,
    "event batch cleanup released transferred or already discarded resources"
  );
  syrnike::desktop_native::RuntimeEvent telemetry_event;
  telemetry_event.type = syrnike::desktop_native::NativeEventType::MicrophoneMetrics;
  require(
    syrnike::desktop_native::eventLane(telemetry_event) ==
      syrnike::desktop_native::EventLane::telemetry,
    "microphone metrics did not use the telemetry lane"
  );
  telemetry_event.type = syrnike::desktop_native::NativeEventType::Input;
  require(
    syrnike::desktop_native::eventLane(telemetry_event) ==
      syrnike::desktop_native::EventLane::realtime,
    "Windows input did not use the real-time ingress lane"
  );
  telemetry_event.type = syrnike::desktop_native::NativeEventType::VoiceStats;
  require(
    syrnike::desktop_native::eventLane(telemetry_event) ==
      syrnike::desktop_native::EventLane::telemetry,
    "voice RTC stats did not use the telemetry lane"
  );

  syrnike::desktop_native::ControlEventLane control_lane(
    2,
    std::chrono::milliseconds(20)
  );
  syrnike::desktop_native::RuntimeEvent first_control;
  first_control.type = syrnike::desktop_native::NativeEventType::Reply;
  first_control.sequence = 1;
  syrnike::desktop_native::RuntimeEvent second_control;
  second_control.type = syrnike::desktop_native::NativeEventType::SessionLifecycle;
  second_control.sequence = 2;
  require(
    control_lane.push(std::move(first_control)).schedule_callback,
    "control lane did not schedule its first callback"
  );
  require(
    control_lane.push(std::move(second_control)).accepted,
    "control lane rejected capacity that was still available"
  );
  syrnike::desktop_native::RuntimeEvent blocked_control;
  blocked_control.type = syrnike::desktop_native::NativeEventType::RuntimeError;
  const auto blocked_started = std::chrono::steady_clock::now();
  const auto blocked_push = control_lane.push(std::move(blocked_control));
  const auto blocked_elapsed = std::chrono::steady_clock::now() - blocked_started;
  require(
    !blocked_push.accepted && blocked_push.timed_out &&
      blocked_elapsed >= std::chrono::milliseconds(15),
    "control lane did not apply bounded producer backpressure"
  );
  require(
    blocked_push.rejected != nullptr,
    "control lane lost ownership of a timed-out event"
  );
  auto control_batch = control_lane.beginCallback();
  require(
    control_batch.size() == 2 &&
      control_batch[0]->sequence == 1 &&
      control_batch[1]->sequence == 2,
    "control lane did not preserve accepted event ordering"
  );
  control_lane.closeAndDiscard();

  syrnike::desktop_native::ControlEventLane schedule_failure_lane(2);
  int schedule_failure_releases = 0;
  syrnike::desktop_native::RuntimeEvent schedule_failure_event;
  schedule_failure_event.type = syrnike::desktop_native::NativeEventType::Reply;
  schedule_failure_event.sequence = 91;
  schedule_failure_event.on_drop = [&] { ++schedule_failure_releases; };
  {
    syrnike::desktop_native::RuntimeEventResourceGuard emitter_fallback(
      schedule_failure_event
    );
    emitter_fallback.attach(schedule_failure_event);
    const auto staged =
      schedule_failure_lane.push(std::move(schedule_failure_event));
    require(
      staged.accepted && staged.schedule_callback,
      "control schedule-failure fixture was not staged"
    );
    schedule_failure_lane.rejectScheduledCallbackAndDiscard(91);
    emitter_fallback.discard();
  }
  require(
    schedule_failure_releases == 1 && schedule_failure_lane.size() == 0,
    "control callback schedule failure double-released or retained its event"
  );

  bool fail_control_store = true;
  syrnike::desktop_native::ControlEventLane throwing_control_lane(
    2,
    std::chrono::milliseconds(20),
    [&] {
      if (!std::exchange(fail_control_store, false)) return;
      throw std::bad_alloc();
    }
  );
  int failed_control_store_releases = 0;
  syrnike::desktop_native::RuntimeEvent allocation_failed_control;
  allocation_failed_control.type = syrnike::desktop_native::NativeEventType::SessionLifecycle;
  allocation_failed_control.on_drop = [&] { ++failed_control_store_releases; };
  bool control_store_threw = false;
  try {
    (void)throwing_control_lane.push(std::move(allocation_failed_control));
  } catch (const std::bad_alloc&) {
    control_store_threw = true;
  }
  require(control_store_threw, "control lane failpoint did not throw");
  require(
    failed_control_store_releases == 1,
    "control lane allocation failure did not release its resource exactly once"
  );
  syrnike::desktop_native::RuntimeEvent after_control_allocation_failure;
  after_control_allocation_failure.type = syrnike::desktop_native::NativeEventType::SessionLifecycle;
  require(
    throwing_control_lane.push(
      std::move(after_control_allocation_failure)
    ).accepted,
    "control lane was corrupted by a failed insertion"
  );
  require(
    throwing_control_lane.beginCallback().size() == 1,
    "control lane retained an orphan after a failed insertion"
  );

  syrnike::desktop_native::RuntimeEvent closed_control;
  closed_control.type = syrnike::desktop_native::NativeEventType::RuntimeError;
  bool closed_control_released = false;
  closed_control.on_drop = [&] { closed_control_released = true; };
  auto closed_control_push = control_lane.push(std::move(closed_control));
  require(
    !closed_control_push.accepted && closed_control_push.rejected != nullptr,
    "closed control lane lost ownership of a rejected event"
  );
  syrnike::desktop_native::discardEvent(*closed_control_push.rejected);
  require(
    closed_control_released,
    "closed control lane leaked a rejected event resource"
  );

  syrnike::desktop_native::CoalescingEventLane media_lane;
  syrnike::desktop_native::RuntimeEvent first_frame;
  first_frame.type = syrnike::desktop_native::NativeEventType::RemoteVideoFrame;
  first_frame.session_id = "voice-a";
  first_frame.generation = 4;
  first_frame.track_id = "camera-a";
  first_frame.sequence = 10;
  bool first_frame_released = false;
  first_frame.on_drop = [&] { first_frame_released = true; };
  auto first_push = media_lane.push(std::move(first_frame));
  require(first_push.accepted, "media lane rejected its first frame");
  require(first_push.schedule_callback, "media lane did not schedule its first drain");
  require(!first_push.discarded, "media lane discarded its first frame");

  syrnike::desktop_native::RuntimeEvent replacement_frame;
  replacement_frame.type = syrnike::desktop_native::NativeEventType::RemoteVideoFrame;
  replacement_frame.session_id = "voice-a";
  replacement_frame.generation = 4;
  replacement_frame.track_id = "camera-a";
  replacement_frame.sequence = 12;
  auto replacement_push = media_lane.push(std::move(replacement_frame));
  require(replacement_push.accepted, "media lane rejected a replacement frame");
  require(!replacement_push.schedule_callback, "media lane scheduled a duplicate drain");
  require(replacement_push.discarded != nullptr, "media lane retained a stale frame");
  syrnike::desktop_native::discardEvent(*replacement_push.discarded);
  require(first_frame_released, "coalesced frame did not release its resource");

  syrnike::desktop_native::RuntimeEvent other_track_frame;
  other_track_frame.type = syrnike::desktop_native::NativeEventType::RemoteVideoFrame;
  other_track_frame.session_id = "voice-a";
  other_track_frame.generation = 4;
  other_track_frame.track_id = "screen-a";
  other_track_frame.sequence = 11;
  auto other_push = media_lane.push(std::move(other_track_frame));
  require(other_push.accepted, "media lane rejected a second track");
  auto latest_frames_batch = media_lane.beginCallback();
  require(latest_frames_batch.active(), "media lane did not start its callback");
  const auto& latest_frames = latest_frames_batch.events();
  require(latest_frames.size() == 2, "media lane did not retain one frame per track");
  require(
    latest_frames[0]->sequence == 11 && latest_frames[1]->sequence == 12,
    "media lane did not drain latest frames in sequence order"
  );
  latest_frames_batch = {};
  media_lane.closeAndDiscard();
  syrnike::desktop_native::RuntimeEvent after_close;
  after_close.type = syrnike::desktop_native::NativeEventType::RemoteVideoFrame;
  after_close.track_id = "camera-a";
  bool closed_frame_released = false;
  after_close.on_drop = [&] { closed_frame_released = true; };
  auto closed_push = media_lane.push(std::move(after_close));
  require(!closed_push.accepted, "closed media lane accepted a frame");
  require(closed_push.discarded != nullptr, "closed media lane lost frame ownership");
  syrnike::desktop_native::discardEvent(*closed_push.discarded);
  require(closed_frame_released, "closed media lane leaked a frame resource");

  syrnike::desktop_native::CoalescingEventLane bounded_media_lane(2);
  int bounded_release_counts[3]{};
  for (int index = 0; index < 3; ++index) {
    syrnike::desktop_native::RuntimeEvent frame;
    frame.type = syrnike::desktop_native::NativeEventType::RemoteVideoFrame;
    frame.track_id = "bounded-track-" + std::to_string(index);
    frame.sequence = static_cast<std::uint64_t>(index + 1);
    frame.on_drop = [&, index] { ++bounded_release_counts[index]; };
    auto pushed = bounded_media_lane.push(std::move(frame));
    if (pushed.discarded) syrnike::desktop_native::discardEvent(*pushed.discarded);
  }
  require(
    bounded_release_counts[0] == 1 && bounded_release_counts[1] == 0 &&
      bounded_release_counts[2] == 0,
    "bounded media lane did not evict the oldest key exactly once"
  );
  auto bounded_batch = bounded_media_lane.beginCallback();
  require(
    bounded_batch.events().size() == 2 &&
      bounded_batch.events()[0]->sequence == 2 &&
      bounded_batch.events()[1]->sequence == 3,
    "bounded media lane retained more than its configured newest keys"
  );

  std::atomic<std::uint64_t> near_exhausted_incarnation{
    (std::numeric_limits<std::uint64_t>::max)() - 1
  };
  require(
    syrnike::desktop_native::claimNextTerminalIncarnation(
      near_exhausted_incarnation
    ) == (std::numeric_limits<std::uint64_t>::max)() &&
      syrnike::desktop_native::claimNextTerminalIncarnation(
        near_exhausted_incarnation
      ) == 0 &&
      syrnike::desktop_native::claimNextTerminalIncarnation(
        near_exhausted_incarnation
      ) == 0,
    "terminal incarnation allocator wrapped after exhaustion"
  );
  std::atomic_int invalid_incarnation_losses{0};
  syrnike::desktop_native::media::AcceptedControlPost invalid_incarnation_post(
    [](syrnike::desktop_native::MediaCommand) { return true; },
    [&](const std::string&) { ++invalid_incarnation_losses; }
  );
  syrnike::desktop_native::MediaCommand invalid_terminal;
  invalid_terminal.type =
    syrnike::desktop_native::NativeCommandType::VoiceTerminal;
  invalid_terminal.terminal_producer =
    syrnike::desktop_native::NativeTerminalProducer::VoiceRoom;
  require(
    !invalid_incarnation_post.postOnce("invalid-incarnation", invalid_terminal),
    "durable control adapter accepted an exhausted terminal incarnation"
  );
  invalid_incarnation_post.close();
  require(
    invalid_incarnation_losses.load() == 1,
    "exhausted terminal incarnation did not trigger typed control loss"
  );

  syrnike::desktop_native::NativeTerminalIncarnationFence candidate_fence;
  require(
    candidate_fence.registerCurrent(
      syrnike::desktop_native::NativeTerminalProducer::VoiceRoom, 40
    ),
    "terminal fence rejected the established owner"
  );
  {
    syrnike::desktop_native::NativeTerminalIncarnationCandidate failed_candidate(
      candidate_fence,
      syrnike::desktop_native::NativeTerminalProducer::VoiceRoom,
      41
    );
    require(
      failed_candidate.incarnation() == 41 &&
        candidate_fence.isCurrent(
          syrnike::desktop_native::NativeTerminalProducer::VoiceRoom, 40
        ),
      "an uncommitted terminal candidate invalidated the active owner"
    );
  }
  syrnike::desktop_native::NativeTerminalIncarnationCandidate committed_candidate(
    candidate_fence,
    syrnike::desktop_native::NativeTerminalProducer::VoiceRoom,
    42
  );
  require(
    committed_candidate.publish() && candidate_fence.isCurrent(
      syrnike::desktop_native::NativeTerminalProducer::VoiceRoom, 42
    ),
    "a committed terminal candidate did not publish its fence"
  );

  syrnike::desktop_native::NativeTerminalIncarnationFence commit_gate_fence;
  require(
    commit_gate_fence.registerCurrent(
      syrnike::desktop_native::NativeTerminalProducer::VoiceRoom, 50
    ),
    "terminal commit gate could not establish the fallback owner"
  );
  syrnike::desktop_native::NativeTerminalCommitGate buffered_terminal(
    commit_gate_fence,
    syrnike::desktop_native::NativeTerminalProducer::VoiceRoom,
    51
  );
  syrnike::desktop_native::MediaCommand early_terminal;
  early_terminal.type =
    syrnike::desktop_native::NativeCommandType::VoiceTerminal;
  early_terminal.terminal_producer =
    syrnike::desktop_native::NativeTerminalProducer::VoiceRoom;
  early_terminal.terminal_incarnation = 51;
  require(
    !buffered_terminal.submit(std::move(early_terminal)).has_value() &&
      commit_gate_fence.isCurrent(
        syrnike::desktop_native::NativeTerminalProducer::VoiceRoom, 50
      ),
    "a pre-commit terminal escaped or invalidated the fallback owner"
  );
  auto released_terminal = buffered_terminal.publish();
  require(
    released_terminal && released_terminal->terminal_incarnation == 51 &&
      commit_gate_fence.isCurrent(
        syrnike::desktop_native::NativeTerminalProducer::VoiceRoom, 51
      ) &&
      !commit_gate_fence.isCurrent(
        syrnike::desktop_native::NativeTerminalProducer::VoiceRoom, 50
      ),
    "commit did not atomically publish and release the buffered terminal"
  );
  syrnike::desktop_native::NativeTerminalCommitGate rolled_back_terminal(
    commit_gate_fence,
    syrnike::desktop_native::NativeTerminalProducer::VoiceRoom,
    52
  );
  syrnike::desktop_native::MediaCommand abandoned_terminal;
  abandoned_terminal.type =
    syrnike::desktop_native::NativeCommandType::VoiceTerminal;
  abandoned_terminal.terminal_incarnation = 52;
  require(
    !rolled_back_terminal.submit(std::move(abandoned_terminal)).has_value(),
    "an uncommitted candidate terminal escaped its gate"
  );
  rolled_back_terminal.cancel();
  require(
    !rolled_back_terminal.publish().has_value() &&
      commit_gate_fence.isCurrent(
        syrnike::desktop_native::NativeTerminalProducer::VoiceRoom, 51
      ),
    "candidate rollback published or released its quarantined terminal"
  );

  auto allocation_failure_sink = std::make_shared<AllocationFailingSink>();
  syrnike::desktop_native::SequencedEmitter allocation_failure_emitter(
    allocation_failure_sink
  );
  syrnike::desktop_native::media::AcceptedControlLossEscalation
    allocation_independent_loss;
  std::atomic_int recycle_requests{0};
  allocation_independent_loss.signal(
    allocation_failure_emitter,
    [](void* context) noexcept {
      static_cast<std::atomic_int*>(context)->fetch_add(
        1, std::memory_order_relaxed
      );
    },
    &recycle_requests
  );
  allocation_independent_loss.signal(
    allocation_failure_emitter,
    [](void* context) noexcept {
      static_cast<std::atomic_int*>(context)->fetch_add(
        1, std::memory_order_relaxed
      );
    },
    &recycle_requests
  );
  require(
    recycle_requests.load() == 1,
    "accepted-control loss did not request one allocation-independent recycle"
  );

  std::atomic_int durable_attempts{0};
  std::atomic_int durable_accepts{0};
  std::atomic_int durable_losses{0};
  syrnike::desktop_native::media::AcceptedControlPost durable_post(
    [&](syrnike::desktop_native::MediaCommand) {
      const auto attempt = ++durable_attempts;
      if (attempt == 1) throw std::bad_alloc();
      if (attempt < 3) return false;
      ++durable_accepts;
      return true;
    },
    [&](const std::string&) { ++durable_losses; },
    {
      std::chrono::milliseconds(1),
      std::chrono::milliseconds(100),
      2,
    }
  );
  syrnike::desktop_native::MediaCommand terminal_command;
  terminal_command.type = syrnike::desktop_native::NativeCommandType::VoiceTerminal;
  terminal_command.terminal_producer =
    syrnike::desktop_native::NativeTerminalProducer::VoiceRoom;
  terminal_command.session_id = "voice-durable";
  terminal_command.generation = 7;
  terminal_command.terminal_incarnation = 1;
  require(
    durable_post.postOnce("voice-durable:7", terminal_command) &&
      durable_post.postOnce("voice-durable:7", terminal_command),
    "durable control adapter rejected a pending duplicate"
  );
  const auto durable_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (durable_accepts.load() == 0 &&
         std::chrono::steady_clock::now() < durable_deadline) {
    std::this_thread::yield();
  }
  durable_post.close();
  require(
    durable_attempts.load() == 3 && durable_accepts.load() == 1 &&
      durable_losses.load() == 0,
    "durable control adapter did not retry and accept exactly once"
  );

  std::atomic_int historical_accepts{0};
  syrnike::desktop_native::media::AcceptedControlPost historical_post(
    [&](syrnike::desktop_native::MediaCommand) {
      ++historical_accepts;
      return true;
    },
    [](const std::string&) {},
    {
      std::chrono::milliseconds(1),
      std::chrono::milliseconds(100),
      16,
    }
  );
  for (std::uint64_t generation = 1; generation <= 20; ++generation) {
    syrnike::desktop_native::MediaCommand historical_terminal;
    historical_terminal.type =
      syrnike::desktop_native::NativeCommandType::VoiceTerminal;
    historical_terminal.terminal_producer =
      syrnike::desktop_native::NativeTerminalProducer::VoiceRoom;
    historical_terminal.session_id = "voice-history";
    historical_terminal.generation = generation;
    historical_terminal.internal_epoch = generation;
    historical_terminal.terminal_incarnation = generation + 1;
    require(
      historical_post.postOnce(
        "voice-history:" + std::to_string(generation), historical_terminal
      ),
      "durable control adapter rejected a new terminal generation"
    );
    const auto accepted_deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (historical_accepts.load() < static_cast<int>(generation) &&
           std::chrono::steady_clock::now() < accepted_deadline) {
      std::this_thread::yield();
    }
    require(
      historical_accepts.load() == static_cast<int>(generation),
      "durable control adapter did not accept a terminal generation"
    );
  }
  syrnike::desktop_native::MediaCommand quarantined_duplicate;
  quarantined_duplicate.type =
    syrnike::desktop_native::NativeCommandType::VoiceTerminal;
  quarantined_duplicate.terminal_producer =
    syrnike::desktop_native::NativeTerminalProducer::VoiceRoom;
  quarantined_duplicate.session_id = "voice-history";
  quarantined_duplicate.generation = 1;
  quarantined_duplicate.internal_epoch = 1;
  quarantined_duplicate.terminal_incarnation = 2;
  require(
    historical_post.postOnce(
      "late-quarantine:voice-history:1", quarantined_duplicate
    ),
    "durable control adapter rejected a stale accepted duplicate"
  );
  const auto duplicate_deadline =
    std::chrono::steady_clock::now() + std::chrono::milliseconds(50);
  while (historical_accepts.load() == 20 &&
         std::chrono::steady_clock::now() < duplicate_deadline) {
    std::this_thread::yield();
  }
  require(
    historical_accepts.load() == 20,
    "durable control adapter re-dispatched a late quarantined duplicate"
  );
  syrnike::desktop_native::MediaCommand next_session_terminal;
  next_session_terminal.type =
    syrnike::desktop_native::NativeCommandType::VoiceTerminal;
  next_session_terminal.terminal_producer =
    syrnike::desktop_native::NativeTerminalProducer::VoiceRoom;
  next_session_terminal.session_id = "voice-next-session";
  next_session_terminal.generation = 1;
  next_session_terminal.internal_epoch = 1;
  next_session_terminal.terminal_incarnation = 22;
  require(
    historical_post.postOnce(
      "voice-next-session:1", next_session_terminal
    ),
    "durable control adapter rejected a distinct terminal session"
  );
  const auto next_session_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (historical_accepts.load() < 21 &&
         std::chrono::steady_clock::now() < next_session_deadline) {
    std::this_thread::yield();
  }
  require(
    historical_accepts.load() == 21,
    "durable control adapter suppressed a distinct terminal session"
  );
  syrnike::desktop_native::MediaCommand third_session_terminal;
  third_session_terminal.type =
    syrnike::desktop_native::NativeCommandType::VoiceTerminal;
  third_session_terminal.terminal_producer =
    syrnike::desktop_native::NativeTerminalProducer::VoiceRoom;
  third_session_terminal.session_id = "voice-third-session";
  third_session_terminal.generation = 1;
  third_session_terminal.internal_epoch = 1;
  third_session_terminal.terminal_incarnation = 23;
  require(
    historical_post.postOnce(
      "voice-third-session:1", third_session_terminal
    ),
    "durable control adapter rejected a third terminal session"
  );
  const auto third_session_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (historical_accepts.load() < 22 &&
         std::chrono::steady_clock::now() < third_session_deadline) {
    std::this_thread::yield();
  }
  require(
    historical_accepts.load() == 22,
    "durable control adapter suppressed a third terminal session"
  );
  quarantined_duplicate.generation = 20;
  quarantined_duplicate.internal_epoch = 20;
  quarantined_duplicate.terminal_incarnation = 21;
  require(
    historical_post.postOnce(
      "late-quarantine:voice-history:20", quarantined_duplicate
    ),
    "durable control adapter rejected an old-session duplicate"
  );
  const auto old_session_deadline =
    std::chrono::steady_clock::now() + std::chrono::milliseconds(50);
  while (historical_accepts.load() == 22 &&
         std::chrono::steady_clock::now() < old_session_deadline) {
    std::this_thread::yield();
  }
  require(
    historical_accepts.load() == 22,
    "durable control adapter re-dispatched an old-session duplicate"
  );
  syrnike::desktop_native::MediaCommand current_session_terminal;
  current_session_terminal.type =
    syrnike::desktop_native::NativeCommandType::VoiceTerminal;
  current_session_terminal.terminal_producer =
    syrnike::desktop_native::NativeTerminalProducer::VoiceRoom;
  current_session_terminal.session_id = "voice-current-session";
  current_session_terminal.generation = 1;
  current_session_terminal.internal_epoch = 1;
  current_session_terminal.terminal_incarnation = 24;
  require(
    historical_post.postOnce(
      "voice-current-session:1", current_session_terminal
    ),
    "durable control adapter rejected the current terminal session"
  );
  const auto current_session_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (historical_accepts.load() < 23 &&
         std::chrono::steady_clock::now() < current_session_deadline) {
    std::this_thread::yield();
  }
  syrnike::desktop_native::MediaCommand microphone_terminal;
  microphone_terminal.type =
    syrnike::desktop_native::NativeCommandType::MicrophoneTerminal;
  microphone_terminal.terminal_producer =
    syrnike::desktop_native::NativeTerminalProducer::MicrophoneCapture;
  microphone_terminal.terminal_incarnation = 30;
  require(
    historical_post.postOnce("microphone-shared-key", microphone_terminal),
    "durable control adapter rejected a microphone capture terminal"
  );
  const auto microphone_capture_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (historical_accepts.load() < 24 &&
         std::chrono::steady_clock::now() < microphone_capture_deadline) {
    std::this_thread::yield();
  }
  microphone_terminal.terminal_producer =
    syrnike::desktop_native::NativeTerminalProducer::MicrophonePublication;
  microphone_terminal.terminal_incarnation = 29;
  require(
    historical_post.postOnce("microphone-shared-key", microphone_terminal),
    "durable control adapter rejected a microphone publication terminal"
  );
  const auto microphone_publication_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (historical_accepts.load() < 25 &&
         std::chrono::steady_clock::now() < microphone_publication_deadline) {
    std::this_thread::yield();
  }
  historical_post.close();
  require(
    historical_accepts.load() == 25,
    "durable control adapter conflated independent terminal producers"
  );

  std::atomic_bool ordered_post_entered{false};
  std::atomic_bool release_ordered_post{false};
  std::atomic_int ordered_accepts{0};
  syrnike::desktop_native::media::AcceptedControlPost ordered_post(
    [&](syrnike::desktop_native::MediaCommand) {
      ordered_post_entered.store(true, std::memory_order_release);
      while (!release_ordered_post.load(std::memory_order_acquire)) {
        std::this_thread::yield();
      }
      ++ordered_accepts;
      return true;
    },
    [](const std::string&) {},
    {
      std::chrono::milliseconds(1),
      std::chrono::milliseconds(100),
      2,
    }
  );
  syrnike::desktop_native::MediaCommand newer_terminal;
  newer_terminal.type =
    syrnike::desktop_native::NativeCommandType::VoiceTerminal;
  newer_terminal.terminal_producer =
    syrnike::desktop_native::NativeTerminalProducer::VoiceRoom;
  newer_terminal.terminal_incarnation = 10;
  require(
    ordered_post.postOnce("voice-order:10", newer_terminal),
    "durable control adapter rejected a newer pending incarnation"
  );
  const auto entered_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (!ordered_post_entered.load(std::memory_order_acquire) &&
         std::chrono::steady_clock::now() < entered_deadline) {
    std::this_thread::yield();
  }
  syrnike::desktop_native::MediaCommand older_terminal = newer_terminal;
  older_terminal.terminal_incarnation = 9;
  require(
    ordered_post.postOnce("voice-order:9", older_terminal),
    "durable control adapter rejected a stale pending incarnation"
  );
  release_ordered_post.store(true, std::memory_order_release);
  const auto ordered_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (ordered_accepts.load() < 2 &&
         std::chrono::steady_clock::now() < ordered_deadline) {
    std::this_thread::yield();
  }
  ordered_post.close();
  require(
    ordered_accepts.load() == 1,
    "durable control adapter dispatched an out-of-order stale incarnation"
  );

  std::atomic_bool superseded_deadline_entered{false};
  std::atomic_bool release_superseded_deadline{false};
  std::atomic_uint64_t superseded_deadline_accept{0};
  std::atomic_int superseded_deadline_losses{0};
  syrnike::desktop_native::media::AcceptedControlPost superseded_deadline_post(
    [&](syrnike::desktop_native::MediaCommand command) {
      if (command.terminal_incarnation == 50) {
        superseded_deadline_entered.store(true, std::memory_order_release);
        while (!release_superseded_deadline.load(std::memory_order_acquire)) {
          std::this_thread::yield();
        }
        return false;
      }
      superseded_deadline_accept.store(
        command.terminal_incarnation, std::memory_order_release
      );
      return true;
    },
    [&](const std::string&) { ++superseded_deadline_losses; },
    {
      std::chrono::milliseconds(1),
      std::chrono::milliseconds(5),
      2,
    }
  );
  syrnike::desktop_native::MediaCommand superseded_deadline_terminal;
  superseded_deadline_terminal.type =
    syrnike::desktop_native::NativeCommandType::VoiceTerminal;
  superseded_deadline_terminal.terminal_producer =
    syrnike::desktop_native::NativeTerminalProducer::VoiceRoom;
  superseded_deadline_terminal.terminal_incarnation = 50;
  require(
    superseded_deadline_post.postOnce(
      "superseded-deadline:50", superseded_deadline_terminal
    ),
    "durable control adapter rejected the deadline blocker"
  );
  const auto superseded_entered_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (!superseded_deadline_entered.load(std::memory_order_acquire) &&
         std::chrono::steady_clock::now() < superseded_entered_deadline) {
    std::this_thread::yield();
  }
  superseded_deadline_terminal.terminal_incarnation = 51;
  require(
    superseded_deadline_post.postOnce(
      "superseded-deadline:51", superseded_deadline_terminal
    ),
    "durable control adapter rejected the superseding incarnation"
  );
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
  release_superseded_deadline.store(true, std::memory_order_release);
  const auto superseded_accept_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (superseded_deadline_accept.load(std::memory_order_acquire) == 0 &&
         std::chrono::steady_clock::now() < superseded_accept_deadline) {
    std::this_thread::yield();
  }
  superseded_deadline_post.close();
  require(
    superseded_deadline_accept.load() == 51 &&
      superseded_deadline_losses.load() == 0,
    "a superseded deadline triggered loss before dispatching its replacement"
  );

  std::atomic_bool restart_blocker_entered{false};
  std::atomic_bool release_restart_blocker{false};
  std::atomic_bool old_restart_dispatched{false};
  std::atomic_uint64_t accepted_restart_incarnation{0};
  syrnike::desktop_native::NativeTerminalIncarnationFence restart_fence;
  syrnike::desktop_native::media::AcceptedControlPost restart_post(
    [&](syrnike::desktop_native::MediaCommand command) {
      if (command.terminal_incarnation == 8) {
        restart_blocker_entered.store(true, std::memory_order_release);
        while (!release_restart_blocker.load(std::memory_order_acquire)) {
          std::this_thread::yield();
        }
      }
      if (!restart_fence.isCurrent(
            command.terminal_producer, command.terminal_incarnation
          )) {
        return true;
      }
      if (command.terminal_incarnation == 9) {
        old_restart_dispatched.store(true, std::memory_order_release);
      }
      accepted_restart_incarnation.store(
        command.terminal_incarnation, std::memory_order_release
      );
      return true;
    },
    [](const std::string&) {},
    {
      std::chrono::milliseconds(1),
      std::chrono::milliseconds(100),
      3,
    }
  );
  syrnike::desktop_native::MediaCommand restart_terminal;
  restart_terminal.type =
    syrnike::desktop_native::NativeCommandType::VoiceTerminal;
  restart_terminal.terminal_producer =
    syrnike::desktop_native::NativeTerminalProducer::VoiceRoom;
  restart_terminal.terminal_incarnation = 8;
  restart_fence.registerCurrent(
    restart_terminal.terminal_producer, restart_terminal.terminal_incarnation
  );
  require(
    restart_post.postOnce("restart-blocker", restart_terminal),
    "durable control adapter rejected the restart blocker"
  );
  const auto restart_entered_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (!restart_blocker_entered.load(std::memory_order_acquire) &&
         std::chrono::steady_clock::now() < restart_entered_deadline) {
    std::this_thread::yield();
  }
  restart_terminal.terminal_incarnation = 9;
  restart_fence.registerCurrent(
    restart_terminal.terminal_producer, restart_terminal.terminal_incarnation
  );
  require(
    restart_post.postOnce("same-terminal-key", restart_terminal),
    "durable control adapter rejected the old restart incarnation"
  );
  restart_terminal.terminal_incarnation = 10;
  restart_fence.registerCurrent(
    restart_terminal.terminal_producer, restart_terminal.terminal_incarnation
  );
  require(
    restart_post.postOnce("same-terminal-key", restart_terminal),
    "durable control adapter rejected the new restart incarnation"
  );
  release_restart_blocker.store(true, std::memory_order_release);
  const auto restart_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (accepted_restart_incarnation.load(std::memory_order_acquire) == 0 &&
         std::chrono::steady_clock::now() < restart_deadline) {
    std::this_thread::yield();
  }
  restart_post.close();
  require(
    accepted_restart_incarnation.load() == 10 &&
      !old_restart_dispatched.load(),
    "durable control adapter suppressed a newer same-key restart"
  );

  std::atomic_int exhausted_losses{0};
  syrnike::desktop_native::media::AcceptedControlPost exhausted_post(
    [](syrnike::desktop_native::MediaCommand) { return false; },
    [&](const std::string& key) {
      if (key == "voice-exhausted:9") ++exhausted_losses;
    },
    {
      std::chrono::milliseconds(1),
      std::chrono::milliseconds(10),
      1,
    }
  );
  terminal_command.session_id = "voice-exhausted";
  terminal_command.generation = 9;
  require(
    exhausted_post.postOnce("voice-exhausted:9", terminal_command),
    "durable control adapter rejected available bounded capacity"
  );
  const auto exhaustion_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (exhausted_losses.load() == 0 &&
         std::chrono::steady_clock::now() < exhaustion_deadline) {
    std::this_thread::yield();
  }
  exhausted_post.close();
  require(
    exhausted_losses.load() == 1,
    "durable control adapter did not escalate an expired control event"
  );

  std::atomic_int self_closed_losses{0};
  syrnike::desktop_native::media::AcceptedControlPost* self_closing_ptr =
    nullptr;
  syrnike::desktop_native::media::AcceptedControlPost self_closing_post(
    [](syrnike::desktop_native::MediaCommand) { return false; },
    [&](const std::string&) {
      ++self_closed_losses;
      self_closing_ptr->close();
    },
    {
      std::chrono::milliseconds(1),
      std::chrono::milliseconds(5),
      1,
    }
  );
  self_closing_ptr = &self_closing_post;
  require(
    self_closing_post.postOnce("voice-self-close:10", terminal_command),
    "self-closing durable control fixture was rejected"
  );
  const auto self_close_deadline =
    std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (self_closed_losses.load() == 0 &&
         std::chrono::steady_clock::now() < self_close_deadline) {
    std::this_thread::yield();
  }
  self_closing_post.close();
  require(
    self_closed_losses.load() == 1,
    "accepted-control loss could not close itself and join externally"
  );

  syrnike::desktop_native::CoalescingEventLane callback_lane;
  syrnike::desktop_native::RuntimeEvent in_flight_frame;
  in_flight_frame.type = syrnike::desktop_native::NativeEventType::RemoteVideoFrame;
  in_flight_frame.track_id = "camera-in-flight";
  bool in_flight_frame_released = false;
  in_flight_frame.on_drop = [&] { in_flight_frame_released = true; };
  require(
    callback_lane.push(std::move(in_flight_frame)).schedule_callback,
    "media lane did not schedule the callback coordination test"
  );
  std::optional<syrnike::desktop_native::CoalescingEventLane::CallbackBatch>
    in_flight_batch(callback_lane.beginCallback());
  require(
    in_flight_batch->active() && in_flight_batch->deliver() &&
      in_flight_batch->events().size() == 1,
    "media callback did not acquire its in-flight batch"
  );
  std::atomic_bool close_waiting{false};
  std::atomic_bool close_finished{false};
  std::thread lane_close([&] {
    callback_lane.closeAndDiscard();
    close_waiting = true;
    static_cast<void>(callback_lane.waitForInFlightCallbacks(
      std::chrono::seconds(1)
    ));
    close_finished = true;
  });
  while (!close_waiting.load()) std::this_thread::yield();
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
  const bool close_finished_early = close_finished.load();
  syrnike::desktop_native::discardEventBatch(in_flight_batch->events());
  in_flight_batch.reset();
  lane_close.join();
  require(
    !close_finished_early,
    "media lane close did not wait for an acquired callback batch"
  );
  require(close_finished.load(), "media lane close did not resume after callback completion");
  require(in_flight_frame_released, "closed in-flight media batch leaked its resource");

  syrnike::desktop_native::CoalescingEventLane failed_schedule_lane;
  syrnike::desktop_native::RuntimeEvent unscheduled_frame;
  unscheduled_frame.type = syrnike::desktop_native::NativeEventType::RemoteVideoFrame;
  unscheduled_frame.track_id = "camera-unscheduled";
  bool unscheduled_frame_released = false;
  unscheduled_frame.on_drop = [&] { unscheduled_frame_released = true; };
  require(
    failed_schedule_lane.push(std::move(unscheduled_frame)).schedule_callback,
    "media lane did not schedule its initial failed callback"
  );
  failed_schedule_lane.cancelScheduledCallbackAndDiscard();
  require(unscheduled_frame_released, "failed media callback scheduling leaked its resource");
  syrnike::desktop_native::RuntimeEvent retry_frame;
  retry_frame.type = syrnike::desktop_native::NativeEventType::RemoteVideoFrame;
  retry_frame.track_id = "camera-unscheduled";
  require(
    failed_schedule_lane.push(std::move(retry_frame)).schedule_callback,
    "failed media callback scheduling left the lane permanently scheduled"
  );

  bool fail_media_store = true;
  syrnike::desktop_native::CoalescingEventLane throwing_media_lane([&] {
    if (!std::exchange(fail_media_store, false)) return;
    throw std::bad_alloc();
  });
  int failed_store_releases = 0;
  syrnike::desktop_native::RuntimeEvent allocation_failed_frame;
  allocation_failed_frame.type = syrnike::desktop_native::NativeEventType::RemoteVideoFrame;
  allocation_failed_frame.session_id = "voice-allocation";
  allocation_failed_frame.track_id = "camera-allocation";
  allocation_failed_frame.on_drop = [&] { ++failed_store_releases; };
  bool media_store_threw = false;
  try {
    (void)throwing_media_lane.push(std::move(allocation_failed_frame));
  } catch (const std::bad_alloc&) {
    media_store_threw = true;
  }
  require(media_store_threw, "media lane failpoint did not throw");
  require(
    failed_store_releases == 1,
    "media lane allocation failure did not release its resource exactly once"
  );
  syrnike::desktop_native::RuntimeEvent after_allocation_failure;
  after_allocation_failure.type = syrnike::desktop_native::NativeEventType::RemoteVideoFrame;
  after_allocation_failure.session_id = "voice-allocation";
  after_allocation_failure.track_id = "camera-allocation";
  require(
    throwing_media_lane.push(std::move(after_allocation_failure)).accepted,
    "media lane was corrupted by a failed insertion"
  );
  require(
    throwing_media_lane.beginCallback().events().size() == 1,
    "media lane retained an orphan key after a failed insertion"
  );

  syrnike::desktop_native::CoalescingEventLane speaker_lane;
  syrnike::desktop_native::RuntimeEvent first_speakers;
  first_speakers.type = syrnike::desktop_native::NativeEventType::ActiveSpeakers;
  first_speakers.session_id = "voice-speakers";
  first_speakers.generation = 9;
  first_speakers.participant_identities = {"old-speaker"};
  require(
    speaker_lane.push(std::move(first_speakers)).accepted,
    "speaker lane rejected its first state"
  );
  syrnike::desktop_native::RuntimeEvent latest_speakers;
  latest_speakers.type = syrnike::desktop_native::NativeEventType::ActiveSpeakers;
  latest_speakers.session_id = "voice-speakers";
  latest_speakers.generation = 9;
  latest_speakers.participant_identities = {"latest-speaker"};
  const auto speakers_push = speaker_lane.push(std::move(latest_speakers));
  require(
    speakers_push.accepted && speakers_push.discarded != nullptr,
    "speaker lane did not coalesce the same voice epoch"
  );
  auto latest_speaker_callback = speaker_lane.beginCallback();
  const auto& latest_speaker_batch = latest_speaker_callback.events();
  require(
    latest_speaker_batch.size() == 1 &&
      latest_speaker_batch.front()->participant_identities ==
        std::vector<std::string>{"latest-speaker"},
    "speaker lane did not retain the latest voice activity state"
  );

  syrnike::desktop_native::BoundedReleaseLedger release_ledger(2);
  require(
    !release_ledger.remember("track-a", 0, 10) &&
      !release_ledger.remember("", 1, 10) &&
      !release_ledger.remember("track-a", 11, 10),
    "release ledger accepted malformed or unissued frame identities"
  );
  require(
    release_ledger.remember("track-a", 1, 10) &&
      release_ledger.remember("track-b", 2, 10),
    "release ledger rejected valid racing releases"
  );
  require(
    !release_ledger.consume("track-b", 1) &&
      release_ledger.consume("track-a", 1),
    "release ledger allowed a cross-track release"
  );
  require(
    release_ledger.remember("track-b", 1, 10) &&
      release_ledger.consume("track-b", 1),
    "release ledger conflated equal sequences from different tracks"
  );
  require(
    release_ledger.remember("track-c", 3, 10) &&
      release_ledger.remember("track-d", 4, 10) &&
      release_ledger.size() == 2 &&
      !release_ledger.consume("track-b", 2),
    "release ledger did not evict its oldest tombstone at capacity"
  );

  syrnike::hotkeys::InputState input;
  require(input.applyDown("keyboard", "ControlLeft", "Left Ctrl").has_value(), "key down missing");
  require(!input.applyDown("keyboard", "ControlLeft", "Left Ctrl").has_value(), "duplicate key down emitted");
  const auto released = input.applyUp("keyboard", "ControlLeft", "Left Ctrl");
  require(released.has_value(), "key up missing");
  require(released->pressed_codes.empty(), "released key stayed pressed");
  require(syrnike::hotkeys::isInjectedKeyEvent(syrnike::hotkeys::kLlkhfInjected), "injected key flag missed");

  input.applyDown("keyboard", "ShiftLeft", "Left Shift");
  input.reset();
  require(!input.applyUp("keyboard", "ShiftLeft", "Left Shift").has_value(), "reset retained pressed key");
  require(input.applyDown("keyboard", "ShiftLeft", "Left Shift").has_value(), "reset blocked fresh key down");

  syrnike::desktop_native::media::GenerationFence fence;
  fence.set("committed", 4);
  const auto committed = fence.current();
  fence.set("candidate", 5);
  fence.restoreIfCurrent("candidate", 5, committed.first, committed.second);
  require(fence.isCurrent("committed", 4), "candidate rollback lost committed generation");
  fence.set("newer", 6);
  fence.restoreIfCurrent("candidate", 5, committed.first, committed.second);
  require(fence.isCurrent("newer", 6), "stale rollback overwrote newer generation");

  syrnike::desktop_native::media::GenerationFence desired;
  require(desired.advance("active", 7), "initial generation was rejected");
  require(!desired.advance("stale", 6), "generation fence regressed");
  require(desired.isCurrent("active", 7), "stale generation changed current intent");
  require(!desired.advance("collision", 7), "same-generation session collision was accepted");
  require(desired.advance("active", 7), "idempotent generation update was rejected");
  bool committed_current = false;
  require(
    desired.commitIfCurrent("active", 7, [&] { committed_current = true; }),
    "current generation commit was rejected"
  );
  require(committed_current, "current generation commit callback was not executed");
  require(desired.advance("next", 8), "newer generation was rejected");
  bool committed_stale = false;
  require(
    !desired.commitIfCurrent("active", 7, [&] { committed_stale = true; }),
    "stale generation commit was accepted"
  );
  require(!committed_stale, "stale generation commit mutated actor state");
  require(
    !desired.setIfCurrent("active", 7, "__terminal__", 7),
    "stale terminal transition overwrote a newer generation"
  );
  require(
    desired.setIfCurrent("next", 8, "__terminal__", 8),
    "current terminal transition was rejected"
  );
  require(
    desired.isCurrent("__terminal__", 8),
    "terminal transition did not update the current generation atomically"
  );

  const auto redacted = syrnike::desktop_native::diagnostics::redactForDiagnostics(
    "wss://example.com/rtc token=abc123 bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"
  );
  require(
    redacted.find("example.com") == std::string::npos,
    "diagnostic redaction leaked URL host"
  );
  require(
    redacted.find("abc123") == std::string::npos,
    "diagnostic redaction leaked token value"
  );
  require(
    redacted.find("<redacted:url>") != std::string::npos,
    "diagnostic redaction missed URL replacement"
  );
  require(
    redacted.find("<redacted:token>") != std::string::npos,
    "diagnostic redaction missed token replacement"
  );
  require(
    redacted.find("<redacted:jwt>") != std::string::npos,
    "diagnostic redaction missed JWT replacement"
  );
  const auto private_redacted =
    syrnike::desktop_native::diagnostics::redactForDiagnostics(
      "identity='user:123' roomID=secret-room device_id=usb-mic "
      "processPath=C:\\Users\\Alice\\syrnike_media.node"
    );
  require(
    private_redacted.find("user:123") == std::string::npos &&
      private_redacted.find("secret-room") == std::string::npos &&
      private_redacted.find("usb-mic") == std::string::npos,
    "diagnostic redaction leaked private runtime identifiers"
  );
  require(
    private_redacted.find("Alice") == std::string::npos,
    "diagnostic redaction leaked a filesystem path"
  );

  const auto diagnostic_path = std::filesystem::temp_directory_path() /
    (L"syrnike-native-diagnostic-test-" +
     std::to_wstring(static_cast<std::uint64_t>(GetCurrentProcessId())) + L".jsonl");
  std::filesystem::remove(diagnostic_path);
  require(
    SetEnvironmentVariableW(
      L"SYRNIKE_NATIVE_MEDIA_LOG_PATH", diagnostic_path.c_str()
    ) != 0,
    "failed to configure native diagnostic test path"
  );
  require(
    SetEnvironmentVariableW(
      L"SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID", L"native-core-test-run"
    ) != 0,
    "failed to configure native diagnostic test run id"
  );
  SetEnvironmentVariableW(L"SYRNIKE_NATIVE_APP_VERSION", L"0.6.2-test");
  SetEnvironmentVariableW(L"SYRNIKE_NATIVE_RELEASE_CHANNEL", L"test");
  auto& diagnostic_log = syrnike::desktop_native::diagnostics::DiagnosticLog::instance();
  diagnostic_log.initializeForMediaProcess();
  diagnostic_log.write(
    "native_core_test_event",
    {
      {"requestId", "request-1"},
      {"message", "identity=user:123 C:\\Users\\Alice\\runtime.node"},
      {"token", "field-secret"},
      {"deviceId", "private-device"}
    }
  );
  const std::string rotation_payload(4'096, 'x');
  for (std::uint64_t index = 0; index < 3'000; ++index) {
    diagnostic_log.write(
      "native_core_rotation_event",
      {
        {"index", index},
        {"message", rotation_payload}
      }
    );
  }
  // The production logger intentionally bounds its producer queue. Let the
  // writer catch up before the final marker so this assertion tests segment
  // rotation order rather than queue saturation on a slow debug filesystem.
  std::this_thread::sleep_for(std::chrono::milliseconds(250));
  diagnostic_log.write(
    "native_core_rotation_event",
    {
      {"index", std::uint64_t{3'000}},
      {"message", rotation_payload},
      {"actionId", "media-action-a"},
      {"operationId", "operation-a"},
      {"revision", std::uint64_t{4}},
      {"generation", std::uint64_t{7}},
      {"hostEpoch", std::uint64_t{2}},
      {"requestId", "request-a"},
      {"commandStage", "native_worker"},
      {"outcome", "success"}
    }
  );
  diagnostic_log.shutdown();
  require(
    std::filesystem::is_regular_file(diagnostic_path),
    "native diagnostic logger did not use the configured exact path"
  );
  const auto diagnostic_extension = diagnostic_path.extension().wstring();
  const auto diagnostic_stem = diagnostic_path.stem().wstring();
  const auto rolled_diagnostic_path = [&](std::size_t index) {
    return diagnostic_path.parent_path() /
      (diagnostic_stem + L"." + std::to_wstring(index) + diagnostic_extension);
  };
  const std::vector<std::filesystem::path> diagnostic_segments{
    diagnostic_path,
    rolled_diagnostic_path(1),
    rolled_diagnostic_path(2),
  };
  std::string diagnostic_contents;
  for (const auto& segment : diagnostic_segments) {
    std::ifstream segment_stream(segment, std::ios::binary);
    diagnostic_contents.append(
      std::istreambuf_iterator<char>(segment_stream),
      std::istreambuf_iterator<char>()
    );
  }
  require(
    diagnostic_contents.find("native-core-test-run") != std::string::npos,
    "native diagnostic logger ignored the shared run id"
  );
  require(
    diagnostic_contents.find("0.6.2-test") != std::string::npos &&
      diagnostic_contents.find("\"releaseChannel\":\"test\"") != std::string::npos,
    "native diagnostic logger omitted build context"
  );
  require(
    diagnostic_contents.find("user:123") == std::string::npos &&
      diagnostic_contents.find("Alice") == std::string::npos &&
      diagnostic_contents.find("field-secret") == std::string::npos &&
      diagnostic_contents.find("private-device") == std::string::npos,
    "native diagnostic file leaked private values"
  );
  for (const auto& segment : diagnostic_segments) {
    require(
      std::filesystem::is_regular_file(segment),
      "native diagnostic rotation omitted a retained segment"
    );
    require(
      std::filesystem::file_size(segment) <= 5ULL * 1024ULL * 1024ULL,
      "native diagnostic rotation exceeded the per-file bound"
    );
    std::ifstream segment_verification_stream(segment, std::ios::binary);
    const std::string contents{
      std::istreambuf_iterator<char>(segment_verification_stream),
      std::istreambuf_iterator<char>()
    };
    require(
      contents.find("\"role\":\"native\"") != std::string::npos &&
        contents.find("\"runId\":\"native-core-test-run\"") != std::string::npos,
      "native diagnostic rotation lost role or run id continuity"
    );
  }
  std::ifstream latest_diagnostic(diagnostic_path, std::ios::binary);
  const std::string latest_diagnostic_contents{
    std::istreambuf_iterator<char>(latest_diagnostic),
    std::istreambuf_iterator<char>()
  };
  require(
    latest_diagnostic_contents.find("\"index\":3000") != std::string::npos,
    "native diagnostic rotation did not retain the newest event"
  );
  require(
    latest_diagnostic_contents.find("\"actionId\":\"media-action-a\"") !=
        std::string::npos &&
      latest_diagnostic_contents.find("\"operationId\":\"operation-a\"") !=
        std::string::npos &&
      latest_diagnostic_contents.find("\"revision\":4") != std::string::npos &&
      latest_diagnostic_contents.find("\"generation\":7") != std::string::npos &&
      latest_diagnostic_contents.find("\"hostEpoch\":2") != std::string::npos &&
      latest_diagnostic_contents.find("\"requestId\":\"request-a\"") !=
        std::string::npos &&
      latest_diagnostic_contents.find("\"commandStage\":\"native_worker\"") !=
        std::string::npos &&
      latest_diagnostic_contents.find("\"outcome\":\"success\"") !=
        std::string::npos,
    "native diagnostic logger omitted command correlation"
  );
  latest_diagnostic.close();
  std::filesystem::remove(diagnostic_path);
  std::filesystem::remove(rolled_diagnostic_path(1));
  std::filesystem::remove(rolled_diagnostic_path(2));
  SetEnvironmentVariableW(L"SYRNIKE_NATIVE_MEDIA_LOG_PATH", nullptr);
  SetEnvironmentVariableW(L"SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID", nullptr);
  SetEnvironmentVariableW(L"SYRNIKE_NATIVE_APP_VERSION", nullptr);
  SetEnvironmentVariableW(L"SYRNIKE_NATIVE_RELEASE_CHANNEL", nullptr);

  syrnike::voice::RuntimeConfig config;
  const syrnike::desktop_native::MediaCommand default_command;
  require(
    default_command.bypass_system_audio_input_processing,
    "media command bypass did not default to enabled"
  );
  require(
    default_command.automatic_gain_control,
    "media command automatic gain control did not default to enabled"
  );
  require(
    config.bypass_system_audio_input_processing,
    "system audio input processing bypass did not default to enabled"
  );
  require(
    config.automatic_gain_control_enabled,
    "automatic gain control did not default to enabled"
  );
  config.input_volume = 0.75f;
  config.voice_gate_enabled = true;
  config.noise_suppression_enabled = true;
  syrnike::desktop_native::MediaCommand partial;
  partial.voice_gate_enabled = false;
  partial.has_voice_gate_enabled = true;
  const auto merged = syrnike::desktop_native::media::mergeRuntimeConfig(config, partial);
  require(merged.input_volume == 0.75f, "partial config reset input volume");
  require(!merged.voice_gate_enabled, "partial config did not apply voice gate");
  require(merged.noise_suppression_enabled, "partial config reset noise suppression");
  require(
    merged.bypass_system_audio_input_processing,
    "partial config reset system audio input processing bypass"
  );
  require(
    merged.automatic_gain_control_enabled,
    "partial config reset automatic gain control"
  );

  syrnike::desktop_native::MediaCommand audio_processing_patch;
  audio_processing_patch.bypass_system_audio_input_processing = false;
  audio_processing_patch.has_bypass_system_audio_input_processing = true;
  audio_processing_patch.automatic_gain_control = false;
  audio_processing_patch.has_automatic_gain_control = true;
  const auto audio_processing_merged =
    syrnike::desktop_native::media::mergeRuntimeConfig(merged, audio_processing_patch);
  require(
    !audio_processing_merged.bypass_system_audio_input_processing,
    "partial config did not apply system audio input processing bypass"
  );
  require(
    !audio_processing_merged.automatic_gain_control_enabled,
    "partial config did not apply automatic gain control"
  );
  require(
    syrnike::desktop_native::media::microphoneCaptureConfigRequiresRestart(
      merged,
      audio_processing_merged
    ),
    "bypass change did not request a capture stream restart"
  );
  auto agc_only = merged;
  agc_only.automatic_gain_control_enabled = false;
  require(
    !syrnike::desktop_native::media::microphoneCaptureConfigRequiresRestart(
      merged,
      agc_only
    ),
    "AGC change unnecessarily requested a capture stream restart"
  );

  using syrnike::desktop_native::media::canReuseActiveScreenRoom;
  require(canReuseActiveScreenRoom(false, "prepared", 1, "other", 2, false), "idle room connect rejected");
  require(canReuseActiveScreenRoom(true, "active", 7, "active", 7, true), "active owner reuse rejected");
  require(!canReuseActiveScreenRoom(true, "active", 7, "prepared", 8, true), "preconnect stole active room");
  require(!canReuseActiveScreenRoom(true, "active", 7, "active", 8, true), "new generation retagged active room");
  require(!canReuseActiveScreenRoom(true, "active", 7, "active", 7, false), "credentials replaced active room");

  using syrnike::desktop_native::media::isCurrentCaptureFailure;
  require(isCurrentCaptureFailure(4, 4, false, false), "current stopped capture failure ignored");
  require(isCurrentCaptureFailure(4, 4, true, false), "unready capture failure ignored");
  require(!isCurrentCaptureFailure(3, 4, false, false), "old capture failure killed restarted pipeline");
  require(!isCurrentCaptureFailure(4, 4, true, true), "healthy pipeline treated as failed");

  using syrnike::desktop_native::media::MicrophoneCaptureDemand;
  MicrophoneCaptureDemand microphone_demand;
  microphone_demand.setPublication(true, true);
  require(
    microphone_demand.captureRequired(),
    "a connected muted publication did not keep microphone capture warm"
  );
  require(
    !microphone_demand.shouldSendPublicationSamples(),
    "a muted publication still accepted microphone samples"
  );
  microphone_demand.setPreview(true);
  microphone_demand.setPreview(false);
  require(
    microphone_demand.captureRequired(),
    "ending preview incorrectly released a connected muted publication"
  );
  microphone_demand.setMuted(false);
  require(
    microphone_demand.captureRequired() &&
      microphone_demand.shouldSendPublicationSamples(),
    "unmute did not resume samples on the existing capture demand"
  );
  microphone_demand.setPublication(false, false);
  microphone_demand.setPreview(true);
  require(
    microphone_demand.captureRequired() &&
      !microphone_demand.shouldSendPublicationSamples(),
    "preview-only demand was coupled to publication sample delivery"
  );
  microphone_demand.setPreview(false);
  require(
    !microphone_demand.captureRequired(),
    "a genuinely idle microphone retained capture demand"
  );
  microphone_demand.setPublication(true, true);
  microphone_demand.reset();
  require(
    !microphone_demand.captureRequired() &&
      !microphone_demand.shouldSendPublicationSamples(),
    "microphone shutdown did not clear capture and sample demand"
  );
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
