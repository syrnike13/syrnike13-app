#include "probe/window_capture_probe.hpp"

#include <windows.h>
#include <tlhelp32.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <charconv>
#include <condition_variable>
#include <cstdint>
#include <future>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_set>
#include <utility>
#include <vector>

#include "capture/wgc_window_capture.hpp"
#include "capture/window_capture.hpp"
#include "sources/source_registry.hpp"
#include "sources/win32_source_enumerator.hpp"

namespace {

using namespace syrnike::windows_media::capture;
using namespace syrnike::windows_media::sources;
using namespace std::chrono_literals;

constexpr auto kResourceDeadline = 5s;
constexpr std::int64_t kHandleBudget = 4;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

std::string jsonString(const std::string& value) {
  std::ostringstream output;
  output << '"';
  for (const unsigned char character : value) {
    switch (character) {
      case '"': output << "\\\""; break;
      case '\\': output << "\\\\"; break;
      case '\b': output << "\\b"; break;
      case '\f': output << "\\f"; break;
      case '\n': output << "\\n"; break;
      case '\r': output << "\\r"; break;
      case '\t': output << "\\t"; break;
      default:
        if (character < 0x20) {
          output << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                 << static_cast<unsigned int>(character) << std::dec;
        } else {
          output << static_cast<char>(character);
        }
    }
  }
  output << '"';
  return output.str();
}

struct Resources {
  DWORD handles = 0;
  DWORD threads = 0;
};

DWORD threadCount() {
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  require(snapshot != INVALID_HANDLE_VALUE, "thread snapshot failed");
  THREADENTRY32 entry{};
  entry.dwSize = sizeof(entry);
  DWORD count = 0;
  if (Thread32First(snapshot, &entry)) {
    do {
      if (entry.th32OwnerProcessID == GetCurrentProcessId()) ++count;
    } while (Thread32Next(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return count;
}

Resources currentResources() {
  DWORD handles = 0;
  require(GetProcessHandleCount(GetCurrentProcess(), &handles) != FALSE,
          "handle count failed");
  return {handles, threadCount()};
}

Resources waitForBudget(const Resources& baseline) {
  const auto deadline = std::chrono::steady_clock::now() + kResourceDeadline;
  Resources current{};
  do {
    current = currentResources();
    const auto handles = static_cast<std::int64_t>(current.handles) -
                         static_cast<std::int64_t>(baseline.handles);
    const auto threads = static_cast<std::int64_t>(current.threads) -
                         static_cast<std::int64_t>(baseline.threads);
    if (handles <= kHandleBudget && threads <= 0) return current;
    Sleep(10);
  } while (std::chrono::steady_clock::now() < deadline);
  return current;
}

std::wstring executableDirectory() {
  std::wstring path(32768, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, path.data(),
                                          static_cast<DWORD>(path.size()));
  require(length > 0 && length < path.size(), "probe path unavailable");
  path.resize(length);
  path.resize(path.find_last_of(L"\\/") + 1);
  return path;
}

class WindowFixture final {
 public:
  WindowFixture() {
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    HANDLE child_stdin_read = nullptr;
    HANDLE child_stdout_write = nullptr;
    try {
      require(CreatePipe(&child_stdin_read, &stdin_write_, &security, 0) !=
                  FALSE,
              "window fixture stdin pipe failed");
      require(CreatePipe(&stdout_read_, &child_stdout_write, &security, 0) !=
                  FALSE,
              "window fixture stdout pipe failed");
      require(SetHandleInformation(stdin_write_, HANDLE_FLAG_INHERIT, 0) !=
                      FALSE &&
                  SetHandleInformation(stdout_read_, HANDLE_FLAG_INHERIT, 0) !=
                      FALSE,
              "window fixture pipe inheritance failed");
      const auto executable = executableDirectory() +
                              L"source_window_fixture.exe";
      std::wstring command_line = L"\"" + executable + L"\"";
      job_ = CreateJobObjectW(nullptr, nullptr);
      require(job_ != nullptr, "window fixture job creation failed");
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
      limits.BasicLimitInformation.LimitFlags =
          JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      require(SetInformationJobObject(job_, JobObjectExtendedLimitInformation,
                                      &limits, sizeof(limits)) != FALSE,
              "window fixture job configuration failed");
      STARTUPINFOW startup{};
      startup.cb = sizeof(startup);
      startup.dwFlags = STARTF_USESTDHANDLES;
      startup.hStdInput = child_stdin_read;
      startup.hStdOutput = child_stdout_write;
      startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
      require(CreateProcessW(executable.c_str(), command_line.data(), nullptr,
                             nullptr, TRUE, CREATE_SUSPENDED, nullptr, nullptr,
                             &startup, &process_) != FALSE,
              "window fixture process creation failed");
      require(AssignProcessToJobObject(job_, process_.hProcess) != FALSE,
              "window fixture job assignment failed");
      require(ResumeThread(process_.hThread) != static_cast<DWORD>(-1),
              "window fixture resume failed");
      CloseHandle(child_stdin_read);
      child_stdin_read = nullptr;
      CloseHandle(child_stdout_write);
      child_stdout_write = nullptr;
      require(readLine() == "READY", "window fixture did not become ready");
      title_ = "Syrnike Window Capture Fixture " +
               std::to_string(process_.dwProcessId);
      command("title " + title_);
    } catch (...) {
      if (child_stdin_read != nullptr) CloseHandle(child_stdin_read);
      if (child_stdout_write != nullptr) CloseHandle(child_stdout_write);
      cleanup(true);
      throw;
    }
  }

  ~WindowFixture() noexcept {
    if (process_.hProcess != nullptr &&
        WaitForSingleObject(process_.hProcess, 0) == WAIT_TIMEOUT) {
      const char quit[] = "quit\n";
      DWORD written = 0;
      if (stdin_write_ != nullptr) {
        (void)WriteFile(stdin_write_, quit,
                        static_cast<DWORD>(sizeof(quit) - 1), &written,
                        nullptr);
      }
      if (WaitForSingleObject(process_.hProcess, 1500) == WAIT_TIMEOUT) {
        (void)TerminateProcess(process_.hProcess, 79);
        (void)WaitForSingleObject(process_.hProcess, 1000);
      }
    }
    cleanup(false);
  }

  const std::string& title() const noexcept { return title_; }

  std::string command(const std::string& value) {
    const std::string line = value + "\n";
    DWORD written = 0;
    require(WriteFile(stdin_write_, line.data(),
                      static_cast<DWORD>(line.size()), &written, nullptr) !=
                        FALSE &&
                    written == line.size(),
            "window fixture command write failed");
    const auto response = readLine();
    require(response.rfind("OK ", 0) == 0,
            "window fixture command failed: " + response);
    return response;
  }

 private:
  std::string readLine() {
    std::promise<std::string> completion;
    auto result = completion.get_future();
    std::thread reader([this, promise = std::move(completion)]() mutable {
      try {
        std::string line;
        for (;;) {
          char value = '\0';
          DWORD read = 0;
          require(ReadFile(stdout_read_, &value, 1, &read, nullptr) != FALSE &&
                      read == 1,
                  "window fixture output ended");
          if (value == '\n') break;
          if (value != '\r') line.push_back(value);
          require(line.size() <= 1024,
                  "window fixture response exceeded its bound");
        }
        promise.set_value(std::move(line));
      } catch (...) {
        promise.set_exception(std::current_exception());
      }
    });
    if (result.wait_for(5s) != std::future_status::ready) {
      if (process_.hProcess != nullptr) {
        (void)TerminateProcess(process_.hProcess, 80);
        (void)WaitForSingleObject(process_.hProcess, 1000);
      }
      reader.join();
      throw std::runtime_error("window fixture response deadline exceeded");
    }
    reader.join();
    return result.get();
  }

  void cleanup(bool terminate) noexcept {
    if (terminate && process_.hProcess != nullptr) {
      (void)TerminateProcess(process_.hProcess, 81);
      (void)WaitForSingleObject(process_.hProcess, 1000);
    }
    if (process_.hThread != nullptr) CloseHandle(process_.hThread);
    if (process_.hProcess != nullptr) CloseHandle(process_.hProcess);
    if (stdin_write_ != nullptr) CloseHandle(stdin_write_);
    if (stdout_read_ != nullptr) CloseHandle(stdout_read_);
    if (job_ != nullptr) CloseHandle(job_);
    process_ = {};
    stdin_write_ = nullptr;
    stdout_read_ = nullptr;
    job_ = nullptr;
  }

  PROCESS_INFORMATION process_{};
  HANDLE stdin_write_ = nullptr;
  HANDLE stdout_read_ = nullptr;
  HANDLE job_ = nullptr;
  std::string title_;
};

unsigned int parseDecimal(const std::string& value, unsigned int minimum,
                          unsigned int maximum, const char* option) {
  unsigned int parsed = 0;
  const auto converted =
      std::from_chars(value.data(), value.data() + value.size(), parsed);
  require(!value.empty() && converted.ec == std::errc{} &&
              converted.ptr == value.data() + value.size(),
          std::string(option) + " requires a decimal integer");
  require(parsed >= minimum, std::string(option) + " is out of range");
  require(parsed <= maximum, std::string(option) + " is out of range");
  return parsed;
}

struct Arguments {
  int frames = 600;
  int cycles = 1;
  bool debug = kDefaultD3dDebugLayer;
  std::optional<std::string> source_id;
};

Arguments parseArguments(int argc, char** argv, const std::string& command) {
  Arguments arguments;
  if (command == "capture-window-repeat") {
    arguments.frames = 2;
    arguments.cycles = 50;
  } else if (command != "capture-window") {
    arguments.frames = 0;
  }
  for (int index = 2; index < argc; ++index) {
    const std::string value = argv[index];
    if (value == "--frames") {
      require(index + 1 < argc, "--frames requires N");
      arguments.frames = static_cast<int>(
          parseDecimal(argv[++index], 1, 10'000, "--frames"));
    } else if (value == "--cycles" || value == "--repeat") {
      require(index + 1 < argc, "--cycles requires N");
      arguments.cycles = static_cast<int>(
          parseDecimal(argv[++index], 1, 50, "--cycles"));
    } else if (value == "--d3d-debug") {
      arguments.debug = true;
    } else if (value == "--source") {
      require(index + 1 < argc, "--source requires an opaque source ID");
      arguments.source_id = argv[++index];
    } else if (value == "--fixture") {
      continue;
    } else {
      throw std::runtime_error("unknown window capture argument: " + value);
    }
  }
  return arguments;
}

const SourceSnapshot* findWindow(const SourceEnumeration& enumeration,
                                 const std::string& title) {
  const auto found = std::find_if(
      enumeration.sources.begin(), enumeration.sources.end(),
      [&](const SourceSnapshot& source) {
        return source.kind == SourceKind::Window && source.title == title;
      });
  return found == enumeration.sources.end() ? nullptr : &*found;
}

struct Evidence {
  std::uint64_t captured = 0;
  std::uint64_t received = 0;
  std::uint64_t dropped = 0;
  std::size_t maximum_depth = 0;
  bool sequence_increasing = true;
  bool timestamps_monotonic = true;
  bool metadata_matches_transitions = true;
  std::uint64_t previous_sequence = 0;
  std::int64_t previous_timestamp = 0;
  std::unordered_set<std::uint64_t> hashes;
  std::vector<std::uint64_t> samples;
  std::vector<WindowCaptureEvent> transitions;
  std::map<std::uint64_t, std::pair<std::uint32_t, std::uint32_t>>
      generation_sizes;
  std::map<std::string, std::uint64_t> frames_per_size;
  std::uint64_t resize_count = 0;
  std::uint64_t no_content_intervals = 0;
  std::string terminal_reason;
  std::uint64_t terminal_event_count = 0;
  std::uint64_t startup_ms = 0;
  std::uint64_t stop_ms = 0;
  WgcWindowCaptureDiagnostics diagnostics;
};

void recordEvent(Evidence& evidence, const WindowCaptureEvent& event) {
  evidence.transitions.push_back(event);
  if (event.kind == WindowCaptureEventKind::Running ||
      event.kind == WindowCaptureEventKind::Resized) {
    const auto [iterator, inserted] = evidence.generation_sizes.emplace(
        event.generation, std::pair{event.width, event.height});
    if (!inserted && iterator->second != std::pair{event.width, event.height}) {
      evidence.metadata_matches_transitions = false;
    }
  }
  if (event.kind == WindowCaptureEventKind::SourceClosed ||
      event.kind == WindowCaptureEventKind::CaptureFailed) {
    ++evidence.terminal_event_count;
    evidence.terminal_reason =
        event.failure ? event.failure->code : toString(event.kind);
  }
}

void recordEvents(WindowCapture& capture, Evidence& evidence) {
  while (auto event = capture.waitForEvent(0ms)) {
    recordEvent(evidence, *event);
  }
}

void captureFrames(WindowCapture& capture, int frames, Evidence& evidence,
                   std::optional<std::uint64_t> required_generation =
                       std::nullopt) {
  const auto deadline = std::chrono::steady_clock::now() +
                        (std::max)(std::chrono::milliseconds{10'000},
                                   std::chrono::milliseconds(frames * 80));
  int accepted = 0;
  while (accepted < frames) {
    require(std::chrono::steady_clock::now() < deadline,
            "window capture frame deadline exceeded");
    recordEvents(capture, evidence);
    auto lease = capture.waitForFrame(500ms);
    if (!lease) {
      if (const auto terminal = capture.terminalFailure()) {
        throw std::runtime_error("window capture terminal failure: " +
                                 terminal->code);
      }
      continue;
    }
    // The resize event is committed before frames of its generation, but it
    // can arrive between the pre-wait event drain and waitForFrame(). Drain
    // once more so validation compares the frame with the already-published
    // generation instead of reporting a scheduling-order false positive.
    recordEvents(capture, evidence);
    const auto metadata = lease->metadata();
    const auto generation_size =
        evidence.generation_sizes.find(metadata.generation);
    if (generation_size == evidence.generation_sizes.end() ||
        generation_size->second !=
            std::pair{metadata.width, metadata.height}) {
      evidence.metadata_matches_transitions = false;
    }
    if (required_generation && metadata.generation != *required_generation) {
      lease->release();
      continue;
    }
    evidence.sequence_increasing = evidence.sequence_increasing &&
                                   metadata.sequence > evidence.previous_sequence;
    evidence.timestamps_monotonic =
        evidence.timestamps_monotonic &&
        (evidence.captured == 0 ||
         metadata.capture_timestamp_100ns >= evidence.previous_timestamp);
    evidence.previous_sequence = metadata.sequence;
    evidence.previous_timestamp = metadata.capture_timestamp_100ns;
    const auto hash = lease->sampledHash();
    evidence.hashes.insert(hash);
    if (evidence.samples.size() < 16) evidence.samples.push_back(hash);
    const auto size = std::to_string(metadata.width) + "x" +
                      std::to_string(metadata.height) + "@" +
                      std::to_string(metadata.generation);
    ++evidence.frames_per_size[size];
    lease->release();
    ++evidence.captured;
    ++accepted;
  }
  recordEvents(capture, evidence);
}

std::uint64_t waitForEvent(WindowCapture& capture,
                           WindowCaptureEventKind expected,
                           Evidence& evidence,
                           std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    auto event = capture.waitForEvent(100ms);
    if (!event) continue;
    recordEvent(evidence, *event);
    if (event->kind == expected) return event->generation;
  }
  throw std::runtime_error(std::string("window event deadline exceeded: ") +
                           toString(expected));
}

std::uint64_t waitForSettledResize(WindowCapture& capture,
                                   Evidence& evidence,
                                   std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  std::optional<std::uint64_t> latest_generation;
  auto quiet_until = deadline;
  while (std::chrono::steady_clock::now() < deadline) {
    auto event = capture.waitForEvent(50ms);
    if (event) {
      recordEvent(evidence, *event);
      if (event->kind == WindowCaptureEventKind::SourceClosed ||
          event->kind == WindowCaptureEventKind::CaptureFailed) {
        throw std::runtime_error(
            "window capture terminated during resize burst");
      }
      if (event->kind == WindowCaptureEventKind::Resized) {
        latest_generation = event->generation;
        quiet_until = std::chrono::steady_clock::now() + 250ms;
      }
    }
    if (latest_generation && std::chrono::steady_clock::now() >= quiet_until) {
      return *latest_generation;
    }
  }
  throw std::runtime_error("resize burst did not settle before deadline");
}

struct CaptureInstance {
  CaptureInstance(SourceRegistry& registry, const std::string& source_id,
                  bool debug,
                  std::shared_ptr<WgcWindowCaptureTestHooks> test_hooks = {})
      : backend(createWgcWindowCaptureBackend(
            {.request_d3d_debug_layer = debug,
             .test_hooks = std::move(test_hooks)})),
        diagnostics(backend.get()),
        capture(registry, source_id, std::move(backend)) {}

  std::unique_ptr<WgcWindowCaptureBackend> backend;
  WgcWindowCaptureBackend* diagnostics = nullptr;
  WindowCapture capture;
};

class CallbackGate final {
 public:
  void arm() {
    std::lock_guard lock(mutex_);
    armed_ = true;
    entered_ = false;
    released_ = false;
  }

  void enter() {
    std::unique_lock lock(mutex_);
    if (!armed_) return;
    entered_ = true;
    condition_.notify_all();
    condition_.wait(lock, [&] { return released_; });
    armed_ = false;
  }

  void waitUntilEntered(std::chrono::milliseconds timeout,
                        const char* failure) {
    std::unique_lock lock(mutex_);
    const bool entered =
        condition_.wait_for(lock, timeout, [&] { return entered_; });
    if (!entered) {
      released_ = true;
      condition_.notify_all();
    }
    lock.unlock();
    require(entered, failure);
  }

  void release() {
    std::lock_guard lock(mutex_);
    released_ = true;
    condition_.notify_all();
  }

 private:
  std::mutex mutex_;
  std::condition_variable condition_;
  bool armed_ = false;
  bool entered_ = false;
  bool released_ = false;
};

void startCapture(CaptureInstance& instance, Evidence& evidence) {
  const auto started_at = std::chrono::steady_clock::now();
  const auto result = instance.capture.start();
  evidence.startup_ms += static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started_at)
          .count());
  if (!result.ok) {
    const auto code = result.failure ? result.failure->code :
                                       "missing_typed_failure";
    throw std::runtime_error("window capture start failed: " + code);
  }
}

void appendStoppedCapture(CaptureInstance& instance, Evidence& evidence) {
  const auto stats = instance.capture.stats();
  evidence.received += stats.frames.received_frames;
  evidence.dropped += stats.frames.dropped_frames;
  evidence.maximum_depth =
      (std::max)(evidence.maximum_depth, stats.frames.maximum_queue_depth);
  evidence.timestamps_monotonic = evidence.timestamps_monotonic &&
                                  stats.frames.timestamps_monotonic;
  evidence.resize_count += stats.resize_count;
  evidence.no_content_intervals += stats.no_content_intervals;
  evidence.diagnostics = instance.diagnostics->diagnostics();
  recordEvents(instance.capture, evidence);
}

void stopCapture(CaptureInstance& instance, Evidence& evidence) {
  const auto stopped_at = std::chrono::steady_clock::now();
  const auto result = instance.capture.stop(2s);
  evidence.stop_ms += static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - stopped_at)
          .count());
  require(result.ok, "window capture stop failed");
  appendStoppedCapture(instance, evidence);
}

void stopCaptureWhileCallbackIsBlocked(CaptureInstance& instance,
                                       CallbackGate& gate,
                                       Evidence& evidence) {
  CaptureStopResult result;
  const auto stopped_at = std::chrono::steady_clock::now();
  std::thread stopper([&] { result = instance.capture.stop(2s); });
  std::this_thread::sleep_for(25ms);
  gate.release();
  stopper.join();
  evidence.stop_ms += static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - stopped_at)
          .count());
  require(result.ok, "window capture resize/stop race failed");
  appendStoppedCapture(instance, evidence);
}

