#include "core/windows_media_runtime.hpp"
#include "capture/optional_preview_budget.hpp"

#include <algorithm>
#include <atomic>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {
using namespace syrnike::windows_media;
using namespace std::chrono_literals;
void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
template <typename Predicate>
void await(Predicate predicate, const char* message) {
  const auto deadline = std::chrono::steady_clock::now() + 3s;
  while (!predicate() && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(2ms);
  require(predicate(), message);
}
void thumbnails(WindowsMediaRuntime& runtime) {
  std::string monitor;
  await([&] {
    const auto sources = runtime.screenSources();
    const auto found = std::find_if(sources.enumeration.sources.begin(), sources.enumeration.sources.end(),
        [](const auto& source) { return source.kind == sources::SourceKind::Monitor &&
            source.availability == sources::SourceAvailability::Available; });
    if (found != sources.enumeration.sources.end()) monitor = found->id;
    return !monitor.empty();
  }, "monitor enumeration for thumbnail");
  std::uint64_t revision = 1;
  sources::ThumbnailSnapshot image;
  await([&] {
    image = runtime.queryThumbnail(revision, monitor);
    return image.state != sources::ThumbnailState::pending;
  }, "thumbnail completion deadline");
  require(image.state == sources::ThumbnailState::ready && image.pixels &&
      image.pixels->size() == sources::kThumbnailBytes, "ready thumbnail pixels");
  const auto& pixels = *image.pixels;
  bool varied = false;
  for (std::size_t offset = 4; offset < pixels.size(); offset += 4) {
    require(pixels[offset + 3] == 255, "opaque thumbnail output");
    varied = varied || pixels[offset] != pixels[0] || pixels[offset + 1] != pixels[1] || pixels[offset + 2] != pixels[2];
  }
  require(varied, "neutral thumbnail readback contains visible content");
  image = {};
  runtime.queryThumbnail(++revision, {});
  for (unsigned cycle = 0; cycle < 16; ++cycle) {
    runtime.queryThumbnail(++revision, monitor);
    await([&] { return runtime.thumbnailStats().active == 1; }, "thumbnail job admitted");
    const auto cancellation = ++revision;
    runtime.queryThumbnail(cancellation, {});
    await([&] { return runtime.thumbnailStats().active == 0; }, "cancelled capture drained");
    require(runtime.queryThumbnail(cancellation, {}).state == sources::ThumbnailState::cancelled,
        "late thumbnail must not replace cancellation");
  }
  const auto stats = runtime.thumbnailStats();
  require(stats.peak_active == 1 && stats.cancelled == 16, "one capture under cancellation pressure");
  require(capture::optionalPreviewBytes() == 0, "thumbnail GPU backing returns to baseline");
  std::cout << "{\"test\":\"thumbnail\",\"ready\":" << stats.ready << ",\"cancelled\":" << stats.cancelled
            << ",\"peakActive\":" << stats.peak_active << ",\"pixelBytes\":" << sources::kThumbnailBytes
            << ",\"optionalBytesAfter\":" << capture::optionalPreviewBytes() << "}\n";
}
void mediaTasksHaveBoundedAdmissionAndReservedRoomControl(LiveKitRoomTransport& transport) {
  struct Probe {
    std::mutex mutex;
    std::condition_variable changed;
    bool entered = false, released = false, serial = true;
    std::thread::id worker;
    std::vector<std::size_t> order;
  };
  const auto probe = std::make_shared<Probe>();
  require(transport.enqueueActiveRoomTask([probe](const auto&) {
    std::unique_lock lock(probe->mutex);
    probe->worker = std::this_thread::get_id();
    probe->entered = true;
    probe->changed.notify_all();
    probe->changed.wait_for(lock, 3s, [&] { return probe->released; });
    probe->order.push_back(0);
  }), "first SDK task was rejected");
  await([&] { std::lock_guard lock(probe->mutex); return probe->entered; },
        "SDK worker did not enter barrier");
  const auto record = [probe](std::size_t value) {
    std::lock_guard lock(probe->mutex);
    probe->serial &= probe->worker == std::this_thread::get_id();
    probe->order.push_back(value);
  };
  for (std::size_t index = 0; index < kLiveKitMediaTaskCapacity; ++index)
    require(transport.enqueueActiveRoomTask([record, index](const auto&) { record(index + 2); }),
            "independent media task was rejected before the queue bound");
  require(!transport.enqueueActiveRoomTask([](const auto&) {}), "SDK queue exceeded its bound");
  // No Room is connected: the typed completion is still delivered through the
  // reserved control slot, ahead of queued media, without network activity.
  transport.startDisconnect(0, [record](auto, auto) { record(1); });
  require(transport.pendingOperationCount() == kLiveKitMediaTaskCapacity + 2,
          "SDK pending count omitted queued media or reserved control");
  {
    std::lock_guard lock(probe->mutex);
    probe->released = true;
  }
  probe->changed.notify_all();
  await([&] {
    std::lock_guard lock(probe->mutex);
    return probe->order.size() == kLiveKitMediaTaskCapacity + 2;
  }, "SDK queue did not drain");
  std::lock_guard lock(probe->mutex);
  require(probe->serial, "SDK tasks ran outside their single owner thread");
  for (std::size_t index = 0; index < probe->order.size(); ++index)
    require(probe->order[index] == index, "Room priority or media FIFO order changed");
}

void run(bool test_thumbnails) {
  auto runtime = std::make_shared<WindowsMediaRuntime>();
  // Retain transport past runtime destruction, as EngineOptions can do. Its
  // delegate must retain joined readers and their mixer without dangling refs.
  const auto transport = runtime->transport();
  if (!test_thumbnails) mediaTasksHaveBoundedAdmissionAndReservedRoomControl(*transport);
  {
    Engine engine({.room_transport = transport, .media_runtime = runtime});
    std::atomic_bool invalid_revision = false;
    require(engine.registerEventCallback([&](const PublicEvent& event) {
      if (const auto track = std::get_if<TrackStateChangedEvent>(&event))
        if (track->media.revision == 0) invalid_revision = true;
    }).ok, "register callback");
    require(engine.start().ok, "start engine");
    EngineDesiredState desired;
    desired.revision = 1;
    require(engine.applyDesiredState(desired).ok, "apply off");
    if (test_thumbnails) thumbnails(*runtime);
    desired.screen.state = ScreenIntentState::on;
    desired.screen.source_id = "unavailable-test-source";
    desired.screen.width = 1920;
    desired.screen.height = 1080;
    desired.screen.fps = 60;
    desired.screen.bitrate = 8'000'000;
    desired.screen.audio_mode = ScreenIntentAudioMode::process;
    desired.screen.audio_bitrate = 128'000;
    desired.revision = 2;
    require(engine.applyDesiredState(desired).ok, "accept intent before Room authority");
    const auto deadline = std::chrono::steady_clock::now() + 2s;
    bool settled = false;
    while (std::chrono::steady_clock::now() < deadline) {
      const auto media = runtime->snapshot();
      const auto& screen = media.paths[static_cast<std::size_t>(TrackKind::Screen)];
      if (screen.revision == 2 && screen.state == MediaPathState::Starting && media.publications_stopped) {
        settled = true;
        break;
      }
      std::this_thread::sleep_for(5ms);
    }
    require(settled, "media must wait for Room without opening publications");
    require(!transport->activeRoom(), "media intent must not create Room membership");
    require(engine.ping().ok, "control remains responsive");
    require(engine.shutdown().ok, "joined shutdown");
    require(!invalid_revision, "track events must refer to an accepted intent revision");
    const auto stopped = runtime->snapshot();
    require(stopped.stopped && stopped.publications_stopped, "all owners acknowledged shutdown");
    require(std::all_of(stopped.paths.begin(), stopped.paths.end(), [](const auto& path) {
      return path.state == MediaPathState::Off;
    }), "shutdown projects all paths off");
  }
  runtime.reset();
}
}  // namespace
int main(int argc, char** argv) {
  try {
    run(argc == 2 && std::string_view(argv[1]) == "--thumbnails");
    std::cout << "product runtime lifecycle passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
