#include "camera/camera_pipeline.hpp"
#include "camera/camera_preview.hpp"
#include "camera/camera_publication.hpp"
#include "capture/optional_preview_budget.hpp"
#include "core/engine.hpp"
#include "lab/synthetic_camera_reader.hpp"

#include <windows.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <algorithm>
#include <array>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>

using namespace syrnike::windows_media;
using namespace syrnike::windows_media::camera;
namespace {
using Clock = std::chrono::steady_clock;
void require(bool value, const char* reason) { if (!value) throw std::runtime_error(reason); }
class SyntheticEnumerator final : public CameraDeviceEnumerator {
 public:
  std::optional<std::vector<CameraEndpoint>> enumerate() override {
    return std::vector<CameraEndpoint>{{L"synthetic-a", "Synthetic A"}, {L"synthetic-b", "Synthetic B"}};
  }
  bool changed() const noexcept override { return false; }
};
struct Resources { DWORD handles = 0; unsigned threads = 0; SIZE_T bytes = 0; };
Resources resources() {
  Resources result;
  require(GetProcessHandleCount(GetCurrentProcess(), &result.handles), "Handle probe failed");
  PROCESS_MEMORY_COUNTERS_EX memory{};
  memory.cb = sizeof(memory);
  require(GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory)),
          "Memory probe failed");
  result.bytes = memory.PrivateUsage;
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  require(snapshot != INVALID_HANDLE_VALUE, "Thread probe failed");
  THREADENTRY32 entry{};
  entry.dwSize = sizeof(entry);
  if (Thread32First(snapshot, &entry)) do {
    if (entry.th32OwnerProcessID == GetCurrentProcessId()) ++result.threads;
  } while (Thread32Next(snapshot, &entry));
  CloseHandle(snapshot);
  return result;
}
void sample(unsigned elapsed, const CameraPipeline& pipeline, const CameraPublication* publication,
            const CameraPreview* preview, const lab::SyntheticCameraControl& control) {
  const auto value = resources();
  const auto pipeline_stats = pipeline.stats();
  const auto publication_stats = publication ? publication->stats() : CameraPublicationStats{};
  const auto preview_stats = preview ? preview->stats() : CameraPreviewStats{};
  std::cout << "CAMERA_RESOURCE {\"elapsedSeconds\":" << elapsed << ",\"handles\":" << value.handles
            << ",\"threads\":" << value.threads << ",\"privateBytes\":" << value.bytes
            << ",\"captured\":" << pipeline_stats.capture.frames << ",\"submitted\":" << publication_stats.submitted
            << ",\"generation\":" << pipeline_stats.capture.generation << ",\"maximumAgeUs\":" << publication_stats.maximum_age_us
            << ",\"readers\":" << control.readers_alive << ",\"samples\":" << control.samples_alive
            << ",\"previewBytes\":" << capture::optionalPreviewBytes() << ",\"previewDrops\":" << preview_stats.dropped
            << ",\"previewOutstanding\":" << preview_stats.outstanding << "}" << std::endl;
}
void phase(const char* name) {
  const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::cout << "CAMERA_PHASE {\"name\":\"" << name << "\",\"atUnixMs\":" << now << "}" << std::endl;
}
int devices() {
  CameraDeviceRegistry registry(makeWindowsCameraDeviceEnumerator());
  const auto snapshot = registry.refresh();
  require(snapshot.status == CameraRegistryStatus::ready, "Camera enumeration failed");
  for (const auto& device : snapshot.devices) {
    std::cout << "CAMERA_DEVICE id=" << device.id << " kind=" << static_cast<int>(device.kind)
              << " available=" << device.available << " label=" << device.label << std::endl;
  }
  return 0;
}
int physical(unsigned id) {
  CameraDeviceRegistry registry(makeWindowsCameraDeviceEnumerator());
  require(registry.refresh().status == CameraRegistryStatus::ready, "Camera enumeration failed");
  const auto endpoint = registry.resolve(id);
  require(endpoint.has_value(), "Requested camera unavailable");
  for (const CameraProfile profile : {CameraProfile{1280, 720, 30}, CameraProfile{1920, 1080, 30}}) {
    CameraCapture capture(*endpoint, profile, profile.width, false);
    const auto failure = capture.start();
    if (failure == CameraFailure::none) std::this_thread::sleep_for(std::chrono::seconds{3});
    const auto stats = capture.stats();
    std::cout << "CAMERA_OPEN failure=" << static_cast<int>(failure) << " platform=" << stats.platform_error
              << " state=" << static_cast<int>(stats.state) << " frames=" << stats.frames << std::endl;
    require(capture.stop(Clock::now() + std::chrono::seconds{5}), "Physical camera stop deadline");
    std::cout << "CAMERA_HARDWARE {\"id\":" << id << ",\"kind\":" << static_cast<int>(endpoint->kind)
              << ",\"width\":" << profile.width << ",\"height\":" << profile.height
              << ",\"failure\":" << static_cast<int>(failure) << ",\"frames\":" << stats.frames
              << ",\"platformError\":" << stats.platform_error << ",\"stopped\":true}" << std::endl;
  }
  return 0;
}
int cycles(unsigned count) {
  Resources baseline, final;
  auto control = std::make_shared<lab::SyntheticCameraControl>();
  control->emit_late_callback = true;
  for (unsigned index = 0; index < count + 3; ++index) {
    {
      CameraDeviceRegistry registry(std::make_unique<SyntheticEnumerator>());
      registry.refresh();
      CameraPipeline pipeline(lab::syntheticCameraReader(control));
      require(pipeline.selectDevice(registry, {}, {1280, 720, 30}) == CameraFailure::none &&
              pipeline.setDemand(false, true) == CameraFailure::none, "Cycle capture start failed");
      CameraPreview preview(pipeline.preview());
      const auto deadline = Clock::now() + std::chrono::seconds{2};
      std::optional<CameraPreviewLease> frame;
      while (!(frame = preview.take()) && Clock::now() < deadline) std::this_thread::sleep_for(std::chrono::milliseconds{5});
      require(frame.has_value(), "Cycle preview deadline");
      require(preview.stop(Clock::now() + std::chrono::seconds{2}), "Cycle preview stop failed");
      frame.reset();
      require(pipeline.stop(Clock::now() + std::chrono::seconds{2}), "Cycle capture stop failed");
    }
    require(control->readers_alive == 0 && control->samples_alive == 0 && capture::optionalPreviewBytes() == 0,
            "Cycle leaked camera backing");
    if (index == 2) baseline = resources();
    final = resources();
    if (index >= 3) std::cout << "CAMERA_CYCLE {\"cycle\":" << index - 2 << ",\"handles\":" << final.handles
      << ",\"threads\":" << final.threads << ",\"privateBytes\":" << final.bytes << "}" << std::endl;
  }
  require(final.handles <= baseline.handles + 2 && final.threads <= baseline.threads + 1 &&
          final.bytes <= baseline.bytes + (8ULL << 20), "Camera cycle resources grew beyond warm baseline");
  std::cout << "CAMERA_RESULT {\"scenario\":\"cycles\",\"accepted\":true,\"cycles\":" << count
            << ",\"lateCallbacks\":" << control->late_callbacks << "}" << std::endl;
  return 0;
}
int publish(unsigned seconds) {
  require(seconds >= 24 && seconds <= 1800, "Camera publication duration outside bounds");
  const auto* url = std::getenv("LIVEKIT_URL");
  const auto* token = std::getenv("LIVEKIT_PUBLISHER_TOKEN");
  require(url && token, "Camera Room credentials missing");
  auto transport = std::make_shared<LiveKitRoomTransport>();
  Engine engine(EngineOptions{.room_transport = transport});
  require(engine.start().ok && engine.installCredentialLease({"camera-lab", url, token}).ok, "Camera Engine start failed");
  EngineDesiredState desired;
  desired.revision = 1;
  desired.room = RoomIntent{"native-v2-media-lab", "native-v2-publisher", "camera-lab"};
  require(engine.applyDesiredState(desired).ok, "Camera Room intent failed");
  const auto deadline = Clock::now() + std::chrono::seconds{12};
  while (!transport->activeRoom() && Clock::now() < deadline) std::this_thread::sleep_for(std::chrono::milliseconds{10});
  const auto original_room = transport->activeRoom();
  require(original_room != nullptr, "Camera Room connection failed");
  {
    auto control = std::make_shared<lab::SyntheticCameraControl>();
    control->emit_late_callback = true;
    CameraDeviceRegistry registry(std::make_unique<SyntheticEnumerator>());
    const auto catalog = registry.refresh();
    CameraPipeline pipeline(lab::syntheticCameraReader(control));
    require(pipeline.selectDevice(registry, catalog.devices[0].id, {1280, 720, 30}) == CameraFailure::none &&
            pipeline.setDemand(true, false) == CameraFailure::none, "Camera capture start failed");
    CameraPublication publication(transport, pipeline.publication(), {1280, 720, 30});
    require(publication.start() == CameraPublicationFailure::none, "Camera publication start failed");
    phase("publication-only-720");
    std::unique_ptr<CameraPreview> preview;
    std::array<std::optional<CameraPreviewLease>, 2> held;
    const auto began = Clock::now();
    unsigned previous = seconds + 1;
    while (Clock::now() - began < std::chrono::seconds{seconds}) {
      const auto elapsed = static_cast<unsigned>(std::chrono::duration_cast<std::chrono::seconds>(Clock::now() - began).count());
      if (elapsed != previous) {
        previous = elapsed;
        if (elapsed == 3) {
          require(pipeline.setDemand(true, true) == CameraFailure::none, "Preview demand failed");
          preview = std::make_unique<CameraPreview>(pipeline.preview());
          phase("preview-running");
        }
        if (elapsed == 6) phase("preview-stalled");
        if (elapsed == 10) {
          held = {};
          const auto opens = control->opens.load();
          for (unsigned index = 0; index < 100; ++index)
            require(pipeline.setDemand(true, index % 2 == 1) == CameraFailure::none, "Preview toggle failed");
          require(control->opens == opens, "Preview restarted capture");
          phase("preview-resumed");
        }
        if (elapsed == 12) {
          require(pipeline.selectDevice(registry, catalog.devices[1].id, {1920, 1080, 30}) == CameraFailure::none,
                  "1080 camera candidate failed");
          phase("switched-1080");
        }
        if (elapsed == 16) {
          const auto generation = pipeline.stats().capture.generation;
          control->fail_open = true;
          require(pipeline.selectDevice(registry, catalog.devices[0].id, {1280, 720, 30}) == CameraFailure::unavailable,
                  "Failed candidate did not roll back");
          control->fail_open = false;
          require(pipeline.stats().capture.generation == generation, "Rollback destroyed active camera");
          phase("failed-candidate-rollback");
        }
        if (elapsed == 20) {
          require(pipeline.selectDevice(registry, catalog.devices[0].id, {1280, 720, 30}) == CameraFailure::none,
                  "720 camera candidate failed");
          phase("returned-720");
        }
        if (elapsed == 22) {
          control->next_failure = CameraFailure::device_removed;
          const auto failed_by = Clock::now() + std::chrono::seconds{1};
          while (pipeline.stats().capture.failure == CameraFailure::none && Clock::now() < failed_by)
            std::this_thread::sleep_for(std::chrono::milliseconds{5});
          require(pipeline.reconcile(registry, catalog.revision) == CameraFailure::device_removed &&
                  !pipeline.stats().active, "Simulated device removal was not isolated and terminal");
          require(transport->activeRoom() == original_room && publication.stats().published,
                  "Simulated removal changed Room/publication ownership");
          require(pipeline.selectDevice(registry, catalog.devices[0].id, {1280, 720, 30}) == CameraFailure::none,
                  "Explicit camera recovery failed");
          phase("simulated-removal-recovered");
        }
        if (elapsed % 10 == 0) sample(elapsed, pipeline, &publication, preview.get(), *control);
      }
      if (preview) {
        if (elapsed >= 6 && elapsed < 10) {
          for (auto& frame : held) if (!frame) frame = preview->take();
        } else { auto frame = preview->take(); }
      }
      require(transport->activeRoom() == original_room && publication.stats().failure == CameraPublicationFailure::none,
              "Camera operation changed Room or failed publication");
      std::this_thread::sleep_for(std::chrono::milliseconds{10});
    }
    sample(seconds, pipeline, &publication, preview.get(), *control);
    const auto stats = publication.stats();
    phase("stopped");
    require(publication.stop(Clock::now() + std::chrono::seconds{6}), "Camera publication stop failed");
    if (preview) require(preview->stop(Clock::now() + std::chrono::seconds{2}), "Camera preview stop failed");
    held = {};
    preview.reset();
    require(pipeline.setDemand(false, false) == CameraFailure::none && pipeline.stop(Clock::now() + std::chrono::seconds{2}),
            "Camera pipeline stop failed");
    require(control->readers_alive == 0 && control->samples_alive == 0 && capture::optionalPreviewBytes() == 0,
            "Camera publication teardown leaked backing");
    require(stats.commits == 1 && stats.submitted > seconds * 20 && control->maximum_readers <= 2,
            "Camera publication throughput or ownership failed");
    std::cout << "CAMERA_RESULT {\"scenario\":\"synthetic-publication\",\"accepted\":true,\"seconds\":" << seconds
              << ",\"submitted\":" << stats.submitted << ",\"publicationCommits\":" << stats.commits
              << ",\"captureOpens\":" << control->opens << ",\"lateCallbacks\":" << control->late_callbacks
              << ",\"maximumReaders\":" << control->maximum_readers << "}" << std::endl;
  }
  require(engine.shutdown(std::chrono::seconds{12}).ok, "Camera Engine shutdown failed");
  return 0;
}
int publicationFailure() {
  auto transport = std::make_shared<LiveKitRoomTransport>();
  auto control = std::make_shared<lab::SyntheticCameraControl>();
  CameraDeviceRegistry registry(std::make_unique<SyntheticEnumerator>());
  registry.refresh();
  CameraPipeline pipeline(lab::syntheticCameraReader(control));
  require(pipeline.selectDevice(registry, {}, {1280, 720, 30}) == CameraFailure::none &&
          pipeline.setDemand(true, true) == CameraFailure::none, "Failure fixture capture start failed");
  const auto generation = pipeline.stats().capture.generation;
  for (unsigned attempt = 0; attempt < 10; ++attempt) {
    CameraPublication publication(transport, pipeline.publication(), {1280, 720, 30});
    require(publication.start() == CameraPublicationFailure::publish_failed, "Missing Room did not fail publication");
    require(publication.stop(Clock::now() + std::chrono::seconds{6}), "Failed camera publication did not clean up");
    require(publication.stats().commits == 0 && !publication.stats().published &&
            pipeline.stats().capture.generation == generation && control->opens == 1,
            "Failed camera publication committed or restarted capture");
  }
  require(pipeline.stop(Clock::now() + std::chrono::seconds{2}) && control->readers_alive == 0,
          "Failure fixture capture cleanup failed");
  std::cout << "CAMERA_RESULT {\"scenario\":\"publication-failure\",\"accepted\":true,\"attempts\":10}" << std::endl;
  return 0;
}
}
int main(int argc, char** argv) try {
  const std::string command = argc > 1 ? argv[1] : "devices";
  if (command == "devices") return devices();
  if (command == "publication-failure") return publicationFailure();
  const unsigned value = argc > 2 ? static_cast<unsigned>(std::stoul(argv[2])) : 0;
  if (command == "physical" && value > 0) return physical(value);
  if (command == "cycles" && value > 0 && value <= 100) return cycles(value);
  if (command == "publish") return publish(value);
  throw std::runtime_error("Usage: camera_lab devices | physical ID | cycles COUNT | publish SECONDS");
} catch (const std::exception& error) {
  std::cerr << error.what() << std::endl;
  return 1;
}
