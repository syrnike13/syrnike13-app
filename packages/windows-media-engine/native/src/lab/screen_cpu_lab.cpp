#include "lab/screen_cpu_lab.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <exception>
#include <functional>
#include <iostream>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

#include <windows.h>

#include <tlhelp32.h>

#include "capture/monitor_capture.hpp"
#include "capture/wgc_monitor_capture.hpp"
#include "capture/wgc_window_capture.hpp"
#include "capture/window_capture.hpp"
#include "lab/reference_screen_sender.hpp"
#include "sources/win32_source_enumerator.hpp"

namespace syrnike::windows_media::lab {
namespace {

using namespace std::chrono_literals;
using capture::CaptureState;
using capture::MonitorCapture;
using capture::WindowCapture;
using screen::ScreenFramePipeline;
using sources::EnumerationOptions;
using sources::SourceKind;
using sources::SourceRegistry;
using sources::SourceSnapshot;

struct ProcessResources {
  DWORD handles = 0;
  DWORD threads = 0;
};

struct CycleResourceSample {
  std::uint64_t cycle = 0;
  long long handles_delta = 0;
  long long threads_delta = 0;
  std::uint64_t frames_published = 0;
  std::size_t pending_frames = 0;
  std::size_t active_frames = 0;
  std::uint64_t live_d3d_resources = 0;
};

struct ScreenEvidence {
  screen::ScreenFramePipelineStats pipeline;
  ReferenceScreenSenderStats sender;
  std::uint64_t capture_received = 0;
  std::uint64_t capture_dropped = 0;
  std::size_t capture_maximum_depth = 0;
  std::uint64_t outstanding_leases = 0;
  std::uint64_t resize_count = 0;
  std::uint64_t cycles = 0;
  std::uint64_t source_closed = 0;
  std::uint64_t d3d_live_objects = 0;
  std::uint64_t d3d_peak_objects = 0;
  std::vector<std::uint64_t> capture_age_ms;
  std::vector<std::uint64_t> readback_duration_us;
  std::vector<std::uint64_t> conversion_duration_us;
  std::vector<std::uint64_t> publish_duration_us;
  std::vector<CycleResourceSample> cycle_resources;
};

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

std::wstring executablePath() {
  std::wstring path(32768, L'\0');
  const DWORD size = GetModuleFileNameW(nullptr, path.data(),
                                        static_cast<DWORD>(path.size()));
  require(size > 0 && size < path.size(), "media_lab path is unavailable");
  path.resize(size);
  return path;
}

std::wstring siblingExecutable(const wchar_t* name) {
  auto path = executablePath();
  const auto separator = path.find_last_of(L"\\/");
  require(separator != std::wstring::npos,
          "media_lab executable directory is unavailable");
  return path.substr(0, separator + 1) + name;
}

DWORD currentThreadCount() {
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

ProcessResources currentResources() {
  DWORD handles = 0;
  require(GetProcessHandleCount(GetCurrentProcess(), &handles) != FALSE,
          "process handle count failed");
  return {handles, currentThreadCount()};
}

ProcessResources settleResources(const ProcessResources& baseline,
                                 DWORD handle_allowance,
                                 std::chrono::steady_clock::time_point deadline) {
  auto current = currentResources();
  while ((current.handles > baseline.handles + handle_allowance ||
          current.threads > baseline.threads) &&
         std::chrono::steady_clock::now() < deadline) {
    Sleep(10);
    current = currentResources();
  }
  return current;
}

ProcessResources stableCurrentResources(
    std::chrono::steady_clock::time_point deadline) {
  auto previous = currentResources();
  int stable_samples = 0;
  while (stable_samples < 5 && std::chrono::steady_clock::now() < deadline) {
    Sleep(10);
    const auto current = currentResources();
    if (current.handles == previous.handles &&
        current.threads == previous.threads) {
      ++stable_samples;
    } else {
      stable_samples = 0;
    }
    previous = current;
  }
  return previous;
}

class MonitorFixture final {
 public:
  explicit MonitorFixture(const SourceSnapshot& source) {
    require(source.kind == SourceKind::Monitor && source.monitor,
            "monitor fixture requires monitor metadata");
    const auto& bounds = source.monitor->logical_bounds;
    const auto point_x = bounds.x + bounds.width / 2;
    const auto point_y = bounds.y + bounds.height / 2;
    const auto executable = siblingExecutable(L"monitor_pattern_fixture.exe");
    std::wstring command = L"\"" + executable + L"\" --monitor-point " +
                           std::to_wstring(point_x) + L" " +
                           std::to_wstring(point_y);
    job_ = CreateJobObjectW(nullptr, nullptr);
    require(job_ != nullptr, "monitor fixture job creation failed");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(SetInformationJobObject(job_, JobObjectExtendedLimitInformation,
                                    &limits, sizeof(limits)) != FALSE,
            "monitor fixture job configuration failed");
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr,
                           FALSE, CREATE_SUSPENDED, nullptr, nullptr, &startup,
                           &process_) != FALSE,
            "monitor fixture failed to start");
    require(AssignProcessToJobObject(job_, process_.hProcess) != FALSE &&
                ResumeThread(process_.hThread) != static_cast<DWORD>(-1),
            "monitor fixture ownership failed");
    CloseHandle(process_.hThread);
    process_.hThread = nullptr;
    require(WaitForInputIdle(process_.hProcess, 3000) == 0,
            "monitor fixture did not become ready");
  }

