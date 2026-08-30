#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "core/room_owner.hpp"
#include "livekit/livekit.h"

namespace {

constexpr int kAudioSampleRate = 48000;
constexpr int kAudioChannels = 1;
constexpr int kAudioFrameMilliseconds = 10;
constexpr int kMarkerBits = 96;
constexpr int kMarkerColumns = 24;
constexpr int kMarkerTileSize = 12;
constexpr std::uint16_t kMarkerMagic = 0x534d;
constexpr double kPi = 3.14159265358979323846;

using syrnike::windows_media::EngineFailure;
using syrnike::windows_media::EngineResult;
using syrnike::windows_media::RoomConnectRequest;
using syrnike::windows_media::RoomOperationCompletion;
using syrnike::windows_media::RoomOwner;
using syrnike::windows_media::RoomTransport;

struct Options {
  std::string url;
  std::string token;
  std::string scenario = "normal";
  int width = 640;
  int height = 360;
  int frames = 660;
  int frames_per_second = 15;
};

EngineResult liveKitFailure(
  std::string code,
  std::string message,
  std::string stage,
  bool retryable = false
) {
  return EngineResult::fail(EngineFailure{
    std::move(code),
    std::move(message),
    std::move(stage),
    retryable,
  });
}

class LiveKitRoomTransport final : public RoomTransport {
 public:
  ~LiveKitRoomTransport() override {
    joinWorkers();
  }

  void startConnect(
    std::uint64_t generation,
    RoomConnectRequest request,
    RoomOperationCompletion completion
  ) override {
    std::shared_ptr<livekit::Room> room;
    {
      std::lock_guard lock(state_mutex_);
      if (reusable_room_ && attempts_.empty() && !active_room_) {
        room = std::move(reusable_room_);
      } else {
        room = std::make_shared<livekit::Room>();
      }
      attempts_[generation] = room;
    }
    std::lock_guard worker_lock(worker_mutex_);
    workers_.emplace_back([
      this,
      generation,
      request = std::move(request),
      completion = std::move(completion),
      room = std::move(room)
    ]() mutable {
      livekit::RoomOptions room_options;
      room_options.auto_subscribe = false;
      room_options.dynacast = false;
      room_options.connect_timeout = std::chrono::seconds(10);
      EngineResult result;
      try {
        result = room->connect(request.url, request.token, room_options)
          ? EngineResult::success()
          : liveKitFailure(
              "livekit_connect_failed",
              "LiveKit Room connect returned false",
              "room_connect",
              true
            );
      } catch (const std::exception& error) {
        result = liveKitFailure(
          "livekit_connect_failed",
          error.what(),
          "room_connect",
          true
        );
      }

      bool cancelled = false;
      {
        std::lock_guard lock(state_mutex_);
        attempts_.erase(generation);
        cancelled = cancelled_attempts_.erase(generation) > 0;
        if (result.ok && !cancelled) {
          active_generation_ = generation;
          active_room_ = room;
        }
      }
      if (result.ok && cancelled) {
        room->disconnect();
        result = liveKitFailure(
          "room_connect_cancelled",
          "LiveKit connect completed after cancellation",
          "room_connect",
          true
        );
      }
      completion(generation, std::move(result));
    });
  }

  void cancelConnect(std::uint64_t generation) noexcept override {
    std::lock_guard lock(state_mutex_);
    cancelled_attempts_.insert(generation);
  }

  void startDisconnect(
    std::uint64_t generation,
    RoomOperationCompletion completion
  ) override {
    std::shared_ptr<livekit::Room> room;
    {
      std::lock_guard lock(state_mutex_);
      if (active_generation_ == generation) room = active_room_;
    }
    if (!room) {
      completion(generation, liveKitFailure(
        "livekit_room_missing",
        "The active LiveKit Room is unavailable",
        "room_disconnect"
      ));
      return;
    }
    std::lock_guard worker_lock(worker_mutex_);
    workers_.emplace_back([
      this,
      generation,
      completion = std::move(completion),
      room = std::move(room)
    ]() mutable {
      EngineResult result;
      try {
        result = room->disconnect()
          ? EngineResult::success()
          : liveKitFailure(
              "livekit_disconnect_failed",
              "LiveKit Room disconnect returned false",
              "room_disconnect",
              true
            );
      } catch (const std::exception& error) {
        result = liveKitFailure(
          "livekit_disconnect_failed",
          error.what(),
          "room_disconnect",
          true
        );
      }
      {
        std::lock_guard lock(state_mutex_);
        if (active_generation_ == generation) {
          active_generation_ = 0;
          active_room_.reset();
          if (result.ok) reusable_room_ = room;
        }
      }
      completion(generation, std::move(result));
    });
  }

