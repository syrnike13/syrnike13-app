#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <windows.h>

// The Tool Help declarations depend on WinAPI types from windows.h.
#include <tlhelp32.h>

#include "core/engine.hpp"
#include "livekit/livekit.h"
#include "livekit/livekit_room_transport.hpp"

namespace {

constexpr int kAudioSampleRate = 48000;
constexpr int kAudioChannels = 1;
constexpr int kAudioFrameMilliseconds = 10;
constexpr int kMarkerBits = 96;
constexpr int kMarkerColumns = 24;
constexpr int kMarkerTileSize = 12;
constexpr std::uint16_t kMarkerMagic = 0x534d;
constexpr double kPi = 3.14159265358979323846;

using syrnike::windows_media::CredentialLease;
using syrnike::windows_media::Engine;
using syrnike::windows_media::EngineDesiredState;
using syrnike::windows_media::EngineOptions;
using syrnike::windows_media::LiveKitRoomTransport;
using syrnike::windows_media::RoomIntent;
using RoomPublicState = syrnike::windows_media::RoomStateChangedEvent::State;

struct Options {
  std::string url;
  std::string token;
  std::string scenario = "normal";
  int width = 640;
  int height = 360;
  int frames = 660;
  int frames_per_second = 15;
  int lifecycle_cycles = 50;
  int cleanup_deadline_ms = 5000;
  bool wait_for_subscribers = true;
};

std::string requiredEnvironment(const char *name) {
  const auto *value = std::getenv(name);
  if (value == nullptr || *value == '\0') {
    throw std::runtime_error(std::string("Missing environment variable: ") +
                             name);
  }
  return value;
}

int integerEnvironment(const char *name, int fallback, int minimum,
                       int maximum) {
  const auto *value = std::getenv(name);
  if (value == nullptr || *value == '\0')
    return fallback;
  const auto parsed = std::stoi(value);
  if (parsed < minimum || parsed > maximum) {
    throw std::runtime_error(
        std::string("Out-of-range environment variable: ") + name);
  }
  return parsed;
}

std::string stringEnvironment(const char *name, std::string fallback) {
  const auto *value = std::getenv(name);
  return value == nullptr || *value == '\0' ? std::move(fallback) : value;
}

bool booleanEnvironment(const char *name, bool fallback) {
  const auto *value = std::getenv(name);
  if (value == nullptr || *value == '\0')
    return fallback;
  const std::string parsed(value);
  if (parsed == "true")
    return true;
  if (parsed == "false")
    return false;
  throw std::runtime_error(
      std::string("Invalid boolean environment variable: ") + name);
}

Options optionsFromEnvironment() {
  Options options;
  options.url = requiredEnvironment("LIVEKIT_URL");
  options.token = requiredEnvironment("LIVEKIT_PUBLISHER_TOKEN");
  options.scenario = stringEnvironment("MEDIA_LAB_SCENARIO", "normal");
  options.width = integerEnvironment("MEDIA_LAB_VIDEO_WIDTH", 640, 320, 1920);
  options.height = integerEnvironment("MEDIA_LAB_VIDEO_HEIGHT", 360, 180, 1080);
  options.frames = integerEnvironment("MEDIA_LAB_VIDEO_FRAMES", 660, 1, 100000);
  options.frames_per_second =
      integerEnvironment("MEDIA_LAB_VIDEO_FPS", 15, 1, 60);
  options.lifecycle_cycles =
      integerEnvironment("MEDIA_LAB_LIFECYCLE_CYCLES", 50, 1, 1000);
  options.cleanup_deadline_ms =
      integerEnvironment("MEDIA_LAB_CLEANUP_DEADLINE_MS", 5000, 100, 60000);
  options.wait_for_subscribers =
      booleanEnvironment("MEDIA_LAB_WAIT_FOR_SUBSCRIBERS", true);
  if (options.scenario != "normal" && options.scenario != "republish" &&
      options.scenario != "disconnect-before-publish" &&
      options.scenario != "lifecycle-churn")
    throw std::runtime_error("Unsupported MEDIA_LAB_SCENARIO");
  if (options.width < kMarkerColumns * kMarkerTileSize ||
      options.height < 4 * kMarkerTileSize) {
    throw std::runtime_error(
        "Video resolution is too small for the machine-readable marker");
  }
  return options;
}

std::uint64_t epochMilliseconds() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch())
          .count());
}

