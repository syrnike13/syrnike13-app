#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

#include "media_contention_protocol_writer.hpp"

namespace {

using namespace std::chrono_literals;
using syrnike::desktop_native::tests::BoundedProtocolWriter;
using syrnike::desktop_native::tests::ProtocolRecordAdmission;
using syrnike::desktop_native::tests::ProtocolRecordPriority;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void blockedPipeIsCancelledWithinTheShutdownDeadline() {
  std::mutex mutex;
  std::condition_variable changed;
  bool entered = false;
  bool cancelled = false;
  std::atomic_uint64_t cancels{0};
  BoundedProtocolWriter writer(
      [&](std::string_view) {
        std::unique_lock lock(mutex);
        entered = true;
        changed.notify_all();
        changed.wait(lock, [&] { return cancelled; });
        return false;
      },
      8,
      2,
      [&](std::thread::native_handle_type) {
        {
          std::lock_guard lock(mutex);
          cancelled = true;
        }
        ++cancels;
        changed.notify_all();
      });
  require(
      writer.enqueue("RUNTIME_READY {}", ProtocolRecordPriority::Control) ==
          ProtocolRecordAdmission::Accepted,
      "control record was not admitted");
  {
    std::unique_lock lock(mutex);
    require(
        changed.wait_for(lock, 1s, [&] { return entered; }),
        "writer did not enter the injected blocking pipe");
  }
  const auto started = std::chrono::steady_clock::now();
  require(
      writer.closeUntil(started + 25ms),
      "blocked writer did not stop after cancellation");
  require(
      std::chrono::steady_clock::now() - started < 300ms,
      "blocked writer exceeded its bounded shutdown budget");
  require(cancels.load() == 1, "blocked writer cancellation was not exact once");
}

void frameTelemetryCannotConsumeReservedControlCapacity() {
  std::mutex mutex;
  std::condition_variable changed;
  bool first_entered = false;
  bool release_writer = false;
  BoundedProtocolWriter writer(
      [&](std::string_view) {
        std::unique_lock lock(mutex);
        first_entered = true;
        changed.notify_all();
        changed.wait(lock, [&] { return release_writer; });
        return true;
      },
      4,
      2,
      [&](std::thread::native_handle_type) {
        {
          std::lock_guard lock(mutex);
          release_writer = true;
        }
        changed.notify_all();
      });
  require(
      writer.enqueue("control-0", ProtocolRecordPriority::Control) ==
          ProtocolRecordAdmission::Accepted,
      "initial control record was not admitted");
  {
    std::unique_lock lock(mutex);
    require(
        changed.wait_for(lock, 1s, [&] { return first_entered; }),
        "writer did not enter the saturation gate");
  }
  require(
      writer.enqueue("frame-1", ProtocolRecordPriority::Frame) ==
          ProtocolRecordAdmission::Accepted &&
          writer.enqueue("frame-2", ProtocolRecordPriority::Frame) ==
              ProtocolRecordAdmission::Accepted &&
          writer.enqueue("frame-3", ProtocolRecordPriority::Frame) ==
              ProtocolRecordAdmission::FrameDropped,
      "frame traffic consumed the reserved control capacity");
  require(
      writer.enqueue("control-1", ProtocolRecordPriority::Control) ==
          ProtocolRecordAdmission::Accepted &&
          writer.enqueue("control-2", ProtocolRecordPriority::Control) ==
              ProtocolRecordAdmission::Accepted &&
          writer.enqueue("control-overflow", ProtocolRecordPriority::Control) ==
              ProtocolRecordAdmission::ControlSaturated,
      "control saturation was not explicit at the fixed queue bound");
  const auto snapshot = writer.snapshot();
  require(
      snapshot.queued == 4 && snapshot.frame_drops == 1 &&
          snapshot.control_saturations == 1,
      "writer saturation counters lost an admitted or rejected record");
  {
    std::lock_guard lock(mutex);
    release_writer = true;
  }
  changed.notify_all();
  require(
      writer.closeUntil(std::chrono::steady_clock::now() + 1s),
      "saturated writer did not drain at shutdown");
}

}  // namespace

int main() try {
  blockedPipeIsCancelledWithinTheShutdownDeadline();
  frameTelemetryCannotConsumeReservedControlCapacity();
  std::cout << "media contention protocol writer tests passed\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
