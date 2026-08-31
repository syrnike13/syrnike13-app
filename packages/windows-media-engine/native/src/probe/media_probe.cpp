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
#include <vector>

#include "core/engine.hpp"
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

struct ResourceBaseline {
  DWORD handles = 0;
  DWORD threads = 0;
};

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

}  // namespace

int main(int argc, char** argv) try {
  if (argc < 2) {
    throw std::runtime_error(
      "usage: media_probe <lifecycle-once|lifecycle-repeat|fail-start|hang-worker|enumerate-sources>"
    );
  }
  const std::string mode = argv[1];
  if (mode == "lifecycle-once") return lifecycleOnce();
  if (mode == "lifecycle-repeat") return lifecycleRepeat(parseCount(argc, argv));
  if (mode == "fail-start") return failStart();
  if (mode == "hang-worker") return hangWorker();
  if (mode == "hang-worker-child") return hangWorkerChild();
  if (mode == "enumerate-sources") return enumerateSources(argc, argv);
  throw std::runtime_error("unknown media_probe mode: " + mode);
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
