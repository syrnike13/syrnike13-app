#include <windows.h>
#include <tlhelp32.h>

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include "core/engine.hpp"

namespace {

using syrnike::windows_media::Engine;
using syrnike::windows_media::EngineOptions;
using syrnike::windows_media::EngineResult;
using syrnike::windows_media::EngineState;
using syrnike::windows_media::LifecycleEvent;
using syrnike::windows_media::PublicEvent;

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

}  // namespace

int main(int argc, char** argv) try {
  if (argc < 2) {
    throw std::runtime_error(
      "usage: media_probe <lifecycle-once|lifecycle-repeat|fail-start|hang-worker>"
    );
  }
  const std::string mode = argv[1];
  if (mode == "lifecycle-once") return lifecycleOnce();
  if (mode == "lifecycle-repeat") return lifecycleRepeat(parseCount(argc, argv));
  if (mode == "fail-start") return failStart();
  if (mode == "hang-worker") return hangWorker();
  if (mode == "hang-worker-child") return hangWorkerChild();
  throw std::runtime_error("unknown media_probe mode: " + mode);
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
