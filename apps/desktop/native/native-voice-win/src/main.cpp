#include <audioclient.h>
#include <avrt.h>
#include <mmdeviceapi.h>
#include <windows.h>
#include <wrl/client.h>

#include <atomic>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <memory>
#include <mutex>
#include <regex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "livekit/livekit.h"
#include "livekit/room_delegate.h"

using Microsoft::WRL::ComPtr;

namespace {

constexpr int kSampleRate = 48000;
constexpr int kChannels = 1;
constexpr int kSamplesPer10Ms = kSampleRate / 100;
constexpr REFERENCE_TIME kBufferDurationHns = 10000000;

std::atomic<bool> g_running{true};

struct StartCommand {
  std::string session_id;
  std::string device_id;
  std::string livekit_url;
  std::string livekit_token;
  std::string participant_identity;
  bool echo_cancellation = false;
  float input_volume = 1.0f;
};

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

std::string jsonEscape(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (char ch : value) {
    if (ch == '\\' || ch == '"') {
      out.push_back('\\');
    }
    out.push_back(ch);
  }
  return out;
}

void emit(const std::string& json) {
  std::cout << json << std::endl;
}

void emitError(const std::string& code, const std::string& message) {
  emit("{\"type\":\"error\",\"code\":\"" + jsonEscape(code) +
       "\",\"message\":\"" + jsonEscape(message) + "\"}");
}

std::string stringField(const std::string& json, const std::string& key) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
  std::smatch match;
  if (!std::regex_search(json, match, pattern)) return {};
  return match[1].str();
}

bool boolField(const std::string& json, const std::string& key) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(true|false)");
  std::smatch match;
  return std::regex_search(json, match, pattern) && match[1].str() == "true";
}

float numberField(const std::string& json, const std::string& key, float fallback) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)");
  std::smatch match;
  if (!std::regex_search(json, match, pattern)) return fallback;
  try {
    return std::stof(match[1].str());
  } catch (...) {
    return fallback;
  }
}

StartCommand parseStartCommand(const std::string& json) {
  StartCommand command;
  command.session_id = stringField(json, "sessionId");
  command.device_id = stringField(json, "deviceId");
  command.livekit_url = stringField(json, "url");
  command.livekit_token = stringField(json, "token");
  command.participant_identity = stringField(json, "participantIdentity");
  command.echo_cancellation = boolField(json, "echoCancellation");
  command.input_volume = numberField(json, "inputVolume", 1.0f);
  return command;
}

std::wstring widen(const std::string& value) {
  if (value.empty()) return {};
  const int count = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(count), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), count);
  return out;
}

std::string narrow(const std::wstring& value) {
  if (value.empty()) return {};
  const int count = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string out(static_cast<size_t>(count), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), count, nullptr, nullptr);
  return out;
}

ComPtr<IMMDevice> getCaptureDevice(const std::string& device_id) {
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
  if (FAILED(hr)) throw std::runtime_error("failed to create MMDeviceEnumerator");

  ComPtr<IMMDevice> device;
  if (!device_id.empty() && device_id != "default") {
    const std::wstring wide_id = widen(device_id);
    hr = enumerator->GetDevice(wide_id.c_str(), &device);
  } else {
    hr = enumerator->GetDefaultAudioEndpoint(eCapture, eCommunications, &device);
  }
  if (FAILED(hr) || !device) throw std::runtime_error("failed to open capture device");
  return device;
}

ComPtr<IMMDevice> getRenderDevice() {
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
  if (FAILED(hr)) throw std::runtime_error("failed to create MMDeviceEnumerator");

  ComPtr<IMMDevice> device;
  hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  if (FAILED(hr) || !device) throw std::runtime_error("failed to open render device");
  return device;
}

void emitDeviceList() {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool com_initialized = SUCCEEDED(hr);

  try {
    ComPtr<IMMDeviceEnumerator> enumerator;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
    if (FAILED(hr) || !enumerator) {
      throw std::runtime_error("failed to create MMDeviceEnumerator");
    }

    ComPtr<IMMDeviceCollection> collection;
    hr = enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &collection);
    if (FAILED(hr) || !collection) {
      throw std::runtime_error("failed to enumerate capture devices");
    }

    UINT count = 0;
    hr = collection->GetCount(&count);
    if (FAILED(hr)) {
      throw std::runtime_error("failed to read capture device count");
    }

    std::string json = "{\"type\":\"device_list\",\"devices\":[";
    bool first = true;
    for (UINT index = 0; index < count; ++index) {
      ComPtr<IMMDevice> device;
      hr = collection->Item(index, &device);
      if (FAILED(hr) || !device) continue;

      LPWSTR raw_id = nullptr;
      hr = device->GetId(&raw_id);
      if (FAILED(hr) || !raw_id) continue;

      const std::string id = narrow(raw_id);
      CoTaskMemFree(raw_id);

      const std::string label = "Microphone " + std::to_string(index + 1);

      if (!first) json += ",";
      first = false;
      json += "{\"deviceId\":\"" + jsonEscape(id) +
              "\",\"kind\":\"audioinput\",\"label\":\"" +
              jsonEscape(label) + "\"}";
    }
    json += "]}";
    emit(json);
  } catch (const std::exception& error) {
    emitError("device_list_failed", error.what());
  }

  if (com_initialized) CoUninitialize();
}

