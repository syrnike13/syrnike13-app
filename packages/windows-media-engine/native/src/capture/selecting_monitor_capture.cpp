#include "capture/selecting_monitor_capture.hpp"
#include "capture/wgc_monitor_capture.hpp"
#include <condition_variable>
#include <thread>
#include <algorithm>

namespace syrnike::windows_media::capture {
namespace {
using Clock = std::chrono::steady_clock;
std::int64_t milliseconds() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch())
      .count();
}
CaptureEnvironment environment() {
  CaptureEnvironment result;
  const auto desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!desktop)
    result.desktop_available = false;
  else {
    wchar_t input[256]{}, current[256]{};
    DWORD bytes = 0;
    result.desktop_available =
        GetUserObjectInformationW(desktop, UOI_NAME, input, sizeof(input), &bytes) &&
        GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, current,
                                  sizeof(current), &bytes) &&
        wcscmp(input, current) == 0;
    CloseDesktop(desktop);
  }
  std::uint64_t hash = 1469598103934665603ULL;
  for (DWORD index = 0;; ++index) {
    DISPLAY_DEVICEW display{};
    display.cb = sizeof(display);
    if (!EnumDisplayDevicesW(nullptr, index, &display, 0)) break;
    if (!(display.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP)) continue;
    for (auto value : display.DeviceName) hash = (hash ^ value) * 1099511628211ULL;
    DEVMODEW mode{};
    mode.dmSize = sizeof(mode);
    if (EnumDisplaySettingsW(display.DeviceName, ENUM_CURRENT_SETTINGS, &mode)) {
      const DWORD values[]{mode.dmPelsWidth,
                           mode.dmPelsHeight,
                           mode.dmDisplayOrientation,
                           mode.dmDisplayFrequency,
                           mode.dmBitsPerPel,
                           static_cast<DWORD>(mode.dmPosition.x),
                           static_cast<DWORD>(mode.dmPosition.y)};
      for (auto value : values) hash = (hash ^ value) * 1099511628211ULL;
    }
  }
  result.display_revision = hash;
  std::array<DISPLAYCONFIG_PATH_INFO, 64> paths{};
  std::array<DISPLAYCONFIG_MODE_INFO, 128> modes{};
  UINT32 path_count = static_cast<UINT32>(paths.size()),
         mode_count = static_cast<UINT32>(modes.size());
  if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &path_count, paths.data(), &mode_count,
                         modes.data(), nullptr) == ERROR_SUCCESS) {
    std::uint64_t color_hash = 1469598103934665603ULL;
    bool complete = true;
    for (UINT32 index = 0; index < path_count; ++index) {
      DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO color{};
      color.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO;
      color.header.size = sizeof(color);
      color.header.adapterId = paths[index].targetInfo.adapterId;
      color.header.id = paths[index].targetInfo.id;
      if (DisplayConfigGetDeviceInfo(&color.header) != ERROR_SUCCESS) {
        complete = false;
        break;
      }
      color_hash = (color_hash ^ color.value ^ color.bitsPerColorChannel ^
                    static_cast<unsigned>(color.colorEncoding)) *
                   1099511628211ULL;
    }
    if (complete) result.hdr_revision = color_hash;
  }
  return result;
}
BackendObservation observation(CaptureFailureKind kind) {
  switch (kind) {
    case CaptureFailureKind::unsupported:
      return BackendObservation::unsupported;
    case CaptureFailureKind::source_unavailable:
      return BackendObservation::source_unavailable;
    case CaptureFailureKind::access_lost:
      return BackendObservation::access_lost;
    case CaptureFailureKind::device_removed:
      return BackendObservation::device_removed;
    case CaptureFailureKind::secure_desktop:
      return BackendObservation::secure_desktop;
    default:
      return BackendObservation::prepare_failed;
  }
}
struct Mailbox {
  std::mutex mutex;
  std::condition_variable changed;
  bool accepting = true;
  bool prepared = false, stop_requested = false, worker_done = false;
  Clock::time_point stop_deadline{};
  CaptureStopResult stop_result;
  std::optional<BackendFrame> frame;
  std::optional<CaptureFailure> failure;
  std::shared_ptr<std::atomic_size_t> retained = std::make_shared<std::atomic_size_t>(0);
};
struct RetainedFrame {
  std::shared_ptr<FrameResource> resource;
  std::shared_ptr<std::atomic_size_t> count;
  RetainedFrame(std::shared_ptr<FrameResource> frame, std::shared_ptr<std::atomic_size_t> counter)
      : resource(std::move(frame)), count(std::move(counter)) {
    ++*count;
  }
  ~RetainedFrame() {
    resource.reset();
    --*count;
  }
};
struct Generation {
  BackendGeneration identity;
  std::unique_ptr<MonitorCaptureBackend> backend;
  std::shared_ptr<Mailbox> mailbox = std::make_shared<Mailbox>();
  std::thread worker;
  bool metrics_harvested = false;
  ~Generation() {
    if (worker.joinable()) {
      {
        std::scoped_lock lock(mailbox->mutex);
        if (!mailbox->worker_done) std::terminate();
      }
      worker.join();
    }
  }
};
void addDxgi(DxgiCaptureDiagnostics& total, const DxgiCaptureDiagnostics& value) {
  total.acquired_frames += value.acquired_frames;
  total.released_frames += value.released_frames;
  total.delivered_frames += value.delivered_frames;
  total.no_content += value.no_content;
  total.unavailable_slots += value.unavailable_slots;
  total.pointer_updates += value.pointer_updates;
  total.context_contention_waits += value.context_contention_waits;
  if (value.maximum_duplication_hold_us > total.maximum_duplication_hold_us) {
    total.maximum_duplication_hold_us = value.maximum_duplication_hold_us;
    total.maximum_hold_before_copy_us = value.maximum_hold_before_copy_us;
    total.maximum_hold_copy_us = value.maximum_hold_copy_us;
    total.maximum_hold_release_us = value.maximum_hold_release_us;
  }
  total.peak_leases = (std::max)(total.peak_leases, value.peak_leases);
  total.active_leases += value.active_leases;
  total.allocated_textures += value.allocated_textures;
  total.width = value.width;
  total.height = value.height;
  total.rotation = value.rotation;
}
class Backend final : public SelectingMonitorCaptureBackend {
 public:
  explicit Backend(SelectingMonitorOptions options) : options_(std::move(options)) {
    policy_.forced = options_.forced;
    if (!options_.create_backend)
      options_.create_backend =
          [](CaptureBackendKind kind) -> std::unique_ptr<MonitorCaptureBackend> {
        if (kind == CaptureBackendKind::dxgi) return createDxgiMonitorCaptureBackend();
        return createWgcMonitorCaptureBackend();
      };
    if (!options_.environment) options_.environment = environment;
  }
  ~Backend() override {
    if (!stop(Clock::now() + std::chrono::seconds{5}).ok) std::terminate();
  }
  BackendStartResult start(const sources::MonitorTargetToken& target, FrameCallback frame,
                           TerminalCallback terminal) override {
    std::scoped_lock owner(owner_mutex_);
    if (started_ || !frame)
      return {false, CaptureFailure{"selection_invalid_state", "Capture selection cannot start"}};
    started_ = true;
    target_ = target;
    on_frame_ = std::move(frame);
    on_terminal_ = std::move(terminal);
    try {
      environment_done_ = false;
      environment_worker_ = std::thread([this] { watchEnvironment(); });
      worker_ = std::thread([this] { run(); });
    } catch (const std::exception& error) {
      std::scoped_lock lock(mutex_);
      stop_ = true;
      if (!worker_.joinable()) done_ = true;
      if (!environment_worker_.joinable()) environment_done_ = true;
      changed_.notify_all();
      return {false, CaptureFailure{"selection_thread_failed", error.what()}};
    }
    // Preparation and first-frame deadlines belong to the control worker.
    return {};
  }
  CaptureStopResult stop(Clock::time_point deadline) noexcept override {
    std::scoped_lock owner(owner_mutex_);
    std::unique_lock lock(mutex_);
    stop_ = true;
    stop_deadline_ = deadline;
    changed_.notify_all();
    if (!worker_.joinable() && !environment_worker_.joinable()) return stop_result_;
    if (!changed_.wait_until(lock, deadline, [&] { return done_ && environment_done_; }))
      return {false, CaptureFailure{"selection_stop_timeout", "Capture selection did not drain",
                                    CaptureFailureKind::stop_timeout}};
    lock.unlock();
    if (worker_.joinable()) worker_.join();
    if (environment_worker_.joinable()) environment_worker_.join();
    return stop_result_;
  }
  void select(std::optional<CaptureBackendKind> kind) override {
    std::scoped_lock lock(mutex_);
    desired_ = kind;
    desired_changed_ = true;
    changed_.notify_all();
  }
  CaptureBackendProgress progress() const override {
    std::scoped_lock lock(mutex_);
    return progress_;
  }
  BackendSelectionDiagnostics diagnostics() const override {
    std::scoped_lock lock(mutex_);
    return diagnostics_;
  }
  void finalizeStop() noexcept override {
    std::scoped_lock owner(owner_mutex_);
    if (!worker_.joinable()) {
      try {
        drainRetired();
        snapshot();
      } catch (...) {
      }
    }
  }