  ~MonitorFixture() { cleanup(); }

 private:
  void cleanup() noexcept {
    if (process_.hThread) CloseHandle(process_.hThread);
    if (process_.hProcess) {
      if (WaitForSingleObject(process_.hProcess, 0) == WAIT_TIMEOUT) {
        (void)TerminateProcess(process_.hProcess, 0);
        (void)WaitForSingleObject(process_.hProcess, 1000);
      }
      CloseHandle(process_.hProcess);
    }
    if (job_) CloseHandle(job_);
    process_ = {};
    job_ = nullptr;
  }

  HANDLE job_ = nullptr;
  PROCESS_INFORMATION process_{};
};

class WindowFixture final {
 public:
  WindowFixture() {
    SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
    HANDLE child_input = nullptr;
    HANDLE child_output = nullptr;
    require(CreatePipe(&child_input, &input_, &security, 0) != FALSE &&
                CreatePipe(&output_, &child_output, &security, 0) != FALSE,
            "window fixture pipe creation failed");
    require(SetHandleInformation(input_, HANDLE_FLAG_INHERIT, 0) != FALSE &&
                SetHandleInformation(output_, HANDLE_FLAG_INHERIT, 0) != FALSE,
            "window fixture pipe inheritance failed");
    job_ = CreateJobObjectW(nullptr, nullptr);
    require(job_ != nullptr, "window fixture job creation failed");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    require(SetInformationJobObject(job_, JobObjectExtendedLimitInformation,
                                    &limits, sizeof(limits)) != FALSE,
            "window fixture job configuration failed");

    const auto executable = siblingExecutable(L"source_window_fixture.exe");
    std::wstring command = L"\"" + executable + L"\"";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = child_input;
    startup.hStdOutput = child_output;
    startup.hStdError = child_output;
    require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr,
                           TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr,
                           nullptr, &startup, &process_) != FALSE,
            "window fixture failed to start");
    CloseHandle(child_input);
    CloseHandle(child_output);
    require(AssignProcessToJobObject(job_, process_.hProcess) != FALSE &&
                ResumeThread(process_.hThread) != static_cast<DWORD>(-1),
            "window fixture ownership failed");
    CloseHandle(process_.hThread);
    process_.hThread = nullptr;
    require(readLine(5s) == "READY", "window fixture did not become ready");
  }

  ~WindowFixture() { cleanup(); }

  void command(const std::string& value) {
    const std::string line = value + "\n";
    DWORD written = 0;
    require(WriteFile(input_, line.data(), static_cast<DWORD>(line.size()),
                      &written, nullptr) != FALSE && written == line.size(),
            "window fixture command failed");
    const auto response = readLine(5s);
    require(response.rfind("OK ", 0) == 0,
            "window fixture rejected command: " + response);
  }

  static constexpr const char* title() {
    return "Syrnike Source Fixture Primary";
  }

 private:
  std::string readLine(std::chrono::milliseconds timeout) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    std::string line;
    while (std::chrono::steady_clock::now() < deadline) {
      DWORD available = 0;
      require(PeekNamedPipe(output_, nullptr, 0, nullptr, &available, nullptr) !=
                  FALSE,
              "window fixture output failed");
      if (available == 0) {
        if (WaitForSingleObject(process_.hProcess, 0) != WAIT_TIMEOUT)
          throw std::runtime_error("window fixture exited unexpectedly");
        Sleep(5);
        continue;
      }
      char value = 0;
      DWORD read = 0;
      require(ReadFile(output_, &value, 1, &read, nullptr) != FALSE && read == 1,
              "window fixture output read failed");
      if (value == '\n') {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        return line;
      }
      line.push_back(value);
    }
    throw std::runtime_error("window fixture response deadline exceeded");
  }

  void cleanup() noexcept {
    if (input_) {
      const std::string quit = "quit\n";
      DWORD written = 0;
      (void)WriteFile(input_, quit.data(), static_cast<DWORD>(quit.size()),
                      &written, nullptr);
    }
    if (process_.hProcess &&
        WaitForSingleObject(process_.hProcess, 1000) == WAIT_TIMEOUT) {
      (void)TerminateProcess(process_.hProcess, 0);
      (void)WaitForSingleObject(process_.hProcess, 1000);
    }
    if (process_.hThread) CloseHandle(process_.hThread);
    if (process_.hProcess) CloseHandle(process_.hProcess);
    if (input_) CloseHandle(input_);
    if (output_) CloseHandle(output_);
    if (job_) CloseHandle(job_);
    process_ = {};
    input_ = nullptr;
    output_ = nullptr;
    job_ = nullptr;
  }

  HANDLE input_ = nullptr;
  HANDLE output_ = nullptr;
  HANDLE job_ = nullptr;
  PROCESS_INFORMATION process_{};
};

