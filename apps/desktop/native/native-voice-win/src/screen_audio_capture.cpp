#include "screen_audio_capture.hpp"

#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <avrt.h>
#include <mmdeviceapi.h>
#include <propidl.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cmath>
#include <stdexcept>
#include <sstream>
#include <thread>
#include <vector>

#include "audio_devices.hpp"
#include "runtime_config.hpp"
#include "screen_video_capture.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::voice {
namespace {

constexpr int kScreenAudioSampleRate = 48000;
constexpr int kScreenAudioChannels = 2;
constexpr REFERENCE_TIME kScreenAudioBufferDurationHns = 1000000; // 100 ms

WAVEFORMATEX desiredScreenLoopbackFormat() {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = kScreenAudioChannels;
  format.nSamplesPerSec = kScreenAudioSampleRate;
  format.wBitsPerSample = 32;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  return format;
}

std::string hresultMessage(const char* action, HRESULT hr) {
  std::ostringstream out;
  out << action << " (HRESULT=0x" << std::hex << static_cast<unsigned long>(hr) << ")";
  return out.str();
}

class AudioClientActivationHandler final
    : public IActivateAudioInterfaceCompletionHandler,
      public IAgileObject {
public:
  AudioClientActivationHandler() : done_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}
  ~AudioClientActivationHandler() {
    if (done_) CloseHandle(done_);
  }

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
    if (!object) return E_POINTER;
    if (iid == __uuidof(IUnknown) ||
        iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *object = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    if (iid == __uuidof(IAgileObject)) {
      *object = static_cast<IAgileObject*>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override {
    return InterlockedIncrement(&ref_count_);
  }

  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG count = InterlockedDecrement(&ref_count_);
    if (count == 0) delete this;
    return count;
  }

  HRESULT STDMETHODCALLTYPE ActivateCompleted(
      IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activate_hr = E_FAIL;
    IUnknown* raw = nullptr;
    result_ = operation->GetActivateResult(&activate_hr, &raw);
    activate_hr_ = activate_hr;
    if (SUCCEEDED(result_) && SUCCEEDED(activate_hr) && raw) {
      raw->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(audio_client_.GetAddressOf()));
      raw->Release();
    }
    SetEvent(done_);
    return S_OK;
  }

  ComPtr<IAudioClient> waitForAudioClient() {
    WaitForSingleObject(done_, 10'000);
    if (FAILED(result_) || FAILED(activate_hr_) || !audio_client_) {
      throw std::runtime_error("failed to activate process loopback client");
    }
    return audio_client_;
  }

private:
  volatile LONG ref_count_ = 1;
  HANDLE done_ = nullptr;
  HRESULT result_ = E_FAIL;
  HRESULT activate_hr_ = E_FAIL;
  ComPtr<IAudioClient> audio_client_;
};

int16_t floatToPcm16(float value) {
  const float clamped = std::clamp(value, -1.0f, 1.0f);
  return static_cast<int16_t>(clamped * 32767.0f);
}

class ComScope {
public:
  ComScope() : initialized_(SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {}
  ~ComScope() {
    if (initialized_) CoUninitialize();
  }

private:
  bool initialized_ = false;
};

ComPtr<IAudioClient> activateSystemLoopbackClient() {
  ComPtr<IMMDevice> render_device = getRenderDevice();

  ComPtr<IAudioClient> audio_client;
  HRESULT hr = render_device->Activate(
      __uuidof(IAudioClient),
      CLSCTX_ALL,
      nullptr,
      reinterpret_cast<void**>(audio_client.GetAddressOf()));
  if (FAILED(hr)) throw std::runtime_error("failed to activate screen loopback client");
  return audio_client;
}

ComPtr<IAudioClient> activateProcessLoopbackClient(
    DWORD process_id,
    PROCESS_LOOPBACK_MODE loopback_mode) {
  AUDIOCLIENT_ACTIVATION_PARAMS activation_params{};
  activation_params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  activation_params.ProcessLoopbackParams.TargetProcessId = process_id;
  activation_params.ProcessLoopbackParams.ProcessLoopbackMode = loopback_mode;

  PROPVARIANT activate_blob;
  PropVariantInit(&activate_blob);
  activate_blob.vt = VT_BLOB;
  activate_blob.blob.cbSize = sizeof(activation_params);
  activate_blob.blob.pBlobData = reinterpret_cast<BYTE*>(&activation_params);

  auto* handler = new AudioClientActivationHandler();
  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
  HRESULT hr = ActivateAudioInterfaceAsync(
      VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
      __uuidof(IAudioClient),
      &activate_blob,
      handler,
      operation.GetAddressOf());
  if (FAILED(hr)) {
    handler->Release();
    throw std::runtime_error(hresultMessage("failed to start process loopback activation", hr));
  }

  ComPtr<IAudioClient> audio_client = handler->waitForAudioClient();
  handler->Release();
  return audio_client;
}

void captureLoopbackAudio(
    const std::shared_ptr<livekit::AudioSource>& audio_source,
    DWORD process_id,
    PROCESS_LOOPBACK_MODE loopback_mode,
    const std::string& session_id,
    const char* audio_mode,
    const char* loopback_mode_name,
    const std::shared_ptr<std::atomic_bool>& running) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool com_initialized = SUCCEEDED(hr);