  [[nodiscard]] std::shared_ptr<livekit::Room> activeRoom() const {
    std::lock_guard lock(state_mutex_);
    return active_room_;
  }

  void joinWorkers() {
    std::vector<std::thread> workers;
    {
      std::lock_guard lock(worker_mutex_);
      workers.swap(workers_);
    }
    for (auto& worker : workers) {
      if (worker.joinable()) worker.join();
    }
  }

 private:
  mutable std::mutex state_mutex_;
  std::map<std::uint64_t, std::shared_ptr<livekit::Room>> attempts_;
  std::set<std::uint64_t> cancelled_attempts_;
  std::uint64_t active_generation_ = 0;
  std::shared_ptr<livekit::Room> active_room_;
  std::shared_ptr<livekit::Room> reusable_room_;
  std::mutex worker_mutex_;
  std::vector<std::thread> workers_;
};

std::string requiredEnvironment(const char* name) {
  const auto* value = std::getenv(name);
  if (value == nullptr || *value == '\0') {
    throw std::runtime_error(std::string("Missing environment variable: ") + name);
  }
  return value;
}

int integerEnvironment(const char* name, int fallback, int minimum, int maximum) {
  const auto* value = std::getenv(name);
  if (value == nullptr || *value == '\0') return fallback;
  const auto parsed = std::stoi(value);
  if (parsed < minimum || parsed > maximum) {
    throw std::runtime_error(std::string("Out-of-range environment variable: ") + name);
  }
  return parsed;
}

std::string stringEnvironment(const char* name, std::string fallback) {
  const auto* value = std::getenv(name);
  return value == nullptr || *value == '\0' ? std::move(fallback) : value;
}

Options optionsFromEnvironment() {
  Options options;
  options.url = requiredEnvironment("LIVEKIT_URL");
  options.token = requiredEnvironment("LIVEKIT_PUBLISHER_TOKEN");
  options.scenario = stringEnvironment("MEDIA_LAB_SCENARIO", "normal");
  options.width = integerEnvironment("MEDIA_LAB_VIDEO_WIDTH", 640, 320, 1920);
  options.height = integerEnvironment("MEDIA_LAB_VIDEO_HEIGHT", 360, 180, 1080);
  options.frames = integerEnvironment("MEDIA_LAB_VIDEO_FRAMES", 660, 1, 100000);
  options.frames_per_second = integerEnvironment("MEDIA_LAB_VIDEO_FPS", 15, 1, 60);
  if (
    options.scenario != "normal" &&
    options.scenario != "republish" &&
    options.scenario != "disconnect-before-publish"
  ) throw std::runtime_error("Unsupported MEDIA_LAB_SCENARIO");
  if (options.width < kMarkerColumns * kMarkerTileSize ||
      options.height < 4 * kMarkerTileSize) {
    throw std::runtime_error("Video resolution is too small for the machine-readable marker");
  }
  return options;
}

std::uint64_t epochMilliseconds() {
  return static_cast<std::uint64_t>(
    std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()
    ).count()
  );
}

bool markerBit(std::uint64_t sequence, std::uint64_t captured_at_ms, int index) {
  if (index < 16) return ((kMarkerMagic >> (15 - index)) & 1U) != 0;
  if (index < 48) return ((sequence >> (47 - index)) & 1ULL) != 0;
  return ((captured_at_ms >> (95 - index)) & 1ULL) != 0;
}