bool markerBit(std::uint64_t sequence, std::uint64_t captured_at_ms,
               int index) {
  if (index < 16)
    return ((kMarkerMagic >> (15 - index)) & 1U) != 0;
  if (index < 48)
    return ((sequence >> (47 - index)) & 1ULL) != 0;
  return ((captured_at_ms >> (95 - index)) & 1ULL) != 0;
}

void fillVideoFrame(livekit::VideoFrame &frame, std::uint64_t sequence,
                    std::uint64_t captured_at_ms) {
  auto *pixels = frame.data();
  const auto width = frame.width();
  const auto height = frame.height();
  const auto moving_x =
      static_cast<int>((sequence * 7) % static_cast<std::uint64_t>(width));

  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const auto offset = static_cast<std::size_t>((y * width + x) * 4);
      const bool bar = std::abs(x - moving_x) < 12;
      pixels[offset] =
          static_cast<std::uint8_t>(bar ? 240 : (x + sequence) % 180 + 30);
      pixels[offset + 1] =
          static_cast<std::uint8_t>(bar ? 80 : (y * 2 + sequence) % 180 + 30);
      pixels[offset + 2] =
          static_cast<std::uint8_t>(bar ? 40 : (x + y + sequence) % 180 + 30);
      pixels[offset + 3] = 255;
    }
  }

  for (int bit = 0; bit < kMarkerBits; ++bit) {
    const int column = bit % kMarkerColumns;
    const int row = bit / kMarkerColumns;
    const auto level = static_cast<std::uint8_t>(
        markerBit(sequence, captured_at_ms, bit) ? 255 : 0);
    for (int y = row * kMarkerTileSize; y < (row + 1) * kMarkerTileSize; ++y) {
      for (int x = column * kMarkerTileSize; x < (column + 1) * kMarkerTileSize;
           ++x) {
        const auto offset = static_cast<std::size_t>((y * width + x) * 4);
        pixels[offset] = level;
        pixels[offset + 1] = level;
        pixels[offset + 2] = level;
        pixels[offset + 3] = 255;
      }
    }
  }
}

void runAudio(const std::shared_ptr<livekit::AudioSource> &source,
              std::atomic_bool &running) {
  const int samples_per_channel =
      kAudioSampleRate * kAudioFrameMilliseconds / 1000;
  std::uint64_t frame_sequence = 0;
  auto next_frame = std::chrono::steady_clock::now();
  while (running.load()) {
    auto frame = livekit::AudioFrame::create(kAudioSampleRate, kAudioChannels,
                                             samples_per_channel);
    const bool control_pulse = frame_sequence % 100 < 2;
    const double frequency = control_pulse ? 1000.0 : 440.0;
    const double amplitude = control_pulse ? 20000.0 : 900.0;
    for (int sample = 0; sample < samples_per_channel; ++sample) {
      const auto global_sample = frame_sequence * samples_per_channel + sample;
      frame.data()[static_cast<std::size_t>(sample)] =
          static_cast<std::int16_t>(
              amplitude *
              std::sin(2.0 * kPi * frequency *
                       static_cast<double>(global_sample) / kAudioSampleRate));
    }
    try {
      source->captureFrame(frame);
    } catch (const std::exception &error) {
      std::cerr << "publisher: audio frame dropped: " << error.what()
                << std::endl;
      try {
        source->clearQueue();
      } catch (...) {
      }
    }
    ++frame_sequence;
    next_frame += std::chrono::milliseconds(kAudioFrameMilliseconds);
    std::this_thread::sleep_until(next_frame);
  }
  source->clearQueue();
}