  DWORD task_index = 0;
  HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);

  try {
    ComPtr<IAudioClient> audio_client =
        process_id != 0
            ? activateProcessLoopbackClient(process_id, loopback_mode)
            : activateSystemLoopbackClient();

    WAVEFORMATEX format = desiredScreenLoopbackFormat();
    hr = audio_client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK |
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        kScreenAudioBufferDurationHns,
        0,
        &format,
        nullptr);
    if (FAILED(hr)) throw std::runtime_error("failed to initialize screen loopback stream");

    ComPtr<IAudioCaptureClient> capture_client;
    hr = audio_client->GetService(
        __uuidof(IAudioCaptureClient),
        reinterpret_cast<void**>(capture_client.GetAddressOf()));
    if (FAILED(hr)) throw std::runtime_error("failed to open screen loopback capture client");

    hr = audio_client->Start();
    if (FAILED(hr)) throw std::runtime_error("failed to start screen loopback stream");

    std::uint64_t captured_frames_total = 0;
    std::uint64_t packets_total = 0;
    float interval_peak = 0.0f;
    double interval_square_sum = 0.0;
    std::uint64_t interval_sample_count = 0;
    auto next_stats_at = std::chrono::steady_clock::now();

    while (g_running.load() && running->load()) {
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

      std::vector<int16_t> pcm(static_cast<size_t>(frames) * kScreenAudioChannels);
      if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0 && data) {
        const auto* samples = reinterpret_cast<const float*>(data);
        for (size_t index = 0; index < pcm.size(); ++index) {
          const float clamped = std::clamp(samples[index], -1.0f, 1.0f);
          const float magnitude = std::abs(clamped);
          interval_peak = std::max(interval_peak, magnitude);
          interval_square_sum += static_cast<double>(clamped) * clamped;
          interval_sample_count += 1;
          pcm[index] = floatToPcm16(clamped);
        }
      }

      capture_client->ReleaseBuffer(frames);

      if (!pcm.empty()) {
        livekit::AudioFrame frame(
            std::move(pcm),
            kScreenAudioSampleRate,
            kScreenAudioChannels,
            static_cast<int>(frames));
        audio_source->captureFrame(frame);
        captured_frames_total += frames;
        packets_total += 1;
      }