const SourceSnapshot& primaryMonitor(const sources::SourceEnumeration& values) {
  const auto primary = std::find_if(
      values.sources.begin(), values.sources.end(),
      [](const SourceSnapshot& value) {
        return value.kind == SourceKind::Monitor && value.flags.primary;
      });
  if (primary != values.sources.end()) return *primary;
  const auto first = std::find_if(
      values.sources.begin(), values.sources.end(),
      [](const SourceSnapshot& value) { return value.kind == SourceKind::Monitor; });
  require(first != values.sources.end(), "no monitor is available");
  return *first;
}

const SourceSnapshot& fixtureWindow(const sources::SourceEnumeration& values) {
  const auto found = std::find_if(
      values.sources.begin(), values.sources.end(),
      [](const SourceSnapshot& value) {
        return value.kind == SourceKind::Window &&
               value.title == WindowFixture::title();
      });
  require(found != values.sources.end(), "window fixture source is unavailable");
  return *found;
}

template <typename Values>
void appendSamples(std::vector<std::uint64_t>& destination,
                   const Values& source) {
  const auto available = kMaximumReferenceScreenTimingSamples -
                         (std::min)(destination.size(),
                                    kMaximumReferenceScreenTimingSamples);
  const auto count = (std::min)(available, source.size());
  destination.insert(destination.end(), source.begin(), source.begin() + count);
}

void merge(ScreenEvidence& target, const ScreenEvidence& value) {
  target.pipeline.submitted += value.pipeline.submitted;
  target.pipeline.accepted += value.pipeline.accepted;
  target.pipeline.superseded += value.pipeline.superseded;
  target.pipeline.dropped += value.pipeline.dropped;
  target.pipeline.too_old += value.pipeline.too_old;
  target.pipeline.released += value.pipeline.released;
  target.pipeline.maximum_depth =
      (std::max)(target.pipeline.maximum_depth, value.pipeline.maximum_depth);
  target.pipeline.pending += value.pipeline.pending;
  target.pipeline.active += value.pipeline.active;
  target.sender.published += value.sender.published;
  target.sender.publication_failures += value.sender.publication_failures;
  target.sender.source_generation_transitions +=
      value.sender.source_generation_transitions;
  target.capture_received += value.capture_received;
  target.capture_dropped += value.capture_dropped;
  target.capture_maximum_depth =
      (std::max)(target.capture_maximum_depth, value.capture_maximum_depth);
  target.outstanding_leases += value.outstanding_leases;
  target.resize_count += value.resize_count;
  target.cycles += value.cycles;
  target.source_closed += value.source_closed;
  target.d3d_live_objects += value.d3d_live_objects;
  target.d3d_peak_objects =
      (std::max)(target.d3d_peak_objects, value.d3d_peak_objects);
  target.cycle_resources.insert(target.cycle_resources.end(),
                                value.cycle_resources.begin(),
                                value.cycle_resources.end());
  appendSamples(target.capture_age_ms, value.sender.capture_age_ms);
  appendSamples(target.readback_duration_us, value.sender.readback_duration_us);
  appendSamples(target.conversion_duration_us,
                value.sender.conversion_duration_us);
  appendSamples(target.publish_duration_us, value.sender.publish_duration_us);
}

