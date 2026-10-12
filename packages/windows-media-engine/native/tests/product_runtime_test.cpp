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
void inboundNetworkDiagnostics() {
  const auto audio_report = [](const char* id, std::int64_t lost, std::uint64_t concealed) {
    livekit::RtcInboundRtpStats report{};
    report.stream.kind = "audio";
    report.inbound.track_identifier = id;
    report.received.packets_received = 100;
    report.received.packets_lost = lost;
    report.inbound.concealed_samples = concealed;
    report.inbound.silent_concealed_samples = 3;
    report.inbound.concealment_events = 4;
    report.inbound.inserted_samples_for_deceleration = 5;
    report.inbound.removed_samples_for_acceleration = 6;
    report.inbound.jitter_buffer_delay = 0.5;
    report.inbound.jitter_buffer_emitted_count = 10;
    return livekit::RtcStats{report};
  };
  livekit::RtcInboundRtpStats video{};
  video.stream.kind = "video";
  video.received.packets_received = 200;
  video.received.packets_lost = 7;
  video.inbound.frames_decoded = 60;
  video.inbound.frames_dropped = 8;
  video.inbound.freeze_count = 2;
  video.inbound.total_freeze_duration = 1.25;
  video.inbound.pause_count = 3;
  video.inbound.total_pause_duration = 2;
  const std::array reports{audio_report("mic", -1, 11), audio_report("mic2", 2, 12),
      audio_report("screen", 4, 30), audio_report("unknown", 99, 99), livekit::RtcStats{video},
      livekit::RtcStats{livekit::RtcOutboundRtpStats{}}};
  const std::array tracks{InboundTrackSource{"mic", livekit::TrackSource::SOURCE_MICROPHONE},
      InboundTrackSource{"mic2", livekit::TrackSource::SOURCE_MICROPHONE},
      InboundTrackSource{"screen", livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO}};
  const auto metrics = inboundNetworkObservation(reports, tracks, 1234);
  const auto metric = [](const auto& values, std::string_view name) {
    const auto found = std::find_if(values.begin(), values.end(), [&](const auto& value) { return value.name == name; });
    require(found != values.end(), "network diagnostic metric missing");
    return found->value;
  };
  require(metric(metrics.microphone, "streams") == 2 && metric(metrics.screen_audio, "streams") == 1,
      "microphone and screen audio attribution");
  require(metric(metrics.microphone, "packets_lost") == 1 && metric(metrics.screen_audio, "packets_lost") == 4,
      "signed packet loss aggregated without clamping");
  require(metric(metrics.microphone, "concealed_samples") == 23 && metric(metrics.screen_audio, "concealed_samples") == 30,
      "concealment must not mix audio sources");
  require(metric(metrics.screen_audio, "silent_concealed_samples") == 3 &&
      metric(metrics.screen_audio, "concealment_events") == 4 &&
      metric(metrics.screen_audio, "inserted_samples_for_deceleration") == 5 &&
      metric(metrics.screen_audio, "removed_samples_for_acceleration") == 6 &&
      metric(metrics.screen_audio, "jitter_buffer_delay") == 0.5 &&
      metric(metrics.screen_audio, "jitter_buffer_emitted_count") == 10, "audio SDK stats projection");
  require(metric(metrics.microphone, "unmapped_streams") == 1 && metric(metrics.screen_audio, "unmapped_streams") == 1,
      "unknown audio must be visible but not misattributed");
  require(metric(metrics.video, "packets_lost") == 7 && metric(metrics.video, "frames_dropped") == 8 &&
      metric(metrics.video, "freeze_count") == 2 && metric(metrics.video, "total_freezes_duration") == 1.25 &&
      metric(metrics.video, "pause_count") == 3, "video SDK stats projection");
  require(metric(metrics.video, "sampled_at_ms") == 1234, "sample freshness timestamp");
  std::vector<livekit::RtcStats> oversized(257, livekit::RtcStats{video});
  const auto bounded = inboundNetworkObservation(oversized, {}, 2000);
  require(metric(bounded.video, "streams") == 256 && metric(bounded.video, "reports_truncated") == 1,
      "room stats diagnostics must remain bounded and mark truncation");
  require(metric(inboundNetworkObservation({}, {}, 2000, true).microphone, "reports_truncated") == 1,
      "publication truncation must be visible");
}
template <typename Predicate>
void await(Predicate predicate, const char* message) {
  const auto deadline = std::chrono::steady_clock::now() + 3s;
  while (!predicate() && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(2ms);
  require(predicate(), message);
}
void thumbnails(WindowsMediaRuntime& runtime) {
  std::vector<std::string> monitors;
  await([&] {
    const auto sources = runtime.screenSources();
    monitors.clear();
    for (const auto& source : sources.enumeration.sources)
      if (source.kind == sources::SourceKind::Monitor &&
          source.availability == sources::SourceAvailability::Available) monitors.push_back(source.id);
    return !monitors.empty();
  }, "monitor enumeration for thumbnail");
  std::uint64_t revision = 0;
  for (const auto& monitor : monitors) {
    const auto request_revision = ++revision;
    sources::ThumbnailSnapshot image;
    await([&] {
      image = runtime.queryThumbnail(request_revision, monitor);
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
  }
  const auto& monitor = monitors.front();
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
    inboundNetworkDiagnostics();
    run(argc == 2 && std::string_view(argv[1]) == "--thumbnails");
    std::cout << "product runtime lifecycle passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
