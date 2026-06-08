#include "microphone_publisher.hpp"

#include <audioclient.h>
#include <avrt.h>
#include <windows.h>
#include <wrl/client.h>

#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

#include "livekit/livekit.h"
#include "livekit/room_delegate.h"

#include "audio_constants.hpp"
#include "audio_devices.hpp"
#include "audio_processing.hpp"
#include "runtime_config.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::voice {
namespace {

class NativeRoomDelegate final : public livekit::RoomDelegate {
public:
  void onConnectionStateChanged(
    livekit::Room&,
    const livekit::ConnectionStateChangedEvent& event
  ) override {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      state_ = event.state;
    }
    condition_.notify_all();
  }

  void onDisconnected(
    livekit::Room&,
    const livekit::DisconnectedEvent&
  ) override {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      state_ = livekit::ConnectionState::Disconnected;
      disconnected_ = true;
    }
    condition_.notify_all();
  }

  bool waitConnected(std::chrono::milliseconds timeout) {
    std::unique_lock<std::mutex> lock(mutex_);
    return condition_.wait_for(lock, timeout, [&] {
      return state_ == livekit::ConnectionState::Connected || disconnected_;
    }) && state_ == livekit::ConnectionState::Connected;
  }

private:
  std::mutex mutex_;
  std::condition_variable condition_;
  livekit::ConnectionState state_ = livekit::ConnectionState::Disconnected;
  bool disconnected_ = false;
};

void captureMicrophone(const StartCommand command, const std::shared_ptr<livekit::AudioSource>& audio_source) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool com_initialized = SUCCEEDED(hr);

  DWORD task_index = 0;
  HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);

  try {
    ComPtr<IMMDevice> device = getCaptureDevice(command.device_id);
    ComPtr<IAudioClient> audio_client;
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(audio_client.GetAddressOf()));
    if (FAILED(hr)) throw std::runtime_error("failed to activate IAudioClient");

    WAVEFORMATEX format = desiredCaptureFormat();
    hr = audio_client->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
      kBufferDurationHns,
      0,
      &format,
      nullptr
    );
    if (FAILED(hr)) throw std::runtime_error("failed to initialize microphone stream");

    ComPtr<IAudioCaptureClient> capture_client;
    hr = audio_client->GetService(IID_PPV_ARGS(&capture_client));
    if (FAILED(hr)) throw std::runtime_error("failed to get capture client");

    hr = audio_client->Start();
    if (FAILED(hr)) throw std::runtime_error("failed to start microphone stream");

    std::vector<std::int16_t> frame;
    frame.reserve(kSamplesPer10Ms);
    float frame_square_sum = 0.0f;
    int frame_sample_count = 0;
    auto last_metrics_at = std::chrono::steady_clock::now();

    while (g_running.load()) {
      UINT32 packet_frames = 0;
      hr = capture_client->GetNextPacketSize(&packet_frames);
      if (FAILED(hr)) break;

      if (packet_frames == 0) {
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
        continue;
      }

      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture_client->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) break;

      const float* samples = reinterpret_cast<const float*>(data);
      for (UINT32 index = 0; index < frames; ++index) {
        const RuntimeConfig config = readRuntimeConfig();
        const float raw_sample = (flags & AUDCLNT_BUFFERFLAGS_SILENT) ? 0.0f : samples[index];
        const float amplified_sample = raw_sample * config.input_volume;
        frame_square_sum += amplified_sample * amplified_sample;
        frame_sample_count += 1;

        const float input_db = frame_sample_count > 0
          ? rmsToDb(std::sqrt(frame_square_sum / static_cast<float>(frame_sample_count)))
          : -60.0f;
        const bool open = gateOpen(input_db, config);
        const float processed = open ? amplified_sample : 0.0f;
        frame.push_back(clampToPcm16(processed));

        if (frame.size() == kSamplesPer10Ms) {
          livekit::AudioFrame audio_frame(std::move(frame), kSampleRate, kChannels, kSamplesPer10Ms);
          audio_source->captureFrame(audio_frame);
          frame.clear();
          frame.reserve(kSamplesPer10Ms);

          const auto now = std::chrono::steady_clock::now();
          if (now - last_metrics_at >= std::chrono::milliseconds(50)) {
            emitMicrophoneMetrics(command.session_id, input_db, config.voice_gate_threshold_db, open);
            last_metrics_at = now;
          }
          frame_square_sum = 0.0f;
          frame_sample_count = 0;
        }
      }

      capture_client->ReleaseBuffer(frames);
    }

    audio_client->Stop();
  } catch (const std::exception& error) {
    emitError("microphone_capture_failed", error.what());
  }

  if (avrt) AvRevertMmThreadCharacteristics(avrt);
  if (com_initialized) CoUninitialize();
}

}  // namespace

