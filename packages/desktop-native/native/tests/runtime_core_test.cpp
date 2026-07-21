#include <iostream>
#include <windows.h>

#include <atomic>
#include <chrono>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iterator>
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
#include "common/coalescing_event_lane.hpp"
#include "common/diagnostic_log.hpp"
#include "common/sequenced_emitter.hpp"
#include "hooks/input_state.hpp"
#include "hooks/key_codes.hpp"
#include "media/generation_fence.hpp"
#include "media/capture_lifecycle_invariants.hpp"
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

bool throwingControlSinkFailsClosed() {
  std::wstring executable(MAX_PATH, L'\0');
  const auto length = GetModuleFileNameW(
    nullptr,
    executable.data(),
    static_cast<DWORD>(executable.size())
  );
  if (length == 0 || length >= executable.size()) return false;
  executable.resize(length);
  std::wstring command = L"\"" + executable + L"\" --throwing-control-sink";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(
        nullptr,
        command.data(),
        nullptr,
        nullptr,
        FALSE,
        CREATE_NO_WINDOW,
        nullptr,
        nullptr,
        &startup,
        &process
      )) {
    return false;
  }
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = 0;
  const bool read_exit = GetExitCodeProcess(process.hProcess, &exit_code) != FALSE;
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  return read_exit && exit_code == 86;
}

bool rejectedEventReleasesOnce() {
  wchar_t executable_buffer[MAX_PATH]{};
  const auto length = GetModuleFileNameW(nullptr, executable_buffer, MAX_PATH);
  if (length == 0 || length >= MAX_PATH) return false;
  const std::wstring executable(executable_buffer, length);
  const auto marker = std::filesystem::temp_directory_path() /
    ("syrnike-event-release-" + std::to_string(GetCurrentProcessId()) + ".txt");
  std::error_code ignored;
  std::filesystem::remove(marker, ignored);
  std::wstring command = L"\"" + executable +
    L"\" --rejecting-resource-sink \"" + marker.wstring() + L"\"";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(
        nullptr,
        command.data(),
        nullptr,
        nullptr,
        FALSE,
        CREATE_NO_WINDOW,
        nullptr,
        nullptr,
        &startup,
        &process
      )) {
    return false;
  }
  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = 0;
  const bool read_exit = GetExitCodeProcess(process.hProcess, &exit_code) != FALSE;
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  std::ifstream input(marker, std::ios::binary);
  const std::string releases{
    std::istreambuf_iterator<char>(input),
    std::istreambuf_iterator<char>()
  };
  input.close();
  std::filesystem::remove(marker, ignored);
  return read_exit && exit_code == 86 && releases == "x";
}

}  // namespace

