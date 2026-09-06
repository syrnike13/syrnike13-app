#include "capture/selecting_monitor_capture.hpp"
#include "sources/win32_source_enumerator.hpp"
#include <charconv>
#include <iostream>
#include <iomanip>
#include <string_view>

using namespace syrnike::windows_media;
using namespace std::chrono_literals;
namespace {
int number(const char* input) {
  int value = -1;
  const std::string_view text(input);
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), value);
  if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size())
    throw std::runtime_error("Invalid numeric argument");
  return value;
}
}  // namespace
int main(int argc, char** argv) {
  try {
    if (argc != 4)
      throw std::runtime_error(
          "Usage: backend_transition_lab wgc|dxgi|switch monitor-index duration-seconds (30..420)");
    const std::string_view kind(argv[1]);
    const int index = number(argv[2]), duration = number(argv[3]);
    const bool switching = kind == "switch";
    if ((kind != "wgc" && kind != "dxgi" && !switching) || index < 0 || duration < 30 ||
        duration > 420 || (switching && duration < 375))
      throw std::runtime_error("Invalid transition proof arguments");
    sources::SourceRegistry registry(sources::createWin32SourceEnumerator());
    sources::EnumerationOptions enumeration;
    enumeration.kind = sources::EnumerationOptions::Kind::Monitor;
    const auto values = registry.enumerate(enumeration);
    if (!values.ok || static_cast<std::size_t>(index) >= values.sources.size())
      throw std::runtime_error("Monitor index unavailable");
    const auto selected = values.sources[static_cast<std::size_t>(index)];
    capture::SelectingMonitorOptions options;
    options.forced =
        kind == "dxgi" ? capture::CaptureBackendKind::dxgi : capture::CaptureBackendKind::wgc;
    options.resolve_target = [&] { return registry.resolveMonitorTarget(selected.id).target; };
    auto backend = capture::createSelectingMonitorCaptureBackend(std::move(options));
    const auto selection = backend.get();
    capture::MonitorCapture capture(registry, selected.id, std::move(backend));
    if (!capture.start().ok) throw std::runtime_error("Transition capture start failed");
    std::cout << "TRANSITION_READY {\"backend\":\"" << kind << "\",\"monitorIndex\":" << index
              << ",\"primary\":" << (selected.flags.primary ? "true" : "false") << "}" << std::endl;
    const auto began = std::chrono::steady_clock::now();
    std::uint64_t frames = 0, recoveries = 0, dimension_changes = 0;
    std::uint32_t width = 0, height = 0;
    bool paused = false;
    unsigned requested_switches = 0;
    std::int64_t last_sample = -500;
    while (std::chrono::steady_clock::now() - began < std::chrono::seconds{duration}) {
      auto frame = capture.waitForFrame(50ms);
      if (frame) {
        ++frames;
        const auto metadata = frame->metadata();
        if (width && (width != metadata.width || height != metadata.height)) ++dimension_changes;
        width = metadata.width;
        height = metadata.height;
        if (paused) {
          ++recoveries;
          paused = false;
        }
      }
      const auto progress = capture.progress();
      if (progress.state == capture::CaptureBackendProgressState::paused && frames) paused = true;
      const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                               std::chrono::steady_clock::now() - began)
                               .count();
      if (switching && requested_switches < 30 && elapsed >= (requested_switches + 1) * 12000LL) {
        ++requested_switches;
        selection->select(requested_switches % 2 ? capture::CaptureBackendKind::dxgi
                                                 : capture::CaptureBackendKind::wgc);
      }
      if (elapsed - last_sample >= 500) {
        last_sample = elapsed;
        const auto value = selection->diagnostics();
        DWORD handles = 0;
        if (!GetProcessHandleCount(GetCurrentProcess(), &handles))
          throw std::runtime_error("Transition handle query failed");
        std::cout << "TRANSITION_SAMPLE {\"elapsedMs\":" << elapsed << ",\"frames\":" << frames
                  << ",\"width\":" << width << ",\"height\":" << height << ",\"paused\":"
                  << (progress.state == capture::CaptureBackendProgressState::paused ? "true"
                                                                                     : "false")
                  << ",\"reason\":" << (progress.reason ? static_cast<int>(*progress.reason) : -1)
                  << ",\"recoveries\":" << recoveries << ",\"attempts\":" << value.attempts
                  << ",\"switches\":" << value.policy.committed_switches
                  << ",\"liveGenerations\":" << value.live_generations << ",\"handles\":" << handles
                  << ",\"retainedFrames\":" << value.retained_frames
                  << ",\"dxgiTextures\":" << value.dxgi.allocated_textures << ",\"backend\":\""
                  << (value.policy.active ? capture::toString(value.policy.active->kind) : "none")
                  << "\",\"failureKind\":"
                  << (value.last_failure ? static_cast<int>(value.last_failure->kind) : -1)
                  << ",\"failureMessage\":"
                  << std::quoted(value.last_failure ? value.last_failure->message : "") << "}"
                  << std::endl;
      }
      if (capture.state() == capture::CaptureState::Failed)
        throw std::runtime_error("Transition capture failed terminally");
    }
    const auto stopped = capture.stop(5s);
    const auto value = selection->diagnostics();
    const bool drained = stopped.ok && value.live_generations == 0 && value.retained_frames == 0 &&
                         value.maximum_live_generations <= 2;
    std::cout << "TRANSITION_SUMMARY {\"drained\":" << (drained ? "true" : "false")
              << ",\"frames\":" << frames << ",\"recoveries\":" << recoveries
              << ",\"dimensionChanges\":" << dimension_changes << ",\"pauses\":" << value.pauses
              << ",\"attempts\":" << value.attempts
              << ",\"switches\":" << value.policy.committed_switches
              << ",\"maximumGenerations\":" << value.maximum_live_generations
              << ",\"maximumHoldUs\":" << value.dxgi.maximum_duplication_hold_us
              << ",\"holdBeforeCopyUs\":" << value.dxgi.maximum_hold_before_copy_us
              << ",\"holdCopyUs\":" << value.dxgi.maximum_hold_copy_us
              << ",\"holdReleaseUs\":" << value.dxgi.maximum_hold_release_us << "}" << std::endl;
    return drained && frames && (!switching || value.policy.committed_switches == 30) ? 0 : 1;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