void fillVideoFrame(
  livekit::VideoFrame& frame,
  std::uint64_t sequence,
  std::uint64_t captured_at_ms
) {
  auto* pixels = frame.data();
  const auto width = frame.width();
  const auto height = frame.height();
  const auto moving_x = static_cast<int>((sequence * 7) % static_cast<std::uint64_t>(width));

  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const auto offset = static_cast<std::size_t>((y * width + x) * 4);
      const bool bar = std::abs(x - moving_x) < 12;
      pixels[offset] = static_cast<std::uint8_t>(bar ? 240 : (x + sequence) % 180 + 30);
      pixels[offset + 1] = static_cast<std::uint8_t>(bar ? 80 : (y * 2 + sequence) % 180 + 30);
      pixels[offset + 2] = static_cast<std::uint8_t>(bar ? 40 : (x + y + sequence) % 180 + 30);
      pixels[offset + 3] = 255;
    }
  }

  for (int bit = 0; bit < kMarkerBits; ++bit) {
    const int column = bit % kMarkerColumns;
    const int row = bit / kMarkerColumns;
    const auto level = static_cast<std::uint8_t>(
      markerBit(sequence, captured_at_ms, bit) ? 255 : 0
    );
    for (int y = row * kMarkerTileSize; y < (row + 1) * kMarkerTileSize; ++y) {
      for (int x = column * kMarkerTileSize; x < (column + 1) * kMarkerTileSize; ++x) {
        const auto offset = static_cast<std::size_t>((y * width + x) * 4);
        pixels[offset] = level;
        pixels[offset + 1] = level;
        pixels[offset + 2] = level;
        pixels[offset + 3] = 255;
      }
    }
  }
}