void waitForAutomaticCleanup(CaptureInstance& instance,
                             std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    if (instance.diagnostics->diagnostics().cleanup_completed) return;
    Sleep(10);
  }
  throw std::runtime_error(
      "terminal window cleanup did not complete before the deadline");
}

void merge(Evidence& total, Evidence value) {
  total.captured += value.captured;
  total.received += value.received;
  total.dropped += value.dropped;
  total.maximum_depth = (std::max)(total.maximum_depth, value.maximum_depth);
  total.sequence_increasing = total.sequence_increasing &&
                              value.sequence_increasing;
  total.timestamps_monotonic = total.timestamps_monotonic &&
                               value.timestamps_monotonic;
  total.metadata_matches_transitions = total.metadata_matches_transitions &&
                                       value.metadata_matches_transitions;
  total.hashes.insert(value.hashes.begin(), value.hashes.end());
  for (const auto hash : value.samples) {
    if (total.samples.size() >= 16) break;
    total.samples.push_back(hash);
  }
  total.transitions.insert(total.transitions.end(), value.transitions.begin(),
                           value.transitions.end());
  total.generation_sizes.insert(value.generation_sizes.begin(),
                                value.generation_sizes.end());
  for (const auto& [size, frames] : value.frames_per_size) {
    total.frames_per_size[size] += frames;
  }
  total.resize_count += value.resize_count;
  total.no_content_intervals += value.no_content_intervals;
  if (!value.terminal_reason.empty()) {
    total.terminal_reason = std::move(value.terminal_reason);
  }
  total.terminal_event_count += value.terminal_event_count;
  total.startup_ms += value.startup_ms;
  total.stop_ms += value.stop_ms;
  total.diagnostics = value.diagnostics;
}

