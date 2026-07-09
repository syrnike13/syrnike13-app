#include "microphone_publisher.hpp"

#include <audioclient.h>
#include <avrt.h>
#include <windows.h>
#include <wrl/client.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <thread>
#include <vector>

#include "livekit/livekit.h"
#include "livekit/local_audio_track.h"
#include "livekit/room_delegate.h"

#include "audio_constants.hpp"
#include "audio_devices.hpp"
#include "microphone_audio_processor.hpp"
#include "microphone_echo_reference.hpp"
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

struct MicrophoneCaptureState {
  std::atomic_bool publishing{false};
  std::mutex mutex;
  std::string session_id;
};

struct ConnectedMicrophoneRoom {
  std::string session_id;
  std::string native_identity;
  std::unique_ptr<livekit::Room> room;
  std::unique_ptr<NativeRoomDelegate> delegate;
  std::shared_ptr<livekit::LocalAudioTrack> audio_track;
};

std::string captureSessionId(const std::shared_ptr<MicrophoneCaptureState>& state) {
  std::lock_guard<std::mutex> lock(state->mutex);
  return state->session_id;
}

MicrophoneProcessingStatus initialMicrophoneProcessingStatus(
  bool noise_suppression_enabled,
  bool echo_cancellation_enabled
) {
  MicrophoneProcessingStatus status;
  status.noise_suppression =
    noise_suppression_enabled ? "software" : "disabled";
  status.echo_cancellation =
    echo_cancellation_enabled ? "unavailable" : "disabled";
  return status;
}

void setCaptureSessionId(
  const std::shared_ptr<MicrophoneCaptureState>& state,
  const std::string& session_id
) {
  std::lock_guard<std::mutex> lock(state->mutex);
  state->session_id = session_id;
}

