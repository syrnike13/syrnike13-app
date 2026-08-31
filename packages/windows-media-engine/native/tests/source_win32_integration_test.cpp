#include <windows.h>

#include <chrono>
#include <atomic>
#include <condition_variable>
#include <future>
#include <iostream>
#include <algorithm>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

#include "sources/source_registry.hpp"
#include "sources/win32_source_enumerator.hpp"

namespace {

using namespace syrnike::windows_media::sources;
inline constexpr auto kHungEnumerationBudget = std::chrono::milliseconds(500);

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

std::wstring executableDirectory() {
  std::wstring path(32768, L'\0');
  const DWORD length = GetModuleFileNameW(nullptr, path.data(),
                                          static_cast<DWORD>(path.size()));
  require(length > 0 && length < path.size(), "GetModuleFileNameW failed");
  path.resize(length);
  path.resize(path.find_last_of(L"\\/") + 1);
  return path;
}

class FixtureProcess final {
 public:
  FixtureProcess() {
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    HANDLE child_stdin_read = nullptr;
    HANDLE child_stdout_write = nullptr;
    try {
      require(CreatePipe(&child_stdin_read, &stdin_write_, &security, 0) != FALSE,
              "fixture stdin pipe failed");
      require(CreatePipe(&stdout_read_, &child_stdout_write, &security, 0) != FALSE,
              "fixture stdout pipe failed");
      require(SetHandleInformation(stdin_write_, HANDLE_FLAG_INHERIT, 0) != FALSE &&
                  SetHandleInformation(stdout_read_, HANDLE_FLAG_INHERIT, 0) != FALSE,
              "fixture pipe inheritance setup failed");
      const std::wstring path = executableDirectory() + L"source_window_fixture.exe";
      std::wstring command_line = L"\"" + path + L"\"";
      STARTUPINFOW startup{};
      startup.cb = sizeof(startup);
      startup.dwFlags = STARTF_USESTDHANDLES;
      startup.hStdInput = child_stdin_read;
      startup.hStdOutput = child_stdout_write;
      startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
      require(CreateProcessW(path.c_str(), command_line.data(), nullptr, nullptr,
                             TRUE, 0, nullptr, nullptr, &startup, &process_) != FALSE,
              "fixture process creation failed");
      CloseHandle(child_stdin_read);
      child_stdin_read = nullptr;
      CloseHandle(child_stdout_write);
      child_stdout_write = nullptr;
      require(readLine() == "READY", "fixture did not become ready");
    } catch (...) {
      if (child_stdin_read != nullptr) CloseHandle(child_stdin_read);
      if (child_stdout_write != nullptr) CloseHandle(child_stdout_write);
      cleanup(true);
      throw;
    }
  }

  ~FixtureProcess() noexcept {
    if (process_.hProcess != nullptr) {
      const char quit[] = "quit\n";
      DWORD written = 0;
      if (stdin_write_ != nullptr) {
        (void)WriteFile(stdin_write_, quit, static_cast<DWORD>(sizeof(quit) - 1),
                        &written, nullptr);
      }
      if (WaitForSingleObject(process_.hProcess, 2000) == WAIT_TIMEOUT) {
        (void)TerminateProcess(process_.hProcess, 74);
        (void)WaitForSingleObject(process_.hProcess, 1000);
      }
    }
    cleanup(false);
  }

  std::string command(const std::string& value) {
    if (process_.hProcess == nullptr) return {};
    const std::string line = value + "\n";
    DWORD written = 0;
    require(WriteFile(stdin_write_, line.data(), static_cast<DWORD>(line.size()),
                      &written, nullptr) != FALSE && written == line.size(),
            "fixture command write failed");
    const auto response = readLine();
    require(response.rfind("OK ", 0) == 0, "fixture command failed");
    return response;
  }

 private:
  std::string readLine() {
    std::promise<std::string> completed;
    auto result = completed.get_future();
    std::thread reader([this, promise = std::move(completed)]() mutable {
      try {
        std::string line;
        for (;;) {
          char value = '\0';
          DWORD read = 0;
          require(ReadFile(stdout_read_, &value, 1, &read, nullptr) != FALSE &&
                      read == 1,
                  "fixture output ended");
          if (value == '\n') break;
          if (value != '\r') line.push_back(value);
          require(line.size() <= 1024, "fixture response exceeded its bound");
        }
        promise.set_value(std::move(line));
      } catch (...) {
        promise.set_exception(std::current_exception());
      }
    });
    if (result.wait_for(std::chrono::seconds(5)) != std::future_status::ready) {
      if (process_.hProcess != nullptr) {
        (void)TerminateProcess(process_.hProcess, 75);
        (void)WaitForSingleObject(process_.hProcess, 1000);
      }
      reader.join();
      throw std::runtime_error("fixture response exceeded its 5 second deadline");
    }
    reader.join();
    return result.get();
  }

