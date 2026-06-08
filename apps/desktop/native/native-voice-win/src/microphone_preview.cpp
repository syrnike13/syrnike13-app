#include "microphone_preview.hpp"

#include <audioclient.h>
#include <avrt.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>

#include "audio_constants.hpp"
#include "audio_devices.hpp"
#include "audio_processing.hpp"
#include "runtime_config.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::voice {

void runMicrophonePreview(const StartCommand& command) {
  g_running.store(true);
  updateRuntimeConfig(command);

  std::thread([]() {
    std::string line;
    while (g_running.load() && std::getline(std::cin, line)) {
      if (commandMatches(line, "stop")) {
        g_running.store(false);
        break;
      }
      if (commandMatches(line, "configure")) {
        updateRuntimeConfig(parseStartCommand(line));
      }
    }
  }).detach();

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool com_initialized = SUCCEEDED(hr);

  DWORD task_index = 0;
  HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);

  try {
    ComPtr<IMMDevice> capture_device = getCaptureDevice(command.device_id);
    ComPtr<IMMDevice> render_device = getRenderDevice();

    ComPtr<IAudioClient> capture_client;
    hr = capture_device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(capture_client.GetAddressOf()));
    if (FAILED(hr)) throw std::runtime_error("failed to activate preview capture client");

    ComPtr<IAudioClient> render_client;
    hr = render_device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(render_client.GetAddressOf()));
    if (FAILED(hr)) throw std::runtime_error("failed to activate preview render client");

    WAVEFORMATEX capture_format = desiredCaptureFormat();
    hr = capture_client->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
      kBufferDurationHns,
      0,
      &capture_format,
      nullptr
    );
    if (FAILED(hr)) throw std::runtime_error("failed to initialize preview capture stream");

    WAVEFORMATEX render_format = desiredRenderFormat();
    hr = render_client->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
      kBufferDurationHns,
      0,
      &render_format,
      nullptr
    );
    if (FAILED(hr)) throw std::runtime_error("failed to initialize preview render stream");

    ComPtr<IAudioCaptureClient> capture;
    hr = capture_client->GetService(IID_PPV_ARGS(&capture));
    if (FAILED(hr)) throw std::runtime_error("failed to get preview capture service");

    ComPtr<IAudioRenderClient> render;
    hr = render_client->GetService(IID_PPV_ARGS(&render));
    if (FAILED(hr)) throw std::runtime_error("failed to get preview render service");

    UINT32 render_buffer_frames = 0;
    hr = render_client->GetBufferSize(&render_buffer_frames);
    if (FAILED(hr)) throw std::runtime_error("failed to get preview render buffer size");

    hr = capture_client->Start();
    if (FAILED(hr)) throw std::runtime_error("failed to start preview capture stream");
    hr = render_client->Start();
    if (FAILED(hr)) throw std::runtime_error("failed to start preview render stream");

    emit("{\"type\":\"ready\",\"port\":0,\"stream_mode\":\"audio\",\"audio_mode\":\"microphone\","
         "\"audio_sample_rate\":48000,\"audio_channels\":1,\"echo_cancellation\":\"unavailable\"}");
    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
         "\",\"kind\":\"microphone\",\"status\":\"running\",\"audio_mode\":\"microphone\","
         "\"audio_sample_rate\":48000,\"audio_channels\":1,\"echo_cancellation\":\"unavailable\"}");

    std::vector<float> queued_samples;
    queued_samples.reserve(static_cast<size_t>(render_buffer_frames));
    float frame_square_sum = 0.0f;
    int frame_sample_count = 0;
    auto last_metrics_at = std::chrono::steady_clock::now();

    while (g_running.load()) {
      UINT32 packet_frames = 0;
      hr = capture->GetNextPacketSize(&packet_frames);
      if (FAILED(hr)) break;

      while (packet_frames > 0) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;
        hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (FAILED(hr)) break;

        const float* samples = reinterpret_cast<const float*>(data);
        for (UINT32 index = 0; index < frames; ++index) {
          const RuntimeConfig config = readRuntimeConfig();
          const float raw_sample = (flags & AUDCLNT_BUFFERFLAGS_SILENT) ? 0.0f : samples[index];
          const float amplified_sample = std::max(-1.0f, std::min(1.0f, raw_sample * config.input_volume));
          frame_square_sum += amplified_sample * amplified_sample;
          frame_sample_count += 1;
          const float input_db = frame_sample_count > 0
            ? rmsToDb(std::sqrt(frame_square_sum / static_cast<float>(frame_sample_count)))
            : -60.0f;
          const bool open = gateOpen(input_db, config);
          const float sample = open ? amplified_sample : 0.0f;
          queued_samples.push_back(sample);

          if (frame_sample_count >= kSamplesPer10Ms) {
            const auto now = std::chrono::steady_clock::now();
            if (now - last_metrics_at >= std::chrono::milliseconds(50)) {
              emitMicrophoneMetrics(command.session_id, input_db, config.voice_gate_threshold_db, open);
              last_metrics_at = now;
            }
            frame_square_sum = 0.0f;
            frame_sample_count = 0;
          }
        }
        capture->ReleaseBuffer(frames);

        hr = capture->GetNextPacketSize(&packet_frames);
        if (FAILED(hr)) break;
      }

      UINT32 padding = 0;
      hr = render_client->GetCurrentPadding(&padding);
      if (FAILED(hr)) break;
      const UINT32 available = render_buffer_frames > padding ? render_buffer_frames - padding : 0;
      const UINT32 frames_to_write = std::min<UINT32>(available, static_cast<UINT32>(queued_samples.size()));
      if (frames_to_write > 0) {
        BYTE* render_data = nullptr;
        hr = render->GetBuffer(frames_to_write, &render_data);
        if (FAILED(hr)) break;
        float* out = reinterpret_cast<float*>(render_data);
        for (UINT32 index = 0; index < frames_to_write; ++index) {
          out[index] = queued_samples[index];
        }
        render->ReleaseBuffer(frames_to_write, 0);
        queued_samples.erase(queued_samples.begin(), queued_samples.begin() + frames_to_write);
      }

      if (queued_samples.size() > render_buffer_frames) {
        queued_samples.erase(
          queued_samples.begin(),
          queued_samples.begin() + (queued_samples.size() - render_buffer_frames)
        );
      }

      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }

    capture_client->Stop();
    render_client->Stop();
  } catch (const std::exception& error) {
    emitError("microphone_preview_failed", error.what());
  }

  if (avrt) AvRevertMmThreadCharacteristics(avrt);
  if (com_initialized) CoUninitialize();

  emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"kind\":\"microphone\",\"status\":\"stopped\"}");
  emit("{\"type\":\"stopped\"}");
}

}  // namespace syrnike::voice