template <typename Capture>
ScreenEvidence driveCapture(Capture& capture, ReferenceScreenSender& sender,
                            const std::shared_ptr<ScreenFramePipeline>& pipeline,
                            std::uint64_t target_frames,
                            const std::function<void()>& wait_until_ready,
                            const std::function<void(ReferenceScreenSender&)>& action = {}) {
  require(capture.start().ok, "WGC screen capture failed to start");
  const auto sender_started = sender.start();
  require(sender_started.ok, "screen publication failed: " +
                                 sender_started.failure);
  if (wait_until_ready) wait_until_ready();
  std::cout << "publisher: screen track published" << std::endl;
  std::atomic_bool producer_running{true};
  std::thread producer([&] {
    while (producer_running.load()) {
      auto lease = capture.waitForFrame(50ms);
      if (lease) {
        (void)pipeline->submit(std::move(*lease));
      } else if (capture.state() == CaptureState::Failed ||
                 capture.state() == CaptureState::Stopped) {
        break;
      }
    }
  });

  std::exception_ptr operation_failure;
  try {
    if (action) action(sender);
    if (target_frames > 0) {
      require(sender.waitForPublished(
                  target_frames, std::chrono::steady_clock::now() + 45s),
              "screen sender publication deadline exceeded");
    }
  } catch (...) {
    operation_failure = std::current_exception();
  }
  producer_running.store(false);
  const auto sender_stopped =
      sender.stop(std::chrono::steady_clock::now() + 5s);
  const auto capture_stopped = capture.stop(5s);
  producer.join();
  if (operation_failure) std::rethrow_exception(operation_failure);
  require(sender_stopped.ok, "screen sender stop failed: " +
                                 sender_stopped.failure);
  require(capture_stopped.ok, "screen capture stop failed");

  ScreenEvidence evidence;
  evidence.pipeline = pipeline->stats();
  evidence.sender = sender.stats();
  evidence.cycles = 1;
  if constexpr (std::is_same_v<Capture, MonitorCapture>) {
    const auto stats = capture.stats();
    evidence.capture_received = stats.received_frames;
    evidence.capture_dropped = stats.dropped_frames;
    evidence.capture_maximum_depth = stats.maximum_queue_depth;
    evidence.outstanding_leases = stats.outstanding_leases;
  } else {
    const auto stats = capture.stats();
    evidence.capture_received = stats.frames.received_frames;
    evidence.capture_dropped = stats.frames.dropped_frames;
    evidence.capture_maximum_depth = stats.frames.maximum_queue_depth;
    evidence.outstanding_leases = stats.frames.outstanding_leases;
    evidence.resize_count = stats.resize_count;
    if (const auto failure = capture.terminalFailure();
        failure && failure->code == "source_closed") {
      evidence.source_closed = 1;
    }
  }
  return evidence;
}

ScreenEvidence runMonitorCycle(SourceRegistry& registry,
                               const std::string& source_id,
                               const std::shared_ptr<livekit::Room>& room,
                               const std::string& mode,
                               const std::function<void()>& wait_until_ready,
                               std::uint64_t target_override = 0,
                               const std::function<void()>& during_publication = {},
                               const std::function<void(
                                   std::chrono::steady_clock::time_point)>&
                                   wait_until_unpublished = {}) {
  auto backend = capture::createWgcMonitorCaptureBackend();
  auto* diagnostics = backend.get();
  MonitorCapture capture(registry, source_id, std::move(backend));
  auto pipeline = std::make_shared<ScreenFramePipeline>();
  ReferenceScreenSenderOptions options;
  options.wait_for_unpublish = wait_until_unpublished;
  if (mode == "screen-cpu-slow-pipeline" ||
      mode == "screen-cpu-stop-during-conversion")
    options.artificial_conversion_delay = 100ms;
  ReferenceScreenSender sender(room, pipeline, options);
  std::uint64_t target = target_override > 0
                             ? target_override
                             : (mode == "screen-cpu-slow-pipeline" ? 60 : 180);
  std::function<void(ReferenceScreenSender&)> action;
  if (mode == "screen-cpu-stop-during-conversion") {
    target = 0;
    action = [&](ReferenceScreenSender& active_sender) {
      require(active_sender.waitForPublished(
                  5, std::chrono::steady_clock::now() + 20s),
              "stop-during-conversion precondition frames were not published");
      const auto deadline = std::chrono::steady_clock::now() + 5s;
      while (pipeline->stats().active == 0 &&
             std::chrono::steady_clock::now() < deadline) {
        Sleep(1);
      }
      require(pipeline->stats().active == 1,
              "converter did not expose an active owned frame before stop");
    };
  } else if (mode == "screen-cpu-room-disconnect") {
    target = 60;
    action = [&](ReferenceScreenSender& active_sender) {
      require(active_sender.waitForPublished(
                  30, std::chrono::steady_clock::now() + 20s),
              "room-disconnect precondition frames were not published");
      require(static_cast<bool>(during_publication),
              "room-disconnect mode requires an interruption callback");
      during_publication();
    };
  }
  auto evidence = driveCapture(
      capture, sender, pipeline, target, wait_until_ready, action);
  const auto d3d = diagnostics->diagnostics();
  evidence.d3d_live_objects = d3d.live_engine_objects;
  evidence.d3d_peak_objects = d3d.peak_engine_objects;
  return evidence;
}

