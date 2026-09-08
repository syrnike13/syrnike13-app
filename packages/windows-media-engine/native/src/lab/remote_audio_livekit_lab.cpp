#include "audio/remote_audio_tracks.hpp"
#include "audio/remote_audio_output.hpp"
#include "lab/remote_audio_probe.hpp"

#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>

#include <cmath>
#include <cstdlib>
#include <iostream>
#include <stdexcept>

using namespace syrnike::windows_media::audio;
namespace {
using Clock = std::chrono::steady_clock;
constexpr double kPi = 3.14159265358979323846;
struct SdkLifetime {
  SdkLifetime() { livekit::initialize(livekit::LogLevel::Warn); }
  ~SdkLifetime() { livekit::shutdown(); }
};
const char* environment(const char* name) {
  const auto* value = std::getenv(name);
  if (!value || !*value) throw std::runtime_error("Missing LiveKit lab environment");
  return value;
}
double amplitude(const std::array<std::int16_t, 480>& samples, double frequency) {
  double sine = 0, cosine = 0;
  for (std::size_t index = 0; index < samples.size(); ++index) {
    const auto phase = 2 * kPi * frequency * static_cast<double>(index) / 48000;
    sine += samples[index] * std::sin(phase);
    cosine += samples[index] * std::cos(phase);
  }
  return 2 * std::sqrt(sine * sine + cosine * cosine) / samples.size();
}
struct ProcessResources {
  std::uint64_t elapsed_ms = 0, private_bytes = 0;
  DWORD handles = 0, threads = 0;
};
ProcessResources resources(std::uint64_t elapsed_ms) {
  ProcessResources result;
  result.elapsed_ms = elapsed_ms;
  PROCESS_MEMORY_COUNTERS_EX memory{};
  if (!GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory), sizeof(memory)) ||
      !GetProcessHandleCount(GetCurrentProcess(), &result.handles)) throw std::runtime_error("Resource sampling failed");
  result.private_bytes = memory.PrivateUsage;
  const auto snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snapshot == INVALID_HANDLE_VALUE) throw std::runtime_error("Thread sampling failed");
  THREADENTRY32 thread{};
  thread.dwSize = sizeof(thread);
  if (Thread32First(snapshot, &thread)) {
    do { if (thread.th32OwnerProcessID == GetCurrentProcessId()) ++result.threads; } while (Thread32Next(snapshot, &thread));
  }
  CloseHandle(snapshot);
  return result;
}
// Separate SDK producer ownership keeps publication changes from stopping PCM.
class RoutingTone {
 public:
  RoutingTone(const std::shared_ptr<livekit::LocalParticipant>& participant,
              livekit::TrackSource kind, unsigned frequency)
      : participant_(participant), source_(std::make_shared<livekit::AudioSource>(48000, 2, 10)),
        track_(livekit::LocalAudioTrack::createLocalAudioTrack("routing-tone", source_)) {
    livekit::TrackPublishOptions options;
    options.source = kind;
    options.dtx = false;
    participant_->publishTrack(track_, options);
    std::cout << "REMOTE_AUDIO_ROUTING_PUBLISHED " << frequency << std::endl;
    worker_ = std::jthread([this, frequency](std::stop_token stop) {
      try {
        auto frame = livekit::AudioFrame::create(48000, 2, 480);
        auto next = Clock::now();
        std::uint64_t packet = 0;
        while (!stop.stop_requested()) {
          for (std::size_t index = 0; index < 480; ++index) {
            const auto value = static_cast<std::int16_t>(1000 * std::sin(
                2 * kPi * frequency * static_cast<double>(packet * 480 + index) / 48000));
            frame.data()[index * 2] = frame.data()[index * 2 + 1] = value;
          }
          source_->captureFrame(frame, 100);
          ++packet;
          next += std::chrono::milliseconds{10};
          if (Clock::now() > next + std::chrono::milliseconds{20}) next = Clock::now();
          std::this_thread::sleep_until(next);
        }
      } catch (...) { failed_ = true; }
    });
  }
  ~RoutingTone() {
    worker_.request_stop();
    if (worker_.joinable()) worker_.join();
    try { if (track_->publication()) participant_->unpublishTrack(track_->publication()->sid()); }
    catch (...) {}
  }
  bool failed() const { return failed_; }
 private:
  std::shared_ptr<livekit::LocalParticipant> participant_;
  std::shared_ptr<livekit::AudioSource> source_;
  std::shared_ptr<livekit::LocalAudioTrack> track_;
  std::atomic_bool failed_{false};
  std::jthread worker_;
};
class RoutingVideo {
 public:
  explicit RoutingVideo(const std::shared_ptr<livekit::LocalParticipant>& participant)
      : participant_(participant), source_(std::make_shared<livekit::VideoSource>(1280, 720)),
        track_(livekit::LocalVideoTrack::createLocalVideoTrack("routing-screen", source_)) {
    livekit::TrackPublishOptions options;
    options.source = livekit::TrackSource::SOURCE_SCREENSHARE;
    options.simulcast = false;
    options.video_codec = livekit::VideoCodec::H264;
    options.video_encoding = livekit::VideoEncodingOptions{3'000'000, 30.0};
    participant_->publishTrack(track_, options);
    worker_ = std::jthread([this](std::stop_token stop) {
      try {
        auto frame = livekit::VideoFrame::create(1280, 720, livekit::VideoBufferType::RGBA);
        std::fill_n(frame.data(), frame.dataSize(), 128);
        auto next = Clock::now();
        while (!stop.stop_requested()) {
          livekit::VideoCaptureOptions options;
          options.timestamp_us = std::chrono::duration_cast<std::chrono::microseconds>(Clock::now().time_since_epoch()).count();
          source_->captureFrame(frame, options);
          next = (std::max)(next + std::chrono::milliseconds{33}, Clock::now());
          std::this_thread::sleep_until(next);
        }
      } catch (...) { failed_ = true; }
    });
  }
  ~RoutingVideo() {
    worker_.request_stop();
    if (worker_.joinable()) worker_.join();
    try { if (track_->publication()) participant_->unpublishTrack(track_->publication()->sid()); }
    catch (...) {}
  }
  std::string sid() const { return track_->publication()->sid(); }
  bool failed() const { return failed_; }
 private:
  std::shared_ptr<livekit::LocalParticipant> participant_;
  std::shared_ptr<livekit::VideoSource> source_;
  std::shared_ptr<livekit::LocalVideoTrack> track_;
  std::atomic_bool failed_{false};
  std::jthread worker_;
};
}  // namespace
int remoteAudioRouting() {
  SdkLifetime sdk;
  AudioDeviceRegistry registry(makeWindowsAudioDeviceEnumerator());
  if (registry.refresh().status != AudioRegistryStatus::ready) throw std::runtime_error("Routing registry unavailable");
  RemoteAudioMixerWorker mixer;
  auto tracks = std::make_shared<RemoteAudioTracks>(mixer);
  auto receiver = std::make_shared<livekit::Room>();
  livekit::Room publisher;
  livekit::RoomOptions options;
  options.auto_subscribe = false;
  if (!tracks->attachRoom(receiver)) throw std::runtime_error("Routing attachment failed");
  receiver->setDelegate(tracks.get());
  if (!receiver->connect(environment("LIVEKIT_URL"), environment("LIVEKIT_OBSERVER_TOKEN"), options) ||
      !publisher.connect(environment("LIVEKIT_URL"), environment("LIVEKIT_PUBLISHER_TOKEN"), options) ||
      !tracks->seedConnectedRoom()) throw std::runtime_error("Routing connect failed");
  auto participant = publisher.localParticipant().lock();
  if (!participant) throw std::runtime_error("Routing participant missing");
  auto microphone = std::make_unique<RoutingTone>(participant, livekit::TrackSource::SOURCE_MICROPHONE, 700);
  auto screen = std::make_unique<RoutingTone>(participant, livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO, 1700);
  auto video = std::make_unique<RoutingVideo>(participant);
  RemoteAudioOutput output(mixer);
  if (output.selectOutput(registry, {AudioDirection::output, {}}) != RemoteOutputFailure::none)
    throw std::runtime_error("Routing output failed");
  auto reference = output.echoReference();
  struct Measurement { const char* name; std::uint64_t frames = 0; double mic = 0, screen = 0, replacement = 0; bool passed = false; };
  std::vector<Measurement> measurements;
  const auto measure = [&](const char* name, double expected_mic, double expected_screen, double expected_replacement) {
    Measurement value{name};
    const auto began = Clock::now();
    while (Clock::now() - began < std::chrono::milliseconds{2500}) {
      if (const auto frame = reference->take(); frame && Clock::now() - began >= std::chrono::milliseconds{1000}) {
        ++value.frames;
        value.mic += amplitude(frame->samples, 700);
        value.screen += amplitude(frame->samples, 1700);
        value.replacement += amplitude(frame->samples, 900);
      }
      std::this_thread::sleep_for(std::chrono::milliseconds{5});
    }
    if (value.frames) {
      value.mic /= value.frames;
      value.screen /= value.frames;
      value.replacement /= value.frames;
    }
    const auto matches = [](double actual, double expected) {
      return expected == 0 ? actual < 15 : actual > expected * 0.7 && actual < expected * 1.2;
    };
    value.passed = value.frames > 80 && matches(value.mic, expected_mic) &&
        matches(value.screen, expected_screen) && matches(value.replacement, expected_replacement);
    measurements.push_back(value);
    std::cout << "REMOTE_AUDIO_ROUTING_PHASE " << name << ' ' << (value.passed ? "pass" : "fail") << std::endl;
    const auto ingress = tracks->stats();
    std::cout << "REMOTE_AUDIO_ROUTING_INGRESS reading=" << ingress.reading << " decoded=" << ingress.decoded
              << " screenProducerFailed=" << (screen && screen->failed()) << std::endl;
    for (const auto& entry : receiver->remotePublications(64).entries)
      std::cout << "REMOTE_AUDIO_ROUTING_PUBLICATION " << entry.publication->sid() << " source="
                << static_cast<int>(entry.publication->source()) << std::endl;
  };
  const auto demand = [&](const std::string& sid) {
    const std::array requested{syrnike::windows_media::RemoteVideoDemand{"remote-a", sid}};
    if (!tracks->setScreenDemand(requested)) throw std::runtime_error("Routing demand rejected");
  };
  measure("microphone-only", 1000, 0, 0);
  const auto old_sid = video->sid();
  demand(old_sid);
  measure("screen-demand", 1000, 1000, 0);
  microphone.reset();
  measure("early-microphone-removed", 0, 1000, 0);
  microphone = std::make_unique<RoutingTone>(participant, livekit::TrackSource::SOURCE_MICROPHONE, 700);
  measure("early-microphone-restored", 1000, 1000, 0);
  if (!tracks->setScreenDemand({})) throw std::runtime_error("Routing revoke rejected");
  measure("screen-revoked", 1000, 0, 0);
  demand(old_sid);
  measure("screen-restored", 1000, 1000, 0);
  video.reset();
  video = std::make_unique<RoutingVideo>(participant);
  measure("old-video-sid", 1000, 0, 0);
  demand(video->sid());
  measure("new-video-sid", 1000, 1000, 0);
  if (!tracks->setUserVolume("remote-a", 0.5f, false)) throw std::runtime_error("Routing volume rejected");
  measure("participant-half", 500, 500, 0);
  microphone.reset();
  measure("microphone-removed", 0, 500, 0);
  microphone = std::make_unique<RoutingTone>(participant, livekit::TrackSource::SOURCE_MICROPHONE, 900);
  measure("microphone-replaced", 0, 500, 500);
  if (!tracks->setUserVolume("remote-a", 0.5f, true)) throw std::runtime_error("Routing mute rejected");
  measure("participant-muted", 0, 0, 0);
  if (!tracks->setUserVolume("remote-a", 0.5f, false)) throw std::runtime_error("Routing unmute rejected");
  measure("participant-unmuted", 0, 500, 500);
  bool producers_healthy = !microphone->failed() && !screen->failed() && !video->failed();
  microphone.reset();
  screen.reset();
  video.reset();
  measure("publications-removed", 0, 0, 0);
  if (!tracks->detachRoom()) throw std::runtime_error("Routing old Room detach failed");
  receiver->disconnect();
  receiver->setDelegate(nullptr);
  receiver = std::make_shared<livekit::Room>();
  if (!tracks->attachRoom(receiver)) throw std::runtime_error("Routing replacement Room attachment failed");
  receiver->setDelegate(tracks.get());
  if (!receiver->connect(environment("LIVEKIT_URL"), environment("LIVEKIT_OBSERVER_TOKEN"), options) ||
      !tracks->seedConnectedRoom()) throw std::runtime_error("Routing replacement Room connect failed");
  microphone = std::make_unique<RoutingTone>(participant, livekit::TrackSource::SOURCE_MICROPHONE, 900);
  screen = std::make_unique<RoutingTone>(participant, livekit::TrackSource::SOURCE_SCREENSHARE_AUDIO, 1700);
  video = std::make_unique<RoutingVideo>(participant);
  measure("room-replaced-controls", 0, 0, 500);
  demand(video->sid());
  measure("room-replaced-screen", 0, 500, 500);
  producers_healthy = producers_healthy && !microphone->failed() && !screen->failed() && !video->failed();
  microphone.reset();
  screen.reset();
  video.reset();
  measure("replacement-publications-removed", 0, 0, 0);
  const auto ingress = tracks->stats();
  const bool connected = receiver->connectionState() == livekit::ConnectionState::Connected;
  const bool detached = tracks->detachRoom();
  receiver->disconnect();
  receiver->setDelegate(nullptr);
  publisher.disconnect();
  tracks->stop();
  const bool stopped = output.stop(Clock::now() + std::chrono::seconds{5});
  const bool mixer_stopped = mixer.stop(Clock::now() + std::chrono::seconds{5});
  bool passed = producers_healthy && connected && detached && stopped && mixer_stopped && !ingress.failed &&
      !ingress.track_failures && ingress.reading == 0;
  for (const auto& value : measurements) passed = passed && value.passed;
  std::cout << "{\"scope\":\"livekit-audio-routing\",\"status\":\"" << (passed ? "pass" : "fail")
            << "\",\"decoded\":" << ingress.decoded << ",\"trackFailures\":" << ingress.track_failures
            << ",\"rejected\":" << ingress.rejected << ",\"measurements\":[";
  for (std::size_t index = 0; index < measurements.size(); ++index) {
    const auto& value = measurements[index];
    if (index) std::cout << ',';
    std::cout << "{\"name\":\"" << value.name << "\",\"frames\":" << value.frames << ",\"tone700\":" << value.mic
              << ",\"tone1700\":" << value.screen << ",\"tone900\":" << value.replacement
              << ",\"passed\":" << (value.passed ? "true" : "false") << '}';
  }
  std::cout << "]}" << std::endl;
  return passed ? 0 : 1;
}
int remoteAudioPublish(unsigned seconds, unsigned frequency) {
  SdkLifetime sdk;
  livekit::Room room;
  livekit::RoomOptions room_options;
  room_options.auto_subscribe = false;
  if (!room.connect(environment("LIVEKIT_URL"), environment("LIVEKIT_PUBLISHER_TOKEN"), room_options))
    throw std::runtime_error("Remote audio publisher connect failed");
  auto participant = room.localParticipant().lock();
  if (!participant) throw std::runtime_error("Publisher participant unavailable");
  auto source = std::make_shared<livekit::AudioSource>(48000, 2, 10);
  auto track = livekit::LocalAudioTrack::createLocalAudioTrack("remote-audio-tone", source);
  livekit::TrackPublishOptions options;
  options.source = livekit::TrackSource::SOURCE_MICROPHONE;
  options.dtx = false;
  participant->publishTrack(track, options);
  std::cout << "REMOTE_AUDIO_PUBLISHER_READY" << std::endl;
  auto frame = livekit::AudioFrame::create(48000, 2, 480);
  auto next = Clock::now();
  for (std::uint64_t packet = 0; packet < seconds * 100; ++packet) {
    for (std::size_t index = 0; index < 480; ++index) {
      const auto position = packet * 480 + index;
      const auto value = static_cast<std::int16_t>(1000 * std::sin(2 * kPi * frequency * static_cast<double>(position) / 48000));
      frame.data()[index * 2] = frame.data()[index * 2 + 1] = value;
    }
    source->captureFrame(frame, 100);
    next += std::chrono::milliseconds{10};
    if (Clock::now() > next + std::chrono::milliseconds{20}) next = Clock::now();
    std::this_thread::sleep_until(next);
  }
  if (track->publication()) participant->unpublishTrack(track->publication()->sid());
  room.disconnect();
  return 0;
}
int remoteAudioReceive(unsigned seconds, bool inject_reader_delay) {
  SdkLifetime sdk;
  AudioDeviceRegistry registry(makeWindowsAudioDeviceEnumerator());
  if (registry.refresh().status != AudioRegistryStatus::ready) throw std::runtime_error("Audio registry unavailable");
  RemoteAudioMixerWorker mixer;
  auto tracks = std::make_shared<RemoteAudioTracks>(mixer);
  auto room = std::make_shared<livekit::Room>();
  if (!tracks->attachRoom(room)) throw std::runtime_error("Audio Room attachment failed");
  room->setDelegate(tracks.get());
  livekit::RoomOptions options;
  options.auto_subscribe = false;
  if (!room->connect(environment("LIVEKIT_URL"), environment("LIVEKIT_OBSERVER_TOKEN"), options))
    throw std::runtime_error("Remote audio receiver connect failed");
  if (!tracks->seedConnectedRoom()) throw std::runtime_error("Remote audio initial publication snapshot failed");
  RemoteAudioOutput output(mixer);
  if (output.selectOutput(registry, {AudioDirection::output, {}}) != RemoteOutputFailure::none)
    throw std::runtime_error("Remote audio receiver output failed");
  std::cout << "REMOTE_AUDIO_RECEIVER_READY" << std::endl;
  struct Measurement { std::uint64_t frames = 0; double first = 0, second = 0; };
  std::array<Measurement, 7> measurements{};
  auto reference = output.echoReference();
  const auto began = Clock::now();
  auto next_resources = began + std::chrono::seconds{5};
  std::array<ProcessResources, 64> resource_samples{};
  std::size_t resource_count = 0;
  unsigned prior = 99;
  bool delayed = false;
  while (Clock::now() - began < std::chrono::seconds{seconds}) {
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - began).count();
    if (inject_reader_delay && !delayed && elapsed >= 20'500) {
      syrnike::windows_media::lab::decoded_reader_delay_ms = 250;
      delayed = true;
    }
    if (Clock::now() >= next_resources && resource_count < resource_samples.size()) {
      resource_samples[resource_count++] = resources(static_cast<std::uint64_t>(elapsed));
      next_resources = Clock::now() + std::chrono::seconds{30};
      const auto& sample = resource_samples[resource_count - 1];
      std::cout << "REMOTE_AUDIO_RESOURCE {\"elapsedMs\":" << sample.elapsed_ms << ",\"privateBytes\":"
                << sample.private_bytes << ",\"handles\":" << sample.handles << ",\"threads\":" << sample.threads << "}" << std::endl;
    }
    // Two seconds warm-up, then three seconds per control state. A long soak
    // remains in the restored state, with bounded aggregate measurements.
    const auto phase = static_cast<unsigned>((std::clamp)((elapsed - 2000) / 3000, std::int64_t{0}, std::int64_t{6}));
    if (phase != prior) {
      constexpr std::array<float, 7> volumes{1, 0.5f, 0, 2, 1, 1, 1};
      if (!tracks->setUserVolume("remote-a", volumes[phase], phase == 4))
        throw std::runtime_error("Remote volume rejected");
      tracks->setDeafened(phase == 5);
      if (!output.setDeafened(phase == 5)) throw std::runtime_error("Output deafen failed");
      prior = phase;
    }
    if (const auto frame = reference->take(); frame && elapsed >= 2500 &&
        (phase == 6 || (elapsed - 2000) % 3000 >= 500)) {
      auto& measured = measurements[phase];
      ++measured.frames;
      measured.first += amplitude(frame->samples, 700);
      measured.second += amplitude(frame->samples, 1300);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds{5});
  }
  const auto ingress = tracks->stats();
  if (resource_count < resource_samples.size()) resource_samples[resource_count++] = resources(seconds * 1000);
  const auto render = output.stats().active;
  const auto mix = mixer.stats();
  const auto connected = room->connectionState() == livekit::ConnectionState::Connected;
  const auto detached = tracks->detachRoom();
  room->disconnect();
  room->setDelegate(nullptr);
  tracks->stop();
  const auto stopped = output.stop(Clock::now() + std::chrono::seconds{5});
  const auto mixer_stopped = mixer.stop(Clock::now() + std::chrono::seconds{5});
  for (auto& value : measurements) {
    if (!value.frames) continue;
    value.first /= value.frames;
    value.second /= value.frames;
  }
  const auto base = measurements[0].first;
  std::uint64_t age_samples = 0, cumulative = 0;
  for (const auto count : render.scheduled_age_histogram) age_samples += count;
  unsigned p95_age_ms = 0;
  for (std::size_t index = 0; index < render.scheduled_age_histogram.size(); ++index) {
    cumulative += render.scheduled_age_histogram[index];
    if (cumulative * 100 >= age_samples * 95) { p95_age_ms = static_cast<unsigned>(index + 1) * 10; break; }
  }
  bool passed = connected && detached && stopped && mixer_stopped && !ingress.failed &&
      ingress.reading == 2 && ingress.track_failures == 0 && base > 300 && measurements[0].second > 300 &&
      render.maximum_scheduled_age_100ns <= kRemoteAudioMaximumAge100ns && mix.inputs == 2;
  const auto baseline_resources = resource_samples[0];
  const auto final_resources = resource_samples[resource_count - 1];
  const bool resources_bounded = final_resources.private_bytes <= baseline_resources.private_bytes + 64 * 1024 * 1024 &&
      final_resources.handles <= baseline_resources.handles + 20 && final_resources.threads <= baseline_resources.threads + 8;
  passed = passed && resources_bounded;
  passed = passed && ingress.maximum_observed_sdk_queue <= 4 && ingress.maximum_observed_app_queue <= 2;
  if (inject_reader_delay) passed = passed && delayed && ingress.sdk_dropped >= 30 && mix.discontinuities > 0;
  for (const auto& value : measurements) passed = passed && value.frames > 80;
  passed = passed && measurements[1].first / base > 0.35 && measurements[1].first / base < 0.65 &&
      measurements[2].first < 10 && measurements[3].first / base > 1.7 && measurements[3].first / base < 2.3 &&
      measurements[4].first < 10 && measurements[5].first < 1 && measurements[5].second < 1 &&
      measurements[6].first / base > 0.8 && measurements[6].first / base < 1.2;
  for (std::size_t index = 1; index < measurements.size(); ++index)
    if (index != 5) passed = passed && measurements[index].second / measurements[0].second > 0.8 &&
        measurements[index].second / measurements[0].second < 1.2;
  std::cout << "{\"scope\":\"livekit-mixer-rendered-reference\",\"status\":\"" << (passed ? "pass" : "fail")
            << "\",\"seconds\":" << seconds << ",\"decoded\":" << ingress.decoded
            << ",\"reading\":" << ingress.reading << ",\"trackFailures\":" << ingress.track_failures
            << ",\"rejected\":" << ingress.rejected << ",\"roomConnected\":" << (connected ? "true" : "false")
            << ",\"injectedDecodedReaderDelayMs\":" << (inject_reader_delay ? 250 : 0)
            << ",\"sdkDropped\":" << ingress.sdk_dropped << ",\"sdkStale\":" << ingress.sdk_stale
            << ",\"maximumObservedSdkQueueFrames\":" << ingress.maximum_observed_sdk_queue
            << ",\"maximumObservedAppQueueFrames\":" << ingress.maximum_observed_app_queue
            << ",\"mixerDiscontinuities\":" << mix.discontinuities
            << ",\"maximumScheduledAgeUs\":" << render.maximum_scheduled_age_100ns / 10
            << ",\"maximumMixerAgeUs\":" << mix.maximum_age_100ns / 10
            << ",\"staleFragments\":" << render.stale_fragments
            << ",\"p95ScheduledAgeUpperMs\":" << p95_age_ms
            << ",\"underruns\":" << render.underruns << ",\"measurements\":[";
  for (std::size_t index = 0; index < measurements.size(); ++index) {
    const auto& value = measurements[index];
    if (index) std::cout << ',';
    std::cout << "{\"phase\":" << index << ",\"frames\":" << value.frames << ",\"tone700\":"
              << value.first << ",\"tone1300\":" << value.second << '}';
  }
  std::cout << "],\"resourceSamples\":[";
  for (std::size_t index = 0; index < resource_count; ++index) {
    const auto& sample = resource_samples[index];
    if (index) std::cout << ',';
    std::cout << "{\"elapsedMs\":" << sample.elapsed_ms << ",\"privateBytes\":" << sample.private_bytes
              << ",\"handles\":" << sample.handles << ",\"threads\":" << sample.threads << '}';
  }
  std::cout << "],\"resourcesBounded\":" << (resources_bounded ? "true" : "false") << "}" << std::endl;
  return passed ? 0 : 1;
}
