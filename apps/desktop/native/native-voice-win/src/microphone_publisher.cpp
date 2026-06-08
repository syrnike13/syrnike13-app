#include "microphone_publisher.hpp"

#include <audioclient.h>
#include <avrt.h>
#include <windows.h>
#include <wrl/client.h>

#include <chrono>
#include <cmath>
#include <condition_variable>
#include <algorithm>
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

    std::vector<float> raw_frame;
    raw_frame.reserve(kSamplesPer10Ms);
    auto last_metrics_at = std::chrono::steady_clock::now();
    auto last_diagnostics_at = last_metrics_at;
    auto last_frame_at = last_metrics_at;
    std::uint64_t total_frames = 0;
    std::uint32_t interval_frames = 0;
    std::uint32_t gated_frames = 0;
    std::uint32_t clipped_samples = 0;
    std::uint32_t max_frame_gap_ms = 0;
    std::uint32_t max_capture_frame_us = 0;
    float last_input_db = -60.0f;
    float max_output_peak = 0.0f;

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
        const float raw_sample = (flags & AUDCLNT_BUFFERFLAGS_SILENT) ? 0.0f : samples[index];
        raw_frame.push_back(raw_sample);

        if (raw_frame.size() == kSamplesPer10Ms) {
          const RuntimeConfig config = readRuntimeConfig();
          float frame_square_sum = 0.0f;
          for (float sample : raw_frame) {
            const float amplified_sample = sample * config.input_volume;
            frame_square_sum += amplified_sample * amplified_sample;
          }
          const float input_db = rmsToDb(std::sqrt(
            frame_square_sum / static_cast<float>(raw_frame.size())
          ));
          const bool open = gateOpen(input_db, config);
          last_input_db = input_db;
          if (!open) gated_frames += 1;

          std::vector<std::int16_t> pcm_frame;
          pcm_frame.reserve(kSamplesPer10Ms);
          for (float sample : raw_frame) {
            const float amplified_sample = sample * config.input_volume;
            const float processed = open ? softLimitSample(amplified_sample) : 0.0f;
            if (std::abs(amplified_sample) > 1.0f) clipped_samples += 1;
            max_output_peak = std::max(max_output_peak, std::abs(processed));
            pcm_frame.push_back(clampToPcm16(processed));
          }

          livekit::AudioFrame audio_frame(std::move(pcm_frame), kSampleRate, kChannels, kSamplesPer10Ms);
          const auto capture_started_at = std::chrono::steady_clock::now();
          audio_source->captureFrame(audio_frame);
          const auto capture_elapsed = std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - capture_started_at
          );
          max_capture_frame_us = std::max(
            max_capture_frame_us,
            static_cast<std::uint32_t>(std::max<std::int64_t>(0, capture_elapsed.count()))
          );
          const auto frame_gap = std::chrono::duration_cast<std::chrono::milliseconds>(
            capture_started_at - last_frame_at
          );
          max_frame_gap_ms = std::max(
            max_frame_gap_ms,
            static_cast<std::uint32_t>(std::max<std::int64_t>(0, frame_gap.count()))
          );
          last_frame_at = capture_started_at;
          total_frames += 1;
          interval_frames += 1;
          raw_frame.clear();

          const auto now = std::chrono::steady_clock::now();
          if (now - last_metrics_at >= std::chrono::milliseconds(50)) {
            emitMicrophoneMetrics(command.session_id, input_db, config.voice_gate_threshold_db, open);
            last_metrics_at = now;
          }
          if (now - last_diagnostics_at >= std::chrono::seconds(1)) {
            emitMicrophoneDiagnostics(
              command.session_id,
              "publish",
              total_frames,
              interval_frames,
              last_input_db,
              max_output_peak,
              clipped_samples,
              gated_frames,
              max_frame_gap_ms,
              max_capture_frame_us,
              config
            );
            interval_frames = 0;
            gated_frames = 0;
            clipped_samples = 0;
            max_frame_gap_ms = 0;
            max_capture_frame_us = 0;
            max_output_peak = 0.0f;
            last_diagnostics_at = now;
          }
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