void runAudio(
  const std::shared_ptr<livekit::AudioSource>& source,
  std::atomic_bool& running
) {
  const int samples_per_channel =
    kAudioSampleRate * kAudioFrameMilliseconds / 1000;
  std::uint64_t frame_sequence = 0;
  auto next_frame = std::chrono::steady_clock::now();
  while (running.load()) {
    auto frame = livekit::AudioFrame::create(
      kAudioSampleRate,
      kAudioChannels,
      samples_per_channel
    );
    const bool control_pulse = frame_sequence % 100 < 2;
    const double frequency = control_pulse ? 1000.0 : 440.0;
    const double amplitude = control_pulse ? 20000.0 : 900.0;
    for (int sample = 0; sample < samples_per_channel; ++sample) {
      const auto global_sample = frame_sequence * samples_per_channel + sample;
      frame.data()[static_cast<std::size_t>(sample)] = static_cast<std::int16_t>(
        amplitude * std::sin(2.0 * kPi * frequency *
          static_cast<double>(global_sample) / kAudioSampleRate)
      );
    }
    try {
      source->captureFrame(frame);
    } catch (const std::exception& error) {
      std::cerr << "publisher: audio frame dropped: " << error.what() << std::endl;
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

}  // namespace

int main() {
  try {
    const auto options = optionsFromEnvironment();
    livekit::initialize(livekit::LogLevel::Info);
    int exit_code = 0;
    {
      auto transport = std::make_shared<LiveKitRoomTransport>();
      RoomOwner room_owner(transport, [](const auto& event) {
        std::cout << "publisher: room generation " << event.generation << " "
                  << syrnike::windows_media::roomConnectionStateName(event.state)
                  << std::endl;
      });
      const auto connect_result = room_owner.connect(
        RoomConnectRequest{options.url, options.token},
        std::chrono::seconds(12)
      );
      transport->joinWorkers();
      if (!connect_result.ok) {
        throw std::runtime_error(
          "LiveKit Room connect failed: " +
          (connect_result.failure
            ? connect_result.failure->code
            : std::string("missing_failure"))
        );
      }
      std::cout << "publisher: connected" << std::endl;

      if (options.scenario == "disconnect-before-publish") {
        const auto initial_disconnect = room_owner.disconnect(std::chrono::seconds(12));
        transport->joinWorkers();
        if (!initial_disconnect.ok) {
          throw std::runtime_error("Lifecycle initial disconnect failed");
        }
        std::cout << "MEDIA_LAB_METRICS {\"scenario\":\""
                  << options.scenario
                  << "\",\"cycles\":1,\"pendingCallbacks\":0,\"workerThreads\":0}"
                  << std::endl;
      } else {
      const auto room = transport->activeRoom();
      if (!room) throw std::runtime_error("Connected LiveKit Room is unavailable");
      auto participant = room->localParticipant().lock();
      if (!participant) throw std::runtime_error("Local participant is unavailable");

      auto audio_source = std::make_shared<livekit::AudioSource>(
        kAudioSampleRate,
        kAudioChannels,
        kAudioFrameMilliseconds
      );
      auto audio_track = livekit::LocalAudioTrack::createLocalAudioTrack(
        "synthetic-audio-v2",
        audio_source
      );
      livekit::TrackPublishOptions audio_options;
      audio_options.source = livekit::TrackSource::SOURCE_MICROPHONE;
      audio_options.dtx = false;
      audio_options.simulcast = false;
      participant->publishTrack(audio_track, audio_options);

      auto video_source = std::make_shared<livekit::VideoSource>(
        options.width,
        options.height
      );
      auto video_track = livekit::LocalVideoTrack::createLocalVideoTrack(
        "synthetic-video-v2",
        video_source
      );
      livekit::TrackPublishOptions video_options;
      video_options.source = livekit::TrackSource::SOURCE_CAMERA;
      video_options.simulcast = false;
      participant->publishTrack(video_track, video_options);
      std::cout << "publisher: tracks published" << std::endl;

      std::atomic_bool audio_running{true};
      std::thread audio_thread([&] { runAudio(audio_source, audio_running); });
      auto video_frame = livekit::VideoFrame::create(
        options.width,
        options.height,
        livekit::VideoBufferType::BGRA
      );
      auto next_frame = std::chrono::steady_clock::now();
      const auto frame_interval = std::chrono::microseconds(
        1000000 / options.frames_per_second
      );
      for (int sequence = 0; sequence < options.frames; ++sequence) {
        if (options.scenario == "republish") {
          if (sequence == options.frames / 4 && video_track->publication()) {
            participant->unpublishTrack(video_track->publication()->sid());
            std::cout << "publisher: video unpublished while audio continued" << std::endl;
          }
          if (sequence == options.frames / 4 + 3) {
            video_track = livekit::LocalVideoTrack::createLocalVideoTrack(
              "synthetic-video-v2-republished",
              video_source
            );
            participant->publishTrack(video_track, video_options);
            std::cout << "publisher: video republished" << std::endl;
          }
          if (sequence == options.frames / 2 && audio_track->publication()) {
            participant->unpublishTrack(audio_track->publication()->sid());
            std::cout << "publisher: audio unpublished while video continued" << std::endl;
          }
          if (sequence == options.frames / 2 + options.frames_per_second) {
            audio_source->clearQueue();
            audio_track = livekit::LocalAudioTrack::createLocalAudioTrack(
              "synthetic-audio-v2-republished",
              audio_source
            );
            participant->publishTrack(audio_track, audio_options);
            std::cout << "publisher: audio republished" << std::endl;
          }
        }
        const auto captured_at_ms = epochMilliseconds();
        fillVideoFrame(video_frame, static_cast<std::uint64_t>(sequence), captured_at_ms);
        livekit::VideoCaptureOptions capture_options;
        capture_options.timestamp_us = static_cast<std::int64_t>(captured_at_ms * 1000);
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
      const auto disconnect_result = room_owner.disconnect(std::chrono::seconds(12));
      transport->joinWorkers();
      if (!disconnect_result.ok) exit_code = 1;
      std::cout << "publisher: disconnected" << std::endl;
      }
    }
    std::cout << "publisher: room destroyed" << std::endl;
    livekit::shutdown();
    std::cout << "publisher: sdk shutdown" << std::endl;
    std::_Exit(exit_code);
  } catch (const std::exception& error) {
    std::cerr << "native-media-lab publisher failed: " << error.what() << '\n';
    try {
      livekit::shutdown();
    } catch (...) {
    }
    std::cerr.flush();
    std::_Exit(1);
  }
}