WAVEFORMATEX desiredCaptureFormat() {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = kChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = 32;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  return format;
}

WAVEFORMATEX desiredRenderFormat() {
  return desiredCaptureFormat();
}

std::int16_t clampToPcm16(float sample) {
  sample = std::max(-1.0f, std::min(1.0f, sample));
  return static_cast<std::int16_t>(std::lrint(sample * 32767.0f));
}

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
        const float sample = (flags & AUDCLNT_BUFFERFLAGS_SILENT) ? 0.0f : samples[index] * command.input_volume;
        frame.push_back(clampToPcm16(sample));
        if (frame.size() == kSamplesPer10Ms) {
          livekit::AudioFrame audio_frame(std::move(frame), kSampleRate, kChannels, kSamplesPer10Ms);
          audio_source->captureFrame(audio_frame);
          frame.clear();
          frame.reserve(kSamplesPer10Ms);
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

void runMicrophonePreview(const StartCommand& command) {
  g_running.store(true);

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
         "\"audio_sample_rate\":48000,\"audio_channels\":1,\"echo_cancellation\":\"windows\"}");
    emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
         "\",\"kind\":\"microphone\",\"status\":\"running\",\"audio_mode\":\"microphone\","
         "\"audio_sample_rate\":48000,\"audio_channels\":1,\"echo_cancellation\":\"windows\"}");

    std::vector<float> queued_samples;
    queued_samples.reserve(static_cast<size_t>(render_buffer_frames));

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
          const float sample = (flags & AUDCLNT_BUFFERFLAGS_SILENT)
            ? 0.0f
            : std::max(-1.0f, std::min(1.0f, samples[index] * command.input_volume));
          queued_samples.push_back(sample);
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

void runMicrophonePublisher(const StartCommand& command) {
  g_running.store(true);
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
  room_options.single_peer_connection = true;

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
       "\"audio_sample_rate\":48000,\"audio_channels\":1,\"echo_cancellation\":\"windows\","
       "\"native_participant_identity\":\"" + jsonEscape(native_identity) + "\"}");
  emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"kind\":\"microphone\",\"status\":\"running\",\"audio_mode\":\"microphone\","
       "\"audio_sample_rate\":48000,\"audio_channels\":1,\"echo_cancellation\":\"windows\"}");

  std::thread capture_thread(captureMicrophone, command, audio_source);

  std::string line;
  while (g_running.load() && std::getline(std::cin, line)) {
    if (line.find("\"cmd\":\"stop\"") != std::string::npos ||
        line.find("\"cmd\": \"stop\"") != std::string::npos) {
      g_running.store(false);
      break;
    }
  }

  if (capture_thread.joinable()) capture_thread.join();
  room.reset();
  livekit::shutdown();

  emit("{\"type\":\"session_lifecycle\",\"session_id\":\"" + jsonEscape(command.session_id) +
       "\",\"kind\":\"microphone\",\"status\":\"stopped\"}");
  emit("{\"type\":\"stopped\"}");
}

}  // namespace

int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.find("\"cmd\":\"list_devices\"") != std::string::npos ||
        line.find("\"cmd\": \"list_devices\"") != std::string::npos) {
      emitDeviceList();
      continue;
    }
    if (line.find("\"cmd\":\"start\"") != std::string::npos ||
        line.find("\"cmd\": \"start\"") != std::string::npos) {
      runMicrophonePublisher(parseStartCommand(line));
      return 0;
    }
    if (line.find("\"cmd\":\"start_preview\"") != std::string::npos ||
        line.find("\"cmd\": \"start_preview\"") != std::string::npos) {
      runMicrophonePreview(parseStartCommand(line));
      return 0;
    }
    if (line.find("\"cmd\":\"stop\"") != std::string::npos ||
        line.find("\"cmd\": \"stop\"") != std::string::npos) {
      return 0;
    }
  }
  return 0;
}
