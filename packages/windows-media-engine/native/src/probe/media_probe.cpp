#include <windows.h>
#include <tlhelp32.h>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <map>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_set>
#include <vector>

#include "capture/monitor_capture.hpp"
#include "capture/wgc_monitor_capture.hpp"
#include "core/engine.hpp"
#include "probe/window_capture_probe.hpp"
#include "sources/source_registry.hpp"
#include "sources/win32_source_enumerator.hpp"

namespace {

using syrnike::windows_media::Engine;
using syrnike::windows_media::EngineOptions;
using syrnike::windows_media::EngineResult;
using syrnike::windows_media::EngineState;
using syrnike::windows_media::LifecycleEvent;
using syrnike::windows_media::PublicEvent;
using namespace syrnike::windows_media::sources;
using namespace syrnike::windows_media::capture;

struct ResourceBaseline {
  DWORD handles = 0;
  DWORD threads = 0;
};

constexpr auto kCaptureResourceDeadline = std::chrono::seconds{5};
constexpr std::int64_t kCaptureHandleBudget = 4;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

void requireOk(const EngineResult& result, const std::string& operation) {
  if (result.ok) return;
  const auto detail = result.failure
    ? result.failure->code + ": " + result.failure->message
    : std::string("missing typed failure");
  throw std::runtime_error(operation + " failed: " + detail);
}

DWORD processThreadCount() {
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snapshot == INVALID_HANDLE_VALUE) {
    throw std::runtime_error("CreateToolhelp32Snapshot failed");
  }
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

ResourceBaseline resources() {
  DWORD handles = 0;
  if (!GetProcessHandleCount(GetCurrentProcess(), &handles)) {
    throw std::runtime_error("GetProcessHandleCount failed");
  }
  return ResourceBaseline{handles, processThreadCount()};
}

ResourceBaseline waitForResourceBaseline(const ResourceBaseline& baseline,
                                         std::chrono::milliseconds deadline) {
  const auto expires = std::chrono::steady_clock::now() + deadline;
  ResourceBaseline current{};
  do {
    current = resources();
    if (current.handles <= baseline.handles &&
        current.threads <= baseline.threads) {
      return current;
    }
    Sleep(10);
  } while (std::chrono::steady_clock::now() < expires);
  return current;
}

ResourceBaseline waitForCaptureResourceBudget(
    const ResourceBaseline& baseline, std::chrono::milliseconds deadline) {
  const auto expires = std::chrono::steady_clock::now() + deadline;
  ResourceBaseline current{};
  do {
    current = resources();
    const auto handles = static_cast<std::int64_t>(current.handles) -
                         static_cast<std::int64_t>(baseline.handles);
    const auto threads = static_cast<std::int64_t>(current.threads) -
                         static_cast<std::int64_t>(baseline.threads);
    if (handles <= kCaptureHandleBudget && threads <= 0) return current;
    Sleep(10);
  } while (std::chrono::steady_clock::now() < expires);
  return current;
}

void requireBaseline(
  const ResourceBaseline& expected,
  const ResourceBaseline& actual,
  const std::string& stage
) {
  if (expected.handles != actual.handles || expected.threads != actual.threads) {
    throw std::runtime_error(
      stage + " resource baseline changed: handles " +
      std::to_string(expected.handles) + " -> " +
      std::to_string(actual.handles) + ", threads " +
      std::to_string(expected.threads) + " -> " +
      std::to_string(actual.threads)
    );
  }
}

void lifecycleCycle() {
  std::vector<LifecycleEvent> events;
  std::mutex events_mutex;
  Engine engine;
  requireOk(engine.registerEventCallback([&](const PublicEvent& event) {
    const auto* lifecycle = std::get_if<LifecycleEvent>(&event);
    if (!lifecycle) return;
    std::lock_guard lock(events_mutex);
    events.push_back(*lifecycle);
  }), "registerEventCallback");
  requireOk(engine.start(), "start");
  requireOk(engine.ping(), "ping");
  requireOk(engine.shutdown(), "shutdown");
  requireOk(engine.shutdown(), "second shutdown");
  require(engine.state() == EngineState::Stopped, "Engine did not stop");
  std::lock_guard lock(events_mutex);
  require(events.size() == 4, "Engine emitted an unexpected lifecycle event count");
  require(events[0].state == EngineState::Starting, "Starting event missing");
  require(events[1].state == EngineState::Running, "Running event missing");
  require(events[2].state == EngineState::Stopping, "Stopping event missing");
  require(events[3].state == EngineState::Stopped, "Stopped event missing");
}

int lifecycleRepeat(int count) {
  require(count > 0 && count <= 10'000, "count must be between 1 and 10000");
  lifecycleCycle();
  const auto baseline = resources();
  for (int cycle = 0; cycle < count; ++cycle) {
    lifecycleCycle();
    requireBaseline(baseline, resources(), "cycle " + std::to_string(cycle + 1));
  }
  std::cout << "lifecycle-repeat:ok count=" << count
            << " handles=" << baseline.handles
            << " threads=" << baseline.threads << '\n';
  return 0;
}

int lifecycleOnce() {
  lifecycleCycle();
  std::cout << "lifecycle-once:ok\n";
  return 0;
}

int failStart() {
  const auto fail_cycle = [] {
    Engine engine(EngineOptions{.fail_start = true});
    const auto result = engine.start();
    require(!result.ok, "fail-start unexpectedly succeeded");
    require(
      result.failure && result.failure->code == "startup_failed",
      "fail-start returned an untyped failure"
    );
    require(engine.state() == EngineState::Failed, "Engine did not enter Failed");
    requireOk(engine.shutdown(), "failed Engine shutdown");
  };
  // MSVC may initialize one process-scoped runtime handle on the first
  // std::thread. Measure the repeatable Engine baseline after that warm-up.
  fail_cycle();
  const auto baseline = resources();
  fail_cycle();
  requireBaseline(baseline, resources(), "fail-start rollback");
  std::cout << "fail-start:ok\n";
  return 0;
}

std::wstring executablePath() {
  std::wstring path(32768, L'\0');
  const DWORD size = GetModuleFileNameW(
    nullptr,
    path.data(),
    static_cast<DWORD>(path.size())
  );
  if (size == 0 || size >= path.size()) {
    throw std::runtime_error("GetModuleFileNameW failed");
  }
  path.resize(size);
  return path;
}

int hangWorkerChild() {
  auto* engine = new Engine(EngineOptions{.test_hang_on_shutdown = true});
  requireOk(engine->start(), "hang-worker start");
  const auto result = engine->shutdown(std::chrono::milliseconds(250));
  require(
    !result.ok && result.failure &&
      result.failure->code == "control_deadline_exceeded",
    "hang-worker did not produce a typed shutdown deadline"
  );
  Sleep(INFINITE);
  return 2;
}

int hangWorker() {
  const auto executable = executablePath();
  std::wstring command = L"\"" + executable + L"\" hang-worker-child";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(
        executable.c_str(),
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
    throw std::runtime_error("CreateProcessW failed for hang-worker child");
  }
  const DWORD wait = WaitForSingleObject(process.hProcess, 1500);
  if (wait != WAIT_TIMEOUT) {
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    throw std::runtime_error("hang-worker child exited before outer deadline");
  }
  require(
    TerminateProcess(process.hProcess, 73) != FALSE,
    "TerminateProcess failed for hung utility boundary"
  );
  require(
    WaitForSingleObject(process.hProcess, 1000) == WAIT_OBJECT_0,
    "hung utility boundary did not terminate"
  );
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  std::cout << "hang-worker:ok forced-exit=73\n";
  return 0;
}

int parseCount(int argc, char** argv) {
  for (int index = 2; index + 1 < argc; ++index) {
    if (std::string(argv[index]) == "--count") {
      return std::stoi(argv[index + 1]);
    }
  }
  throw std::runtime_error("lifecycle-repeat requires --count N");
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
        if (character < 0x20U) {
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

std::string boundsJson(const SourceBounds& bounds) {
  return "{\"x\":" + std::to_string(bounds.x) +
         ",\"y\":" + std::to_string(bounds.y) +
         ",\"width\":" + std::to_string(bounds.width) +
         ",\"height\":" + std::to_string(bounds.height) + "}";
}

template <typename Value>
std::string optionalNumberJson(const std::optional<Value>& value) {
  if (!value) return "null";
  std::ostringstream output;
  output << *value;
  return output.str();
}

std::string monitorJson(const std::optional<MonitorMetadata>& monitor) {
  if (!monitor) return "null";
  return "{\"logicalBounds\":" + boundsJson(monitor->logical_bounds) +
         ",\"physicalBounds\":" +
         (monitor->physical_bounds ? boundsJson(*monitor->physical_bounds)
                                   : std::string("null")) +
         ",\"dpi\":{\"x\":" + optionalNumberJson(monitor->dpi_x) +
         ",\"y\":" + optionalNumberJson(monitor->dpi_y) +
         ",\"scale\":" + optionalNumberJson(monitor->scale_factor) + "}}";
}

std::string sourceJson(const SourceSnapshot& source) {
  std::ostringstream output;
  output << "{\"id\":" << jsonString(source.id)
         << ",\"kind\":" << jsonString(toString(source.kind))
         << ",\"title\":" << jsonString(source.title)
         << ",\"label\":" << jsonString(source.label)
         << ",\"availability\":" << jsonString(toString(source.availability))
         << ",\"flags\":{\"visible\":"
         << (source.flags.visible ? "true" : "false")
         << ",\"available\":"
         << (source.availability == SourceAvailability::Available ? "true" : "false")
         << ",\"minimized\":" << (source.flags.minimized ? "true" : "false")
         << ",\"primary\":" << (source.flags.primary ? "true" : "false")
         << ",\"ownProcess\":" << (source.flags.own_process ? "true" : "false")
         << "},\"captureSupport\":"
         << jsonString(toString(source.capture_support)) << ",\"exclusions\":[";
  for (std::size_t index = 0; index < source.exclusions.size(); ++index) {
    if (index != 0) output << ',';
    output << jsonString(toString(source.exclusions[index]));
  }
  output << "],\"monitor\":" << monitorJson(source.monitor) << '}';
  return output.str();
}

std::string snapshotJson(const SourceEnumeration& snapshot) {
  std::ostringstream output;
  output << "{\"ok\":" << (snapshot.ok ? "true" : "false")
         << ",\"complete\":" << (snapshot.complete ? "true" : "false")
         << ",\"completeness\":{\"monitors\":"
         << jsonString(toString(snapshot.monitors)) << ",\"windows\":"
         << jsonString(toString(snapshot.windows)) << "}"
         << ",\"sources\":[";
  for (std::size_t index = 0; index < snapshot.sources.size(); ++index) {
    if (index != 0) output << ',';
    output << sourceJson(snapshot.sources[index]);
  }
  output << "],\"addedIds\":[";
  for (std::size_t index = 0; index < snapshot.added_ids.size(); ++index) {
    if (index != 0) output << ',';
    output << jsonString(snapshot.added_ids[index]);
  }
  output << "],\"updatedIds\":[";
  for (std::size_t index = 0; index < snapshot.updated_ids.size(); ++index) {
    if (index != 0) output << ',';
    output << jsonString(snapshot.updated_ids[index]);
  }
  output << "],\"removed\":[";
  for (std::size_t index = 0; index < snapshot.removed.size(); ++index) {
    if (index != 0) output << ',';
    output << "{\"id\":" << jsonString(snapshot.removed[index].id)
           << ",\"kind\":" << jsonString(toString(snapshot.removed[index].kind))
           << ",\"availability\":"
           << jsonString(toString(snapshot.removed[index].availability)) << '}';
  }
  output << "],\"truncated\":{\"monitors\":"
         << (snapshot.monitors_truncated ? "true" : "false")
         << ",\"windows\":" << (snapshot.windows_truncated ? "true" : "false")
         << "},\"diagnostics\":[";
  for (std::size_t index = 0; index < snapshot.diagnostics.size(); ++index) {
    if (index != 0) output << ',';
    output << "{\"code\":" << jsonString(snapshot.diagnostics[index].code)
           << ",\"detail\":" << jsonString(snapshot.diagnostics[index].detail)
           << '}';
  }
  output << "]}";
  return output.str();
}

std::string sanitizedSnapshotJson(const SourceEnumeration& snapshot) {
  const auto monitors = static_cast<std::size_t>(std::count_if(
      snapshot.sources.begin(), snapshot.sources.end(),
      [](const SourceSnapshot& source) { return source.kind == SourceKind::Monitor; }));
  const auto windows = snapshot.sources.size() - monitors;
  std::ostringstream output;
  output << "{\"ok\":" << (snapshot.ok ? "true" : "false")
         << ",\"complete\":" << (snapshot.complete ? "true" : "false")
         << ",\"completeness\":{\"monitors\":"
         << jsonString(toString(snapshot.monitors)) << ",\"windows\":"
         << jsonString(toString(snapshot.windows)) << "}"
         << ",\"counts\":{\"monitors\":" << monitors
         << ",\"windows\":" << windows << "}"
         << ",\"changes\":{\"added\":" << snapshot.added_ids.size()
         << ",\"updated\":" << snapshot.updated_ids.size()
         << ",\"removed\":" << snapshot.removed.size() << "}"
         << ",\"truncated\":{\"monitors\":"
         << (snapshot.monitors_truncated ? "true" : "false")
         << ",\"windows\":" << (snapshot.windows_truncated ? "true" : "false")
         << "},\"diagnosticCodes\":[";
  for (std::size_t index = 0; index < snapshot.diagnostics.size(); ++index) {
    if (index != 0) output << ',';
    output << jsonString(snapshot.diagnostics[index].code);
  }
  output << "]}";
  return output.str();
}

struct EnumerateArguments {
  int repeat = 1;
  bool diff = false;
  bool sanitized = false;
  EnumerationOptions options;
};

EnumerateArguments parseEnumerateArguments(int argc, char** argv) {
  EnumerateArguments result;
  bool repeat_seen = false;
  bool kind_seen = false;
  for (int index = 2; index < argc; ++index) {
    const std::string argument = argv[index];
    if (argument == "--repeat") {
      require(index + 1 < argc, "--repeat requires N");
      require(!repeat_seen, "--repeat may be specified only once");
      repeat_seen = true;
      const std::string value = argv[++index];
      require(!value.empty() &&
                  std::all_of(value.begin(), value.end(), [](unsigned char character) {
                    return character >= '0' && character <= '9';
                  }),
              "--repeat requires a decimal integer between 1 and 1000");
      unsigned int parsed = 0;
      for (const unsigned char character : value) {
        parsed = parsed * 10U + static_cast<unsigned int>(character - '0');
        require(parsed <= 1000U,
                "--repeat requires a decimal integer between 1 and 1000");
      }
      require(parsed >= 1U, "--repeat must be between 1 and 1000");
      result.repeat = static_cast<int>(parsed);
    } else if (argument == "--diff") {
      result.diff = true;
    } else if (argument == "--sanitized") {
      result.sanitized = true;
    } else if (argument == "--include-own-windows") {
      result.options.include_own_windows = true;
    } else if (argument == "--kind") {
      require(index + 1 < argc, "--kind requires monitor, window, or all");
      require(!kind_seen, "--kind may be specified only once");
      kind_seen = true;
      const std::string kind = argv[++index];
      if (kind == "monitor")
        result.options.kind = EnumerationOptions::Kind::Monitor;
      else if (kind == "window")
        result.options.kind = EnumerationOptions::Kind::Window;
      else if (kind == "all")
        result.options.kind = EnumerationOptions::Kind::All;
      else
        throw std::runtime_error("--kind requires monitor, window, or all");
    } else {
      throw std::runtime_error("unknown enumerate-sources argument: " + argument);
    }
  }
  return result;
}

std::string kindName(EnumerationOptions::Kind value) {
  switch (value) {
    case EnumerationOptions::Kind::Monitor: return "monitor";
    case EnumerationOptions::Kind::Window: return "window";
    case EnumerationOptions::Kind::All: return "all";
  }
  return "all";
}

int enumerateSources(int argc, char** argv) {
  const auto arguments = parseEnumerateArguments(argc, argv);
  bool enumeration_ok = true;
  {
    // DisplayConfig, DPI and process metadata APIs lazily initialize process-wide
    // Windows state. Keep that one-time cost outside the registry lifetime
    // measurement, while still destroying the registry used by the measured run.
    SourceRegistry warm_registry(createWin32SourceEnumerator());
    enumeration_ok = warm_registry.enumerate(arguments.options).ok;
  }
  const auto before = resources();
  SourceEnumeration first;
  SourceEnumeration last;
  std::vector<std::string> diffs;
  {
    SourceRegistry registry(createWin32SourceEnumerator());
    for (int iteration = 1; iteration <= arguments.repeat; ++iteration) {
      auto current = registry.enumerate(arguments.options);
      enumeration_ok = enumeration_ok && current.ok;
      if (iteration == 1) first = current;
      if (arguments.diff && (!current.added_ids.empty() ||
                             !current.updated_ids.empty() ||
                             !current.removed.empty())) {
        std::ostringstream diff;
        diff << "{\"iteration\":" << iteration;
        if (arguments.sanitized) {
          diff << ",\"added\":" << current.added_ids.size()
               << ",\"updated\":" << current.updated_ids.size()
               << ",\"removed\":" << current.removed.size() << '}';
          diffs.push_back(diff.str());
          last = std::move(current);
          continue;
        }
        diff << ",\"addedIds\":[";
        for (std::size_t index = 0; index < current.added_ids.size(); ++index) {
          if (index != 0) diff << ',';
          diff << jsonString(current.added_ids[index]);
        }
        diff << "],\"updatedIds\":[";
        for (std::size_t index = 0; index < current.updated_ids.size(); ++index) {
          if (index != 0) diff << ',';
          diff << jsonString(current.updated_ids[index]);
        }
        diff << "],\"removed\":[";
        for (std::size_t index = 0; index < current.removed.size(); ++index) {
          if (index != 0) diff << ',';
          diff << "{\"id\":" << jsonString(current.removed[index].id)
               << ",\"kind\":" << jsonString(toString(current.removed[index].kind))
               << "}";
        }
        diff << "]}";
        diffs.push_back(diff.str());
      }
      last = std::move(current);
    }
  }
  const auto after = resources();
  const auto handle_delta = static_cast<std::int64_t>(after.handles) -
                            static_cast<std::int64_t>(before.handles);
  const auto thread_delta = static_cast<std::int64_t>(after.threads) -
                            static_cast<std::int64_t>(before.threads);
  constexpr std::int64_t kHandleBudget = 2;
  constexpr std::int64_t kThreadBudget = 0;
  const bool within_budget = handle_delta <= kHandleBudget &&
                             thread_delta <= kThreadBudget;
  const bool ok = within_budget && enumeration_ok;
  std::cout << "{\"ok\":" << (ok ? "true" : "false")
            << ",\"command\":\"enumerate-sources\",\"repeat\":"
            << arguments.repeat << ",\"kind\":"
            << jsonString(kindName(arguments.options.kind))
            << ",\"includeOwnWindows\":"
            << (arguments.options.include_own_windows ? "true" : "false")
            << ",\"sanitized\":" << (arguments.sanitized ? "true" : "false")
            << ",\"first\":"
            << (arguments.sanitized ? sanitizedSnapshotJson(first)
                                    : snapshotJson(first))
            << ",\"last\":"
            << (arguments.sanitized ? sanitizedSnapshotJson(last)
                                    : snapshotJson(last))
            << ",\"diffs\":[";
  for (std::size_t index = 0; index < diffs.size(); ++index) {
    if (index != 0) std::cout << ',';
    std::cout << diffs[index];
  }
  std::cout << "],\"resources\":{\"before\":{\"handles\":" << before.handles
            << ",\"threads\":" << before.threads
            << "},\"after\":{\"handles\":" << after.handles
            << ",\"threads\":" << after.threads
            << "},\"delta\":{\"handles\":" << handle_delta
            << ",\"threads\":" << thread_delta
            << "},\"budget\":{\"handles\":" << kHandleBudget
            << ",\"threads\":" << kThreadBudget << "}}}\n";
  return ok ? 0 : 1;
}

class MonitorPatternFixture final {
 public:
  explicit MonitorPatternFixture(const SourceSnapshot& source) {
    require(source.kind == SourceKind::Monitor && source.monitor.has_value(),
            "monitor pattern fixture requires monitor metadata");
    const auto& bounds = source.monitor->logical_bounds;
    const auto point_x = bounds.x + bounds.width / 2;
    const auto point_y = bounds.y + bounds.height / 2;
    const auto executable = executablePath();
    const auto separator = executable.find_last_of(L"\\/");
    require(separator != std::wstring::npos,
            "media_probe executable directory was unavailable");
    const auto fixture = executable.substr(0, separator + 1) +
                         L"monitor_pattern_fixture.exe";
    std::wstring command = L"\"" + fixture + L"\" --monitor-point " +
                           std::to_wstring(point_x) + L" " +
                           std::to_wstring(point_y);
    job_ = CreateJobObjectW(nullptr, nullptr);
    require(job_ != nullptr, "monitor fixture job could not be created");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION job_limits{};
    job_limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job_, JobObjectExtendedLimitInformation,
                                 &job_limits, sizeof(job_limits))) {
      cleanup();
      throw std::runtime_error("monitor fixture job could not be configured");
    }
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    if (!CreateProcessW(fixture.c_str(), command.data(), nullptr, nullptr,
                        FALSE, CREATE_SUSPENDED, nullptr, nullptr, &startup,
                        &process_)) {
      cleanup();
      throw std::runtime_error("monitor pattern fixture could not start");
    }
    if (!AssignProcessToJobObject(job_, process_.hProcess) ||
        ResumeThread(process_.hThread) == static_cast<DWORD>(-1)) {
      cleanup();
      throw std::runtime_error("monitor pattern fixture could not be owned");
    }
    CloseHandle(process_.hThread);
    process_.hThread = nullptr;
    const DWORD ready = WaitForInputIdle(process_.hProcess, 3000);
    if (ready != 0) {
      cleanup();
      throw std::runtime_error("monitor pattern fixture did not become ready");
    }
  }

  ~MonitorPatternFixture() noexcept { cleanup(); }

 private:
  void cleanup() noexcept {
    if (process_.hThread != nullptr) {
      CloseHandle(process_.hThread);
      process_.hThread = nullptr;
    }
    if (process_.hProcess != nullptr) {
      if (WaitForSingleObject(process_.hProcess, 0) == WAIT_TIMEOUT) {
        (void)TerminateProcess(process_.hProcess, 0);
        (void)WaitForSingleObject(process_.hProcess, 1000);
      }
      CloseHandle(process_.hProcess);
      process_.hProcess = nullptr;
    }
    if (job_ != nullptr) {
      CloseHandle(job_);
      job_ = nullptr;
    }
  }

  HANDLE job_ = nullptr;
  PROCESS_INFORMATION process_{};
};

struct CaptureMonitorArguments {
  int frames = 600;
  int repeat = 1;
  int slow_consumer_ms = 0;
  bool frames_explicit = false;
  bool request_d3d_debug = kDefaultD3dDebugLayer;
  bool stop_during_start = false;
  std::optional<std::string> source_id;
};

unsigned int parseBoundedDecimal(const std::string& value,
                                 unsigned int minimum,
                                 unsigned int maximum,
                                 const char* option) {
  require(!value.empty() &&
              std::all_of(value.begin(), value.end(), [](unsigned char value) {
                return value >= '0' && value <= '9';
              }),
          std::string(option) + " requires a decimal integer");
  unsigned int parsed = 0;
  for (const unsigned char character : value) {
    parsed = parsed * 10U + static_cast<unsigned int>(character - '0');
    require(parsed <= maximum, std::string(option) + " is out of range");
  }
  require(parsed >= minimum, std::string(option) + " is out of range");
  return parsed;
}

CaptureMonitorArguments parseCaptureMonitorArguments(
    int argc, char** argv, const std::string& command) {
  CaptureMonitorArguments result;
  if (command == "capture-monitor-repeat") {
    result.repeat = 50;
    result.frames = 2;
  } else if (command == "capture-monitor-slow-consumer") {
    result.frames = 10;
    result.slow_consumer_ms = 1000;
  } else if (command == "capture-monitor-stop-during-start") {
    result.stop_during_start = true;
  }
  for (int index = 2; index < argc; ++index) {
    const std::string argument = argv[index];
    if (argument == "--frames") {
      require(index + 1 < argc, "--frames requires N");
      result.frames = static_cast<int>(
          parseBoundedDecimal(argv[++index], 1, 10'000, "--frames"));
      result.frames_explicit = true;
    } else if (argument == "--repeat" || argument == "--cycles") {
      require(index + 1 < argc, "--repeat/--cycles requires N");
      result.repeat = static_cast<int>(
          parseBoundedDecimal(argv[++index], 1, 50, "--repeat/--cycles"));
    } else if (argument == "--slow-consumer-ms") {
      require(index + 1 < argc, "--slow-consumer-ms requires N");
      result.slow_consumer_ms = static_cast<int>(parseBoundedDecimal(
          argv[++index], 1, 1000, "--slow-consumer-ms"));
    } else if (argument == "--d3d-debug") {
      result.request_d3d_debug = true;
    } else if (argument == "--stop-during-start") {
      result.stop_during_start = true;
    } else if (argument == "--source") {
      require(index + 1 < argc, "--source requires an opaque source ID");
      result.source_id = argv[++index];
      require(!result.source_id->empty(),
              "--source requires an opaque source ID");
    } else {
      throw std::runtime_error("unknown capture-monitor argument: " + argument);
    }
  }
  if (result.repeat > 1 && !result.frames_explicit) result.frames = 2;
  if (result.stop_during_start) result.frames = 0;
  return result;
}

const SourceSnapshot& primaryMonitor(const SourceEnumeration& sources) {
  const auto primary = std::find_if(
      sources.sources.begin(), sources.sources.end(),
      [](const SourceSnapshot& source) {
        return source.kind == SourceKind::Monitor && source.flags.primary;
      });
  if (primary != sources.sources.end()) return *primary;
  const auto first = std::find_if(
      sources.sources.begin(), sources.sources.end(),
      [](const SourceSnapshot& source) {
        return source.kind == SourceKind::Monitor;
      });
  require(first != sources.sources.end(), "no monitor source is available");
  return *first;
}

struct CaptureMonitorEvidence {
  std::uint64_t captured_frames = 0;
  std::uint64_t received_frames = 0;
  std::uint64_t dropped_frames = 0;
  std::size_t maximum_queue_depth = 0;
  bool sequence_increasing = true;
  bool timestamps_monotonic = true;
  std::unordered_set<std::uint64_t> hashes;
  std::vector<std::uint64_t> sampled_hashes;
  std::uint64_t startup_duration_ms = 0;
  std::uint64_t stop_duration_ms = 0;
  WgcMonitorCaptureDiagnostics diagnostics;
};

void mergeEvidence(CaptureMonitorEvidence& aggregate,
                   CaptureMonitorEvidence cycle) {
  aggregate.captured_frames += cycle.captured_frames;
  aggregate.received_frames += cycle.received_frames;
  aggregate.dropped_frames += cycle.dropped_frames;
  aggregate.maximum_queue_depth =
      (std::max)(aggregate.maximum_queue_depth, cycle.maximum_queue_depth);
  aggregate.sequence_increasing =
      aggregate.sequence_increasing && cycle.sequence_increasing;
  aggregate.timestamps_monotonic =
      aggregate.timestamps_monotonic && cycle.timestamps_monotonic;
  aggregate.hashes.insert(cycle.hashes.begin(), cycle.hashes.end());
  for (const auto hash : cycle.sampled_hashes) {
    if (aggregate.sampled_hashes.size() >= 16) break;
    aggregate.sampled_hashes.push_back(hash);
  }
  aggregate.startup_duration_ms += cycle.startup_duration_ms;
  aggregate.stop_duration_ms += cycle.stop_duration_ms;
  aggregate.diagnostics = cycle.diagnostics;
}

CaptureMonitorEvidence captureMonitorCycle(SourceRegistry& registry,
                                           const std::string& source_id,
                                           int frames,
                                           int slow_consumer_ms,
                                           bool request_d3d_debug) {
  auto backend = createWgcMonitorCaptureBackend(
      {.request_d3d_debug_layer = request_d3d_debug});
  auto* diagnostics = backend.get();
  MonitorCapture capture(registry, source_id, std::move(backend));
  const auto start_started = std::chrono::steady_clock::now();
  const auto started = capture.start();
  const auto start_finished = std::chrono::steady_clock::now();
  if (!started.ok) {
    const auto detail = started.failure
                            ? started.failure->code + ": " +
                                  started.failure->message
                            : std::string("missing typed failure");
    throw std::runtime_error("capture-monitor start failed: " + detail);
  }

  CaptureMonitorEvidence evidence;
  evidence.startup_duration_ms = static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(start_finished -
                                                            start_started)
          .count());
  std::uint64_t previous_sequence = 0;
  std::int64_t previous_timestamp = 0;
  const auto deadline = std::chrono::steady_clock::now() +
                        (std::max)(std::chrono::milliseconds(10'000),
                                   std::chrono::milliseconds(frames * 50));
  while (evidence.captured_frames < static_cast<std::uint64_t>(frames)) {
    require(std::chrono::steady_clock::now() < deadline,
            "capture-monitor frame deadline exceeded");
    auto lease = capture.waitForFrame(std::chrono::seconds(2));
    if (!lease) {
      const auto terminal = capture.terminalFailure();
      if (terminal) {
        throw std::runtime_error("capture-monitor terminal failure: " +
                                 terminal->code + ": " + terminal->message);
      }
      continue;
    }
    if (slow_consumer_ms > 0) {
      std::this_thread::sleep_for(
          std::chrono::milliseconds(slow_consumer_ms));
    }
    const auto metadata = lease->metadata();
    evidence.sequence_increasing = evidence.sequence_increasing &&
                                   metadata.sequence > previous_sequence;
    evidence.timestamps_monotonic =
        evidence.timestamps_monotonic &&
        (evidence.captured_frames == 0 ||
         metadata.capture_timestamp_100ns >= previous_timestamp);
    previous_sequence = metadata.sequence;
    previous_timestamp = metadata.capture_timestamp_100ns;
    const auto hash = lease->sampledHash();
    evidence.hashes.insert(hash);
    if (evidence.sampled_hashes.size() < 16) {
      evidence.sampled_hashes.push_back(hash);
    }
    lease->release();
    ++evidence.captured_frames;
  }
  const auto stop_started = std::chrono::steady_clock::now();
  CaptureStopResult stopped;
  std::thread stopper(
      [&] { stopped = capture.stop(std::chrono::seconds(2)); });
  stopper.join();
  evidence.stop_duration_ms = static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - stop_started)
          .count());
  require(stopped.ok, "capture-monitor stop exceeded its lease deadline");
  const auto stats = capture.stats();
  evidence.received_frames = stats.received_frames;
  evidence.dropped_frames = stats.dropped_frames;
  evidence.maximum_queue_depth = stats.maximum_queue_depth;
  evidence.timestamps_monotonic = evidence.timestamps_monotonic &&
                                  stats.timestamps_monotonic;
  evidence.diagnostics = diagnostics->diagnostics();
  return evidence;
}

int stopMonitorDuringStart(SourceRegistry& registry,
                           const std::string& source_id,
                           bool request_d3d_debug,
                           const std::string& command) {
  const auto before = resources();
  auto backend = createWgcMonitorCaptureBackend(
      {.request_d3d_debug_layer = request_d3d_debug});
  auto* diagnostics = backend.get();
  MonitorCapture capture(registry, source_id, std::move(backend));
  CaptureStartResult started;
  const auto start_time = std::chrono::steady_clock::now();
  std::thread starter([&] { started = capture.start(); });
  for (int attempt = 0; attempt < 100 &&
                        capture.state() == CaptureState::Idle;
       ++attempt) {
    Sleep(1);
  }
  const auto stop_time = std::chrono::steady_clock::now();
  const auto stopped = capture.stop(std::chrono::seconds(5));
  const auto stopped_time = std::chrono::steady_clock::now();
  if (!stopped.ok) {
    const auto failure = stopped.failure.value_or(
        CaptureFailure{"capture_stop_failed", "capture stop failed"});
    std::cout << "{\"ok\":false,\"command\":" << jsonString(command)
              << ",\"mode\":\"stop-during-start\",\"failure\":{\"code\":"
              << jsonString(failure.code) << ",\"message\":"
              << jsonString(failure.message) << "}}\n" << std::flush;
    ExitProcess(1);
  }
  starter.join();
  const auto after =
      waitForCaptureResourceBudget(before, kCaptureResourceDeadline);
  const auto stats = capture.stats();
  const auto d3d = diagnostics->diagnostics();
  const auto handle_delta = static_cast<std::int64_t>(after.handles) -
                            static_cast<std::int64_t>(before.handles);
  const auto thread_delta = static_cast<std::int64_t>(after.threads) -
                            static_cast<std::int64_t>(before.threads);
  constexpr std::int64_t handle_budget = kCaptureHandleBudget;
  const bool resource_baseline = handle_delta <= handle_budget &&
                                 thread_delta <= 0;
  const bool debug_clean =
      !d3d.d3d_debug_enabled ||
      (d3d.live_objects_reported && d3d.live_objects_hresult >= 0 &&
       d3d.live_engine_objects == 0);
  const bool ok = capture.state() == CaptureState::Stopped &&
                  resource_baseline && debug_clean;
  std::cout << "{\"ok\":" << (ok ? "true" : "false")
            << ",\"command\":" << jsonString(command) << ",\"mode\":"
               "\"stop-during-start\",\"startCompleted\":"
            << (started.ok ? "true" : "false")
            << ",\"startFailure\":"
            << (started.failure ? jsonString(started.failure->code) : "null")
            << ",\"state\":" << jsonString(toString(capture.state()))
            << ",\"receivedFrames\":" << stats.received_frames
            << ",\"capturedFrames\":0,\"sequenceIncreasing\":true"
               ",\"timestampsMonotonic\":"
            << (stats.timestamps_monotonic ? "true" : "false")
            << ",\"durationsMs\":{\"startupToStop\":"
            << std::chrono::duration_cast<std::chrono::milliseconds>(
                   stop_time - start_time)
                   .count()
            << ",\"stopTotal\":"
            << std::chrono::duration_cast<std::chrono::milliseconds>(
                   stopped_time - stop_time)
                   .count()
            << "},\"hashes\":{\"unique\":0,\"changed\":true,\"samples\":[]},"
               "\"queue\":{\"capacity\":"
            << kMaximumMonitorFrames << ",\"received\":"
            << stats.received_frames << ",\"dropped\":"
            << stats.dropped_frames << ",\"maximumDepth\":"
            << stats.maximum_queue_depth << "},\"d3dDebug\":{\"requested\":"
            << (d3d.d3d_debug_requested ? "true" : "false")
            << ",\"enabled\":" << (d3d.d3d_debug_enabled ? "true" : "false")
            << ",\"status\":"
            << jsonString(!d3d.d3d_debug_enabled
                              ? "skipped"
                              : (d3d.live_objects_reported ? "reported"
                                                           : "failed"))
            << ",\"reportHresult\":" << d3d.live_objects_hresult
            << ",\"liveEngineObjects\":" << d3d.live_engine_objects
            << "},\"resources\":{\"before\":{\"handles\":" << before.handles
            << ",\"threads\":" << before.threads
            << "},\"after\":{\"handles\":" << after.handles
            << ",\"threads\":" << after.threads
            << "},\"delta\":{\"handles\":" << handle_delta
            << ",\"threads\":" << thread_delta
            << "},\"budget\":{\"handles\":" << handle_budget
            << ",\"threads\":0}}"
            << "}\n";
  return ok ? 0 : 1;
}

int captureMonitor(int argc, char** argv, const std::string& command) {
  const auto arguments = parseCaptureMonitorArguments(argc, argv, command);
  SourceRegistry registry(createWin32SourceEnumerator());
  EnumerationOptions options;
  options.kind = EnumerationOptions::Kind::Monitor;
  const auto sources = registry.enumerate(options);
  require(sources.ok && !sources.sources.empty(),
          "monitor enumeration failed before capture");
  const SourceSnapshot* selected_source = nullptr;
  if (arguments.source_id) {
    const auto selected = std::find_if(
        sources.sources.begin(), sources.sources.end(),
        [&](const SourceSnapshot& source) {
          return source.kind == SourceKind::Monitor &&
                 source.id == *arguments.source_id;
        });
    if (selected == sources.sources.end()) {
      std::cout << "{\"ok\":false,\"command\":" << jsonString(command)
                << ",\"failure\":{\"code\":\"source_unavailable\","
                   "\"message\":\"opaque source ID is not available in this "
                   "probe process\"}}\n";
      return 1;
    }
    selected_source = &*selected;
  } else {
    selected_source = &primaryMonitor(sources);
  }
  const std::string source_id = selected_source->id;
  MonitorPatternFixture fixture(*selected_source);
  const int warmup_cycles = arguments.repeat > 1 ? 3 : 1;
  const int warmup_frames =
      (std::clamp)(arguments.frames, 64, 600);
  for (int warmup = 0; warmup < warmup_cycles; ++warmup) {
    (void)captureMonitorCycle(registry, source_id, warmup_frames, 0,
                              arguments.request_d3d_debug);
  }
  if (arguments.stop_during_start) {
    return stopMonitorDuringStart(registry, source_id,
                                  arguments.request_d3d_debug, command);
  }

  const auto before = resources();
  CaptureMonitorEvidence evidence;
  bool each_cycle_at_baseline = true;
  std::int64_t maximum_cycle_handle_delta = 0;
  std::int64_t maximum_cycle_thread_delta = 0;
  for (int cycle = 0; cycle < arguments.repeat; ++cycle) {
    mergeEvidence(evidence,
                  captureMonitorCycle(registry, source_id, arguments.frames,
                                      arguments.slow_consumer_ms,
                                      arguments.request_d3d_debug));
    if (arguments.repeat > 1) {
      const auto current =
          waitForCaptureResourceBudget(before, kCaptureResourceDeadline);
      const auto handles = static_cast<std::int64_t>(current.handles) -
                           static_cast<std::int64_t>(before.handles);
      const auto threads = static_cast<std::int64_t>(current.threads) -
                           static_cast<std::int64_t>(before.threads);
      maximum_cycle_handle_delta =
          (std::max)(maximum_cycle_handle_delta, handles);
      maximum_cycle_thread_delta =
          (std::max)(maximum_cycle_thread_delta, threads);
      constexpr std::int64_t cycle_handle_budget = kCaptureHandleBudget;
      each_cycle_at_baseline = each_cycle_at_baseline &&
                               handles <= cycle_handle_budget && threads <= 0;
    }
  }
  const auto after =
      waitForCaptureResourceBudget(before, kCaptureResourceDeadline);
  const auto handle_delta = static_cast<std::int64_t>(after.handles) -
                            static_cast<std::int64_t>(before.handles);
  const auto thread_delta = static_cast<std::int64_t>(after.threads) -
                            static_cast<std::int64_t>(before.threads);
  constexpr std::int64_t handle_budget = kCaptureHandleBudget;
  const bool hashes_changed = arguments.frames < 2 || evidence.hashes.size() > 1;
  const bool slow_queue_observed = arguments.slow_consumer_ms == 0 ||
                                   evidence.dropped_frames > 0;
  const bool resource_baseline = handle_delta <= handle_budget &&
                                 thread_delta <= 0 &&
                                 (arguments.repeat == 1 ||
                                  each_cycle_at_baseline);
  const bool debug_clean =
      !evidence.diagnostics.d3d_debug_enabled ||
      (evidence.diagnostics.live_objects_reported &&
       evidence.diagnostics.live_objects_hresult >= 0 &&
       evidence.diagnostics.live_engine_objects == 0);
  const bool ok = evidence.captured_frames ==
                      static_cast<std::uint64_t>(arguments.frames) *
                          static_cast<std::uint64_t>(arguments.repeat) &&
                  evidence.sequence_increasing &&
                  evidence.timestamps_monotonic && hashes_changed &&
                  slow_queue_observed && resource_baseline &&
                  debug_clean &&
                  evidence.maximum_queue_depth <= kMaximumMonitorFrames;
  const char* debug_status = evidence.diagnostics.d3d_debug_enabled
                                 ? (evidence.diagnostics.live_objects_reported
                                        ? "reported"
                                        : "failed")
                                 : "skipped";
  std::cout << "{\"ok\":" << (ok ? "true" : "false")
            << ",\"command\":" << jsonString(command) << ",\"mode\":"
            << jsonString(arguments.slow_consumer_ms > 0
                              ? "slow-consumer"
                              : (arguments.repeat > 1 ? "repeat" : "capture"))
            << ",\"repeat\":" << arguments.repeat
            << ",\"requestedFramesPerCycle\":" << arguments.frames
            << ",\"capturedFrames\":" << evidence.captured_frames
            << ",\"sequenceIncreasing\":"
            << (evidence.sequence_increasing ? "true" : "false")
            << ",\"timestampsMonotonic\":"
            << (evidence.timestamps_monotonic ? "true" : "false")
            << ",\"durationsMs\":{\"startupTotal\":"
            << evidence.startup_duration_ms << ",\"stopTotal\":"
            << evidence.stop_duration_ms
            << "},\"hashes\":{\"unique\":" << evidence.hashes.size()
            << ",\"changed\":" << (hashes_changed ? "true" : "false")
            << ",\"samples\":[";
  for (std::size_t index = 0; index < evidence.sampled_hashes.size(); ++index) {
    if (index != 0) std::cout << ',';
    std::cout << jsonString(std::to_string(evidence.sampled_hashes[index]));
  }
  std::cout << "]},\"queue\":{\"capacity\":" << kMaximumMonitorFrames
            << ",\"received\":" << evidence.received_frames
            << ",\"dropped\":" << evidence.dropped_frames
            << ",\"maximumDepth\":" << evidence.maximum_queue_depth
            << "},\"d3dDebug\":{\"requested\":"
            << (evidence.diagnostics.d3d_debug_requested ? "true" : "false")
            << ",\"enabled\":"
            << (evidence.diagnostics.d3d_debug_enabled ? "true" : "false")
            << ",\"status\":" << jsonString(debug_status)
            << ",\"reportHresult\":"
            << evidence.diagnostics.live_objects_hresult
            << ",\"liveEngineObjects\":"
            << evidence.diagnostics.live_engine_objects
            << "},\"resources\":{\"before\":{\"handles\":"
            << before.handles << ",\"threads\":" << before.threads
            << "},\"after\":{\"handles\":" << after.handles
            << ",\"threads\":" << after.threads
            << "},\"delta\":{\"handles\":" << handle_delta
            << ",\"threads\":" << thread_delta
            << "},\"maximumCycleDelta\":{\"handles\":"
            << maximum_cycle_handle_delta << ",\"threads\":"
            << maximum_cycle_thread_delta
            << "},\"budget\":{\"handles\":" << handle_budget
            << ",\"threads\":0}}}\n";
  return ok ? 0 : 1;
}

}  // namespace

int main(int argc, char** argv) try {
  if (argc < 2) {
    throw std::runtime_error(
      "usage: media_probe <lifecycle-once|lifecycle-repeat|fail-start|hang-worker|enumerate-sources|capture-monitor|capture-monitor-repeat|capture-monitor-slow-consumer|capture-monitor-stop-during-start|capture-window|capture-window-resize|capture-window-minimize|capture-window-close|capture-window-repeat>"
    );
  }
  const std::string mode = argv[1];
  if (mode == "lifecycle-once") return lifecycleOnce();
  if (mode == "lifecycle-repeat") return lifecycleRepeat(parseCount(argc, argv));
  if (mode == "fail-start") return failStart();
  if (mode == "hang-worker") return hangWorker();
  if (mode == "hang-worker-child") return hangWorkerChild();
  if (mode == "enumerate-sources") return enumerateSources(argc, argv);
  if (mode == "capture-monitor" || mode == "capture-monitor-repeat" ||
      mode == "capture-monitor-slow-consumer" ||
      mode == "capture-monitor-stop-during-start") {
    return captureMonitor(argc, argv, mode);
  }
  if (mode == "capture-window" || mode == "capture-window-resize" ||
      mode == "capture-window-minimize" || mode == "capture-window-close" ||
      mode == "capture-window-repeat") {
    return captureWindowProbe(argc, argv, mode);
  }
  throw std::runtime_error("unknown media_probe mode: " + mode);
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
