#include "microphone_preview.hpp"

#include <audioclient.h>
#include <avrt.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>

#include "audio_constants.hpp"
#include "audio_devices.hpp"
#include "audio_processing.hpp"
#include "microphone_audio_processor.hpp"
#include "runtime_config.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::voice {
namespace {

MicrophoneProcessingStatus initialPreviewProcessingStatus(
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

}  // namespace

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

    const MicrophoneProcessingStatus initial_status =
      initialPreviewProcessingStatus(
        command.noise_suppression,
        command.echo_cancellation
      );
    emit("{\"type\":\"ready\",\"port\":0,\"stream_mode\":\"audio\",\"audio_mode\":\"microphone\","
         "\"audio_sample_rate\":48000,\"audio_channels\":1,"
         "\"noise_suppression\":\"" + jsonEscape(initial_status.noise_suppression) + "\","
         "\"echo_cancellation\":\"" + jsonEscape(initial_status.echo_cancellation) + "\"}");
    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
         "\",\"kind\":\"microphone\",\"status\":\"running\",\"audio_mode\":\"microphone\","
         "\"audio_sample_rate\":48000,\"audio_channels\":1,"
         "\"noise_suppression\":\"" + jsonEscape(initial_status.noise_suppression) + "\","
         "\"echo_cancellation\":\"" + jsonEscape(initial_status.echo_cancellation) + "\"}");

    std::vector<float> queued_samples;
    queued_samples.reserve(static_cast<size_t>(render_buffer_frames));
    MicrophoneAudioProcessor processor;
    std::vector<float> raw_frame;
    raw_frame.reserve(kSamplesPer10Ms);
    auto last_metrics_at = std::chrono::steady_clock::now();
    auto last_diagnostics_at = last_metrics_at;
    auto last_frame_at = last_metrics_at;
    MicrophoneProcessingStatus last_processing_status = initial_status;
    std::uint64_t total_frames = 0;
    std::uint32_t interval_frames = 0;
    std::uint32_t gated_frames = 0;
    std::uint32_t clipped_samples = 0;
    std::uint32_t max_frame_gap_ms = 0;
    float last_input_db = -60.0f;
    float max_output_peak = 0.0f;

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
          const float raw_sample = (flags & AUDCLNT_BUFFERFLAGS_SILENT) ? 0.0f : samples[index];
          raw_frame.push_back(raw_sample);

          if (raw_frame.size() == kSamplesPer10Ms) {
            const RuntimeConfig config = readRuntimeConfig();
            RuntimeConfig preview_config = config;
            preview_config.echo_cancellation_enabled = false;
            auto processed = processor.processFrame(raw_frame, preview_config, nullptr);
            processed.status.echo_cancellation =
              config.echo_cancellation_enabled ? "unavailable" : "disabled";

            const float input_db = processed.gate_metrics.input_db;
            const bool open = processed.gate_metrics.open;
            last_input_db = input_db;
            if (!open) gated_frames += 1;

            clipped_samples += processed.clipped_samples;
            max_output_peak = std::max(max_output_peak, processed.output_peak);
            last_processing_status = processed.status;
            for (std::int16_t sample : processed.pcm) {
              queued_samples.push_back(static_cast<float>(sample) / 32768.0f);
            }
            const auto frame_at = std::chrono::steady_clock::now();
            const auto frame_gap = std::chrono::duration_cast<std::chrono::milliseconds>(
              frame_at - last_frame_at
            );
            max_frame_gap_ms = std::max(
              max_frame_gap_ms,
              static_cast<std::uint32_t>(std::max<std::int64_t>(0, frame_gap.count()))
            );
            last_frame_at = frame_at;
            total_frames += 1;
            interval_frames += 1;

            const auto now = std::chrono::steady_clock::now();
            if (now - last_metrics_at >= std::chrono::milliseconds(50)) {
              emitMicrophoneMetrics(command.session_id, input_db, config.voice_gate_threshold_db, open);
              last_metrics_at = now;
            }
            if (now - last_diagnostics_at >= std::chrono::seconds(1)) {
              emitMicrophoneDiagnostics(
                command.session_id,
                "preview",
                total_frames,
                interval_frames,
                last_input_db,
                max_output_peak,
                clipped_samples,
                gated_frames,
                max_frame_gap_ms,
                0,
                config,
                last_processing_status
              );
              interval_frames = 0;
              gated_frames = 0;
              clipped_samples = 0;
              max_frame_gap_ms = 0;
              max_output_peak = 0.0f;
              last_diagnostics_at = now;
            }
            raw_frame.clear();
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