 private:
  void watchEnvironment() noexcept {
    try {
      for (;;) {
        {
          std::scoped_lock lock(mutex_);
          if (stop_) break;
        }
        auto value = options_.environment();
        if (options_.resolve_target && value.desktop_available) {
          const auto target = options_.resolve_target();
          value.source_available = target && target->valid();
        }
        std::unique_lock lock(mutex_);
        // Unsupported/transient HDR queries do not invent a display change.
        if (!value.hdr_revision) value.hdr_revision = environment_value_.hdr_revision;
        environment_value_ = value;
        ++environment_revision_;
        changed_.notify_all();
        if (changed_.wait_for(lock, std::chrono::milliseconds{200}, [&] { return stop_; })) break;
      }
    } catch (...) {
      std::scoped_lock lock(mutex_);
      environment_failed_ = true;
    }
    std::scoped_lock lock(mutex_);
    environment_done_ = true;
    changed_.notify_all();
  }
  bool drainRetired() {
    bool pending = false;
    for (auto& generation : retired_) {
      if (generation) {
        bool done;
        CaptureStopResult stopped;
        Clock::time_point deadline;
        {
          std::scoped_lock lock(generation->mailbox->mutex);
          done = generation->mailbox->worker_done;
          stopped = generation->mailbox->stop_result;
          deadline = generation->mailbox->stop_deadline;
        }
        if ((!done && Clock::now() >= deadline) || (done && !stopped.ok)) {
          stop_result_ = {false, CaptureFailure{"selection_stop_timeout",
                                                "Capture generation did not drain within deadline",
                                                CaptureFailureKind::stop_timeout}};
          throw std::runtime_error(
              "Capture generation exceeded stop deadline; utility must retire");
        }
        if (done) {
          if (generation->worker.joinable()) generation->worker.join();
          if (!generation->metrics_harvested) {
            if (auto* dxgi = dynamic_cast<DxgiMonitorCaptureBackend*>(generation->backend.get())) {
              auto value = dxgi->diagnostics();
              value.active_leases = value.allocated_textures = 0;
              addDxgi(retired_dxgi_, value);
            }
            generation->metrics_harvested = true;
          }
          if (generation->mailbox->retained->load() == 0) generation.reset();
        }
      }
      pending |= static_cast<bool>(generation);
    }
    return pending;
  }
  void transition(BackendObservation event, BackendGeneration origin = {},
                  std::optional<CaptureBackendKind> forced = {}) {
    const auto result = selectCaptureBackend(policy_, {event, milliseconds(), origin, forced});
    policy_ = result.state;
    switch (result.action) {
      case BackendSelectionAction::start_candidate:
        prepare();
        break;
      case BackendSelectionAction::discard_candidate:
        retire(candidate_);
        break;
      case BackendSelectionAction::commit_candidate:
        retire(active_);
        active_ = std::move(candidate_);
        break;
      case BackendSelectionAction::pause:
        ++pauses_;
        retire(candidate_);
        retire(active_);
        break;
      case BackendSelectionAction::terminal:
        retire(candidate_);
        retire(active_);
        break;
      default:
        break;
    }
  }
  void retire(std::unique_ptr<Generation>& generation) {
    if (!generation) return;
    if (!generation->backend) {
      generation.reset();
      return;
    }
    const auto mailbox = generation->mailbox;
    auto deadline = Clock::now() + std::chrono::seconds{3};
    {
      std::scoped_lock lock(mutex_);
      if (stop_) deadline = (std::min)(deadline, stop_deadline_);
    }
    {
      std::scoped_lock lock(mailbox->mutex);
      mailbox->accepting = false;
      mailbox->frame.reset();
      mailbox->failure.reset();
      mailbox->stop_requested = true;
      mailbox->stop_deadline = deadline;
      mailbox->changed.notify_all();
    }
    drainRetired();
    for (auto& retired : retired_)
      if (!retired) {
        retired = std::move(generation);
        break;
      }
    if (generation) throw std::logic_error("Capture retirement capacity exceeded");
    policy_.retirement_pending = drainRetired();
  }
  void prepare() {
    if (candidate_) throw std::logic_error("Second capture candidate");
    candidate_ = std::make_unique<Generation>();
    candidate_->identity = *policy_.candidate;
    const auto identity = candidate_->identity;
    const auto mailbox = candidate_->mailbox;
    ++attempts_;
    maximum_generations_ =
        (std::max)(maximum_generations_, static_cast<std::size_t>(active_ ? 2 : 1));
    candidate_->backend = options_.create_backend(identity.kind);
    if (!candidate_->backend) throw std::runtime_error("Capture backend factory returned null");
    const auto on_frame = [mailbox, identity](BackendFrame frame) {
      std::scoped_lock lock(mailbox->mutex);
      if (!mailbox->accepting || mailbox->failure) return;
      if (!frame.resource || !frame.width || !frame.height || frame.capture_timestamp_100ns <= 0) {
        mailbox->failure =
            CaptureFailure{"selection_invalid_frame", "Backend returned an invalid frame"};
        return;
      }
      auto retained = std::make_shared<RetainedFrame>(frame.resource, mailbox->retained);
      frame.resource = std::shared_ptr<FrameResource>(retained, retained->resource.get());
      frame.generation = identity.generation;
      mailbox->frame = std::move(frame);
    };
    const auto on_terminal = [mailbox](CaptureFailure failure) {
      std::scoped_lock lock(mailbox->mutex);
      if (mailbox->accepting) {
        mailbox->failure = std::move(failure);
        mailbox->frame.reset();
      }
    };
    try {
      candidate_->worker =
          std::thread([generation = candidate_.get(), mailbox, on_frame, on_terminal,
                       resolver = options_.resolve_target, target = target_] {
            BackendStartResult result;
            try {
              const auto resolved = resolver ? resolver() : std::optional{target};
              if (!resolved || !resolved->valid())
                result = {false, CaptureFailure{"selection_source_unavailable",
                                                "Selected monitor is unavailable",
                                                CaptureFailureKind::source_unavailable}};
              else
                result = generation->backend->start(*resolved, on_frame, on_terminal);
            } catch (const std::exception& error) {
              result = {false, CaptureFailure{"selection_prepare_failed", error.what()}};
            } catch (...) {
              result = {false, CaptureFailure{"selection_prepare_failed",
                                              "Unknown backend prepare failure"}};
            }
            Clock::time_point deadline;
            {
              std::unique_lock lock(mailbox->mutex);
              mailbox->prepared = result.ok;
              if (!result.ok && !mailbox->failure)
                mailbox->failure = result.failure.value_or(
                    CaptureFailure{"selection_prepare_failed", "Backend failed to prepare"});
              mailbox->changed.wait(lock, [&] { return mailbox->stop_requested; });
              deadline = mailbox->stop_deadline;
            }
            const auto stopped = generation->backend->stop(deadline);
            if (stopped.ok) generation->backend->finalizeStop();
            std::scoped_lock lock(mailbox->mutex);
            mailbox->stop_result = stopped;
            mailbox->worker_done = true;
            mailbox->changed.notify_all();
          });
    } catch (const std::exception& error) {
      std::scoped_lock lock(mailbox->mutex);
      mailbox->failure = CaptureFailure{"selection_thread_failed", error.what()};
      mailbox->worker_done = true;
    }
  }
  void consume(std::unique_ptr<Generation>& generation) {
    if (!generation) return;
    const auto identity = generation->identity;
    std::optional<BackendFrame> frame;
    std::optional<CaptureFailure> failure;
    {
      std::scoped_lock lock(generation->mailbox->mutex);
      if (generation->mailbox->prepared) {
        frame = std::move(generation->mailbox->frame);
        generation->mailbox->frame.reset();
      }
      failure = std::move(generation->mailbox->failure);
      generation->mailbox->failure.reset();
    }
    if (failure) {
      last_failure_ = failure;
      transition(observation(failure->kind), identity);
      return;
    }
    if (!frame || frame->capture_timestamp_100ns <= last_timestamp_) return;
    transition(BackendObservation::healthy_frame, identity);
    if (policy_.active && *policy_.active == identity && policy_.active_healthy &&
        frame->capture_timestamp_100ns > last_timestamp_) {
      last_timestamp_ = frame->capture_timestamp_100ns;
      on_frame_(std::move(*frame));
      ++delivered_;
    }
  }
  void snapshot() {
    BackendSelectionDiagnostics value;
    value.policy = policy_;
    value.attempts = attempts_;
    value.delivered_frames = delivered_;
    value.pauses = pauses_;
    value.last_failure = last_failure_;
    value.dxgi = retired_dxgi_;
    for (const auto* generation : {active_.get(), candidate_.get()})
      if (generation) {
        ++value.live_generations;
        value.retained_frames += generation->mailbox->retained->load();
        if (auto* dxgi = dynamic_cast<DxgiMonitorCaptureBackend*>(generation->backend.get()))
          addDxgi(value.dxgi, dxgi->diagnostics());
      }
    for (const auto& retired : retired_)
      if (retired) {
        ++value.live_generations;
        value.retained_frames += retired->mailbox->retained->load();
        if (auto* dxgi = dynamic_cast<DxgiMonitorCaptureBackend*>(retired->backend.get())) {
          const auto resources = dxgi->diagnostics();
          if (!retired->metrics_harvested)
            addDxgi(value.dxgi, resources);
          else {
            value.dxgi.active_leases += resources.active_leases;
            value.dxgi.allocated_textures += resources.allocated_textures;
          }
        }
      }
    maximum_generations_ = (std::max)(maximum_generations_, value.live_generations);
    value.maximum_live_generations = maximum_generations_;
    std::scoped_lock lock(mutex_);
    diagnostics_ = std::move(value);
    progress_ = policy_.active_healthy
                    ? CaptureBackendProgress{}
                    : CaptureBackendProgress{CaptureBackendProgressState::paused,
                                             policy_.paused  ? CaptureFailureKind::secure_desktop
                                             : last_failure_ ? last_failure_->kind
                                                             : CaptureFailureKind::backend_failed};
  }
  void run() noexcept {
    try {
      CaptureEnvironment previous;
      std::uint64_t environment_revision = 0;
      bool cancelled = false;
      {
        std::unique_lock lock(mutex_);
        if (!changed_.wait_for(
                lock, std::chrono::seconds{3},
                [&] { return environment_revision_ || environment_failed_ || stop_; }) ||
            environment_failed_)
          throw std::runtime_error("Capture environment observation unavailable");
        previous = environment_value_;
        environment_revision = environment_revision_;
        cancelled = stop_;
      }
      if (!cancelled)
        transition(!previous.desktop_available ? BackendObservation::secure_desktop
                   : previous.source_available ? BackendObservation::start
                                               : BackendObservation::source_unavailable);
      for (;;) {
        bool desired_changed;
        std::optional<CaptureBackendKind> desired;
        CaptureEnvironment current;
        bool environment_changed;
        {
          std::scoped_lock lock(mutex_);
          if (stop_) break;
          if (environment_failed_)
            throw std::runtime_error("Capture environment observation failed");
          desired_changed = desired_changed_;
          desired_changed_ = false;
          desired = desired_;
          current = environment_value_;
          environment_changed = environment_revision != environment_revision_;
          environment_revision = environment_revision_;
        }
        if (!drainRetired() && policy_.retirement_pending)
          transition(BackendObservation::retirement_drained);
        if (environment_changed) {
          if (current.desktop_available != previous.desktop_available ||
              (policy_.paused && current.desktop_available))
            transition(current.desktop_available ? BackendObservation::desktop_available
                                                 : BackendObservation::secure_desktop);
          if (current.source_available &&
              (current.display_revision != previous.display_revision ||
               current.hdr_revision != previous.hdr_revision || !previous.source_available))
            transition(BackendObservation::display_changed);
          if (current.desktop_available && !current.source_available) {
            last_failure_ = CaptureFailure{"selection_source_unavailable",
                                           "Selected monitor left the active topology",
                                           CaptureFailureKind::source_unavailable};
            transition(BackendObservation::source_unavailable);
          }
          previous = current;
        }
        if (desired_changed) transition(BackendObservation::force_backend, {}, desired);
        consume(active_);
        consume(candidate_);
        transition(BackendObservation::tick);
        snapshot();
        std::unique_lock lock(mutex_);
        changed_.wait_for(lock, std::chrono::milliseconds{2},
                          [&] { return stop_ || desired_changed_; });
      }
    } catch (const std::exception& error) {
      last_failure_ = CaptureFailure{"selection_control_failed", error.what()};
      try {
        if (on_terminal_) on_terminal_(*last_failure_);
      } catch (...) {
      }
    } catch (...) {
      last_failure_ = CaptureFailure{"selection_control_failed", "Unknown capture control failure"};
      try {
        if (on_terminal_) on_terminal_(*last_failure_);
      } catch (...) {
      }
    }
    try {
      retire(candidate_);
      retire(active_);
      policy_.active_healthy = false;
      for (;;) {
        drainRetired();
        bool pending_worker = false;
        for (const auto& retired : retired_)
          if (retired) {
            std::scoped_lock lock(retired->mailbox->mutex);
            pending_worker |= !retired->mailbox->worker_done;
          }
        if (!pending_worker) break;
        std::this_thread::sleep_for(std::chrono::milliseconds{1});
      }
      snapshot();
    } catch (...) {
      stop_result_ = {false, CaptureFailure{"selection_stop_timeout",
                                            "Capture generation did not drain; utility must retire",
                                            CaptureFailureKind::stop_timeout}};
      try {
        if (on_terminal_) on_terminal_(*stop_result_.failure);
      } catch (...) {
      }
    }
    std::scoped_lock lock(mutex_);
    stop_ = true;
    on_frame_ = {};
    on_terminal_ = {};
    done_ = true;
    changed_.notify_all();
  }
  SelectingMonitorOptions options_;
  sources::MonitorTargetToken target_;
  FrameCallback on_frame_;
  TerminalCallback on_terminal_;
  std::mutex owner_mutex_;
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  bool started_ = false, stop_ = false, done_ = false, desired_changed_ = false;
  std::optional<CaptureBackendKind> desired_;
  Clock::time_point stop_deadline_{};
  std::thread worker_, environment_worker_;
  CaptureEnvironment environment_value_;
  std::uint64_t environment_revision_ = 0;
  bool environment_done_ = true, environment_failed_ = false;
  CaptureStopResult stop_result_;
  CaptureBackendProgress progress_;
  BackendSelectionDiagnostics diagnostics_;
  BackendSelectionState policy_;
  std::unique_ptr<Generation> active_, candidate_;
  std::array<std::unique_ptr<Generation>, 2> retired_{};
  DxgiCaptureDiagnostics retired_dxgi_;
  std::optional<CaptureFailure> last_failure_;
  std::uint64_t attempts_ = 0, delivered_ = 0, pauses_ = 0;
  std::size_t maximum_generations_ = 0;
  std::int64_t last_timestamp_ = 0;
};
}  // namespace
std::unique_ptr<SelectingMonitorCaptureBackend> createSelectingMonitorCaptureBackend(
    SelectingMonitorOptions options) {
  return std::make_unique<Backend>(std::move(options));
}
}  // namespace syrnike::windows_media::capture