  void cleanup(bool terminate_child) noexcept {
    if (terminate_child && process_.hProcess != nullptr) {
      (void)TerminateProcess(process_.hProcess, 76);
      (void)WaitForSingleObject(process_.hProcess, 1000);
    }
    if (process_.hThread != nullptr) CloseHandle(process_.hThread);
    if (process_.hProcess != nullptr) CloseHandle(process_.hProcess);
    if (stdin_write_ != nullptr) CloseHandle(stdin_write_);
    if (stdout_read_ != nullptr) CloseHandle(stdout_read_);
    process_ = {};
    stdin_write_ = nullptr;
    stdout_read_ = nullptr;
  }

  PROCESS_INFORMATION process_{};
  HANDLE stdin_write_ = nullptr;
  HANDLE stdout_read_ = nullptr;
};

const SourceSnapshot* findTitle(const SourceEnumeration& result,
                                const std::string& title) {
  for (const auto& source : result.sources) {
    if (source.kind == SourceKind::Window && source.title == title) return &source;
  }
  return nullptr;
}

bool hasDiagnostic(const SourceEnumeration& result, const std::string& code) {
  return std::any_of(result.diagnostics.begin(), result.diagnostics.end(),
                     [&](const EnumerationDiagnostic& diagnostic) {
                       return diagnostic.code == code;
                     });
}

std::string processUniqueTitle(const std::string& prefix) {
  return prefix + " pid=" + std::to_string(GetCurrentProcessId());
}

void realMonitorsExposeMinimumMetadata() {
  SourceRegistry registry(createWin32SourceEnumerator());
  EnumerationOptions options;
  options.kind = EnumerationOptions::Kind::Monitor;
  const auto result = registry.enumerate(options);
  require(!result.sources.empty(), "no active monitor was enumerated");
  for (const auto& monitor : result.sources) {
    require(monitor.kind == SourceKind::Monitor && monitor.monitor.has_value() &&
                monitor.availability == SourceAvailability::Available &&
                monitor.flags.visible && monitor.monitor->logical_bounds.width > 0 &&
                monitor.monitor->logical_bounds.height > 0,
            "active monitor omitted required current metadata");
    (void)monitor.monitor->physical_bounds;
    (void)monitor.monitor->dpi_x;
    (void)monitor.monitor->dpi_y;
    (void)monitor.monitor->scale_factor;
  }
}

LRESULT CALLBACK ownWindowProcedure(HWND window, UINT message, WPARAM wparam,
                                    LPARAM lparam) {
  return DefWindowProcW(window, message, wparam, lparam);
}

void ownProcessWindowsAreExplicit() {
  constexpr wchar_t class_name[] = L"SyrnikeSourceIntegrationOwnWindow";
  WNDCLASSW window_class{};
  window_class.lpfnWndProc = ownWindowProcedure;
  window_class.hInstance = GetModuleHandleW(nullptr);
  window_class.lpszClassName = class_name;
  require(RegisterClassW(&window_class) != 0, "own-window class registration failed");
  const std::string title = processUniqueTitle("Syrnike Source Integration Own");
  const std::wstring wide_title(title.begin(), title.end());
  const HWND window = CreateWindowExW(
      0, class_name, wide_title.c_str(), WS_OVERLAPPEDWINDOW | WS_VISIBLE,
      40, 40, 320, 180, nullptr, nullptr, window_class.hInstance, nullptr);
  require(window != nullptr, "own-window creation failed");

  SourceRegistry registry(createWin32SourceEnumerator());
  EnumerationOptions options;
  options.kind = EnumerationOptions::Kind::Window;
  const auto omitted = registry.enumerate(options);
  require(hasDiagnostic(omitted, "window_omitted_own_process"),
          "default own-window omission was silent");
  options.include_own_windows = true;
  const auto included = registry.enumerate(options);
  const auto* source = findTitle(included, title);
  require(source != nullptr && source->flags.own_process &&
              std::find(source->exclusions.begin(), source->exclusions.end(),
                        ExclusionReason::OwnProcess) != source->exclusions.end(),
          "included own window had no explicit own-process state");
  DestroyWindow(window);
  UnregisterClassW(class_name, window_class.hInstance);
}

void fixtureBehaviorIsObservableWithoutBlocking() {
  FixtureProcess fixture;
  const std::string primary_title =
      processUniqueTitle("Syrnike Source Fixture Primary");
  const std::string renamed_title =
      processUniqueTitle("Syrnike Source Fixture Renamed");
  const std::string second_title =
      processUniqueTitle("Syrnike Source Fixture Second");
  const std::string rapid_title =
      processUniqueTitle("Syrnike Source Fixture Rapid");
  const std::string recreated_title =
      processUniqueTitle("Syrnike Source Fixture Recreated");
  fixture.command("title " + primary_title);
  SourceRegistry registry(createWin32SourceEnumerator());
  EnumerationOptions options;
  options.kind = EnumerationOptions::Kind::Window;

  auto result = registry.enumerate(options);
  const auto* primary = findTitle(result, primary_title);
  require(primary != nullptr, "fixture primary window was not enumerated");
  require(primary->label == "source_window_fixture.exe" &&
              primary->label != primary->title,
          "window application label duplicated title or exposed another value");
  const std::string original_id = primary->id;

  fixture.command("title " + renamed_title);
  result = registry.enumerate(options);
  primary = findTitle(result, renamed_title);
  require(primary != nullptr && primary->id == original_id,
          "title change replaced fixture identity");

  fixture.command("second");
  fixture.command("second-title " + second_title);
  result = registry.enumerate(options);
  const auto* second = findTitle(result, second_title);
  require(second != nullptr,
          "second fixture window was not enumerated");
  const std::string second_id = second->id;
  fixture.command("close-second");
  result = registry.enumerate(options);
  require(findTitle(result, second_title) == nullptr &&
              std::any_of(result.removed.begin(), result.removed.end(),
                          [&](const SourceEnumeration::RemovedSource& removed) {
                            return removed.id == second_id;
                          }),
          "second fixture close was not reported as a typed removal");

  fixture.command("minimize");
  result = registry.enumerate(options);
  primary = findTitle(result, renamed_title);
  require(primary != nullptr && primary->flags.minimized,
          "minimize state was not reflected");
  fixture.command("restore");
  result = registry.enumerate(options);
  primary = findTitle(result, renamed_title);
  require(primary != nullptr && !primary->flags.minimized,
          "restore state was not reflected");

  fixture.command("hide");
  result = registry.enumerate(options);
  primary = findTitle(result, renamed_title);
  require(primary != nullptr && !primary->flags.visible &&
              std::find(primary->exclusions.begin(), primary->exclusions.end(),
                        ExclusionReason::NotVisible) != primary->exclusions.end(),
          "hidden fixture had no explicit visibility exclusion");
  fixture.command("show");

  fixture.command("hang");
  const auto hung_started = std::chrono::steady_clock::now();
  result = registry.enumerate(options);
  const auto hung_elapsed = std::chrono::steady_clock::now() - hung_started;
  require(findTitle(result, renamed_title) != nullptr,
          "hung UI thread blocked or removed safe enumeration");
  require(hung_elapsed <= kHungEnumerationBudget,
          "hung UI thread exceeded the 500 ms enumeration budget");
  std::cout << "hung-enumeration-ms="
            << std::chrono::duration_cast<std::chrono::milliseconds>(hung_elapsed).count()
            << '\n';
  fixture.command("unhang");

  const auto rapid_response = fixture.command("rapid");
  if (rapid_response.find("recycled=0") != std::string::npos) {
    std::cout << "rapid-recycle:skip "
              << rapid_response.substr(rapid_response.find("attempts=")) << '\n';
  }
  fixture.command("title " + rapid_title);
  result = registry.enumerate(options);
  primary = findTitle(result, rapid_title);
  require(primary != nullptr && primary->id != original_id,
          "rapid Win32 destroy/create reused the prior opaque ID");
  const std::string rapid_id = primary->id;

  fixture.command("destroy");
  result = registry.enumerate(options);
  require(findTitle(result, rapid_title) == nullptr,
          "destroyed source remained in registry");
  fixture.command("create");
  fixture.command("title " + recreated_title);
  result = registry.enumerate(options);
  primary = findTitle(result, recreated_title);
  require(primary != nullptr && primary->id != rapid_id,
          "recreated Win32 source reused removed opaque ID");
}

void closeDuringEnumerationIsRejectedAtThePostBarrier() {
  FixtureProcess fixture;
  const std::string second_title =
      processUniqueTitle("Syrnike Source Fixture Concurrent Second");
  fixture.command("second");
  fixture.command("second-title " + second_title);
  std::atomic<bool> close_during_scan{false};
  Win32SourceEnumeratorTestHooks hooks;
  hooks.before_post_barrier = [&] {
    if (close_during_scan.exchange(false)) fixture.command("close-second");
  };
  SourceRegistry registry(createWin32SourceEnumerator(std::move(hooks)));
  EnumerationOptions options;
  options.kind = EnumerationOptions::Kind::Window;
  const auto initial = registry.enumerate(options);
  const auto* second = findTitle(initial, second_title);
  require(second != nullptr, "concurrent-close fixture window was absent");
  const std::string id = second->id;
  close_during_scan = true;
  const auto closed = registry.enumerate(options);
  require(findTitle(closed, second_title) == nullptr &&
              std::any_of(closed.removed.begin(), closed.removed.end(),
                          [&](const SourceEnumeration::RemovedSource& removed) {
                            return removed.id == id;
                          }),
          "window closed between collection and final barrier escaped as available");
}

void deadEpochCapacityRecoversWithoutRotatingLiveIds() {
  FixtureProcess fixture;
  const std::string primary_title =
      processUniqueTitle("Syrnike Source Capacity Primary");
  const std::string second_title =
      processUniqueTitle("Syrnike Source Capacity Second");
  fixture.command("title " + primary_title);
  fixture.command("second");
  fixture.command("second-title " + second_title);
  Win32SourceEnumeratorTestHooks hooks;
  hooks.maximum_tracked_windows = 2;
  hooks.force_windows_truncated = true;
  hooks.include_window_title = [=](const std::string& title) {
    return title == primary_title || title == second_title;
  };
  SourceRegistry registry(createWin32SourceEnumerator(std::move(hooks)));
  EnumerationOptions options;
  options.kind = EnumerationOptions::Kind::Window;
  const auto initial = registry.enumerate(options);
  const auto* primary = findTitle(initial, primary_title);
  require(initial.ok && primary != nullptr && findTitle(initial, second_title),
          "capacity fixture did not fill the bounded lifetime tracker");
  const std::string primary_id = primary->id;

  fixture.command("close-second");
  require(registry.enumerate(options).ok,
          "dead lifetime epoch made the truncated tracker terminal");
  fixture.command("second");
  fixture.command("second-title " + second_title);
  const auto recovered = registry.enumerate(options);
  primary = findTitle(recovered, primary_title);
  require(recovered.ok && primary != nullptr && primary->id == primary_id &&
              findTitle(recovered, second_title) != nullptr,
          "dead epoch recovery failed or rotated a continuously live ID");
}

void ownerShutdownCancelsProductionEnumeration() {
  FixtureProcess fixture;
  const std::string title =
      processUniqueTitle("Syrnike Source Cancellation Primary");
  fixture.command("title " + title);
  std::mutex mutex;
  std::condition_variable changed;
  bool armed = false;
  bool entered = false;
  bool released = false;
  Win32SourceEnumeratorTestHooks hooks;
  hooks.include_window_title = [&](const std::string& candidate) {
    return candidate == title;
  };
  hooks.before_post_barrier = [&] {
    std::unique_lock lock(mutex);
    if (!armed) return;
    entered = true;
    changed.notify_all();
    changed.wait(lock, [&] { return released; });
  };
  hooks.on_cancel = [&] {
    {
      std::lock_guard lock(mutex);
      released = true;
    }
    changed.notify_all();
  };
  SourceRegistry registry(createWin32SourceEnumerator(std::move(hooks)));
  EnumerationOptions options;
  options.kind = EnumerationOptions::Kind::Window;
  const auto initial = registry.enumerate(options);
  const auto* source = findTitle(initial, title);
  require(source != nullptr, "cancellation fixture source was absent");
  const std::string id = source->id;
  {
    std::lock_guard lock(mutex);
    armed = true;
  }
  SourceEnumeration cancelled;
  std::thread active([&] { cancelled = registry.enumerate(options); });
  {
    std::unique_lock lock(mutex);
    changed.wait(lock, [&] { return entered; });
  }
  const auto started = std::chrono::steady_clock::now();
  registry.shutdown();
  const auto elapsed = std::chrono::steady_clock::now() - started;
  active.join();
  require(elapsed <= kHungEnumerationBudget && !cancelled.ok &&
              registry.resolve(id).status == ResolveStatus::Failed,
          "production adapter shutdown missed its 500 ms cancellation budget");
}

void delayedCloseIsRejectedAtTheFinalBarrier() {
  FixtureProcess fixture;
  const std::string second_title =
      processUniqueTitle("Syrnike Source Final Barrier Second");
  fixture.command("second");
  fixture.command("second-title " + second_title);
  std::atomic<bool> armed{false};
  Win32SourceEnumeratorTestHooks hooks;
  hooks.before_final_barrier = [&] {
    if (armed.exchange(false)) fixture.command("close-second");
  };
  SourceRegistry registry(createWin32SourceEnumerator(std::move(hooks)));
  EnumerationOptions options;
  options.kind = EnumerationOptions::Kind::Window;
  const auto initial = registry.enumerate(options);
  const auto* second = findTitle(initial, second_title);
  require(second != nullptr, "final-barrier fixture source was absent");
  const std::string id = second->id;
  armed = true;
  const auto closed = registry.enumerate(options);
  require(findTitle(closed, second_title) == nullptr &&
              std::any_of(closed.removed.begin(), closed.removed.end(),
                          [&](const SourceEnumeration::RemovedSource& removed) {
                            return removed.id == id;
                          }),
          "destroy after the first barrier escaped final validation");
}

void visibilityFlipCannotOmitALiveIdentity() {
  FixtureProcess fixture;
  const std::string title =
      processUniqueTitle("Syrnike Source Visibility Flip");
  fixture.command("title " + title);
  std::atomic<bool> armed{false};
  Win32SourceEnumeratorTestHooks hooks;
  hooks.include_window_title = [&](const std::string& candidate) {
    return candidate == title;
  };
  hooks.after_window_observed = [&](const std::string& candidate) {
    if (candidate == title && armed.exchange(false)) fixture.command("hide");
  };
  SourceRegistry registry(createWin32SourceEnumerator(std::move(hooks)));
  EnumerationOptions options;
  options.kind = EnumerationOptions::Kind::Window;
  const auto initial = registry.enumerate(options);
  const auto* source = findTitle(initial, title);
  require(source != nullptr, "visibility fixture source was absent");
  const std::string id = source->id;
  armed = true;
  const auto flipped = registry.enumerate(options);
  source = findTitle(flipped, title);
  require(source != nullptr && source->id == id && flipped.removed.empty(),
          "visibility change during the scan omitted a live HWND");
  fixture.command("show");
  const auto restored = registry.enumerate(options);
  source = findTitle(restored, title);
  require(source != nullptr && source->id == id,
          "visibility restore replaced the live opaque ID");
}

void monitorTopologyChangePreservesPriorRegistryState() {
  std::atomic<std::uint64_t> generation{1};
  std::atomic<bool> change_during_scan{false};
  Win32SourceEnumeratorTestHooks hooks;
  hooks.monitor_topology_generation = [&] { return generation.load(); };
  hooks.before_monitor_post_validation = [&] {
    if (change_during_scan.exchange(false)) ++generation;
  };
  SourceRegistry registry(createWin32SourceEnumerator(std::move(hooks)));
  EnumerationOptions options;
  options.kind = EnumerationOptions::Kind::Monitor;
  const auto initial = registry.enumerate(options);
  require(initial.ok && !initial.sources.empty(),
          "topology fixture had no initial monitor");
  const std::string id = initial.sources[0].id;
  change_during_scan = true;
  const auto changed = registry.enumerate(options);
  require(!changed.ok && changed.sources.empty() && changed.removed.empty(),
          "topology transition was committed as a complete monitor snapshot");
  const auto restored = registry.enumerate(options);
  require(restored.ok &&
              std::any_of(restored.sources.begin(), restored.sources.end(),
                          [&](const SourceSnapshot& monitor) {
                            return monitor.id == id;
                          }),
          "failed topology validation replaced a prior canonical monitor ID");
}

}  // namespace

int main() try {
  realMonitorsExposeMinimumMetadata();
  ownProcessWindowsAreExplicit();
  fixtureBehaviorIsObservableWithoutBlocking();
  closeDuringEnumerationIsRejectedAtThePostBarrier();
  deadEpochCapacityRecoversWithoutRotatingLiveIds();
  ownerShutdownCancelsProductionEnumeration();
  delayedCloseIsRejectedAtTheFinalBarrier();
  visibilityFlipCannotOmitALiveIdentity();
  monitorTopologyChangePreservesPriorRegistryState();
  std::cout << "source-win32-integration:ok\n";
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