ScreenEvidence runWindowCycle(SourceRegistry& registry,
                              const std::string& source_id,
                              const std::shared_ptr<livekit::Room>& room,
                              const std::string& mode,
                              WindowFixture& fixture,
                              const std::function<void()>& wait_until_ready,
                              std::uint64_t target_override = 0,
                              const std::function<void(
                                  std::chrono::steady_clock::time_point)>&
                                  wait_until_unpublished = {}) {
  auto backend = capture::createWgcWindowCaptureBackend();
  auto* diagnostics = backend.get();
  WindowCapture capture(registry, source_id, std::move(backend));
  auto pipeline = std::make_shared<ScreenFramePipeline>();
  ReferenceScreenSenderOptions sender_options;
  sender_options.wait_for_unpublish = wait_until_unpublished;
  ReferenceScreenSender sender(room, pipeline, std::move(sender_options));
  std::function<void(ReferenceScreenSender&)> action;
  std::uint64_t target = mode == "screen-cpu-repeat" ? 30 : 180;
  if (mode == "screen-cpu-resize") {
    target = 120;
    action = [&](ReferenceScreenSender& active_sender) {
      require(active_sender.waitForPublished(
                  40, std::chrono::steady_clock::now() + 20s),
              "resize precondition frames were not published");
      fixture.command("resize 900 540");
    };
  } else if (mode == "screen-cpu-source-close") {
    target = 0;
    action = [&](ReferenceScreenSender& active_sender) {
      require(active_sender.waitForPublished(
                  40, std::chrono::steady_clock::now() + 20s),
              "source-close precondition frames were not published");
      fixture.command("close-after 5");
      const auto close_deadline = std::chrono::steady_clock::now() + 5s;
      bool closed = false;
      while (!closed && std::chrono::steady_clock::now() < close_deadline) {
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
            close_deadline - std::chrono::steady_clock::now());
        const auto event = capture.waitForEvent((std::max)(remaining, 1ms));
        if (!event) continue;
        if (event->kind == capture::WindowCaptureEventKind::SourceClosed) {
          closed = true;
        } else if (event->kind ==
                   capture::WindowCaptureEventKind::CaptureFailed) {
          throw std::runtime_error(
              "window close became capture failure: " +
              (event->failure ? event->failure->code : std::string("unknown")));
        }
      }
      require(closed, "window source close deadline exceeded");
    };
  }
  if (target_override > 0) {
    target = target_override;
    action = {};
  }
  auto evidence = driveCapture(capture, sender, pipeline, target,
                               wait_until_ready, action);
  const auto d3d = diagnostics->diagnostics();
  evidence.d3d_live_objects = d3d.live_engine_objects;
  evidence.d3d_peak_objects = d3d.peak_engine_objects;
  if (mode == "screen-cpu-source-close") evidence.source_closed = 1;
  return evidence;
}

