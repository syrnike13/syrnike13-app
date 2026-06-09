#include "microphone_warmup.hpp"

#include <audioclient.h>
#include <avrt.h>
#include <windows.h>
#include <wrl/client.h>

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

#include "audio_constants.hpp"
#include "audio_devices.hpp"
#include "audio_processing.hpp"
#include "runtime_config.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::voice {
namespace {

std::mutex g_warmup_mutex;
std::thread g_warmup_thread;
std::atomic_bool g_warmup_running{false};

MicrophoneProcessingStatus warmupProcessingStatus(const RuntimeConfig& config) {
  MicrophoneProcessingStatus status;
  status.noise_suppression =
    config.noise_suppression_enabled ? "unavailable" : "disabled";
  status.echo_cancellation =
    config.echo_cancellation_enabled ? "unavailable" : "disabled";
  return status;
}

void runMicrophoneWarmup(std::string device_id, std::string session_id) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool com_initialized = SUCCEEDED(hr);

  DWORD task_index = 0;
  HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);

  try {
    ComPtr<IMMDevice> device = getCaptureDevice(device_id);
    ComPtr<IAudioClient> audio_client;
    hr = device->Activate(
      __uuidof(IAudioClient),
      CLSCTX_ALL,
      nullptr,
      reinterpret_cast<void**>(audio_client.GetAddressOf())
    );
    if (FAILED(hr)) throw std::runtime_error("failed to activate warm microphone client");

    WAVEFORMATEX format = desiredCaptureFormat();
    hr = audio_client->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
      kBufferDurationHns,
      0,
      &format,
      nullptr
    );
    if (FAILED(hr)) throw std::runtime_error("failed to initialize warm microphone stream");

    ComPtr<IAudioCaptureClient> capture_client;
    hr = audio_client->GetService(IID_PPV_ARGS(&capture_client));
    if (FAILED(hr)) throw std::runtime_error("failed to get warm microphone capture client");

    hr = audio_client->Start();
    if (FAILED(hr)) throw std::runtime_error("failed to start warm microphone stream");

    VoiceGateProcessor gate(kSampleRate);
    std::vector<float> raw_frame;
    raw_frame.reserve(kSamplesPer10Ms);
    std::vector<float> processed_frame;
    processed_frame.reserve(kSamplesPer10Ms);
    auto last_metrics_at = std::chrono::steady_clock::now();
    auto last_diagnostics_at = last_metrics_at;
    auto last_frame_at = last_metrics_at;
    std::uint64_t total_frames = 0;
    std::uint32_t interval_frames = 0;
    std::uint32_t gated_frames = 0;
    std::uint32_t clipped_samples = 0;
    std::uint32_t max_frame_gap_ms = 0;
    float last_input_db = -60.0f;
    float max_output_peak = 0.0f;

    while (g_warmup_running.load()) {
      UINT32 packet_frames = 0;
      hr = capture_client->GetNextPacketSize(&packet_frames);
      if (FAILED(hr)) break;

      while (packet_frames > 0 && g_warmup_running.load()) {
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
            gate.updateConfig(voiceGateConfigFromRuntimeConfig(config));

            processed_frame.clear();
            for (float sample : raw_frame) {
              processed_frame.push_back(sample * config.input_volume);
            }

            const VoiceGateFrameMetrics gate_metrics = gate.processFrame(processed_frame);
            const float input_db = gate_metrics.input_db;
            const bool open = gate_metrics.open;
            for (float sample : processed_frame) {
              if (std::abs(sample) > 1.0f) clipped_samples += 1;
              max_output_peak = std::max(max_output_peak, std::abs(softLimitSample(sample)));
            }
            last_input_db = input_db;
            if (!open) gated_frames += 1;

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
              emitMicrophoneMetrics(
                session_id,
                input_db,
                config.voice_gate_threshold_db,
                open
              );
              last_metrics_at = now;
            }
            if (now - last_diagnostics_at >= std::chrono::seconds(1)) {
              emitMicrophoneDiagnostics(
                session_id,
                "warmup",
                total_frames,
                interval_frames,
                last_input_db,
                max_output_peak,
                clipped_samples,
                gated_frames,
                max_frame_gap_ms,
                0,
                config,
                warmupProcessingStatus(config)
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
        capture_client->ReleaseBuffer(frames);
        hr = capture_client->GetNextPacketSize(&packet_frames);
        if (FAILED(hr)) break;
      }

      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }

    audio_client->Stop();
  } catch (const std::exception& error) {
    std::cerr << "[microphone-warmup] " << error.what() << std::endl;
  }

  if (avrt) AvRevertMmThreadCharacteristics(avrt);
  if (com_initialized) CoUninitialize();
}

}  // namespace

void startMicrophoneWarmup(
  const std::string& device_id,
  const std::string& session_id
) {
  std::lock_guard<std::mutex> lock(g_warmup_mutex);
  if (g_warmup_running.load()) return;

  g_warmup_running.store(true);
  g_warmup_thread = std::thread(runMicrophoneWarmup, device_id, session_id);
}

void stopMicrophoneWarmup() {
  std::thread warmup_thread;
  {
    std::lock_guard<std::mutex> lock(g_warmup_mutex);
    if (!g_warmup_running.load() && !g_warmup_thread.joinable()) return;
    g_warmup_running.store(false);
    warmup_thread = std::move(g_warmup_thread);
  }

  if (warmup_thread.joinable()) warmup_thread.join();
}

}  // namespace syrnike::voice