class RoomStateLatch final {
public:
  void observe(const syrnike::windows_media::PublicEvent &event) {
    const auto *room =
        std::get_if<syrnike::windows_media::RoomStateChangedEvent>(&event);
    if (!room)
      return;
    {
      std::lock_guard lock(mutex_);
      state_ = room->state;
      failure_ = room->failure;
    }
    changed_.notify_all();
  }

  void waitFor(RoomPublicState expected, std::chrono::seconds timeout) {
    std::unique_lock lock(mutex_);
    if (!changed_.wait_for(lock, timeout, [this, expected] {
          return state_ == expected || state_ == RoomPublicState::Failed;
        })) {
      throw std::runtime_error("Timed out waiting for Engine room state");
    }
    if (state_ == RoomPublicState::Failed) {
      throw std::runtime_error(
          "Engine room failed: " +
          (failure_ ? failure_->code : std::string("missing_failure")));
    }
  }

private:
  std::mutex mutex_;
  std::condition_variable changed_;
  RoomPublicState state_ = RoomPublicState::Off;
  std::optional<syrnike::windows_media::EngineFailure> failure_;
};

class LocalSubscriptionLatch final : public livekit::RoomDelegate {
public:
  void
  onLocalTrackSubscribed(livekit::Room &,
                         const livekit::LocalTrackSubscribedEvent &) override {
    {
      std::lock_guard lock(mutex_);
      ++subscriptions_;
    }
    changed_.notify_all();
  }

  void waitFor(std::size_t expected, std::chrono::seconds timeout) {
    std::unique_lock lock(mutex_);
    if (!changed_.wait_for(lock, timeout, [this, expected] {
          return subscriptions_ >= expected;
        })) {
      throw std::runtime_error("Timed out waiting for local track subscribers");
    }
  }

private:
  std::mutex mutex_;
  std::condition_variable changed_;
  std::size_t subscriptions_ = 0;
};

class ScopedRoomDelegate final {
public:
  ScopedRoomDelegate(const std::shared_ptr<livekit::Room> &room,
                     livekit::RoomDelegate *delegate)
      : room_(room) {
    room_->setDelegate(delegate);
  }

  ~ScopedRoomDelegate() { room_->setDelegate(nullptr); }

private:
  std::shared_ptr<livekit::Room> room_;
};

EngineDesiredState desiredState(std::uint64_t revision,
                                std::optional<RoomIntent> room) {
  return EngineDesiredState{revision, std::move(room), {}, {}, {}, {}, {}};
}

struct ProcessResources {
  DWORD handles = 0;
  DWORD threads = 0;
};

