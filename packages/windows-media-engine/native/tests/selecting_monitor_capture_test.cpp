#include "capture/selecting_monitor_capture.hpp"
#include <thread>
#include <iostream>
#include <stdexcept>
#include <vector>

using namespace syrnike::windows_media;
using namespace capture;
using namespace std::chrono_literals;
namespace {
void require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
template <class Predicate>
void eventually(Predicate predicate, const char* message) {
  const auto until = std::chrono::steady_clock::now() + 4s;
  while (!predicate() && std::chrono::steady_clock::now() < until) std::this_thread::sleep_for(2ms);
  require(predicate(), message);
}
struct Resource final : FrameResource {
  std::uint64_t sampledHash() override { return 1; }
};
struct Control {
  std::mutex mutex;
  MonitorCaptureBackend::FrameCallback frame;
  MonitorCaptureBackend::TerminalCallback terminal;
  std::atomic_bool stopped{false}, ready{false};
  std::atomic_bool hold_prepare{false};
  void emit(std::int64_t timestamp) {
    std::scoped_lock lock(mutex);
    if (frame) frame({timestamp, 2, 2, FramePixelFormat::Bgra8, std::make_shared<Resource>()});
  }
  void fail(CaptureFailureKind kind = CaptureFailureKind::backend_failed) {
    std::scoped_lock lock(mutex);
    terminal({"test_backend_failure", "injected backend failure", kind});
  }
};
struct Fake final : MonitorCaptureBackend {
  std::shared_ptr<Control> control;
  explicit Fake(std::shared_ptr<Control> value) : control(std::move(value)) {}
  BackendStartResult start(const sources::MonitorTargetToken&, FrameCallback frame,
                           TerminalCallback terminal) override {
    {
      std::scoped_lock lock(control->mutex);
      control->frame = std::move(frame);
      control->terminal = std::move(terminal);
      control->ready = true;
    }
    while (control->hold_prepare) std::this_thread::sleep_for(1ms);
    return {};
  }
  CaptureStopResult stop(std::chrono::steady_clock::time_point) noexcept override {
    control->stopped = true;
    return {};
  }
  CaptureBackendProgress progress() const override { return {}; }
};
void lifecycle() {
  std::mutex mutex;
  std::vector<std::shared_ptr<Control>> created;
  std::atomic_bool desktop{true};
  std::atomic_bool source_available{true};
  SelectingMonitorOptions options;
  options.environment = [&] { return CaptureEnvironment{desktop.load(), 1}; };
  options.resolve_target = [&]() -> std::optional<sources::MonitorTargetToken> {
    return source_available ? std::optional{sources::MonitorTargetToken{1}} : std::nullopt;
  };
  options.create_backend = [&](CaptureBackendKind) {
    auto control = std::make_shared<Control>();
    {
      std::scoped_lock lock(mutex);
      control->hold_prepare = created.size() == 1;
      created.push_back(control);
    }
    return std::make_unique<Fake>(control);
  };
  auto owner = createSelectingMonitorCaptureBackend(std::move(options));
  std::mutex frames_mutex;
  std::vector<BackendFrame> frames;
  require(owner
              ->start(
                  sources::MonitorTargetToken{1},
                  [&](BackendFrame frame) {
                    std::scoped_lock lock(frames_mutex);
                    frames.push_back(std::move(frame));
                  },
                  [](CaptureFailure) {})
              .ok,
          "selection start failed");
  const auto control = [&](std::size_t index) {
    eventually(
        [&] {
          std::scoped_lock lock(mutex);
          return created.size() > index && created[index]->ready;
        },
        "candidate missing");
    std::scoped_lock lock(mutex);
    return created[index];
  };
  auto first = control(0);
  first->emit(100);
  eventually([&] { return owner->diagnostics().policy.active_healthy; },
             "first frame did not commit");
  owner->select(CaptureBackendKind::dxgi);
  auto failed = control(1);
  require(!first->stopped && owner->diagnostics().policy.active->kind == CaptureBackendKind::wgc,
          "candidate replaced active before first frame");
  failed->emit(150);
  first->emit(175);
  eventually([&] { return owner->diagnostics().delivered_frames == 2; },
             "slow candidate prepare blocked healthy active frames");
  require(owner->diagnostics().policy.active->kind == CaptureBackendKind::wgc,
          "candidate committed before prepare returned");
  failed->fail();
  failed->hold_prepare = false;
  eventually([&] { return failed->stopped.load(); }, "failed candidate not stopped");
  failed->emit(200);
  first->emit(300);
  eventually([&] { return owner->diagnostics().delivered_frames == 3; },
             "healthy active stopped delivering");
  owner->select(CaptureBackendKind::dxgi);
  auto second = control(2);
  second->emit(250);
  std::this_thread::sleep_for(20ms);
  require(owner->diagnostics().policy.active->kind == CaptureBackendKind::wgc && !first->stopped,
          "stale candidate frame replaced healthy active");
  second->emit(400);
  eventually([&] { return first->stopped.load(); }, "old generation not stopped after commit");
  eventually([&] { return owner->diagnostics().policy.active->kind == CaptureBackendKind::dxgi; },
             "candidate did not commit");
  owner->select(CaptureBackendKind::wgc);
  std::this_thread::sleep_for(1100ms);
  {
    std::scoped_lock lock(mutex);
    require(created.size() == 3, "third GPU generation admitted while retired lease held");
  }
  {
    std::scoped_lock lock(frames_mutex);
    frames.clear();
  }
  auto third = control(3);
  third->emit(500);
  eventually([&] { return owner->diagnostics().policy.committed_switches == 2; },
             "switch did not resume after retired lease drained");
  desktop = false;
  eventually([&] { return owner->progress().reason == CaptureFailureKind::secure_desktop; },
             "desktop loss not exposed as typed pause");
  require(third->stopped, "paused generation still capturing");
  {
    std::scoped_lock lock(frames_mutex);
    frames.clear();
  }
  desktop = true;
  auto resumed = control(4);
  resumed->emit(600);
  eventually([&] { return owner->diagnostics().policy.active_healthy; },
             "desktop return did not recover");
  source_available = false;
  eventually([&] { return owner->progress().reason == CaptureFailureKind::source_unavailable; },
             "missing source without backend Closed callback was not detected");
  require(resumed->stopped, "unavailable source kept its old backend alive");
  const auto attempts_before = owner->diagnostics().attempts;
  std::this_thread::sleep_for(1200ms);
  require(owner->diagnostics().attempts == attempts_before, "unavailable source kept restarting");
  {
    std::scoped_lock lock(frames_mutex);
    frames.clear();
  }
  source_available = true;
  auto reconnected = control(5);
  reconnected->emit(700);
  eventually([&] { return owner->diagnostics().policy.active_healthy; },
             "source return did not restart capture");
  require(owner->stop(std::chrono::steady_clock::now() + 3s).ok, "selection stop failed");
  {
    std::scoped_lock lock(frames_mutex);
    frames.clear();
  }
  require(owner->diagnostics().maximum_live_generations <= 2, "generation bound exceeded");
  owner->finalizeStop();
  require(owner->diagnostics().live_generations == 0 && owner->diagnostics().retained_frames == 0,
          "stopped selection retained a drained generation");
  {
    std::scoped_lock lock(mutex);
    for (const auto& value : created) require(value->stopped, "backend leaked after stop");
  }
}
void hdrTransitions() {
  std::mutex mutex;
  std::vector<std::shared_ptr<Control>> created;
  std::atomic_uint64_t hdr{1};
  SelectingMonitorOptions options;
  options.environment = [&] {
    const auto revision = hdr.load();
    return CaptureEnvironment{true, 1, revision ? std::optional{revision} : std::nullopt};
  };
  options.create_backend = [&](CaptureBackendKind) {
    auto control = std::make_shared<Control>();
    std::scoped_lock lock(mutex);
    created.push_back(control);
    return std::make_unique<Fake>(control);
  };
  auto owner = createSelectingMonitorCaptureBackend(std::move(options));
  require(owner->start(
                   sources::MonitorTargetToken{1}, [](BackendFrame) {}, [](CaptureFailure) {})
              .ok,
          "HDR selection start failed");
  const auto control = [&](std::size_t index) {
    eventually(
        [&] {
          std::scoped_lock lock(mutex);
          return created.size() > index && created[index]->ready;
        },
        "HDR candidate missing");
    std::scoped_lock lock(mutex);
    return created[index];
  };
  auto first = control(0);
  first->emit(100);
  eventually([&] { return owner->diagnostics().policy.active_healthy; },
             "HDR initial frame did not commit");
  hdr = 2;
  // Observe across several environment polls: a color notification alone must
  // not retire a healthy backend.
  std::this_thread::sleep_for(650ms);
  require(owner->diagnostics().attempts == 1 && !first->stopped,
          "HDR change replaced a healthy backend");
  first->fail(CaptureFailureKind::device_removed);
  eventually([&] { return owner->diagnostics().policy.terminal && first->stopped; },
             "device removal did not degrade the HDR backend");
  hdr = 0;
  // An unavailable advanced-color query is not a new display revision, even
  // after the retry spacing has elapsed.
  std::this_thread::sleep_for(1200ms);
  require(owner->diagnostics().attempts == 1, "unknown HDR query manufactured a recovery event");
  hdr = 3;
  auto recovered = control(1);
  recovered->emit(200);
  eventually([&] { return owner->diagnostics().policy.active_healthy; },
             "real HDR revision did not permit degraded recovery");
  require(owner->diagnostics().attempts == 2, "HDR recovery repeated attempts");
  require(owner->stop(std::chrono::steady_clock::now() + 3s).ok, "HDR selection stop failed");
  owner->finalizeStop();
  require(owner->diagnostics().live_generations == 0 && recovered->stopped,
          "HDR selection retained a generation");
}
}  // namespace
int main() {
  try {
    lifecycle();
    hdrTransitions();
    std::cout << "Capture selection lifecycle passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