ScreenEvidence runWindowRepeat(
    SourceRegistry& registry, const std::string& source_id,
    const std::shared_ptr<livekit::Room>& room, int cycles,
    const std::function<void()>& wait_until_ready,
    const std::function<void(std::chrono::steady_clock::time_point)>&
        wait_until_unpublished) {
  auto backend = capture::createWgcWindowCaptureBackend();
  auto* diagnostics = backend.get();
  WindowCapture capture(registry, source_id, std::move(backend));
  auto pipeline = std::make_shared<ScreenFramePipeline>();
  ReferenceScreenSenderOptions sender_options;
  sender_options.reusable_publication = true;
  sender_options.wait_for_unpublish = wait_until_unpublished;
  ReferenceScreenSender sender(room, pipeline, std::move(sender_options));

  require(capture.start().ok, "repeat WGC capture failed to start");
  std::atomic_bool producer_running{true};
  std::thread producer([&] {
    while (producer_running.load()) {
      auto lease = capture.waitForFrame(50ms);
      if (lease) {
        (void)pipeline->submit(std::move(*lease));
      } else if (capture.state() == CaptureState::Failed ||
                 capture.state() == CaptureState::Stopped) {
        break;
      }
    }
  });

  std::exception_ptr operation_failure;
  std::vector<CycleResourceSample> cycle_resources;
  cycle_resources.reserve(static_cast<std::size_t>(cycles));
  std::uint64_t previous_published = 0;
  try {
    const auto capture_warmup_deadline =
        std::chrono::steady_clock::now() + 5s;
    while (capture.stats().frames.received_frames < 30 &&
           std::chrono::steady_clock::now() < capture_warmup_deadline) {
      Sleep(10);
    }
    require(capture.stats().frames.received_frames >= 30,
            "repeat capture did not reach its resource baseline");

    ProcessResources publication_baseline;

    for (int cycle = 0; cycle < cycles; ++cycle) {
      if (cycle > 0) {
        require(pipeline->restart(),
                "repeat pipeline did not return to its stopped baseline");
      }
      const auto started = sender.start();
      require(started.ok, "repeat screen publication failed: " +
                              started.failure);
      if (wait_until_ready) wait_until_ready();
      std::cout << "publisher: screen track published" << std::endl;
      require(sender.waitForPublished(
                  previous_published + 30ULL,
                  std::chrono::steady_clock::now() + 45s),
              "repeat screen publication deadline exceeded");
      const auto stopped =
          sender.stop(std::chrono::steady_clock::now() + 5s);
      require(stopped.ok, "repeat screen stop failed: " + stopped.failure);
      const auto pipeline_stats = pipeline->stats();
      const auto sender_stats = sender.stats();
      const auto d3d_stats = diagnostics->diagnostics();
      ProcessResources resources;
      if (cycle == 0) {
        resources = stableCurrentResources(
            std::chrono::steady_clock::now() + 5s);
        publication_baseline = resources;
      } else {
        resources = settleResources(
            publication_baseline, 8, std::chrono::steady_clock::now() + 5s);
      }
      cycle_resources.push_back({
          static_cast<std::uint64_t>(cycle + 1),
          static_cast<long long>(resources.handles) -
              publication_baseline.handles,
          static_cast<long long>(resources.threads) -
              publication_baseline.threads,
          sender_stats.published - previous_published,
          pipeline_stats.pending,
          pipeline_stats.active,
          d3d_stats.live_engine_objects,
      });
      previous_published = sender_stats.published;
      if (resources.threads > publication_baseline.threads) {
        throw std::runtime_error(
            "repeat publication resources did not return to baseline at cycle " +
            std::to_string(cycle + 1) + ": handles delta=" +
            std::to_string(static_cast<long long>(resources.handles) -
                           publication_baseline.handles) +
            ", threads delta=" +
            std::to_string(static_cast<long long>(resources.threads) -
                           publication_baseline.threads));
      }
      require(pipeline_stats.pending == 0 && pipeline_stats.active == 0,
              "repeat publication retained a pipeline frame after stop");
    }
  } catch (...) {
    operation_failure = std::current_exception();
  }
  (void)sender.stop(std::chrono::steady_clock::now() + 5s);
  producer_running.store(false);
  const auto capture_stopped = capture.stop(5s);
  producer.join();
  if (operation_failure) std::rethrow_exception(operation_failure);
  require(capture_stopped.ok, "repeat screen capture stop failed");

  ScreenEvidence evidence;
  evidence.pipeline = pipeline->stats();
  evidence.sender = sender.stats();
  evidence.cycles = static_cast<std::uint64_t>(cycles);
  evidence.cycle_resources = std::move(cycle_resources);
  const auto stats = capture.stats();
  evidence.capture_received = stats.frames.received_frames;
  evidence.capture_dropped = stats.frames.dropped_frames;
  evidence.capture_maximum_depth = stats.frames.maximum_queue_depth;
  evidence.outstanding_leases = stats.frames.outstanding_leases;
  evidence.resize_count = stats.resize_count;
  const auto d3d = diagnostics->diagnostics();
  evidence.d3d_live_objects = d3d.live_engine_objects;
  evidence.d3d_peak_objects = d3d.peak_engine_objects;
  return evidence;
}

std::uint64_t percentile(std::vector<std::uint64_t> values, double ratio) {
  if (values.empty()) return 0;
  std::sort(values.begin(), values.end());
  const auto index = (std::min)(
      values.size() - 1,
      static_cast<std::size_t>(
          std::ceil(static_cast<double>(values.size()) * ratio) - 1));
  return values[index];
}