ProcessResources processResources() {
  ProcessResources resources;
  if (!GetProcessHandleCount(GetCurrentProcess(), &resources.handles)) {
    throw std::runtime_error("GetProcessHandleCount failed");
  }
  const DWORD process_id = GetCurrentProcessId();
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  if (snapshot == INVALID_HANDLE_VALUE) {
    throw std::runtime_error("CreateToolhelp32Snapshot failed");
  }
  THREADENTRY32 entry{.dwSize = sizeof(THREADENTRY32)};
  if (Thread32First(snapshot, &entry)) {
    do {
      if (entry.th32OwnerProcessID == process_id)
        ++resources.threads;
    } while (Thread32Next(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return resources;
}

std::size_t waitForTransportIdle(
    const std::shared_ptr<LiveKitRoomTransport> &transport,
    std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  auto pending = transport->pendingOperationCount();
  while (pending != 0 && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
    pending = transport->pendingOperationCount();
  }
  if (pending != 0)
    throw std::runtime_error(
        "LiveKit transport operations did not return to baseline");
  return pending;
}

void publishAndUnpublishSyntheticTracks(
    const std::shared_ptr<livekit::Room> &room, const Options &options,
    int cycle) {
  auto participant = room->localParticipant().lock();
  if (!participant)
    throw std::runtime_error(
        "Lifecycle churn local participant is unavailable");

  const auto suffix = std::to_string(cycle);
  auto audio_source = std::make_shared<livekit::AudioSource>(
      kAudioSampleRate, kAudioChannels, kAudioFrameMilliseconds);
  auto audio_track = livekit::LocalAudioTrack::createLocalAudioTrack(
      "lifecycle-audio-" + suffix, audio_source);
  livekit::TrackPublishOptions audio_options;
  audio_options.source = livekit::TrackSource::SOURCE_MICROPHONE;
  audio_options.dtx = false;
  audio_options.simulcast = false;
  participant->publishTrack(audio_track, audio_options);

  auto video_source =
      std::make_shared<livekit::VideoSource>(options.width, options.height);
  auto video_track = livekit::LocalVideoTrack::createLocalVideoTrack(
      "lifecycle-video-" + suffix, video_source);
  livekit::TrackPublishOptions video_options;
  video_options.source = livekit::TrackSource::SOURCE_CAMERA;
  video_options.simulcast = false;
  participant->publishTrack(video_track, video_options);

  auto audio_frame = livekit::AudioFrame::create(
      kAudioSampleRate, kAudioChannels,
      kAudioSampleRate * kAudioFrameMilliseconds / 1000);
  audio_source->captureFrame(audio_frame);
  auto video_frame = livekit::VideoFrame::create(
      options.width, options.height, livekit::VideoBufferType::BGRA);
  fillVideoFrame(video_frame, static_cast<std::uint64_t>(cycle),
                 epochMilliseconds());
  video_source->captureFrame(video_frame);

  const auto video_publication = video_track->publication();
  const auto audio_publication = audio_track->publication();
  if (!video_publication || !audio_publication)
    throw std::runtime_error(
        "Lifecycle churn track publication is unavailable");
  participant->unpublishTrack(video_publication->sid());
  participant->unpublishTrack(audio_publication->sid());
  audio_source->clearQueue();
}

} // namespace

int main() {
  try {
    const auto options = optionsFromEnvironment();
    int exit_code = 0;
    {
      auto transport = std::make_shared<LiveKitRoomTransport>();
      RoomStateLatch room_state;
      Engine engine(EngineOptions{.room_transport = transport});
      if (!engine
               .registerEventCallback([&room_state](const auto &event) {
                 room_state.observe(event);
               })
               .ok ||
          !engine.start().ok) {
        throw std::runtime_error("Engine v2 failed to start");
      }
      const auto lease = engine.installCredentialLease(CredentialLease{
          "media-lab-lease",
          options.url,
          options.token,
      });
      if (!lease.ok)
        throw std::runtime_error("Credential lease was rejected");
      const RoomIntent room_intent{
          "native-v2-media-lab",
          "native-v2-publisher",
          "media-lab-lease",
      };
      const auto connect_result =
          engine.applyDesiredState(desiredState(1, room_intent));
      if (!connect_result.ok)
        throw std::runtime_error("Room intent was rejected");
      room_state.waitFor(RoomPublicState::Connected, std::chrono::seconds(12));
      std::cout << "publisher: connected" << std::endl;

      if (options.scenario == "lifecycle-churn") {
        std::uint64_t revision = 2;
        if (!engine.applyDesiredState(desiredState(revision++, std::nullopt))
                 .ok) {
          throw std::runtime_error("Lifecycle warm-up disconnect failed");
        }
        room_state.waitFor(RoomPublicState::Off, std::chrono::seconds(12));
        const auto run_cancellation_cycle = [&](int timing_variant) {
          const auto cancellation_lease = engine.installCredentialLease(
              CredentialLease{"media-lab-lease", options.url, options.token});
          if (!cancellation_lease.ok) {
            throw std::runtime_error(
                "Lifecycle cancellation lease was rejected");
          }
          if (!engine.applyDesiredState(desiredState(revision++, room_intent))
                   .ok) {
            throw std::runtime_error(
                "Lifecycle cancellation connect intent failed");
          }
          if (timing_variant == 0) {
            std::this_thread::yield();
          } else if (timing_variant == 1) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
          }
          if (!engine.applyDesiredState(desiredState(revision++, std::nullopt))
                   .ok) {
            throw std::runtime_error(
                "Lifecycle cancellation off intent failed");
          }
          room_state.waitFor(RoomPublicState::Off, std::chrono::seconds(12));
        };
        // Exercise every cancellation timing before taking the resource
        // baseline. LiveKit initializes a small, process-lifetime set of Win32
        // handles lazily on these paths; the measured cycles must detect
        // growth, not first-use initialization.
        for (int timing_variant = 0; timing_variant < 3; ++timing_variant) {
          run_cancellation_cycle(timing_variant);
        }
        const auto warmup_lease = engine.installCredentialLease(
            CredentialLease{"media-lab-lease", options.url, options.token});
        if (!warmup_lease.ok ||
            !engine.applyDesiredState(desiredState(revision++, room_intent))
                 .ok) {
          throw std::runtime_error("Lifecycle track warm-up connect failed");
        }
        room_state.waitFor(RoomPublicState::Connected,
                           std::chrono::seconds(12));
        const auto warmup_room = transport->activeRoom();
        if (!warmup_room)
          throw std::runtime_error("Lifecycle track warm-up room unavailable");
        publishAndUnpublishSyntheticTracks(warmup_room, options, -1);
        if (!engine.applyDesiredState(desiredState(revision++, std::nullopt))
                 .ok) {
          throw std::runtime_error("Lifecycle track warm-up disconnect failed");
        }
        room_state.waitFor(RoomPublicState::Off, std::chrono::seconds(12));
        waitForTransportIdle(transport, std::chrono::seconds(5));
        const auto baseline = processResources();
        std::vector<long long> handle_deltas;
        std::vector<long long> thread_deltas;
        std::vector<std::size_t> pending_callback_counts;
        handle_deltas.reserve(options.lifecycle_cycles);
        thread_deltas.reserve(options.lifecycle_cycles);
        pending_callback_counts.reserve(options.lifecycle_cycles);
        for (int cycle = 0; cycle < options.lifecycle_cycles; ++cycle) {
          run_cancellation_cycle(cycle % 3);

          const auto cycle_lease = engine.installCredentialLease(
              CredentialLease{"media-lab-lease", options.url, options.token});
          if (!cycle_lease.ok) {
            throw std::runtime_error("Lifecycle churn lease was rejected");
          }
          if (!engine.applyDesiredState(desiredState(revision++, room_intent))
                   .ok) {
            throw std::runtime_error("Lifecycle churn connect intent failed");
          }
          room_state.waitFor(RoomPublicState::Connected,
                             std::chrono::seconds(12));
          const auto cycle_room = transport->activeRoom();
          if (!cycle_room)
            throw std::runtime_error("Lifecycle churn room unavailable");
          publishAndUnpublishSyntheticTracks(cycle_room, options, cycle);
          if (!engine.applyDesiredState(desiredState(revision++, std::nullopt))
                   .ok) {
            throw std::runtime_error(
                "Lifecycle churn disconnect intent failed");
          }
          room_state.waitFor(RoomPublicState::Off, std::chrono::seconds(12));
          pending_callback_counts.push_back(
              waitForTransportIdle(transport, std::chrono::seconds(5)));
          const auto cycle_resources = processResources();
          handle_deltas.push_back(
              static_cast<long long>(cycle_resources.handles) -
              baseline.handles);
          thread_deltas.push_back(
              static_cast<long long>(cycle_resources.threads) -
              baseline.threads);
        }
        auto final_resources = processResources();
        const auto cleanup_started = std::chrono::steady_clock::now();
        const auto cleanup_deadline =
            cleanup_started +
            std::chrono::milliseconds(options.cleanup_deadline_ms);
        while ((final_resources.handles > baseline.handles + 2 ||
                final_resources.threads > baseline.threads) &&
               std::chrono::steady_clock::now() < cleanup_deadline) {
          std::this_thread::sleep_for(std::chrono::milliseconds(10));
          final_resources = processResources();
        }
        const auto cleanup_settle_ms =
            std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - cleanup_started)
                .count();
        std::cout << "MEDIA_LAB_METRICS {\"scenario\":\"lifecycle-churn\""
                  << ",\"cycles\":" << options.lifecycle_cycles
                  << ",\"cancellationCycles\":" << options.lifecycle_cycles
                  << ",\"trackCycles\":" << options.lifecycle_cycles
                  << ",\"handleDelta\":"
                  << static_cast<long long>(final_resources.handles) -
                         baseline.handles
                  << ",\"threadDelta\":"
                  << static_cast<long long>(final_resources.threads) -
                         baseline.threads
                  << ",\"pendingCallbacks\":"
                  << transport->pendingOperationCount()
                  << ",\"cleanupSettleMs\":" << cleanup_settle_ms
                  << ",\"handleDeltas\":[";
        for (std::size_t index = 0; index < handle_deltas.size(); ++index) {
          if (index != 0)
            std::cout << ',';
          std::cout << handle_deltas[index];
        }
        std::cout << "],\"threadDeltas\":[";
        for (std::size_t index = 0; index < thread_deltas.size(); ++index) {
          if (index != 0)
            std::cout << ',';
          std::cout << thread_deltas[index];
        }
        std::cout << "],\"pendingCallbackCounts\":[";
        for (std::size_t index = 0; index < pending_callback_counts.size();
             ++index) {
          if (index != 0)
            std::cout << ',';
          std::cout << pending_callback_counts[index];
        }
        std::cout << "]}" << std::endl;
        if (final_resources.handles > baseline.handles + 2 ||
            final_resources.threads > baseline.threads ||
            transport->pendingOperationCount() != 0)
          exit_code = 1;
      } else if (options.scenario == "disconnect-before-publish") {
        const auto initial_disconnect =
            engine.applyDesiredState(desiredState(2, std::nullopt));
        if (!initial_disconnect.ok) {
          throw std::runtime_error("Lifecycle initial disconnect failed");
        }
        room_state.waitFor(RoomPublicState::Off, std::chrono::seconds(12));
        std::cout
            << "MEDIA_LAB_METRICS {\"scenario\":\"" << options.scenario
            << "\",\"cycles\":1,\"roomState\":\"off\"}"
            << std::endl;
      } else {
        const auto room = transport->activeRoom();
        if (!room)
          throw std::runtime_error("Connected LiveKit Room is unavailable");
        LocalSubscriptionLatch subscription_latch;
        ScopedRoomDelegate delegate_scope(room, &subscription_latch);
        auto participant = room->localParticipant().lock();
        if (!participant)
          throw std::runtime_error("Local participant is unavailable");

        auto audio_source = std::make_shared<livekit::AudioSource>(
            kAudioSampleRate, kAudioChannels, kAudioFrameMilliseconds);
        auto audio_track = livekit::LocalAudioTrack::createLocalAudioTrack(
            "synthetic-audio-v2", audio_source);
        livekit::TrackPublishOptions audio_options;
        audio_options.source = livekit::TrackSource::SOURCE_MICROPHONE;
        audio_options.dtx = false;
        audio_options.simulcast = false;
        participant->publishTrack(audio_track, audio_options);

        auto video_source = std::make_shared<livekit::VideoSource>(
            options.width, options.height);
        auto video_track = livekit::LocalVideoTrack::createLocalVideoTrack(
            "synthetic-video-v2", video_source);
        livekit::TrackPublishOptions video_options;
        video_options.source = livekit::TrackSource::SOURCE_CAMERA;
        video_options.simulcast = false;
        participant->publishTrack(video_track, video_options);
        std::cout << "publisher: tracks published" << std::endl;
        if (options.wait_for_subscribers) {
          subscription_latch.waitFor(2, std::chrono::seconds(25));
          std::cout << "publisher: subscribers ready" << std::endl;
        }

        std::atomic_bool audio_running{true};
        std::thread audio_thread(
            [&] { runAudio(audio_source, audio_running); });
        auto video_frame = livekit::VideoFrame::create(
            options.width, options.height, livekit::VideoBufferType::BGRA);
        auto next_frame = std::chrono::steady_clock::now();
        const auto frame_interval =
            std::chrono::microseconds(1000000 / options.frames_per_second);
        for (int sequence = 0; sequence < options.frames; ++sequence) {
          if (options.scenario == "republish") {
            if (sequence == options.frames / 4 && video_track->publication()) {
              participant->unpublishTrack(video_track->publication()->sid());
              std::cout << "publisher: video unpublished while audio continued"
                        << std::endl;
            }
            if (sequence == options.frames / 4 + 3) {
              video_track = livekit::LocalVideoTrack::createLocalVideoTrack(
                  "synthetic-video-v2-republished", video_source);
              participant->publishTrack(video_track, video_options);
              if (options.wait_for_subscribers) {
                subscription_latch.waitFor(3, std::chrono::seconds(25));
              }
              std::cout << "publisher: video republished" << std::endl;
            }
            if (sequence == options.frames / 2 && audio_track->publication()) {
              participant->unpublishTrack(audio_track->publication()->sid());
              std::cout << "publisher: audio unpublished while video continued"
                        << std::endl;
            }
            if (sequence == options.frames / 2 + options.frames_per_second) {
              audio_source->clearQueue();
              audio_track = livekit::LocalAudioTrack::createLocalAudioTrack(
                  "synthetic-audio-v2-republished", audio_source);
              participant->publishTrack(audio_track, audio_options);
              if (options.wait_for_subscribers) {
                subscription_latch.waitFor(4, std::chrono::seconds(25));
              }
              std::cout << "publisher: audio republished" << std::endl;
            }
          }
          const auto captured_at_ms = epochMilliseconds();
          fillVideoFrame(video_frame, static_cast<std::uint64_t>(sequence),
                         captured_at_ms);
          livekit::VideoCaptureOptions capture_options;
          capture_options.timestamp_us =
              static_cast<std::int64_t>(captured_at_ms * 1000);
          capture_options.rotation = livekit::VideoRotation::VIDEO_ROTATION_0;
          video_source->captureFrame(video_frame, capture_options);
          next_frame += frame_interval;
          std::this_thread::sleep_until(next_frame);
        }
        std::cout << "publisher: video complete" << std::endl;

        audio_running.store(false);
        audio_thread.join();
        std::cout << "publisher: audio stopped" << std::endl;
        if (video_track->publication()) {
          participant->unpublishTrack(video_track->publication()->sid());
        }
        if (audio_track->publication()) {
          participant->unpublishTrack(audio_track->publication()->sid());
        }
        std::cout << "publisher: tracks unpublished" << std::endl;
        const auto disconnect_result =
            engine.applyDesiredState(desiredState(2, std::nullopt));
        if (!disconnect_result.ok)
          exit_code = 1;
        room_state.waitFor(RoomPublicState::Off, std::chrono::seconds(12));
        std::cout << "publisher: disconnected" << std::endl;
      }
      if (!engine.shutdown(std::chrono::seconds(12)).ok)
        exit_code = 1;
    }
    std::cout << "publisher: room destroyed" << std::endl;
    std::cout << "publisher: sdk shutdown" << std::endl;
    return exit_code;
  } catch (const std::exception &error) {
    std::cerr << "native-media-lab publisher failed: " << error.what() << '\n';
    return 1;
  }
}
