#include <iostream>
#include <windows.h>

#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "common/bounded_queue.hpp"
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

}  // namespace

int main() try {
  using syrnike::desktop_native::BoundedQueue;

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