Evidence simpleCycle(SourceRegistry& registry, const std::string& source_id,
                     int frames, bool debug) {
  Evidence evidence;
  CaptureInstance instance(registry, source_id, debug);
  startCapture(instance, evidence);
  captureFrames(instance.capture, frames, evidence);
  stopCapture(instance, evidence);
  return evidence;
}

void writeEvidence(const Evidence& evidence, const std::string& command,
                   const std::string& mode, int repeat,
                   const Resources& before, const Resources& after,
                   bool extra_ok, bool handle_reuse_rejected,
                   const std::string& handle_reuse_status,
                   const std::string& monitor_move_status,
                   const std::string& dpi_transition_status) {
  const auto handle_delta = static_cast<std::int64_t>(after.handles) -
                            static_cast<std::int64_t>(before.handles);
  const auto thread_delta = static_cast<std::int64_t>(after.threads) -
                            static_cast<std::int64_t>(before.threads);
  const bool debug_clean = evidence.diagnostics.cleanup_completed &&
      evidence.diagnostics.live_engine_objects == 0 &&
      evidence.diagnostics.peak_engine_objects <= kMaximumWindowFrames + 1 &&
      (!evidence.diagnostics.d3d_debug_enabled ||
       (evidence.diagnostics.live_objects_reported &&
        evidence.diagnostics.live_objects_hresult >= 0));
  const bool resources_clean = handle_delta <= kHandleBudget &&
                               thread_delta <= 0;
  const bool ok = extra_ok && evidence.sequence_increasing &&
                  evidence.timestamps_monotonic &&
                  evidence.metadata_matches_transitions && debug_clean &&
                  resources_clean &&
                  evidence.maximum_depth <= kMaximumWindowFrames;
  std::cout << "{\"ok\":" << (ok ? "true" : "false")
            << ",\"command\":" << jsonString(command)
            << ",\"mode\":" << jsonString(mode)
            << ",\"repeat\":" << repeat
            << ",\"capturedFrames\":" << evidence.captured
            << ",\"sequenceIncreasing\":"
            << (evidence.sequence_increasing ? "true" : "false")
            << ",\"timestampsMonotonic\":"
            << (evidence.timestamps_monotonic ? "true" : "false")
            << ",\"metadataMatchesTransitions\":"
            << (evidence.metadata_matches_transitions ? "true" : "false")
            << ",\"hashes\":{\"unique\":" << evidence.hashes.size()
            << ",\"changed\":"
            << (evidence.hashes.size() > 1 ? "true" : "false")
            << ",\"samples\":[";
  for (std::size_t index = 0; index < evidence.samples.size(); ++index) {
    if (index != 0) std::cout << ',';
    std::cout << jsonString(std::to_string(evidence.samples[index]));
  }
  std::cout << "]},\"queue\":{\"capacity\":" << kMaximumWindowFrames
            << ",\"received\":" << evidence.received
            << ",\"dropped\":" << evidence.dropped
            << ",\"maximumDepth\":" << evidence.maximum_depth
            << "},\"generation\":{\"resizeCount\":"
            << evidence.resize_count << ",\"transitions\":[";
  for (std::size_t index = 0; index < evidence.transitions.size(); ++index) {
    if (index != 0) std::cout << ',';
    const auto& event = evidence.transitions[index];
    std::cout << "{\"kind\":" << jsonString(toString(event.kind))
              << ",\"generation\":" << event.generation
              << ",\"width\":" << event.width
              << ",\"height\":" << event.height << '}';
  }
  std::cout << "],\"framesPerSize\":{";
  std::size_t size_index = 0;
  for (const auto& [size, frames] : evidence.frames_per_size) {
    if (size_index++ != 0) std::cout << ',';
    std::cout << jsonString(size) << ':' << frames;
  }
  std::cout << "}},\"noContentIntervals\":"
            << evidence.no_content_intervals
            << ",\"terminalReason\":"
            << (evidence.terminal_reason.empty()
                    ? "null"
                    : jsonString(evidence.terminal_reason))
            << ",\"terminalEventCount\":"
            << evidence.terminal_event_count
            << ",\"checks\":{\"handleReuseRejected\":"
            << (handle_reuse_rejected ? "true" : "false")
            << ",\"handleReuseStatus\":"
            << jsonString(handle_reuse_status)
            << ",\"monitorMoveStatus\":"
            << jsonString(monitor_move_status)
            << ",\"dpiTransitionStatus\":"
            << jsonString(dpi_transition_status)
            << "},\"durationsMs\":{\"startupTotal\":"
            << evidence.startup_ms << ",\"stopTotal\":"
            << evidence.stop_ms
            << "},\"d3dDebug\":{\"requested\":"
            << (evidence.diagnostics.d3d_debug_requested ? "true" : "false")
            << ",\"enabled\":"
            << (evidence.diagnostics.d3d_debug_enabled ? "true" : "false")
            << ",\"status\":"
            << jsonString(!evidence.diagnostics.d3d_debug_enabled
                              ? "skipped"
                              : (evidence.diagnostics.live_objects_reported
                                     ? "reported"
                                     : "failed"))
            << ",\"reportHresult\":"
            << evidence.diagnostics.live_objects_hresult
            << ",\"liveEngineObjects\":"
            << evidence.diagnostics.live_engine_objects
            << ",\"peakEngineObjects\":"
            << evidence.diagnostics.peak_engine_objects
            << ",\"cleanupCompleted\":"
            << (evidence.diagnostics.cleanup_completed ? "true" : "false")
            << "},\"resources\":{\"before\":{\"handles\":"
            << before.handles << ",\"threads\":" << before.threads
            << "},\"after\":{\"handles\":" << after.handles
            << ",\"threads\":" << after.threads
            << "},\"delta\":{\"handles\":" << handle_delta
            << ",\"threads\":" << thread_delta
            << "},\"budget\":{\"handles\":" << kHandleBudget
            << ",\"threads\":0}}}\n";
  if (!ok) throw std::runtime_error("window capture acceptance failed");
}

}  // namespace