std::string reportJson(const std::string& mode, const ScreenEvidence& evidence,
                       const ProcessResources& before,
                       const ProcessResources& after) {
  const auto handle_delta = static_cast<long long>(after.handles) - before.handles;
  const auto thread_delta = static_cast<long long>(after.threads) - before.threads;
  const bool slow_ok = mode != "screen-cpu-slow-pipeline" ||
                       evidence.pipeline.dropped > 0;
  const bool resize_ok = mode != "screen-cpu-resize" ||
                         evidence.resize_count > 0;
  const bool close_ok = mode != "screen-cpu-source-close" ||
                        evidence.source_closed > 0;
  const bool repeat_resources_ok =
      mode != "screen-cpu-repeat" ||
      (handle_delta <= 12 && thread_delta <= 0 &&
       std::all_of(evidence.cycle_resources.begin(),
                   evidence.cycle_resources.end(),
                   [](const CycleResourceSample& sample) {
                     return sample.handles_delta <= 32 &&
                            sample.threads_delta <= 0 &&
                            sample.pending_frames == 0 &&
                            sample.active_frames == 0;
                   }));
  const bool ok = evidence.sender.published > 0 &&
                  evidence.sender.publication_failures == 0 && slow_ok &&
                  resize_ok && close_ok && repeat_resources_ok &&
                  evidence.pipeline.maximum_depth <=
                      screen::kScreenFramePipelineCapacity &&
                  evidence.pipeline.pending == 0 &&
                  evidence.pipeline.active == 0 &&
                  evidence.pipeline.released == evidence.pipeline.submitted &&
                  evidence.outstanding_leases == 0 &&
                  evidence.d3d_live_objects == 0;
  std::ostringstream output;
  output << "{\"schemaVersion\":1,\"accepted\":"
         << (ok ? "true" : "false") << ",\"mode\":\"" << mode
         << "\",\"referencePath\":\"cpu-non-production\",\"profile\":{"
         << "\"width\":" << screen::kCpuReferenceWidth
         << ",\"height\":" << screen::kCpuReferenceHeight
         << ",\"fps\":" << screen::kCpuReferenceFramesPerSecond
         << "},\"pipeline\":{\"capacity\":"
         << screen::kScreenFramePipelineCapacity
         << ",\"maximumAgeMs\":"
         << screen::kScreenFrameMaximumAge.count()
         << ",\"submitted\":" << evidence.pipeline.submitted
         << ",\"accepted\":" << evidence.pipeline.accepted
         << ",\"superseded\":" << evidence.pipeline.superseded
         << ",\"dropped\":" << evidence.pipeline.dropped
         << ",\"tooOld\":" << evidence.pipeline.too_old
         << ",\"released\":" << evidence.pipeline.released
         << ",\"maximumDepth\":" << evidence.pipeline.maximum_depth
         << ",\"pending\":" << evidence.pipeline.pending
         << ",\"active\":" << evidence.pipeline.active
         << "},\"capture\":{\"received\":" << evidence.capture_received
         << ",\"dropped\":" << evidence.capture_dropped
         << ",\"maximumDepth\":" << evidence.capture_maximum_depth
         << ",\"outstandingLeases\":" << evidence.outstanding_leases
         << ",\"resizeCount\":" << evidence.resize_count
         << ",\"sourceClosed\":" << evidence.source_closed
         << "},\"sender\":{\"published\":" << evidence.sender.published
         << ",\"publicationFailures\":"
         << evidence.sender.publication_failures
         << ",\"generationTransitions\":"
         << evidence.sender.source_generation_transitions
         << "},\"timing\":{\"captureAgeMs\":{\"p50\":"
         << percentile(evidence.capture_age_ms, 0.50)
         << ",\"p95\":" << percentile(evidence.capture_age_ms, 0.95)
         << ",\"max\":" << percentile(evidence.capture_age_ms, 1.0)
         << "},\"readbackUs\":{\"p50\":"
         << percentile(evidence.readback_duration_us, 0.50)
         << ",\"p95\":" << percentile(evidence.readback_duration_us, 0.95)
         << "},\"convertUs\":{\"p50\":"
         << percentile(evidence.conversion_duration_us, 0.50)
         << ",\"p95\":" << percentile(evidence.conversion_duration_us, 0.95)
         << "},\"publishUs\":{\"p50\":"
         << percentile(evidence.publish_duration_us, 0.50)
         << ",\"p95\":" << percentile(evidence.publish_duration_us, 0.95)
         << "}},\"resources\":{\"cycles\":" << evidence.cycles
         << ",\"handlesDelta\":" << handle_delta
         << ",\"threadsDelta\":" << thread_delta
         << ",\"d3dLiveObjects\":" << evidence.d3d_live_objects
         << ",\"d3dPeakObjects\":" << evidence.d3d_peak_objects
         << ",\"series\":[";
  for (std::size_t index = 0; index < evidence.cycle_resources.size(); ++index) {
    if (index > 0) output << ',';
    const auto& sample = evidence.cycle_resources[index];
    output << "{\"cycle\":" << sample.cycle
           << ",\"handlesDelta\":" << sample.handles_delta
           << ",\"threadsDelta\":" << sample.threads_delta
           << ",\"publishedTracksAfterStop\":0"
           << ",\"reusableTransceivers\":null"
           << ",\"pendingPublications\":0"
           << ",\"framesPublished\":" << sample.frames_published
           << ",\"pendingFrames\":" << sample.pending_frames
           << ",\"activeFrames\":" << sample.active_frames
           << ",\"liveD3dResources\":" << sample.live_d3d_resources
           << '}';
  }
  output << "]}}";
  return output.str();
}

}  // namespace