      const auto now = std::chrono::steady_clock::now();
      if (now >= next_stats_at) {
        const double rms = interval_sample_count > 0
            ? std::sqrt(interval_square_sum / static_cast<double>(interval_sample_count))
            : 0.0;
        const auto peak_db = interval_peak > 0.0f
            ? 20.0 * std::log10(static_cast<double>(interval_peak))
            : -120.0;
        const auto rms_db = rms > 0.0
            ? 20.0 * std::log10(rms)
            : -120.0;
        emit("{\"type\":\"screen_audio_frame\",\"session_id\":\"" +
             jsonEscape(session_id) +
             "\",\"frames\":" + std::to_string(captured_frames_total) +
             ",\"packets\":" + std::to_string(packets_total) +
             ",\"peak_db\":" + std::to_string(peak_db) +
             ",\"rms_db\":" + std::to_string(rms_db) +
             ",\"sample_rate\":48000,\"channels\":2" +
             ",\"audio_mode\":\"" + std::string(audio_mode) +
             "\",\"audio_loopback_mode\":\"" + std::string(loopback_mode_name) +
             "\",\"audio_target_process_id\":" + std::to_string(process_id) + "}");
        interval_peak = 0.0f;
        interval_square_sum = 0.0;
        interval_sample_count = 0;
        next_stats_at = now + std::chrono::seconds(1);
      }
    }

    audio_client->Stop();
  } catch (const std::exception& error) {
    emit("{\"type\":\"error\",\"code\":\"screen_audio_capture_failed\",\"message\":\"" +
         jsonEscape(error.what()) + "\"}");
    running->store(false);
  } catch (...) {
    emit("{\"type\":\"error\",\"code\":\"screen_audio_capture_failed\",\"message\":\"unknown screen audio capture failure\"}");
    running->store(false);
  }

  if (avrt) AvRevertMmThreadCharacteristics(avrt);
  if (com_initialized) CoUninitialize();
}

ScreenAudioProbeResult probeLoopbackClient(
    DWORD process_id,
    PROCESS_LOOPBACK_MODE loopback_mode,
    int duration_ms) {
  ComPtr<IAudioClient> audio_client =
      process_id != 0
          ? activateProcessLoopbackClient(process_id, loopback_mode)
          : activateSystemLoopbackClient();

  WAVEFORMATEX format = desiredScreenLoopbackFormat();
  HRESULT hr = audio_client->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK |
          AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
          AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
      kScreenAudioBufferDurationHns,
      0,
      &format,
      nullptr);
  if (FAILED(hr)) throw std::runtime_error("failed to initialize screen loopback probe");

  ComPtr<IAudioCaptureClient> capture_client;
  hr = audio_client->GetService(
      __uuidof(IAudioCaptureClient),
      reinterpret_cast<void**>(capture_client.GetAddressOf()));
  if (FAILED(hr)) throw std::runtime_error("failed to open screen loopback probe client");

  hr = audio_client->Start();
  if (FAILED(hr)) throw std::runtime_error("failed to start screen loopback probe");
  ScreenAudioProbeResult result;
  result.ok = true;
  result.target_process_id = process_id;

  float peak = 0.0f;
  double square_sum = 0.0;
  std::uint64_t sample_count = 0;
  const auto deadline = std::chrono::steady_clock::now() +
      std::chrono::milliseconds(std::max(1, duration_ms));
  while (std::chrono::steady_clock::now() < deadline) {
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

    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0 && data) {
      const auto* samples = reinterpret_cast<const float*>(data);
      const size_t count = static_cast<size_t>(frames) * kScreenAudioChannels;
      for (size_t index = 0; index < count; ++index) {
        const float clamped = std::clamp(samples[index], -1.0f, 1.0f);
        peak = std::max(peak, std::abs(clamped));
        square_sum += static_cast<double>(clamped) * clamped;
        sample_count += 1;
      }
    }

    capture_client->ReleaseBuffer(frames);
  }

  audio_client->Stop();
  const double rms = sample_count > 0
      ? std::sqrt(square_sum / static_cast<double>(sample_count))
      : 0.0;
  result.peak_db = peak > 0.0f
      ? 20.0 * std::log10(static_cast<double>(peak))
      : -120.0;
  result.rms_db = rms > 0.0
      ? 20.0 * std::log10(rms)
      : -120.0;
  return result;
}

}  // namespace

