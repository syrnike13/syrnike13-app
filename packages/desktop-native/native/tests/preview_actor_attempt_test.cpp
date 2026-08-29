#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

#include "common/cleanup_supervisor.hpp"
#include "common/event_sink.hpp"
#include "common/sequenced_emitter.hpp"
#include "media/audio_constants.hpp"
#include "media/preview_actor.hpp"

namespace {

using namespace std::chrono_literals;

thread_local bool count_realtime_memory = false;
std::atomic_size_t realtime_allocations{0};
std::atomic_size_t realtime_deallocations{0};

class CollectingSink final : public syrnike::desktop_native::EventSink {
 public:
  bool emit(syrnike::desktop_native::RuntimeEvent event) override {
    std::lock_guard lock(mutex_);
    events_.push_back(std::move(event));
    return true;
  }

  void close() override {}

  [[nodiscard]] std::size_t size() const {
    std::lock_guard lock(mutex_);
    return events_.size();
  }

  [[nodiscard]] std::vector<syrnike::desktop_native::RuntimeEvent> events()
      const {
    std::lock_guard lock(mutex_);
    return events_;
  }

 private:
  mutable std::mutex mutex_;
  std::vector<syrnike::desktop_native::RuntimeEvent> events_;
};

class AttemptGate final {
 public:
  std::size_t enter() {
    std::unique_lock lock(mutex_);
    const auto index = entered_++;
    if (index >= released_.size()) {
      throw std::runtime_error("unexpected preview attempt");
    }
    changed_.notify_all();
    changed_.wait(lock, [&] { return released_[index]; });
    ++exited_;
    changed_.notify_all();
    return index;
  }

  bool waitForEntered(std::size_t count) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, 1s, [&] { return entered_ >= count; });
  }

  bool waitForExited(std::size_t count) {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, 1s, [&] { return exited_ >= count; });
  }

  void release(std::size_t index) {
    {
      std::lock_guard lock(mutex_);
      released_.at(index) = true;
    }
    changed_.notify_all();
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  std::array<bool, 2> released_{};
  std::size_t entered_ = 0;
  std::size_t exited_ = 0;
};

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

template <typename Predicate>
bool waitUntil(Predicate predicate, std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    if (predicate()) return true;
    std::this_thread::sleep_for(2ms);
  }
  return predicate();
}

template <typename Operation>
void requireThrows(Operation operation, const char* message) {
  try {
    operation();
  } catch (const std::exception&) {
    return;
  }
  throw std::runtime_error(message);
}

}  // namespace

void* operator new(std::size_t size) {
  if (count_realtime_memory) realtime_allocations.fetch_add(1);
  if (void* allocation = std::malloc(size)) return allocation;
  throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
  if (count_realtime_memory) realtime_allocations.fetch_add(1);
  if (void* allocation = std::malloc(size)) return allocation;
  throw std::bad_alloc();
}

void operator delete(void* allocation) noexcept {
  if (count_realtime_memory) realtime_deallocations.fetch_add(1);
  std::free(allocation);
}

void operator delete[](void* allocation) noexcept {
  if (count_realtime_memory) realtime_deallocations.fetch_add(1);
  std::free(allocation);
}

void operator delete(void* allocation, std::size_t) noexcept {
  if (count_realtime_memory) realtime_deallocations.fetch_add(1);
  std::free(allocation);
}

void operator delete[](void* allocation, std::size_t) noexcept {
  if (count_realtime_memory) realtime_deallocations.fetch_add(1);
  std::free(allocation);
}

