#include "capture/selecting_monitor_capture.hpp"
#include "sources/win32_source_enumerator.hpp"
#include <filesystem>
#include <iostream>
#include <thread>

using namespace syrnike::windows_media;
using namespace std::chrono_literals;
namespace {
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
struct Fixture {
  HANDLE process = nullptr, job = nullptr;
  ~Fixture() {
    if (job) CloseHandle(job);
    if (process) {
      WaitForSingleObject(process, 3000);
      CloseHandle(process);
    }
  }
  void start(HMONITOR monitor) {
    MONITORINFO info{sizeof(info)};
    require(GetMonitorInfoW(monitor, &info) != FALSE, "monitor unavailable");
    wchar_t executable[MAX_PATH]{};
    require(GetModuleFileNameW(nullptr, executable, MAX_PATH) > 0, "executable path unavailable");
    const auto path =
        std::filesystem::path(executable).parent_path() / L"monitor_pattern_fixture.exe";
    auto command = L"\"" + path.wstring() + L"\" --monitor-point " +
                   std::to_wstring((info.rcMonitor.left + info.rcMonitor.right) / 2) + L" " +
                   std::to_wstring((info.rcMonitor.top + info.rcMonitor.bottom) / 2) +
                   L" --static-fullscreen";
    job = CreateJobObjectW(nullptr, nullptr);
    require(job != nullptr, "fixture job unavailable");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                                    sizeof(limits)) != FALSE,
            "fixture job limits failed");
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child{};
    require(CreateProcessW(path.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED,
                           nullptr, nullptr, &startup, &child) != FALSE,
            "fixture start failed");
    process = child.hProcess;
    if (!AssignProcessToJobObject(job, process)) {
      TerminateProcess(process, 1);
      CloseHandle(child.hThread);
      throw std::runtime_error("fixture ownership failed");
    }
    const auto resumed = ResumeThread(child.hThread);
    CloseHandle(child.hThread);
    require(resumed != static_cast<DWORD>(-1), "fixture resume failed");
    require(WaitForInputIdle(process, 3000) == 0, "fixture did not initialize");
  }
};
}  // namespace
int main(int argc, char** argv) {
  try {
    require(
        argc == 2 && (std::string_view(argv[1]) == "wgc" || std::string_view(argv[1]) == "dxgi"),
        "Usage: backend_capture_lab wgc|dxgi (65 second static fullscreen proof)");
    sources::SourceRegistry registry(sources::createWin32SourceEnumerator());
    sources::EnumerationOptions enumeration;
    enumeration.kind = sources::EnumerationOptions::Kind::Monitor;
    const auto values = registry.enumerate(enumeration);
    require(values.ok && !values.sources.empty(), "no monitors");
    auto selected = values.sources.front();
    for (const auto& value : values.sources)
      if (value.monitor && value.flags.primary) selected = value;
    const auto target = registry.resolveMonitorTarget(selected.id);
    require(target.target.has_value(), "monitor resolution failed");
    Fixture fixture;
    fixture.start(reinterpret_cast<HMONITOR>(target.target->platformValue()));
    capture::SelectingMonitorOptions options;
    options.forced = std::string_view(argv[1]) == "dxgi" ? capture::CaptureBackendKind::dxgi
                                                         : capture::CaptureBackendKind::wgc;
    options.resolve_target = [&] { return registry.resolveMonitorTarget(selected.id).target; };
    auto backend = capture::createSelectingMonitorCaptureBackend(std::move(options));
    const auto selection = backend.get();
    capture::MonitorCapture capture(registry, selected.id, std::move(backend));
    require(capture.start().ok, "static capture did not start");
    const auto started = std::chrono::steady_clock::now();
    std::uint64_t received = 0;
    while (std::chrono::steady_clock::now() - started < 65s) {
      auto frame = capture.waitForFrame(50ms);
      if (frame) ++received;
      require(capture.state() != capture::CaptureState::Failed, "static capture failed");
    }
    require(capture.stop(5s).ok, "static capture stop failed");
    const auto evidence = selection->diagnostics();
    const bool accepted = received > 0 && evidence.attempts == 1 &&
                          evidence.policy.committed_switches == 0 && evidence.pauses == 0 &&
                          evidence.live_generations == 0 && evidence.retained_frames == 0 &&
                          evidence.dxgi.acquired_frames == evidence.dxgi.released_frames &&
                          (std::string_view(argv[1]) != "dxgi" || evidence.dxgi.no_content >= 1000);
    std::cout << "{\"accepted\":" << (accepted ? "true" : "false")
              << ",\"scenario\":\"static-fullscreen\",\"backend\":\"" << argv[1]
              << "\",\"durationMs\":65000,\"frames\":" << received
              << ",\"attempts\":" << evidence.attempts
              << ",\"switches\":" << evidence.policy.committed_switches
              << ",\"pauses\":" << evidence.pauses
              << ",\"liveGenerations\":" << evidence.live_generations
              << ",\"noContent\":" << evidence.dxgi.no_content
              << ",\"maximumHoldUs\":" << evidence.dxgi.maximum_duplication_hold_us << "}\n";
    return accepted ? 0 : 1;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