int main(int argc, char** argv) try {
  if (argc == 2 && std::string(argv[1]) == "--throwing-control-sink") {
    std::set_terminate([] { ExitProcess(86); });
    auto throwing_sink = std::make_shared<ThrowingSink>();
    syrnike::desktop_native::SequencedEmitter throwing_emitter(throwing_sink);
    syrnike::desktop_native::RuntimeEvent event;
    event.type = "sessionLifecycle";
    throwing_emitter.emit(std::move(event));
    return 1;
  }
  if (argc == 3 && std::string(argv[1]) == "--rejecting-resource-sink") {
    std::set_terminate([] { ExitProcess(86); });
    auto rejecting_sink = std::make_shared<RejectingSink>();
    syrnike::desktop_native::SequencedEmitter rejecting_emitter(rejecting_sink);
    syrnike::desktop_native::RuntimeEvent event;
    event.type = "sessionLifecycle";
    const std::filesystem::path marker(argv[2]);
    event.on_drop = [marker] {
      std::ofstream output(marker, std::ios::binary | std::ios::app);
      output << 'x';
    };
    rejecting_emitter.emit(std::move(event));
    return 1;
  }
  using syrnike::desktop_native::BoundedQueue;

  require(
    throwingControlSinkFailsClosed(),
    "throwing control sink did not fail-close the utility process"
  );
  require(
    rejectedEventReleasesOnce(),
    "rejected event resource was not released exactly once before fail-close"
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
        event.type = "test";
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

  event_sink->block_next_emit.store(true);
  std::thread final_emit([&] {
    syrnike::desktop_native::RuntimeEvent event;
    event.type = "test";
    emitter.emit(std::move(event));
  });
  while (!event_sink->blocked_emit_entered.load()) std::this_thread::yield();
  std::thread close_thread([&] { emitter.close(); });
  std::this_thread::sleep_for(std::chrono::milliseconds(1));
  event_sink->release_blocked_emit.store(true);
  final_emit.join();
  close_thread.join();
  require(!event_sink->concurrent_close.load(), "event sink close raced with emit");

  syrnike::desktop_native::RuntimeEvent control_event;
  control_event.type = "sessionLifecycle";
  require(
    syrnike::desktop_native::eventLane(control_event) ==
      syrnike::desktop_native::EventLane::control,
    "lifecycle event did not use the lossless control lane"
  );
  syrnike::desktop_native::RuntimeEvent media_event;
  media_event.type = "remoteVideoFrame";
  require(
    syrnike::desktop_native::eventLane(media_event) ==
      syrnike::desktop_native::EventLane::media,
    "video frame did not use the lossy media lane"
  );
  syrnike::desktop_native::RuntimeEvent active_speakers_event;
  active_speakers_event.type = "activeSpeakers";
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
  telemetry_event.type = "microphoneMetrics";
  require(
    syrnike::desktop_native::eventLane(telemetry_event) ==
      syrnike::desktop_native::EventLane::telemetry,
    "microphone metrics did not use the telemetry lane"
  );

  syrnike::desktop_native::CoalescingEventLane media_lane;
  syrnike::desktop_native::RuntimeEvent first_frame;
  first_frame.type = "remoteVideoFrame";
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
  replacement_frame.type = "remoteVideoFrame";
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
  other_track_frame.type = "remoteVideoFrame";
  other_track_frame.session_id = "voice-a";
  other_track_frame.generation = 4;
  other_track_frame.track_id = "screen-a";
  other_track_frame.sequence = 11;
  auto other_push = media_lane.push(std::move(other_track_frame));
  require(other_push.accepted, "media lane rejected a second track");
  const auto latest_frames = media_lane.take();
  require(latest_frames.size() == 2, "media lane did not retain one frame per track");
  require(
    latest_frames[0]->sequence == 11 && latest_frames[1]->sequence == 12,
    "media lane did not drain latest frames in sequence order"
  );
  media_lane.close();
  syrnike::desktop_native::RuntimeEvent after_close;
  after_close.type = "remoteVideoFrame";
  after_close.track_id = "camera-a";
  bool closed_frame_released = false;
  after_close.on_drop = [&] { closed_frame_released = true; };
  auto closed_push = media_lane.push(std::move(after_close));
  require(!closed_push.accepted, "closed media lane accepted a frame");
  require(closed_push.discarded != nullptr, "closed media lane lost frame ownership");
  syrnike::desktop_native::discardEvent(*closed_push.discarded);
  require(closed_frame_released, "closed media lane leaked a frame resource");

  syrnike::desktop_native::CoalescingEventLane callback_lane;
  syrnike::desktop_native::RuntimeEvent in_flight_frame;
  in_flight_frame.type = "remoteVideoFrame";
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
    auto pending = callback_lane.close();
    syrnike::desktop_native::discardEventBatch(pending);
    close_waiting = true;
    callback_lane.waitForInFlightCallbacks();
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
  unscheduled_frame.type = "remoteVideoFrame";
  unscheduled_frame.track_id = "camera-unscheduled";
  bool unscheduled_frame_released = false;
  unscheduled_frame.on_drop = [&] { unscheduled_frame_released = true; };
  require(
    failed_schedule_lane.push(std::move(unscheduled_frame)).schedule_callback,
    "media lane did not schedule its initial failed callback"
  );
  auto unscheduled = failed_schedule_lane.cancelScheduledCallback();
  syrnike::desktop_native::discardEventBatch(unscheduled);
  require(unscheduled_frame_released, "failed media callback scheduling leaked its resource");
  syrnike::desktop_native::RuntimeEvent retry_frame;
  retry_frame.type = "remoteVideoFrame";
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
  allocation_failed_frame.type = "remoteVideoFrame";
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
  after_allocation_failure.type = "remoteVideoFrame";
  after_allocation_failure.session_id = "voice-allocation";
  after_allocation_failure.track_id = "camera-allocation";
  require(
    throwing_media_lane.push(std::move(after_allocation_failure)).accepted,
    "media lane was corrupted by a failed insertion"
  );
  require(
    throwing_media_lane.take().size() == 1,
    "media lane retained an orphan key after a failed insertion"
  );

  syrnike::desktop_native::CoalescingEventLane speaker_lane;
  syrnike::desktop_native::RuntimeEvent first_speakers;
  first_speakers.type = "activeSpeakers";
  first_speakers.session_id = "voice-speakers";
  first_speakers.generation = 9;
  first_speakers.participant_identities = {"old-speaker"};
  require(
    speaker_lane.push(std::move(first_speakers)).accepted,
    "speaker lane rejected its first state"
  );
  syrnike::desktop_native::RuntimeEvent latest_speakers;
  latest_speakers.type = "activeSpeakers";
  latest_speakers.session_id = "voice-speakers";
  latest_speakers.generation = 9;
  latest_speakers.participant_identities = {"latest-speaker"};
  const auto speakers_push = speaker_lane.push(std::move(latest_speakers));
  require(
    speakers_push.accepted && speakers_push.discarded != nullptr,
    "speaker lane did not coalesce the same voice epoch"
  );
  const auto latest_speaker_batch = speaker_lane.take();
  require(
    latest_speaker_batch.size() == 1 &&
      latest_speaker_batch.front()->participant_identities ==
        std::vector<std::string>{"latest-speaker"},
    "speaker lane did not retain the latest voice activity state"
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
  diagnostic_log.shutdown();
  require(
    std::filesystem::is_regular_file(diagnostic_path),
    "native diagnostic logger did not use the configured exact path"
  );
  std::ifstream diagnostic_file(diagnostic_path, std::ios::binary);
  const std::string diagnostic_contents{
    std::istreambuf_iterator<char>(diagnostic_file),
    std::istreambuf_iterator<char>()
  };
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
  diagnostic_file.close();
  std::filesystem::remove(diagnostic_path);
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
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