int main() try {
  using syrnike::desktop_native::CleanupSupervisor;
  using syrnike::desktop_native::MediaCommand;
  using syrnike::desktop_native::SequencedEmitter;
  using syrnike::desktop_native::media::PreviewActor;

  auto sink = std::make_shared<CollectingSink>();
  SequencedEmitter emitter(sink);
  auto gate = std::make_shared<AttemptGate>();
  const auto cleanup_before = CleanupSupervisor::instance().snapshot();

  PreviewActor preview(emitter, [gate] {
    if (gate->enter() == 0) {
      throw std::runtime_error("late old preview render failure");
    }
  });
  MediaCommand old_start;
  old_start.type = syrnike::desktop_native::NativeCommandType::StartMicrophonePreview;
  old_start.request_id = "preview-old";
  old_start.session_id = "preview";
  old_start.generation = 1;
  const auto old_reply = preview.start(old_start);
  require(old_reply.ok && gate->waitForEntered(1),
          "old preview attempt did not become active");

  const auto stop_started = std::chrono::steady_clock::now();
  preview.stop(old_start, false);
  require(std::chrono::steady_clock::now() - stop_started < 2500ms,
          "timed-out preview stop exceeded its bounded deadline");

  MediaCommand replacement = old_start;
  replacement.request_id = "preview-replacement";
  replacement.generation = 2;
  const auto replacement_reply = preview.start(replacement);
  require(replacement_reply.ok && gate->waitForEntered(2),
          "replacement preview did not start after the old timeout");
  require(replacement_reply.session_id == replacement.session_id &&
              replacement_reply.generation == replacement.generation,
          "old readiness changed the replacement reply identity");
  require(!preview.failFromCapture(
              old_start.session_id,
              old_start.generation,
              "late old capture failure"),
          "old preview generation failed the active replacement");
  const std::array<std::int16_t, 2> late_old_frame{1, -1};
  preview.pushFrame(
      old_start.session_id,
      old_start.generation,
      late_old_frame);
  preview.pushFrame(
      replacement.session_id,
      replacement.generation,
      late_old_frame);
  std::array<
      std::int16_t,
      syrnike::voice::kSamplesPer10Ms> bounded_frame{};
  for (std::size_t frame = 0; frame < 11; ++frame) {
    bounded_frame[0] = static_cast<std::int16_t>(frame);
    preview.pushFrame(
        replacement.session_id,
        replacement.generation,
        bounded_frame);
  }
  const auto queue_metrics = preview.queueMetrics();
  require(
      queue_metrics.accepted_frames == 10 &&
          queue_metrics.dropped_frames == 1 &&
          queue_metrics.invalid_frames == 1 &&
          queue_metrics.queued_frames == 10,
      "preview capture handoff was not fixed-capacity or observable");

  // The old worker exits only after generation 2 is active. Its completion
  // must not satisfy generation 2's finished fence or mutate its lifecycle.
  gate->release(0);
  require(gate->waitForExited(1), "old preview attempt did not resume");

  std::mutex shutdown_mutex;
  std::condition_variable shutdown_changed;
  bool shutdown_returned = false;
  std::thread shutdown([&] {
    preview.shutdown(std::chrono::steady_clock::now() + 100ms);
    {
      std::lock_guard lock(shutdown_mutex);
      shutdown_returned = true;
    }
    shutdown_changed.notify_all();
  });
  bool shutdown_was_bounded = false;
  {
    std::unique_lock lock(shutdown_mutex);
    shutdown_was_bounded = shutdown_changed.wait_for(
        lock, 500ms, [&] { return shutdown_returned; });
  }
  gate->release(1);
  shutdown.join();
  require(shutdown_was_bounded,
          "old worker completion made replacement shutdown join past deadline");
  require(gate->waitForExited(2), "replacement preview attempt did not exit");

  require(waitUntil(
              [&] {
                const auto cleanup = CleanupSupervisor::instance().snapshot();
                return cleanup.owned_jobs == cleanup_before.owned_jobs &&
                    cleanup.completed_jobs == cleanup_before.completed_jobs + 2;
              },
              1s),
          "quarantined preview attempts were not reclaimed exactly once");
  const auto cleanup_after = CleanupSupervisor::instance().snapshot();
  require(cleanup_after.accepted_jobs == cleanup_before.accepted_jobs + 2,
          "preview quarantine did not submit exactly two bounded cleanup jobs");
  require(sink->size() == 0,
          "late preview attempt emitted lifecycle events after replacement");

  const auto bounded_cleanup_before =
      CleanupSupervisor::instance().snapshot();
  auto bounded_gate = std::make_shared<AttemptGate>();
  PreviewActor bounded(emitter, [bounded_gate] {
    static_cast<void>(bounded_gate->enter());
  });
  MediaCommand bounded_old = old_start;
  bounded_old.request_id = "bounded-old";
  bounded_old.generation = 20;
  require(bounded.start(bounded_old).ok && bounded_gate->waitForEntered(1),
          "bounded old preview attempt did not become active");
  bounded.stop(bounded_old, false);

  MediaCommand bounded_replacement = bounded_old;
  bounded_replacement.request_id = "bounded-replacement";
  bounded_replacement.generation = 21;
  require(bounded.start(bounded_replacement).ok &&
              bounded_gate->waitForEntered(2),
          "bounded replacement preview attempt did not become active");

  MediaCommand over_capacity = bounded_replacement;
  over_capacity.request_id = "bounded-over-capacity";
  over_capacity.generation = 22;
  requireThrows(
      [&] { static_cast<void>(bounded.start(over_capacity)); },
      "preview actor exceeded its fixed quarantined-attempt bound");
  bounded_gate->release(0);
  bounded_gate->release(1);
  require(bounded_gate->waitForExited(2),
          "bounded preview attempts did not resume during cleanup");
  bounded.shutdown();
  require(waitUntil(
              [&] {
                const auto cleanup = CleanupSupervisor::instance().snapshot();
                return cleanup.owned_jobs ==
                           bounded_cleanup_before.owned_jobs &&
                    cleanup.completed_jobs ==
                        bounded_cleanup_before.completed_jobs + 2;
              },
              1s),
          "bounded preview cleanup did not reclaim both attempts");
  const auto bounded_cleanup_after =
      CleanupSupervisor::instance().snapshot();
  require(
      bounded_cleanup_after.accepted_jobs ==
          bounded_cleanup_before.accepted_jobs + 2,
      "bounded preview cleanup admitted an unexpected attempt");

  const auto repeated_cleanup_before =
      CleanupSupervisor::instance().snapshot();
  std::atomic_size_t render_attempts{0};
  PreviewActor repeated(emitter, [&] {
    render_attempts.fetch_add(1, std::memory_order_acq_rel);
  });
  MediaCommand previous;
  for (std::uint64_t generation = 10; generation < 18; ++generation) {
    MediaCommand command;
    command.type = syrnike::desktop_native::NativeCommandType::StartMicrophonePreview;
    command.request_id = "repeated-preview";
    command.session_id = "repeated";
    command.generation = generation;
    const auto started = repeated.start(command);
    require(started.ok, "repeated preview attempt did not start");
    if (!previous.session_id.empty()) {
      repeated.pushFrame(
          previous.session_id,
          previous.generation,
          late_old_frame);
      require(!repeated.failFromCapture(
                  previous.session_id,
                  previous.generation,
                  "late repeated capture failure"),
              "late repeated terminal mutated the active generation");
      repeated.stop(previous, false);
    }
    if (generation == 17) {
      require(repeated.failFromCapture(
                  command.session_id,
                  command.generation,
                  "current capture failure"),
              "active repeated generation was lost after stale callbacks");
    } else {
      repeated.stop(command, false);
    }
    previous = command;
  }
  repeated.shutdown();
  repeated.shutdown();

  require(render_attempts.load(std::memory_order_acquire) == 8,
          "repeated preview lifecycle leaked or skipped an attempt");
  const auto repeated_cleanup_after =
      CleanupSupervisor::instance().snapshot();
  require(
      repeated_cleanup_after.accepted_jobs ==
              repeated_cleanup_before.accepted_jobs &&
          repeated_cleanup_after.completed_jobs ==
              repeated_cleanup_before.completed_jobs &&
          repeated_cleanup_after.owned_jobs ==
              repeated_cleanup_before.owned_jobs,
      "cooperative preview restarts leaked into quarantine cleanup");

  std::atomic_bool frame_entered{false};
  std::atomic_bool release_frame{false};
  PreviewActor reclaimed_on_control(
      emitter,
      [] {},
      [&] {
        frame_entered.store(true, std::memory_order_release);
        while (!release_frame.load(std::memory_order_acquire)) {
          std::this_thread::yield();
        }
      });
  MediaCommand reclamation_start;
  reclamation_start.type =
      syrnike::desktop_native::NativeCommandType::StartMicrophonePreview;
  reclamation_start.request_id = "preview-reclamation";
  reclamation_start.session_id = "reclamation";
  reclamation_start.generation = 90;
  require(reclaimed_on_control.start(reclamation_start).ok,
          "preview reclamation attempt did not start");
  realtime_allocations.store(0, std::memory_order_relaxed);
  realtime_deallocations.store(0, std::memory_order_relaxed);
  std::thread realtime_push([&] {
    count_realtime_memory = true;
    reclaimed_on_control.pushFrame(
        reclamation_start.session_id,
        reclamation_start.generation,
        bounded_frame);
    count_realtime_memory = false;
  });
  require(waitUntil(
              [&] { return frame_entered.load(std::memory_order_acquire); },
              1s),
          "preview realtime frame did not acquire the active attempt");
  reclaimed_on_control.stop(reclamation_start, false);
  release_frame.store(true, std::memory_order_release);
  realtime_push.join();
  require(
      realtime_allocations.load(std::memory_order_acquire) == 0 &&
          realtime_deallocations.load(std::memory_order_acquire) == 0,
      "preview attempt ownership was reclaimed on the realtime frame lane");
  reclamation_start.generation = 91;
  require(reclaimed_on_control.start(reclamation_start).ok,
          "preview control lane did not reclaim and replace the retired route");
  reclaimed_on_control.stop(reclamation_start, false);
  reclaimed_on_control.shutdown();
  const auto events = sink->events();
  require(events.size() == 2 && events[0].type == syrnike::desktop_native::NativeEventType::RuntimeError &&
              events[0].generation == 17 &&
              events[1].type == syrnike::desktop_native::NativeEventType::SessionStopped &&
              events[1].generation == 17,
          "stale preview callbacks changed the replacement terminal identity");

  std::cout << "preview attempt isolation tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