void captureMicrophone(
  const StartCommand command,
  const std::shared_ptr<livekit::AudioSource>& audio_source,
  const std::shared_ptr<MicrophoneCaptureState>& state
) {
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

    MicrophoneAudioProcessor processor;
    MicrophoneEchoReference echo_reference;
    bool echo_reference_enabled = command.echo_cancellation;
    if (echo_reference_enabled) {
      echo_reference.start();
    }
    std::vector<float> raw_frame;
    raw_frame.reserve(kSamplesPer10Ms);
    std::vector<std::int16_t> silent_reference_frame(kSamplesPer10Ms, 0);
    auto last_metrics_at = std::chrono::steady_clock::now();
    auto last_diagnostics_at = last_metrics_at;
    auto last_frame_at = last_metrics_at;
    MicrophoneProcessingStatus last_processing_status =
      initialMicrophoneProcessingStatus(
        command.noise_suppression,
        command.echo_cancellation
      );
    std::uint64_t total_frames = 0;
    std::uint32_t interval_frames = 0;
    std::uint32_t gated_frames = 0;
    std::uint32_t clipped_samples = 0;
    std::uint32_t max_frame_gap_ms = 0;
    std::uint32_t max_capture_frame_us = 0;
    float last_input_db = -60.0f;
    VoiceGateFrameMetrics last_gate_metrics;
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
          if (config.echo_cancellation_enabled != echo_reference_enabled) {
            echo_reference_enabled = config.echo_cancellation_enabled;
            if (echo_reference_enabled) {
              echo_reference.start();
            } else {
              echo_reference.stop();
            }
          }

          const auto reference_frame = echo_reference_enabled
            ? echo_reference.popFrame()
            : std::nullopt;
          const auto reference_status = echo_reference.status();
          const std::vector<std::int16_t>* reference_frame_ptr = nullptr;
          if (echo_reference_enabled && reference_status.available) {
            reference_frame_ptr = reference_frame.has_value()
              ? &reference_frame.value()
              : &silent_reference_frame;
          }
          auto processed = processor.processFrame(
            raw_frame,
            config,
            reference_frame_ptr
          );

          const float input_db = processed.gate_metrics.input_db;
          const bool open = processed.gate_metrics.open;
          last_input_db = input_db;
          last_gate_metrics = processed.gate_metrics;
          if (!open) gated_frames += 1;
          clipped_samples += processed.clipped_samples;
          max_output_peak = std::max(max_output_peak, processed.output_peak);
          last_processing_status = processed.status;

          const auto capture_started_at = std::chrono::steady_clock::now();
          if (state->publishing.load()) {
            livekit::AudioFrame audio_frame(
              std::move(processed.pcm),
              kSampleRate,
              kChannels,
              kSamplesPer10Ms
            );
            audio_source->captureFrame(audio_frame);
            const auto capture_elapsed = std::chrono::duration_cast<std::chrono::microseconds>(
              std::chrono::steady_clock::now() - capture_started_at
            );
            max_capture_frame_us = std::max(
              max_capture_frame_us,
              static_cast<std::uint32_t>(std::max<std::int64_t>(0, capture_elapsed.count()))
            );
          }
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
            emitMicrophoneMetrics(
              captureSessionId(state),
              input_db,
              processed.gate_metrics.threshold_db,
              open
            );
            last_metrics_at = now;
          }
          if (now - last_diagnostics_at >= std::chrono::seconds(1)) {
            emitMicrophoneDiagnostics(
              captureSessionId(state),
              state->publishing.load() ? "publish" : "warmup",
              total_frames,
              interval_frames,
              last_input_db,
              max_output_peak,
              clipped_samples,
              gated_frames,
              max_frame_gap_ms,
              max_capture_frame_us,
              last_gate_metrics,
              config,
              last_processing_status
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

void emitMicrophoneMuteState(const std::string& session_id, bool muted) {
  emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(session_id) +
       "\",\"kind\":\"microphone\",\"status\":\"running\",\"message\":\"" +
       (muted ? "microphone_muted" : "microphone_unmuted") + "\"}");
}

void emitMicrophoneReady(
  const StartCommand& command,
  const std::string& native_identity
) {
  const MicrophoneProcessingStatus status = initialMicrophoneProcessingStatus(
    command.noise_suppression,
    command.echo_cancellation
  );
  emit("{\"type\":\"ready\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"port\":0,\"stream_mode\":\"audio\",\"audio_mode\":\"microphone\","
       "\"audio_sample_rate\":48000,\"audio_channels\":1,"
       "\"noise_suppression\":\"" + jsonEscape(status.noise_suppression) + "\","
       "\"echo_cancellation\":\"" + jsonEscape(status.echo_cancellation) + "\","
       "\"native_participant_identity\":\"" + jsonEscape(native_identity) + "\"}");
}

void disconnectMicrophoneRoom(
  ConnectedMicrophoneRoom& connected,
  const std::shared_ptr<MicrophoneCaptureState>& state,
  bool emit_stopped_event = true
) {
  if (connected.audio_track) {
    connected.audio_track.reset();
  }
  state->publishing.store(false);
  if (connected.room) {
    try {
      connected.room->disconnect();
    } catch (const std::exception& error) {
      if (emit_stopped_event) {
        emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(connected.session_id) +
             "\",\"kind\":\"microphone\",\"status\":\"stopped\",\"message\":\"disconnect_failed:" +
             jsonEscape(error.what()) + "\"}");
      }
    }
  }
  connected.room.reset();
  connected.delegate.reset();
  if (emit_stopped_event && !connected.session_id.empty()) {
    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(connected.session_id) +
         "\",\"kind\":\"microphone\",\"status\":\"stopped\"}");
  }
  connected.session_id.clear();
  connected.native_identity.clear();
}