bool isScreenCpuMode(const std::string& mode) noexcept {
  return mode == "screen-cpu-monitor" || mode == "screen-cpu-window" ||
         mode == "screen-cpu-slow-pipeline" ||
         mode == "screen-cpu-resize" || mode == "screen-cpu-repeat" ||
         mode == "screen-cpu-source-close" ||
         mode == "screen-cpu-stop-during-conversion" ||
         mode == "screen-cpu-room-disconnect";
}

void warmScreenCpuLab(const std::shared_ptr<livekit::Room>& room,
                      const std::string& mode,
                      const std::function<void()>& wait_until_ready,
                      const std::function<void(
                          std::chrono::steady_clock::time_point)>&
                          wait_until_unpublished) {
  require(static_cast<bool>(room), "screen CPU warm-up requires Room");
  if (mode == "screen-cpu-monitor" ||
      mode == "screen-cpu-slow-pipeline" ||
      mode == "screen-cpu-stop-during-conversion" ||
      mode == "screen-cpu-room-disconnect") {
    SourceRegistry registry(sources::createWin32SourceEnumerator());
    EnumerationOptions options;
    options.kind = EnumerationOptions::Kind::Monitor;
    const auto values = registry.enumerate(options);
    require(values.ok, "monitor warm-up enumeration failed");
    const auto selected = primaryMonitor(values);
    MonitorFixture fixture(selected);
    (void)runMonitorCycle(registry, selected.id, room, "screen-cpu-monitor",
                          wait_until_ready, 30, {}, wait_until_unpublished);
  } else {
    WindowFixture fixture;
    SourceRegistry registry(sources::createWin32SourceEnumerator());
    EnumerationOptions options;
    options.kind = EnumerationOptions::Kind::Window;
    const auto values = registry.enumerate(options);
    require(values.ok, "window warm-up enumeration failed");
    const auto source_id = fixtureWindow(values).id;
    (void)runWindowCycle(registry, source_id, room, "screen-cpu-window",
                         fixture, wait_until_ready, 30,
                         wait_until_unpublished);
  }
}

std::string runScreenCpuLab(const std::shared_ptr<livekit::Room>& room,
                            const std::string& mode, int cycles,
                            const std::function<void()>& wait_until_ready,
                            const std::function<void(
                                std::chrono::steady_clock::time_point)>&
                                wait_until_unpublished,
                            const std::function<void()>& during_publication) {
  require(static_cast<bool>(room),
          "screen CPU lab requires a connected Room");
  require(isScreenCpuMode(mode), "unknown screen CPU lab mode");
  const auto before = currentResources();
  ScreenEvidence evidence;
  if (mode == "screen-cpu-monitor" ||
      mode == "screen-cpu-slow-pipeline" ||
      mode == "screen-cpu-stop-during-conversion" ||
      mode == "screen-cpu-room-disconnect") {
    SourceRegistry registry(sources::createWin32SourceEnumerator());
    EnumerationOptions options;
    options.kind = EnumerationOptions::Kind::Monitor;
    const auto values = registry.enumerate(options);
    require(values.ok, "monitor enumeration failed");
    const auto selected = primaryMonitor(values);
    const auto source_id = selected.id;
    MonitorFixture fixture(selected);
    merge(evidence, runMonitorCycle(registry, source_id, room, mode,
                                    wait_until_ready, 0,
                                    during_publication,
                                    wait_until_unpublished));
  } else {
    WindowFixture fixture;
    SourceRegistry registry(sources::createWin32SourceEnumerator());
    EnumerationOptions options;
    options.kind = EnumerationOptions::Kind::Window;
    const auto values = registry.enumerate(options);
    require(values.ok, "window enumeration failed");
    const auto source_id = fixtureWindow(values).id;
    if (mode == "screen-cpu-repeat") {
      merge(evidence,
            runWindowRepeat(registry, source_id, room, cycles,
                            wait_until_ready, wait_until_unpublished));
    } else {
      merge(evidence,
            runWindowCycle(registry, source_id, room, mode, fixture,
                           wait_until_ready, 0,
                           wait_until_unpublished));
    }
  }
  const auto after = settleResources(before, 12,
                                     std::chrono::steady_clock::now() + 5s);
  return reportJson(mode, evidence, before, after);
}

}  // namespace syrnike::windows_media::lab