void runMicrophonePublisher(const StartCommand& command) {
  g_running.store(true);
  updateRuntimeConfig(command);
  if (command.session_id.empty() || command.livekit_url.empty() || command.livekit_token.empty()) {
    emitError("invalid_start_command", "missing sessionId or LiveKit credentials");
    return;
  }

  const std::string native_identity = command.participant_identity;

  emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"kind\":\"microphone\",\"status\":\"starting\"}");

  livekit::initialize(livekit::LogLevel::Info);
  auto room = std::make_unique<livekit::Room>();
  NativeRoomDelegate delegate;
  room->setDelegate(&delegate);
  livekit::RoomOptions room_options;
  room_options.auto_subscribe = false;
  room_options.single_peer_connection = false;

  bool connected = false;
  try {
    connected = room->connect(command.livekit_url, command.livekit_token, room_options);
  } catch (const std::exception& error) {
    livekit::shutdown();
    emitError("livekit_connect_failed", error.what());
    return;
  }
  if (!connected) {
    livekit::shutdown();
    emitError("livekit_connect_failed", "LiveKit native microphone connect returned false");
    return;
  }
  if (!delegate.waitConnected(std::chrono::milliseconds(10'000))) {
    room.reset();
    livekit::shutdown();
    emitError("livekit_connect_failed", "LiveKit native microphone did not reach connected state");
    return;
  }

  auto audio_source = std::make_shared<livekit::AudioSource>(kSampleRate, kChannels);

  try {
    if (auto participant = room->localParticipant().lock()) {
      participant->publishAudioTrack(
        "microphone",
        audio_source,
        livekit::TrackSource::SOURCE_MICROPHONE
      );
    } else {
      throw std::runtime_error("local participant is unavailable");
    }
  } catch (const std::exception& error) {
    room.reset();
    livekit::shutdown();
    emitError("livekit_publish_failed", error.what());
    return;
  }

  emit("{\"type\":\"ready\",\"port\":0,\"stream_mode\":\"audio\",\"audio_mode\":\"microphone\","
       "\"audio_sample_rate\":48000,\"audio_channels\":1,\"echo_cancellation\":\"unavailable\","
       "\"native_participant_identity\":\"" + jsonEscape(native_identity) + "\"}");
  emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"kind\":\"microphone\",\"status\":\"running\",\"audio_mode\":\"microphone\","
       "\"audio_sample_rate\":48000,\"audio_channels\":1,\"echo_cancellation\":\"unavailable\"}");

  std::thread capture_thread(captureMicrophone, command, audio_source);

  std::string line;
  while (g_running.load() && std::getline(std::cin, line)) {
    if (commandMatches(line, "stop")) {
      g_running.store(false);
      break;
    }
    if (commandMatches(line, "configure")) {
      updateRuntimeConfig(parseStartCommand(line));
      continue;
    }
  }

  if (capture_thread.joinable()) capture_thread.join();
  room.reset();
  livekit::shutdown();

  emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"kind\":\"microphone\",\"status\":\"stopped\"}");
  emit("{\"type\":\"stopped\"}");
}

}  // namespace syrnike::voice