bool connectMicrophoneRoom(
  const StartCommand& command,
  const std::shared_ptr<livekit::AudioSource>& audio_source,
  const std::shared_ptr<MicrophoneCaptureState>& state,
  ConnectedMicrophoneRoom& connected
) {
  const auto started_at = std::chrono::steady_clock::now();
  auto elapsedMs = [&]() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started_at
    ).count();
  };

  if (command.session_id.empty() || command.livekit_url.empty() || command.livekit_token.empty()) {
    emitError("invalid_start_command", "missing sessionId or LiveKit credentials");
    return false;
  }

  disconnectMicrophoneRoom(connected, state, false);
  setCaptureSessionId(state, command.session_id);
  const std::string native_identity = command.participant_identity;

  emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"kind\":\"microphone\",\"status\":\"starting\",\"message\":\"livekit_connecting\",\"elapsed_ms\":" +
       std::to_string(elapsedMs()) + "}");

  auto room = std::make_unique<livekit::Room>();
  auto delegate = std::make_unique<NativeRoomDelegate>();
  room->setDelegate(delegate.get());
  livekit::RoomOptions room_options;
  room_options.auto_subscribe = false;
  room_options.single_peer_connection = false;

  bool room_connected = false;
  try {
    room_connected = room->connect(command.livekit_url, command.livekit_token, room_options);
  } catch (const std::exception& error) {
    emitError("livekit_connect_failed", error.what());
    return false;
  }
  if (!room_connected) {
    emitError("livekit_connect_failed", "LiveKit native microphone connect returned false");
    return false;
  }
  if (!delegate->waitConnected(std::chrono::milliseconds(10'000))) {
    room.reset();
    emitError("livekit_connect_failed", "LiveKit native microphone did not reach connected state");
    return false;
  }

  emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"kind\":\"microphone\",\"status\":\"starting\",\"message\":\"livekit_connected\",\"elapsed_ms\":" +
       std::to_string(elapsedMs()) + "}");

  std::shared_ptr<livekit::LocalAudioTrack> audio_track;
  try {
    if (auto participant = room->localParticipant().lock()) {
      emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
           "\",\"kind\":\"microphone\",\"status\":\"starting\",\"message\":\"publishing_audio_track\",\"elapsed_ms\":" +
           std::to_string(elapsedMs()) + "}");
      audio_track = livekit::LocalAudioTrack::createLocalAudioTrack("microphone", audio_source);
      livekit::AudioEncodingOptions audio_encoding;
      audio_encoding.max_bitrate = command.audio_bitrate;
      livekit::TrackPublishOptions publish_options;
      publish_options.audio_encoding = audio_encoding;
      publish_options.dtx = true;
      publish_options.source = livekit::TrackSource::SOURCE_MICROPHONE;
      participant->publishTrack(audio_track, publish_options);
      if (command.muted && audio_track) {
        audio_track->mute();
        emitMicrophoneMuteState(command.session_id, true);
      }
    } else {
      throw std::runtime_error("local participant is unavailable");
    }
  } catch (const std::exception& error) {
    room.reset();
    emitError("livekit_publish_failed", error.what());
    return false;
  }

  connected.session_id = command.session_id;
  connected.native_identity = native_identity;
  connected.room = std::move(room);
  connected.delegate = std::move(delegate);
  connected.audio_track = audio_track;
  state->publishing.store(true);

  emitMicrophoneReady(command, native_identity);
  const MicrophoneProcessingStatus status = initialMicrophoneProcessingStatus(
    command.noise_suppression,
    command.echo_cancellation
  );
  emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"kind\":\"microphone\",\"status\":\"running\",\"audio_mode\":\"microphone\","
       "\"audio_sample_rate\":48000,\"audio_channels\":1,"
       "\"noise_suppression\":\"" + jsonEscape(status.noise_suppression) + "\","
       "\"echo_cancellation\":\"" + jsonEscape(status.echo_cancellation) + "\","
       "\"elapsed_ms\":" + std::to_string(elapsedMs()) + "}");
  return true;
}

}  // namespace

void runMicrophonePublisher(const StartCommand& command) {
  g_running.store(true);
  updateRuntimeConfig(command);
  livekit::initialize(livekit::LogLevel::Info);
  auto audio_source = std::make_shared<livekit::AudioSource>(kSampleRate, kChannels);
  auto state = std::make_shared<MicrophoneCaptureState>();
  setCaptureSessionId(state, command.session_id);
  std::thread capture_thread(captureMicrophone, command, audio_source, state);
  ConnectedMicrophoneRoom connected;

  if (!command.livekit_url.empty() || !command.livekit_token.empty()) {
    connectMicrophoneRoom(command, audio_source, state, connected);
  }

  std::string line;
  while (g_running.load() && std::getline(std::cin, line)) {
    if (commandMatches(line, "stop")) {
      g_running.store(false);
      break;
    }
    if (commandMatches(line, "connect_microphone") || commandMatches(line, "start")) {
      const auto connect_command = parseStartCommand(line);
      updateRuntimeConfig(connect_command);
      connectMicrophoneRoom(connect_command, audio_source, state, connected);
      continue;
    }
    if (commandMatches(line, "disconnect_microphone")) {
      disconnectMicrophoneRoom(connected, state);
      setCaptureSessionId(state, command.session_id);
      continue;
    }
    if (commandMatches(line, "set_microphone_muted")) {
      if (connected.audio_track) {
        const bool muted = parseStartCommand(line).muted;
        if (muted) {
          connected.audio_track->mute();
        } else {
          connected.audio_track->unmute();
        }
        emitMicrophoneMuteState(connected.session_id, muted);
      }
      continue;
    }
    if (commandMatches(line, "configure")) {
      updateRuntimeConfig(parseStartCommand(line));
      continue;
    }
  }

  disconnectMicrophoneRoom(connected, state);
  g_running.store(false);
  if (capture_thread.joinable()) capture_thread.join();
  livekit::shutdown();

  emit("{\"type\":\"stopped\"}");
}

}  // namespace syrnike::voice