void captureSystemLoopbackAudio(
    DWORD excluded_process_id,
    const std::string& session_id,
    const std::shared_ptr<livekit::AudioSource>& audio_source,
    const std::shared_ptr<std::atomic_bool>& running) {
  captureLoopbackAudio(
      audio_source,
      excluded_process_id,
      PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
      session_id,
      "system_exclude",
      "exclude_target_process_tree",
      running);
}

void captureProcessLoopbackAudio(
    DWORD process_id,
    const std::string& session_id,
    const std::shared_ptr<livekit::AudioSource>& audio_source,
    const std::shared_ptr<std::atomic_bool>& running) {
  captureLoopbackAudio(
      audio_source,
      process_id,
      PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
      session_id,
      "process",
      "include_target_process_tree",
      running);
}

void validateScreenLoopbackAudio(
    const ScreenCaptureTarget& target,
    DWORD excluded_process_id) {
  const bool process_audio = target.window;
  if (!process_audio && excluded_process_id == 0) {
    throw std::runtime_error("screen loopback requires excluded process id");
  }
  const DWORD process_id = process_audio ? target.process_id : excluded_process_id;
  const PROCESS_LOOPBACK_MODE mode = process_audio
      ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
      : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
  ComScope com;
  probeLoopbackClient(process_id, mode, 50);
}

ScreenAudioProbeResult runScreenLoopbackAudioProbe(
    const ScreenCaptureTarget& target,
    DWORD excluded_process_id,
    int duration_ms) {
  const bool process_audio = target.window;
  if (!process_audio && excluded_process_id == 0) {
    throw std::runtime_error("screen loopback requires excluded process id");
  }
  const DWORD process_id = process_audio ? target.process_id : excluded_process_id;
  const PROCESS_LOOPBACK_MODE mode = process_audio
      ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
      : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
  ComScope com;
  return probeLoopbackClient(process_id, mode, duration_ms);
}

void emitScreenAudioProbe(const StartCommand& command) {
  try {
    const ScreenCaptureTarget target = resolveScreenCaptureTarget(command.source_id);
    const bool source_audio_supported = !target.window || target.process_id != 0;
    const bool process_audio = target.window;
    const DWORD process_id = process_audio
        ? target.process_id
        : static_cast<DWORD>(command.exclude_process_id);
    const char* mode_name = process_audio ? "process" : "system_exclude";
    const char* loopback_mode_name = process_audio ? "include_target_process_tree" : "exclude_target_process_tree";

    if (!source_audio_supported) {
      emit("{\"type\":\"screen_audio_probe\",\"sourceId\":\"" +
           jsonEscape(command.source_id) +
           "\",\"ok\":false,\"audio_mode\":\"none\",\"reason\":\"missing_target_process\"}");
      return;
    }

    const auto probe = runScreenLoopbackAudioProbe(
        target,
        static_cast<DWORD>(command.exclude_process_id),
        std::min(std::max(50, command.duration_ms), 250));

    emit("{\"type\":\"screen_audio_probe\",\"sourceId\":\"" +
         jsonEscape(command.source_id) +
         "\",\"ok\":true,\"audio_mode\":\"" + std::string(mode_name) +
         "\",\"loopback_mode\":\"" + std::string(loopback_mode_name) +
         "\",\"peak_db\":" + std::to_string(probe.peak_db) +
         ",\"rms_db\":" + std::to_string(probe.rms_db) +
         ",\"sample_rate\":48000,\"channels\":2" +
         ",\"target_process_id\":" + std::to_string(process_id) + "}");
  } catch (const std::exception& error) {
    emit("{\"type\":\"screen_audio_probe\",\"sourceId\":\"" +
         jsonEscape(command.source_id) +
         "\",\"ok\":false,\"message\":\"" + jsonEscape(error.what()) + "\"}");
  }
}

}  // namespace syrnike::voice