int captureWindowProbe(int argc, char** argv, const std::string& command) {
  const auto arguments = parseArguments(argc, argv, command);
  WindowFixture fixture;
  SourceRegistry registry(createWin32SourceEnumerator());
  EnumerationOptions window_options;
  window_options.kind = EnumerationOptions::Kind::Window;
  const auto windows = registry.enumerate(window_options);
  require(windows.ok, "window enumeration failed before capture");
  const SourceSnapshot* selected = nullptr;
  if (arguments.source_id) {
    const auto found = std::find_if(
        windows.sources.begin(), windows.sources.end(),
        [&](const SourceSnapshot& source) {
          return source.kind == SourceKind::Window &&
                 source.id == *arguments.source_id;
        });
    if (found != windows.sources.end()) selected = &*found;
  } else {
    selected = findWindow(windows, fixture.title());
  }
  if (selected == nullptr) {
    std::cout << "{\"ok\":false,\"command\":" << jsonString(command)
              << ",\"failure\":{\"code\":\"source_unavailable\","
                 "\"message\":\"fixture window source is unavailable\"}}\n";
    return 1;
  }
  std::string source_id = selected->id;

  if (command == "capture-window-close") {
    Evidence warm_close;
    CaptureInstance warm_instance(registry, source_id, arguments.debug);
    startCapture(warm_instance, warm_close);
    captureFrames(warm_instance.capture, 2, warm_close);
    fixture.command("rapid");
    (void)waitForEvent(warm_instance.capture,
                       WindowCaptureEventKind::SourceClosed, warm_close, 3s);
    stopCapture(warm_instance, warm_close);
    const auto warm_refreshed = registry.enumerate(window_options);
    const auto warm_replacement = findWindow(
        warm_refreshed, "Syrnike Source Fixture Rapid");
    require(warm_replacement != nullptr &&
                warm_replacement->id != source_id,
            "window close warm-up did not create a replacement identity");
    source_id = warm_replacement->id;
  } else if (command == "capture-window-resize") {
    Evidence warm_resize;
    CaptureInstance warm_instance(registry, source_id, arguments.debug);
    startCapture(warm_instance, warm_resize);
    captureFrames(warm_instance.capture, 2, warm_resize);
    fixture.command("resize 700 400");
    const auto warm_generation = waitForEvent(
        warm_instance.capture, WindowCaptureEventKind::Resized, warm_resize,
        3s);
    captureFrames(warm_instance.capture, 2, warm_resize, warm_generation);
    stopCapture(warm_instance, warm_resize);
  } else {
    const int warmup_cycles = command == "capture-window-repeat" ? 3 : 1;
    for (int warmup = 0; warmup < warmup_cycles; ++warmup) {
      (void)simpleCycle(registry, source_id, 32, arguments.debug);
    }
  }
  const auto before = currentResources();
  Evidence evidence;
  bool handle_reuse_rejected = false;
  std::string handle_reuse_status = "not_applicable";
  std::string monitor_move_status = "not_applicable";
  std::string dpi_transition_status = "not_applicable";
  bool extra_ok = true;

  if (command == "capture-window" || command == "capture-window-repeat") {
    for (int cycle = 0; cycle < arguments.cycles; ++cycle) {
      merge(evidence, simpleCycle(registry, source_id, arguments.frames,
                                  arguments.debug));
      const auto current = waitForBudget(before);
      extra_ok = extra_ok &&
                 static_cast<std::int64_t>(current.handles) -
                         static_cast<std::int64_t>(before.handles) <=
                     kHandleBudget &&
                 static_cast<std::int64_t>(current.threads) -
                         static_cast<std::int64_t>(before.threads) <=
                     0;
    }
    extra_ok = extra_ok && evidence.captured ==
                               static_cast<std::uint64_t>(arguments.frames) *
                                   arguments.cycles &&
               evidence.hashes.size() > 1;
  } else if (command == "capture-window-resize") {
    CallbackGate resize_gate;
    auto hooks = std::make_shared<WgcWindowCaptureTestHooks>();
    hooks->before_frame_pool_recreate = [&] { resize_gate.enter(); };
    CaptureInstance instance(registry, source_id, arguments.debug, hooks);
    startCapture(instance, evidence);
    captureFrames(instance.capture, 10, evidence);
    auto held_lease = instance.capture.waitForFrame(1s);
    require(held_lease.has_value(),
            "resize retirement lease was unavailable");
    fixture.command("resize 720 420");
    bool resized_before_release = false;
    const auto retirement_check = std::chrono::steady_clock::now() + 250ms;
    while (std::chrono::steady_clock::now() < retirement_check) {
      auto event = instance.capture.waitForEvent(25ms);
      if (!event) continue;
      recordEvent(evidence, *event);
      if (event->kind == WindowCaptureEventKind::Resized) {
        resized_before_release = true;
        break;
      }
    }
    require(!resized_before_release,
            "frame pool resized while an old generation lease was live");
    held_lease->release();
    const auto retired_generation = waitForEvent(
        instance.capture, WindowCaptureEventKind::Resized, evidence, 3s);
    captureFrames(instance.capture, 2, evidence, retired_generation);
    fixture.command("resize-burst");
    const auto burst_generation =
        waitForSettledResize(instance.capture, evidence, 5s);
    captureFrames(instance.capture, 2, evidence, burst_generation);
    for (int resize = 0; resize < 30; ++resize) {
      const int width = resize % 3 == 0 ? 480 : (resize % 3 == 1 ? 960 : 640);
      const int height = resize % 3 == 0 ? 320 : (resize % 3 == 1 ? 540 : 360);
      fixture.command("resize " + std::to_string(width) + " " +
                      std::to_string(height));
      const auto generation = waitForEvent(
          instance.capture, WindowCaptureEventKind::Resized, evidence, 3s);
      captureFrames(instance.capture, 2, evidence, generation);
    }
    EnumerationOptions monitor_options;
    monitor_options.kind = EnumerationOptions::Kind::Monitor;
    const auto monitors = registry.enumerate(monitor_options);
    std::vector<const SourceSnapshot*> monitor_sources;
    for (const auto& source : monitors.sources) {
      if (source.kind == SourceKind::Monitor && source.monitor) {
        monitor_sources.push_back(&source);
      }
    }
    if (monitor_sources.size() >= 2) {
      auto second = monitor_sources.begin() + 1;
      const auto first_scale = monitor_sources.front()->monitor->scale_factor;
      const auto different_dpi = std::find_if(
          second, monitor_sources.end(), [&](const SourceSnapshot* source) {
            return source->monitor->scale_factor != first_scale;
          });
      if (different_dpi != monitor_sources.end()) {
        std::iter_swap(second, different_dpi);
        dpi_transition_status = "tested";
      } else {
        dpi_transition_status = "skipped_no_mixed_dpi";
      }
      for (std::size_t index = 0; index < 2; ++index) {
        const auto& bounds = monitor_sources[index]->monitor->logical_bounds;
        fixture.command("move " + std::to_string(bounds.x + 80) + " " +
                        std::to_string(bounds.y + 80));
        captureFrames(instance.capture, 5, evidence);
      }
      monitor_move_status = "tested";
    } else {
      monitor_move_status = "skipped_insufficient_monitors";
      dpi_transition_status = "skipped_insufficient_monitors";
    }
    resize_gate.arm();
    fixture.command("resize 800 500");
    resize_gate.waitUntilEntered(3s,
                                "frame-pool Recreate gate was not reached");
    stopCaptureWhileCallbackIsBlocked(instance, resize_gate, evidence);
    extra_ok = evidence.resize_count >= 30 &&
               evidence.frames_per_size.size() >= 3 &&
               evidence.terminal_event_count == 0;
  } else if (command == "capture-window-minimize") {
    CaptureInstance instance(registry, source_id, arguments.debug);
    startCapture(instance, evidence);
    captureFrames(instance.capture, 10, evidence);
    fixture.command("minimize");
    (void)waitForEvent(instance.capture,
                       WindowCaptureEventKind::TemporarilyNoContent, evidence,
                       3s);
    const auto minimized_until = std::chrono::steady_clock::now() + 10s;
    while (std::chrono::steady_clock::now() < minimized_until) {
      if (auto lease = instance.capture.waitForFrame(250ms)) lease->release();
      require(!instance.capture.terminalFailure(),
              "minimized window became terminal");
    }
    fixture.command("restore");
    (void)waitForEvent(instance.capture,
                       WindowCaptureEventKind::ContentRestored, evidence, 3s);
    captureFrames(instance.capture, 20, evidence);
    fixture.command("hide");
    (void)waitForEvent(instance.capture,
                       WindowCaptureEventKind::TemporarilyNoContent, evidence,
                       3s);
    fixture.command("show");
    (void)waitForEvent(instance.capture,
                       WindowCaptureEventKind::ContentRestored, evidence, 3s);
    captureFrames(instance.capture, 10, evidence);
    stopCapture(instance, evidence);
    extra_ok = evidence.no_content_intervals >= 2 &&
               evidence.terminal_reason.empty();
  } else if (command == "capture-window-close") {
    CallbackGate close_gate;
    auto hooks = std::make_shared<WgcWindowCaptureTestHooks>();
    hooks->before_frame_callback = [&] { close_gate.enter(); };
    CaptureInstance first(registry, source_id, arguments.debug, hooks);
    startCapture(first, evidence);
    captureFrames(first.capture, 10, evidence);
    close_gate.arm();
    close_gate.waitUntilEntered(3s, "frame callback gate was not reached");
    const auto rapid = fixture.command("rapid");
    (void)waitForEvent(first.capture, WindowCaptureEventKind::SourceClosed,
                       evidence, 3s);
    close_gate.release();
    waitForAutomaticCleanup(first, 3s);
    stopCapture(first, evidence);
    const auto refreshed = registry.enumerate(window_options);
    const auto replacement = findWindow(refreshed,
                                         "Syrnike Source Fixture Rapid");
    const bool replacement_rejected = replacement != nullptr &&
                                      replacement->id != source_id &&
                                      registry.resolve(source_id).status ==
                                          ResolveStatus::Removed;
    require(replacement_rejected,
            "recreated HWND retained the old opaque source identity: " + rapid);
    const bool recycled = rapid.find("recycled=1") != std::string::npos;
    handle_reuse_rejected = recycled && replacement_rejected;
    handle_reuse_status = recycled ? "tested" : "skipped_no_reuse";
    extra_ok = evidence.terminal_reason == "source_closed" &&
               evidence.terminal_event_count == 1;
  } else {
    throw std::runtime_error("unknown window capture mode");
  }

  const auto after = waitForBudget(before);
  const std::string mode =
      command == "capture-window" ? "capture" :
      command.substr(std::string("capture-window-").size());
  writeEvidence(evidence, command, mode,
                arguments.cycles, before, after, extra_ok,
                handle_reuse_rejected, handle_reuse_status,
                monitor_move_status, dpi_transition_status);
  return 0;
}
