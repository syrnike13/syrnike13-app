#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <endpointvolume.h>
#include <propkeydef.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mmdeviceapi.h>
#include <propvarutil.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "media/windows_audio_session_policy.hpp"

namespace {

using Microsoft::WRL::ComPtr;
using syrnike::desktop_native::media::applyWindowsAudioCategoryPolicy;
using syrnike::desktop_native::media::applyWindowsAudioDuckingPolicy;
using syrnike::desktop_native::media::windowsAudioCategoryName;
using syrnike::desktop_native::media::WindowsAudioPolicyOutcome;
using syrnike::desktop_native::media::WindowsAudioPolicyStatus;
using syrnike::desktop_native::media::windowsAudioPolicyStatusName;
using syrnike::desktop_native::media::WindowsAudioSessionUse;

constexpr auto kObservationDelay = std::chrono::milliseconds(250);
constexpr float kReferenceVolume = 0.5F;
constexpr float kVolumeTolerance = 0.0001F;
constexpr float kMinimumEffectiveSignal = 0.002F;
constexpr float kMinimumRetainedSignalRatio = 0.85F;
constexpr std::uint32_t kSampleRate = 48'000;
constexpr std::uint16_t kChannelCount = 2;
constexpr float kToneAmplitude = 0.08F;

void requireHr(HRESULT result, const char *message);

WAVEFORMATEX pcmFormat() noexcept {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_PCM;
  format.nChannels = kChannelCount;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = 16;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  return format;
}

class AudioClientActivationHandler final
    : public IActivateAudioInterfaceCompletionHandler,
      public IAgileObject {
public:
  AudioClientActivationHandler()
      : done_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
    if (!done_)
      throw std::runtime_error("create process-loopback activation event failed");
  }

  ~AudioClientActivationHandler() { CloseHandle(done_); }

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **object) override {
    if (!object)
      return E_POINTER;
    if (iid == __uuidof(IUnknown) ||
        iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *object = static_cast<IActivateAudioInterfaceCompletionHandler *>(this);
    } else if (iid == __uuidof(IAgileObject)) {
      *object = static_cast<IAgileObject *>(this);
    } else {
      *object = nullptr;
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }

  ULONG STDMETHODCALLTYPE AddRef() override {
    return static_cast<ULONG>(InterlockedIncrement(&references_));
  }

  ULONG STDMETHODCALLTYPE Release() override {
    const auto remaining =
        static_cast<ULONG>(InterlockedDecrement(&references_));
    if (remaining == 0)
      delete this;
    return remaining;
  }

  HRESULT STDMETHODCALLTYPE ActivateCompleted(
      IActivateAudioInterfaceAsyncOperation *operation) override {
    IUnknown *raw = nullptr;
    completion_result_ =
        operation->GetActivateResult(&activation_result_, &raw);
    if (SUCCEEDED(completion_result_) && SUCCEEDED(activation_result_) && raw) {
      completion_result_ = raw->QueryInterface(
          __uuidof(IAudioClient),
          reinterpret_cast<void **>(client_.GetAddressOf()));
    }
    if (raw)
      raw->Release();
    SetEvent(done_);
    return S_OK;
  }

  [[nodiscard]] ComPtr<IAudioClient> wait() {
    if (WaitForSingleObject(done_, 5'000) != WAIT_OBJECT_0)
      throw std::runtime_error("process-loopback activation timed out");
    requireHr(completion_result_, "complete process-loopback activation failed");
    requireHr(activation_result_, "activate process-loopback client failed");
    if (!client_)
      throw std::runtime_error("process-loopback activation returned no client");
    return client_;
  }

private:
  volatile LONG references_ = 1;
  HANDLE done_ = nullptr;
  HRESULT completion_result_ = E_FAIL;
  HRESULT activation_result_ = E_FAIL;
  ComPtr<IAudioClient> client_;
};

class DuckObserver final : public IAudioVolumeDuckNotification {
public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **object) override {
    if (!object)
      return E_POINTER;
    if (iid == __uuidof(IUnknown) ||
        iid == __uuidof(IAudioVolumeDuckNotification)) {
      *object = static_cast<IAudioVolumeDuckNotification *>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }

  ULONG STDMETHODCALLTYPE AddRef() override {
    return references_.fetch_add(1, std::memory_order_relaxed) + 1;
  }

  ULONG STDMETHODCALLTYPE Release() override {
    const auto remaining =
        references_.fetch_sub(1, std::memory_order_acq_rel) - 1;
    if (remaining == 0)
      delete this;
    return remaining;
  }

  HRESULT STDMETHODCALLTYPE OnVolumeDuckNotification(LPCWSTR,
                                                       UINT32) override {
    duck_count_.fetch_add(1, std::memory_order_relaxed);
    return S_OK;
  }

  HRESULT STDMETHODCALLTYPE OnVolumeUnduckNotification(LPCWSTR) override {
    unduck_count_.fetch_add(1, std::memory_order_relaxed);
    return S_OK;
  }

  [[nodiscard]] std::uint32_t duckCount() const noexcept {
    return duck_count_.load(std::memory_order_relaxed);
  }

  [[nodiscard]] std::uint32_t unduckCount() const noexcept {
    return unduck_count_.load(std::memory_order_relaxed);
  }

private:
  std::atomic<ULONG> references_{1};
  std::atomic<std::uint32_t> duck_count_{0};
  std::atomic<std::uint32_t> unduck_count_{0};
};

WindowsAudioPolicyOutcome applyReferenceGameMediaCategory(
    IAudioClient *client) noexcept {
  WindowsAudioPolicyOutcome outcome{
      .use = WindowsAudioSessionUse::RemotePlayback,
      .status = WindowsAudioPolicyStatus::Failed,
      .category = AudioCategory_GameMedia,
      .hresult = E_POINTER,
  };
  if (!client)
    return outcome;
  ComPtr<IAudioClient2> client2;
  outcome.hresult = client->QueryInterface(IID_PPV_ARGS(&client2));
  if (FAILED(outcome.hresult) || !client2) {
    outcome.status = WindowsAudioPolicyStatus::Unsupported;
    return outcome;
  }
  AudioClientProperties properties{};
  properties.cbSize = sizeof(properties);
  properties.eCategory = AudioCategory_GameMedia;
  outcome.hresult = client2->SetClientProperties(&properties);
  outcome.status = SUCCEEDED(outcome.hresult)
                       ? WindowsAudioPolicyStatus::Applied
                       : WindowsAudioPolicyStatus::Failed;
  return outcome;
}

void requireHr(HRESULT result, const char *message) {
  if (SUCCEEDED(result))
    return;
  std::ostringstream detail;
  detail << message << " (HRESULT=0x" << std::hex
         << static_cast<std::uint32_t>(result) << ')';
  throw std::runtime_error(detail.str());
}

class ComApartment final {
public:
  ComApartment() : result_(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {
    if (FAILED(result_) && result_ != RPC_E_CHANGED_MODE) {
      requireHr(result_, "initialize COM failed");
    }
  }
  ~ComApartment() {
    if (SUCCEEDED(result_))
      CoUninitialize();
  }
  ComApartment(const ComApartment &) = delete;
  ComApartment &operator=(const ComApartment &) = delete;

private:
  HRESULT result_;
};

std::string narrow(std::wstring_view value) {
  if (value.empty())
    return {};
  const auto size = WideCharToMultiByte(CP_UTF8, 0, value.data(),
                                        static_cast<int>(value.size()), nullptr,
                                        0, nullptr, nullptr);
  if (size <= 0)
    return {};
  std::string result(static_cast<std::size_t>(size), '\0');
  static_cast<void>(WideCharToMultiByte(CP_UTF8, 0, value.data(),
                                        static_cast<int>(value.size()),
                                        result.data(), size, nullptr, nullptr));
  return result;
}

std::string lower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](char character) {
    return static_cast<char>(
        std::tolower(static_cast<unsigned char>(character)));
  });
  return value;
}

std::string jsonEscape(std::string_view value) {
  std::string result;
  result.reserve(value.size() + 8);
  for (const auto character : value) {
    switch (character) {
    case '\\':
      result += "\\\\";
      break;
    case '"':
      result += "\\\"";
      break;
    case '\b':
      result += "\\b";
      break;
    case '\f':
      result += "\\f";
      break;
    case '\n':
      result += "\\n";
      break;
    case '\r':
      result += "\\r";
      break;
    case '\t':
      result += "\\t";
      break;
    default:
      if (static_cast<unsigned char>(character) < 0x20U) {
        std::ostringstream escaped;
        escaped << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                << static_cast<unsigned int>(
                       static_cast<unsigned char>(character));
        result += escaped.str();
      } else {
        result.push_back(character);
      }
      break;
    }
  }
  return result;
}

struct CoTaskMemFormat final {
  WAVEFORMATEX *value = nullptr;
  ~CoTaskMemFormat() { CoTaskMemFree(value); }
};

struct EndpointInfo final {
  std::wstring id;
  std::string name;
  std::string instance_id;
  EDataFlow flow = eRender;

  [[nodiscard]] bool bluetooth() const {
    const auto searchable = lower(name + " " + instance_id);
    return searchable.find("bth") != std::string::npos ||
           searchable.find("bluetooth") != std::string::npos ||
           searchable.find("hands-free") != std::string::npos ||
           searchable.find("headset") != std::string::npos;
  }
};

std::string propertyString(IPropertyStore *store, const PROPERTYKEY &key) {
  if (!store)
    return {};
  PROPVARIANT value;
  PropVariantInit(&value);
  const auto result = store->GetValue(key, &value);
  std::string text;
  if (SUCCEEDED(result) && value.vt == VT_LPWSTR && value.pwszVal) {
    text = narrow(value.pwszVal);
  }
  PropVariantClear(&value);
  return text;
}

class EndpointCatalog final {
public:
  EndpointCatalog() {
    requireHr(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
                               CLSCTX_ALL, IID_PPV_ARGS(&enumerator_)),
              "create MMDevice enumerator failed");
  }

  [[nodiscard]] ComPtr<IMMDevice>
  device(EDataFlow flow, const std::optional<std::wstring> &id) const {
    ComPtr<IMMDevice> result;
    if (id) {
      requireHr(enumerator_->GetDevice(id->c_str(), &result),
                "open explicit audio endpoint failed");
    } else {
      requireHr(
          enumerator_->GetDefaultAudioEndpoint(flow, eConsole, &result),
          "open default audio endpoint failed");
    }
    return result;
  }

  [[nodiscard]] std::vector<EndpointInfo> endpoints(EDataFlow flow) const {
    ComPtr<IMMDeviceCollection> collection;
    requireHr(
        enumerator_->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &collection),
        "enumerate active audio endpoints failed");
    UINT count = 0;
    requireHr(collection->GetCount(&count), "count audio endpoints failed");
    std::vector<EndpointInfo> result;
    result.reserve(count);
    for (UINT index = 0; index < count; ++index) {
      ComPtr<IMMDevice> item;
      requireHr(collection->Item(index, &item), "read audio endpoint failed");
      LPWSTR raw_id = nullptr;
      requireHr(item->GetId(&raw_id), "read audio endpoint id failed");
      std::wstring id = raw_id ? raw_id : L"";
      CoTaskMemFree(raw_id);
      ComPtr<IPropertyStore> properties;
      static_cast<void>(item->OpenPropertyStore(STGM_READ, &properties));
      result.push_back({
          .id = std::move(id),
          .name = propertyString(properties.Get(), PKEY_Device_FriendlyName),
          .instance_id =
              propertyString(properties.Get(), PKEY_Device_InstanceId),
          .flow = flow,
      });
    }
    return result;
  }

  [[nodiscard]] std::wstring defaultId(EDataFlow flow) const {
    auto endpoint = device(flow, std::nullopt);
    LPWSTR raw_id = nullptr;
    requireHr(endpoint->GetId(&raw_id),
              "read default audio endpoint id failed");
    std::wstring result = raw_id ? raw_id : L"";
    CoTaskMemFree(raw_id);
    return result;
  }

private:
  ComPtr<IMMDeviceEnumerator> enumerator_;
};

struct SignalWindow final {
  double squared_sum = 0.0;
  std::uint64_t sample_count = 0;
  float peak = 0.0F;

  [[nodiscard]] float rms() const noexcept {
    if (sample_count == 0)
      return 0.0F;
    return static_cast<float>(
        std::sqrt(squared_sum / static_cast<double>(sample_count)));
  }
};

class ProcessLoopbackSignal final {
public:
  explicit ProcessLoopbackSignal(DWORD process_id) {
    AUDIOCLIENT_ACTIVATION_PARAMS activation{};
    activation.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activation.ProcessLoopbackParams.TargetProcessId = process_id;
    activation.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT parameters;
    PropVariantInit(&parameters);
    parameters.vt = VT_BLOB;
    parameters.blob.cbSize = sizeof(activation);
    parameters.blob.pBlobData = reinterpret_cast<BYTE *>(&activation);

    auto *handler = new AudioClientActivationHandler();
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    const auto begin = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient),
        &parameters, handler, operation.GetAddressOf());
    if (FAILED(begin)) {
      handler->Release();
      requireHr(begin, "start process-loopback activation failed");
    }
    try {
      client_ = handler->wait();
    } catch (...) {
      handler->Release();
      throw;
    }
    handler->Release();

    format_ = pcmFormat();
    requireHr(client_->Initialize(
                  AUDCLNT_SHAREMODE_SHARED,
                  AUDCLNT_STREAMFLAGS_LOOPBACK |
                      AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                      AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                      AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                  0, 0, &format_, nullptr),
              "initialize process-loopback observation failed");
    event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!event_)
      throw std::runtime_error("create process-loopback sample event failed");
    requireHr(client_->SetEventHandle(event_),
              "set process-loopback sample event failed");
    requireHr(client_->GetService(IID_PPV_ARGS(&capture_)),
              "open process-loopback capture client failed");
    requireHr(client_->Start(), "start process-loopback observation failed");
    started_ = true;
  }

  ~ProcessLoopbackSignal() {
    if (started_)
      static_cast<void>(client_->Stop());
    if (event_)
      CloseHandle(event_);
  }

  ProcessLoopbackSignal(const ProcessLoopbackSignal &) = delete;
  ProcessLoopbackSignal &operator=(const ProcessLoopbackSignal &) = delete;

  void drain(SignalWindow &window) {
    UINT32 frames = 0;
    while (SUCCEEDED(capture_->GetNextPacketSize(&frames)) && frames != 0) {
      BYTE *data = nullptr;
      DWORD flags = 0;
      UINT64 device_position = 0;
      UINT64 qpc_position = 0;
      requireHr(capture_->GetBuffer(&data, &frames, &flags, &device_position,
                                    &qpc_position),
                "read process-loopback samples failed");
      const auto sample_count =
          static_cast<std::uint64_t>(frames) * format_.nChannels;
      if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0 && data) {
        const auto *samples = reinterpret_cast<const std::int16_t *>(data);
        for (std::uint64_t index = 0; index < sample_count; ++index) {
          const auto normalized =
              static_cast<float>(samples[index]) / 32'768.0F;
          window.squared_sum +=
              static_cast<double>(normalized) * normalized;
          window.peak = std::max(window.peak, std::fabs(normalized));
        }
      }
      window.sample_count += sample_count;
      requireHr(capture_->ReleaseBuffer(frames),
                "release process-loopback samples failed");
    }
  }

private:
  WAVEFORMATEX format_{};
  ComPtr<IAudioClient> client_;
  ComPtr<IAudioCaptureClient> capture_;
  HANDLE event_ = nullptr;
  bool started_ = false;
};

class AudioClientSession final {
public:
  enum class Kind { ReferenceRender, RemoteRender, Microphone, ScreenLoopback };

  AudioClientSession(const EndpointCatalog &catalog, Kind kind,
                     const std::optional<std::wstring> &endpoint_id)
      : kind_(kind),
        device_(catalog.device(kind == Kind::Microphone ? eCapture : eRender,
                               endpoint_id)) {
    requireHr(
        device_->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                          reinterpret_cast<void **>(client_.GetAddressOf())),
        "activate audio client failed");
  }

  AudioClientSession(const AudioClientSession &) = delete;
  AudioClientSession &operator=(const AudioClientSession &) = delete;

  ~AudioClientSession() {
    if (started_ && client_)
      static_cast<void>(client_->Stop());
    if (duck_observation_registered_ && duck_manager_ && duck_observer_)
      static_cast<void>(
          duck_manager_->UnregisterDuckNotification(duck_observer_.Get()));
    if (event_)
      CloseHandle(event_);
  }

  void start() {
    const auto use = policyUse();
    category_ = kind_ == Kind::ReferenceRender
                    ? applyReferenceGameMediaCategory(client_.Get())
                    : applyWindowsAudioCategoryPolicy(client_.Get(), use);
    CoTaskMemFormat format;
    requireHr(client_->GetMixFormat(&format.value),
              "read endpoint mix format failed");
    DWORD flags = 0;
    WAVEFORMATEX loopback_format{};
    WAVEFORMATEX render_format{};
    auto *selected_format = format.value;
    if (kind_ == Kind::ScreenLoopback) {
      flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
              AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
              AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
      loopback_format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
      loopback_format.nChannels = 2;
      loopback_format.nSamplesPerSec = 48'000;
      loopback_format.wBitsPerSample = 32;
      loopback_format.nBlockAlign =
          loopback_format.nChannels * loopback_format.wBitsPerSample / 8;
      loopback_format.nAvgBytesPerSec =
          loopback_format.nSamplesPerSec * loopback_format.nBlockAlign;
      selected_format = &loopback_format;
    } else if (kind_ == Kind::ReferenceRender ||
               kind_ == Kind::RemoteRender) {
      flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
              AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
      render_format = pcmFormat();
      selected_format = &render_format;
    }
    GUID session_id{};
    requireHr(CoCreateGuid(&session_id), "create audio session id failed");
    const auto loopback = kind_ == Kind::ScreenLoopback;
    requireHr(client_->Initialize(AUDCLNT_SHAREMODE_SHARED, flags,
                                  loopback ? 400'000 : 10'000'000, 0,
                                  selected_format,
                                  loopback ? nullptr : &session_id),
              "initialize audio policy matrix stream failed");
    if (loopback) {
      event_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);
      if (!event_)
        throw std::runtime_error("create loopback event failed");
      requireHr(client_->SetEventHandle(event_), "set loopback event failed");
    }
    if (kind_ == Kind::RemoteRender) {
      ducking_ = applyWindowsAudioDuckingPolicy(client_.Get(), use);
    }
    if (kind_ == Kind::ReferenceRender || kind_ == Kind::RemoteRender) {
      requireHr(client_->GetService(IID_PPV_ARGS(&render_)),
                "open matrix render client failed");
      requireHr(client_->GetBufferSize(&buffer_frames_),
                "read matrix render capacity failed");
      pump();
    } else {
      requireHr(client_->GetService(IID_PPV_ARGS(&capture_)),
                "open matrix capture client failed");
    }
    if (kind_ == Kind::ReferenceRender) {
      registerDuckObservation();
    }
    requireHr(client_->Start(), "start audio policy matrix stream failed");
    started_ = true;
  }

  [[nodiscard]] WindowsAudioPolicyOutcome category() const { return category_; }
  [[nodiscard]] WindowsAudioPolicyOutcome ducking() const { return ducking_; }

  [[nodiscard]] bool duckObservationRegistered() const noexcept {
    return duck_observation_registered_;
  }

  [[nodiscard]] std::uint32_t duckCount() const noexcept {
    return duck_observer_ ? duck_observer_->duckCount() : 0;
  }

  [[nodiscard]] std::uint32_t unduckCount() const noexcept {
    return duck_observer_ ? duck_observer_->unduckCount() : 0;
  }

  [[nodiscard]] bool unregisterDuckObservation() noexcept {
    if (!duck_observation_registered_)
      return true;
    const auto outcome =
        duck_manager_->UnregisterDuckNotification(duck_observer_.Get());
    if (SUCCEEDED(outcome))
      duck_observation_registered_ = false;
    return SUCCEEDED(outcome);
  }

  void pump() {
    if (render_) {
      UINT32 padding = 0;
      requireHr(client_->GetCurrentPadding(&padding),
                "read matrix render padding failed");
      const auto available = buffer_frames_ - padding;
      if (available == 0)
        return;
      BYTE *buffer = nullptr;
      requireHr(render_->GetBuffer(available, &buffer),
                "reserve matrix render buffer failed");
      if (kind_ == Kind::ReferenceRender) {
        auto *samples = reinterpret_cast<std::int16_t *>(buffer);
        constexpr double kPi = 3.14159265358979323846;
        constexpr double kFrequency = 440.0;
        for (UINT32 frame = 0; frame < available; ++frame) {
          const auto phase = 2.0 * kPi * kFrequency *
                             static_cast<double>(tone_frame_ + frame) /
                             static_cast<double>(kSampleRate);
          const auto sample = static_cast<std::int16_t>(
              std::sin(phase) * kToneAmplitude * 32'767.0);
          for (std::uint16_t channel = 0; channel < kChannelCount; ++channel)
            samples[static_cast<std::size_t>(frame) * kChannelCount + channel] =
                sample;
        }
        tone_frame_ += available;
        requireHr(render_->ReleaseBuffer(available, 0),
                  "commit reference GameMedia tone failed");
      } else {
        requireHr(
            render_->ReleaseBuffer(available, AUDCLNT_BUFFERFLAGS_SILENT),
            "commit silent remote render buffer failed");
      }
      return;
    }
    if (!capture_)
      return;
    UINT32 frames = 0;
    while (SUCCEEDED(capture_->GetNextPacketSize(&frames)) && frames != 0) {
      BYTE *buffer = nullptr;
      DWORD flags = 0;
      UINT64 device_position = 0;
      UINT64 qpc_position = 0;
      requireHr(capture_->GetBuffer(&buffer, &frames, &flags, &device_position,
                                    &qpc_position),
                "drain matrix capture buffer failed");
      requireHr(capture_->ReleaseBuffer(frames),
                "release matrix capture buffer failed");
    }
  }

  [[nodiscard]] ComPtr<ISimpleAudioVolume> simpleVolume() const {
    ComPtr<ISimpleAudioVolume> volume;
    requireHr(client_->GetService(IID_PPV_ARGS(&volume)),
              "open simple audio volume failed");
    return volume;
  }

  [[nodiscard]] std::uint32_t verifyMuteRoundTrip() const {
    const auto volume = simpleVolume();
    requireHr(volume->SetMute(TRUE, nullptr), "mute matrix session failed");
    BOOL muted = FALSE;
    requireHr(volume->GetMute(&muted), "read muted matrix session failed");
    if (!muted)
      throw std::runtime_error("matrix session did not enter muted state");
    requireHr(volume->SetMute(FALSE, nullptr), "unmute matrix session failed");
    muted = TRUE;
    requireHr(volume->GetMute(&muted), "read unmuted matrix session failed");
    if (muted)
      throw std::runtime_error("matrix session did not leave muted state");
    return 2;
  }

  [[nodiscard]] float endpointVolume() const {
    ComPtr<IAudioEndpointVolume> volume;
    requireHr(
        device_->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, nullptr,
                          reinterpret_cast<void **>(volume.GetAddressOf())),
        "open endpoint volume failed");
    float result = 0.0F;
    requireHr(volume->GetMasterVolumeLevelScalar(&result),
              "read endpoint master volume failed");
    return result;
  }

private:
  void registerDuckObservation() {
    ComPtr<IAudioSessionControl> session_control;
    requireHr(client_->GetService(IID_PPV_ARGS(&session_control)),
              "open reference session control failed");
    ComPtr<IAudioSessionControl2> session_control2;
    requireHr(session_control.As(&session_control2),
              "open reference session control2 failed");
    LPWSTR session_instance = nullptr;
    requireHr(session_control2->GetSessionInstanceIdentifier(&session_instance),
              "read reference session instance id failed");
    const std::unique_ptr<wchar_t, decltype(&CoTaskMemFree)> session_guard(
        session_instance, &CoTaskMemFree);
    requireHr(device_->Activate(
                  __uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                  reinterpret_cast<void **>(duck_manager_.GetAddressOf())),
              "open reference audio session manager failed");
    duck_observer_.Attach(new DuckObserver());
    requireHr(duck_manager_->RegisterDuckNotification(session_instance,
                                                       duck_observer_.Get()),
              "register reference duck notification failed");
    duck_observation_registered_ = true;
  }

  [[nodiscard]] WindowsAudioSessionUse policyUse() const {
    switch (kind_) {
    case Kind::ReferenceRender:
    case Kind::RemoteRender:
      return WindowsAudioSessionUse::RemotePlayback;
    case Kind::Microphone:
      return WindowsAudioSessionUse::MicrophoneCapture;
    case Kind::ScreenLoopback:
      return WindowsAudioSessionUse::ScreenLoopbackCapture;
    }
    return WindowsAudioSessionUse::RemotePlayback;
  }

  Kind kind_;
  ComPtr<IMMDevice> device_;
  ComPtr<IAudioClient> client_;
  ComPtr<IAudioRenderClient> render_;
  ComPtr<IAudioCaptureClient> capture_;
  ComPtr<IAudioSessionManager2> duck_manager_;
  ComPtr<DuckObserver> duck_observer_;
  HANDLE event_ = nullptr;
  UINT32 buffer_frames_ = 0;
  std::uint64_t tone_frame_ = 0;
  bool started_ = false;
  bool duck_observation_registered_ = false;
  WindowsAudioPolicyOutcome category_{};
  WindowsAudioPolicyOutcome ducking_{};
};

constexpr std::uint32_t kUtilityProbeMagic = 0x5341504DU;
constexpr std::uint32_t kUtilityProbeVersion = 1;

struct UtilityProbeWire final {
  std::uint32_t magic = kUtilityProbeMagic;
  std::uint32_t version = kUtilityProbeVersion;
  std::uint32_t process_id = 0;
  std::uint32_t passed = 0;
  std::uint32_t generations = 0;
  std::uint32_t category_applications = 0;
  std::uint32_t ducking_applications = 0;
  std::uint32_t mute_transitions = 0;
};

std::wstring utilityEventName(std::wstring_view prefix,
                              std::wstring_view phase,
                              std::uint32_t generation) {
  return std::wstring(prefix) + L"-" + std::wstring(phase) + L"-" +
         std::to_wstring(generation);
}

void writeUtilityProbeWire(const std::filesystem::path &path,
                           const UtilityProbeWire &wire) {
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  if (!output)
    throw std::runtime_error("open utility probe result failed");
  output.write(reinterpret_cast<const char *>(&wire), sizeof(wire));
  if (!output)
    throw std::runtime_error("write utility probe result failed");
}

std::vector<std::unique_ptr<AudioClientSession>> createTargetSessions(
    const EndpointCatalog &catalog, std::string_view mode,
    const std::optional<std::wstring> &render_id,
    const std::optional<std::wstring> &capture_id,
    UtilityProbeWire &wire) {
  std::vector<std::unique_ptr<AudioClientSession>> targets;
  const auto add = [&](AudioClientSession::Kind kind,
                       const std::optional<std::wstring> &id) {
    auto target = std::make_unique<AudioClientSession>(catalog, kind, id);
    target->start();
    if (target->category().status != WindowsAudioPolicyStatus::Applied)
      throw std::runtime_error("utility target category policy failed");
    ++wire.category_applications;
    if (kind == AudioClientSession::Kind::RemoteRender) {
      if (target->category().category != AudioCategory_GameChat)
        throw std::runtime_error("utility remote render did not use GameChat");
      if (target->ducking().status != WindowsAudioPolicyStatus::Applied)
        throw std::runtime_error("utility remote duck opt-out failed");
      ++wire.ducking_applications;
    } else if (target->category().category != AudioCategory_Other) {
      throw std::runtime_error("utility capture did not use Other category");
    }
    wire.mute_transitions += target->verifyMuteRoundTrip();
    targets.push_back(std::move(target));
  };

  if (mode == "warm_microphone" || mode == "combined")
    add(AudioClientSession::Kind::Microphone, capture_id);
  if (mode == "remote_render" || mode == "combined")
    add(AudioClientSession::Kind::RemoteRender, render_id);
  if (mode == "screen_audio" || mode == "combined")
    add(AudioClientSession::Kind::ScreenLoopback, render_id);
  if (targets.empty())
    throw std::invalid_argument("unknown utility audio mode");
  return targets;
}

int runUtilityProbe(std::string mode,
                    const std::optional<std::wstring> &render_id,
                    const std::optional<std::wstring> &capture_id,
                    std::wstring_view event_prefix,
                    const std::filesystem::path &result_path) {
  UtilityProbeWire wire{.process_id = GetCurrentProcessId()};
  try {
    EndpointCatalog catalog;
    for (std::uint32_t generation = 0; generation < 2; ++generation) {
      auto targets = createTargetSessions(catalog, mode, render_id, capture_id,
                                          wire);
      const auto ready_name =
          utilityEventName(event_prefix, L"ready", generation);
      const auto continue_name =
          utilityEventName(event_prefix, L"continue", generation);
      const HANDLE ready =
          OpenEventW(EVENT_MODIFY_STATE, FALSE, ready_name.c_str());
      const HANDLE proceed =
          OpenEventW(SYNCHRONIZE, FALSE, continue_name.c_str());
      if (!ready || !proceed) {
        if (ready)
          CloseHandle(ready);
        if (proceed)
          CloseHandle(proceed);
        throw std::runtime_error("open utility lifecycle events failed");
      }
      if (!SetEvent(ready)) {
        CloseHandle(ready);
        CloseHandle(proceed);
        throw std::runtime_error("signal utility generation ready failed");
      }
      CloseHandle(ready);

      const auto deadline =
          std::chrono::steady_clock::now() + std::chrono::seconds(5);
      for (;;) {
        const auto wait = WaitForSingleObject(proceed, 0);
        if (wait == WAIT_OBJECT_0)
          break;
        if (wait != WAIT_TIMEOUT) {
          CloseHandle(proceed);
          throw std::runtime_error("wait for utility generation failed");
        }
        for (const auto &target : targets)
          target->pump();
        if (std::chrono::steady_clock::now() >= deadline) {
          CloseHandle(proceed);
          throw std::runtime_error("utility generation release timed out");
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
      CloseHandle(proceed);
      targets.clear();
      ++wire.generations;
    }
    wire.passed = 1;
    writeUtilityProbeWire(result_path, wire);
    return 0;
  } catch (...) {
    try {
      writeUtilityProbeWire(result_path, wire);
    } catch (...) {
    }
    throw;
  }
}

struct ScenarioResult final {
  std::string mode;
  std::string endpoint;
  std::string status = "pass";
  std::string reason;
  float system_before = 0.0F;
  float system_after = 0.0F;
  float reference_before = 0.0F;
  float reference_after = 0.0F;
  std::string microphone_category;
  std::string screen_category;
  std::string render_ducking;
  bool duck_observation_registered = false;
  bool duck_observation_unregistered = false;
  bool effective_signal_observed = false;
  std::uint32_t duck_notifications = 0;
  std::uint32_t unduck_notifications = 0;
  float effective_signal_before = 0.0F;
  float effective_signal_during = 0.0F;
  float retained_signal_ratio = 0.0F;
  std::uint32_t utility_epochs = 0;
  std::uint32_t endpoint_recreations = 0;
  std::uint32_t mute_transitions = 0;
  std::uint32_t client_generations = 0;
  std::uint32_t category_applications = 0;
  std::uint32_t ducking_applications = 0;
  std::array<std::uint32_t, 2> utility_process_ids{};
};

bool sameVolume(float left, float right) {
  return std::fabs(left - right) <= kVolumeTolerance;
}

bool applied(const WindowsAudioPolicyOutcome &outcome) {
  return outcome.status == WindowsAudioPolicyStatus::Applied;
}

SignalWindow observeSignal(
    ProcessLoopbackSignal &capture, AudioClientSession &reference,
    const std::vector<std::unique_ptr<AudioClientSession>> &targets,
    std::chrono::milliseconds duration) {
  SignalWindow window;
  const auto deadline = std::chrono::steady_clock::now() + duration;
  while (std::chrono::steady_clock::now() < deadline) {
    reference.pump();
    for (const auto &target : targets)
      target->pump();
    capture.drain(window);
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  capture.drain(window);
  return window;
}

class ChildProcess final {
public:
  explicit ChildProcess(HANDLE process) : process_(process) {}
  ~ChildProcess() {
    if (!process_)
      return;
    DWORD exit_code = 0;
    if (GetExitCodeProcess(process_, &exit_code) && exit_code == STILL_ACTIVE) {
      static_cast<void>(TerminateProcess(process_, ERROR_TIMEOUT));
      static_cast<void>(WaitForSingleObject(process_, 1'000));
    }
    CloseHandle(process_);
  }

  ChildProcess(const ChildProcess &) = delete;
  ChildProcess &operator=(const ChildProcess &) = delete;

  [[nodiscard]] HANDLE get() const noexcept { return process_; }

private:
  HANDLE process_ = nullptr;
};

struct TemporaryFile final {
  std::filesystem::path path;
  ~TemporaryFile() {
    if (!path.empty())
      static_cast<void>(DeleteFileW(path.c_str()));
  }
};

std::wstring quoteCommandArgument(std::wstring_view argument) {
  std::wstring result(1, L'"');
  std::size_t backslashes = 0;
  for (const wchar_t character : argument) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'"') {
      result.append(backslashes * 2 + 1, L'\\');
      result.push_back(character);
      backslashes = 0;
      continue;
    }
    result.append(backslashes, L'\\');
    backslashes = 0;
    result.push_back(character);
  }
  result.append(backslashes * 2, L'\\');
  result.push_back(L'"');
  return result;
}

std::filesystem::path utilityResultPath(std::uint32_t sequence) {
  std::array<wchar_t, MAX_PATH + 1> temporary_directory{};
  const auto length = GetTempPathW(static_cast<DWORD>(temporary_directory.size()),
                                   temporary_directory.data());
  if (length == 0 || length >= temporary_directory.size())
    throw std::runtime_error("resolve utility probe temporary directory failed");
  return std::filesystem::path(temporary_directory.data()) /
         (L"syrnike-audio-policy-" + std::to_wstring(GetCurrentProcessId()) +
          L"-" + std::to_wstring(sequence) + L".bin");
}

std::filesystem::path currentExecutablePath() {
  std::vector<wchar_t> buffer(32'768);
  const auto length = GetModuleFileNameW(nullptr, buffer.data(),
                                         static_cast<DWORD>(buffer.size()));
  if (length == 0 || length >= buffer.size())
    throw std::runtime_error("resolve matrix executable path failed");
  return std::filesystem::path(std::wstring(buffer.data(), length));
}

struct UtilityEpochEvidence final {
  UtilityProbeWire wire{};
  float minimum_effective_signal = 0.0F;
};

UtilityEpochEvidence runUtilityEpoch(
    ProcessLoopbackSignal &signal, AudioClientSession &reference,
    std::string_view mode, const std::optional<std::wstring> &render_id,
    const std::optional<std::wstring> &capture_id,
    std::uint32_t sequence) {
  const auto prefix =
      L"Local\\SyrnikeAudioPolicyMatrix-" +
      std::to_wstring(GetCurrentProcessId()) + L"-" +
      std::to_wstring(sequence);
  std::array<HANDLE, 2> ready_events{};
  std::array<HANDLE, 2> continue_events{};
  const auto close_events = [&] {
    for (auto handle : ready_events) {
      if (handle)
        CloseHandle(handle);
    }
    for (auto handle : continue_events) {
      if (handle)
        CloseHandle(handle);
    }
  };
  for (std::uint32_t generation = 0; generation < 2; ++generation) {
    const auto ready_name = utilityEventName(prefix, L"ready", generation);
    const auto continue_name =
        utilityEventName(prefix, L"continue", generation);
    ready_events[generation] =
        CreateEventW(nullptr, TRUE, FALSE, ready_name.c_str());
    continue_events[generation] =
        CreateEventW(nullptr, TRUE, FALSE, continue_name.c_str());
    if (!ready_events[generation] || !continue_events[generation]) {
      close_events();
      throw std::runtime_error("create utility lifecycle events failed");
    }
  }

  TemporaryFile result_file{utilityResultPath(sequence)};
  const auto executable = currentExecutablePath();
  const auto mode_wide = std::wstring(mode.begin(), mode.end());
  const auto render_argument = render_id.value_or(L"-");
  const auto capture_argument = capture_id.value_or(L"-");
  std::wstring command = quoteCommandArgument(executable.native()) +
                         L" --utility-probe " +
                         quoteCommandArgument(mode_wide) + L" " +
                         quoteCommandArgument(render_argument) + L" " +
                         quoteCommandArgument(capture_argument) + L" " +
                         quoteCommandArgument(prefix) + L" " +
                         quoteCommandArgument(result_file.path.native());
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process_info{};
  if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE,
                      CREATE_NO_WINDOW, nullptr, nullptr, &startup,
                      &process_info)) {
    close_events();
    throw std::runtime_error("launch utility audio policy probe failed");
  }
  CloseHandle(process_info.hThread);
  ChildProcess child(process_info.hProcess);

  try {
    std::vector<std::unique_ptr<AudioClientSession>> no_local_targets;
    float minimum_signal = std::numeric_limits<float>::max();
    for (std::uint32_t generation = 0; generation < 2; ++generation) {
      SignalWindow startup_samples;
      const auto ready_deadline =
          std::chrono::steady_clock::now() + std::chrono::seconds(5);
      for (;;) {
        const auto ready_wait =
            WaitForSingleObject(ready_events[generation], 0);
        if (ready_wait == WAIT_OBJECT_0)
          break;
        if (ready_wait != WAIT_TIMEOUT)
          throw std::runtime_error("wait for utility readiness failed");
        reference.pump();
        signal.drain(startup_samples);
        const auto child_wait = WaitForSingleObject(child.get(), 0);
        if (child_wait == WAIT_OBJECT_0)
          throw std::runtime_error("utility audio policy probe exited early");
        if (child_wait != WAIT_TIMEOUT)
          throw std::runtime_error("query utility process state failed");
        if (std::chrono::steady_clock::now() >= ready_deadline)
          throw std::runtime_error("utility audio policy probe ready timed out");
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
      const auto observed = observeSignal(signal, reference, no_local_targets,
                                          kObservationDelay);
      minimum_signal = std::min(minimum_signal, observed.rms());
      if (!SetEvent(continue_events[generation]))
        throw std::runtime_error("release utility generation failed");
    }

    SignalWindow shutdown_samples;
    const auto exit_deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(5);
    for (;;) {
      const auto exit_wait = WaitForSingleObject(child.get(), 0);
      if (exit_wait == WAIT_OBJECT_0)
        break;
      if (exit_wait != WAIT_TIMEOUT)
        throw std::runtime_error("wait for utility shutdown failed");
      reference.pump();
      signal.drain(shutdown_samples);
      if (std::chrono::steady_clock::now() >= exit_deadline)
        throw std::runtime_error("utility audio policy probe shutdown timed out");
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    DWORD exit_code = 0;
    if (!GetExitCodeProcess(child.get(), &exit_code) || exit_code != 0)
      throw std::runtime_error("utility audio policy probe failed");

    std::ifstream input(result_file.path, std::ios::binary);
    UtilityProbeWire wire;
    input.read(reinterpret_cast<char *>(&wire), sizeof(wire));
    if (!input || wire.magic != kUtilityProbeMagic ||
        wire.version != kUtilityProbeVersion || wire.passed != 1 ||
        wire.process_id == GetCurrentProcessId() || wire.generations != 2)
      throw std::runtime_error("utility audio policy probe evidence invalid");
    const auto target_count = mode == "combined" ? 3U : 1U;
    const auto expected_ducking =
        mode == "remote_render" || mode == "combined" ? 2U : 0U;
    if (wire.category_applications != target_count * 2 ||
        wire.ducking_applications != expected_ducking ||
        wire.mute_transitions != target_count * 4)
      throw std::runtime_error("utility lifecycle evidence was incomplete");
    close_events();
    return {.wire = wire, .minimum_effective_signal = minimum_signal};
  } catch (...) {
    close_events();
    throw;
  }
}

ScenarioResult runScenario(const EndpointCatalog &catalog, std::string mode,
                           std::string endpoint,
                           const std::optional<std::wstring> &render_id,
                           const std::optional<std::wstring> &capture_id) {
  ScenarioResult result{.mode = std::move(mode),
                        .endpoint = std::move(endpoint)};
  try {
    ProcessLoopbackSignal signal(GetCurrentProcessId());
    AudioClientSession reference(
        catalog, AudioClientSession::Kind::ReferenceRender, render_id);
    reference.start();
    if (!applied(reference.category()) ||
        reference.category().category != AudioCategory_GameMedia) {
      throw std::runtime_error(
          "reference competitor is not a real GameMedia session");
    }
    auto reference_volume = reference.simpleVolume();
    requireHr(reference_volume->SetMasterVolume(kReferenceVolume, nullptr),
              "set reference session volume failed");
    requireHr(reference_volume->SetMute(FALSE, nullptr),
              "unmute reference session failed");
    result.duck_observation_registered =
        reference.duckObservationRegistered();
    result.system_before = reference.endpointVolume();
    requireHr(reference_volume->GetMasterVolume(&result.reference_before),
              "read reference session volume failed");

    std::vector<std::unique_ptr<AudioClientSession>> no_local_targets;
    static_cast<void>(observeSignal(signal, reference, no_local_targets,
                                    std::chrono::milliseconds(150)));
    const auto before =
        observeSignal(signal, reference, no_local_targets, kObservationDelay);
    result.effective_signal_before = before.rms();
    static std::atomic<std::uint32_t> utility_sequence{1};
    const auto first = runUtilityEpoch(
        signal, reference, result.mode, render_id, capture_id,
        utility_sequence.fetch_add(1, std::memory_order_relaxed));
    const auto second = runUtilityEpoch(
        signal, reference, result.mode, render_id, capture_id,
        utility_sequence.fetch_add(1, std::memory_order_relaxed));
    result.utility_epochs = 2;
    result.utility_process_ids = {first.wire.process_id, second.wire.process_id};
    result.endpoint_recreations = 2;
    result.mute_transitions =
        first.wire.mute_transitions + second.wire.mute_transitions;
    result.client_generations =
        first.wire.generations + second.wire.generations;
    result.category_applications = first.wire.category_applications +
                                   second.wire.category_applications;
    result.ducking_applications = first.wire.ducking_applications +
                                  second.wire.ducking_applications;
    result.effective_signal_during =
        std::min(first.minimum_effective_signal,
                 second.minimum_effective_signal);
    if (result.mode == "warm_microphone" || result.mode == "combined")
      result.microphone_category = "other";
    if (result.mode == "remote_render" || result.mode == "combined")
      result.render_ducking = "applied";
    if (result.mode == "screen_audio" || result.mode == "combined")
      result.screen_category = "other";
    if (result.effective_signal_before > 0.0F) {
      result.retained_signal_ratio = result.effective_signal_during /
                                     result.effective_signal_before;
    }
    result.duck_notifications = reference.duckCount();
    result.unduck_notifications = reference.unduckCount();
    result.duck_observation_unregistered =
        reference.unregisterDuckObservation();
    result.effective_signal_observed =
        result.effective_signal_before >= kMinimumEffectiveSignal &&
        result.retained_signal_ratio >= kMinimumRetainedSignalRatio &&
        result.duck_notifications == 0;
    result.system_after = reference.endpointVolume();
    requireHr(reference_volume->GetMasterVolume(&result.reference_after),
              "read final reference session volume failed");
    if (!sameVolume(result.system_before, result.system_after) ||
        !sameVolume(result.reference_before, result.reference_after)) {
      throw std::runtime_error(
          "another audio session changed reference volume");
    }
    if (!result.duck_observation_registered ||
        !result.duck_observation_unregistered ||
        !result.effective_signal_observed) {
      throw std::runtime_error(
          "GameMedia reference signal or duck-observer proof failed");
    }
    if (result.utility_epochs != 2 || result.endpoint_recreations < 2 ||
        result.mute_transitions < 4) {
      throw std::runtime_error(
          "utility restart, endpoint recreation, or mute lifecycle was not exercised");
    }
  } catch (const std::exception &error) {
    result.status = "failed";
    result.reason = error.what();
  }
  return result;
}

std::string scenarioJson(const ScenarioResult &scenario) {
  std::ostringstream json;
  json << std::fixed << std::setprecision(6) << "{\"mode\":\""
       << jsonEscape(scenario.mode) << "\",\"endpoint\":\""
       << jsonEscape(scenario.endpoint) << "\",\"status\":\""
       << jsonEscape(scenario.status) << '"';
  if (!scenario.reason.empty()) {
    json << ",\"reason\":\"" << jsonEscape(scenario.reason) << '"';
  }
  json << ",\"systemVolumeBefore\":" << scenario.system_before
       << ",\"systemVolumeAfter\":" << scenario.system_after
       << ",\"referenceSessionVolumeBefore\":" << scenario.reference_before
       << ",\"referenceSessionVolumeAfter\":" << scenario.reference_after
       << ",\"duckObservationRegistered\":"
       << (scenario.duck_observation_registered ? "true" : "false")
       << ",\"duckObservationUnregistered\":"
       << (scenario.duck_observation_unregistered ? "true" : "false")
       << ",\"duckNotifications\":" << scenario.duck_notifications
       << ",\"unduckNotifications\":" << scenario.unduck_notifications
       << ",\"effectiveSignalBefore\":" << scenario.effective_signal_before
       << ",\"effectiveSignalDuring\":" << scenario.effective_signal_during
       << ",\"retainedSignalRatio\":" << scenario.retained_signal_ratio
       << ",\"defaultEndpointRole\":\"console\""
       << ",\"referenceCategory\":\"game_media\""
       << ",\"utilityEpochs\":" << scenario.utility_epochs
       << ",\"utilityProcessIds\":[" << scenario.utility_process_ids[0]
       << ',' << scenario.utility_process_ids[1] << ']'
       << ",\"endpointRecreations\":" << scenario.endpoint_recreations
       << ",\"clientGenerations\":" << scenario.client_generations
       << ",\"categoryPolicyApplications\":"
       << scenario.category_applications
       << ",\"duckingPolicyApplications\":"
       << scenario.ducking_applications
       << ",\"muteTransitions\":" << scenario.mute_transitions;
  if (!scenario.microphone_category.empty()) {
    json << ",\"microphoneCaptureCategory\":\""
         << jsonEscape(scenario.microphone_category) << '"';
  }
  if (!scenario.screen_category.empty()) {
    json << ",\"screenCaptureCategory\":\""
         << jsonEscape(scenario.screen_category) << '"';
  }
  if (!scenario.render_ducking.empty()) {
    json << ",\"renderDuckingOptOut\":\"" << jsonEscape(scenario.render_ducking)
         << '"';
  }
  json << '}';
  return json.str();
}

std::optional<std::wstring>
firstExplicit(const std::vector<EndpointInfo> &endpoints,
              std::wstring_view default_id) {
  if (endpoints.empty())
    return std::nullopt;
  const auto alternate = std::find_if(
      endpoints.begin(), endpoints.end(),
      [&](const EndpointInfo &endpoint) { return endpoint.id != default_id; });
  if (alternate != endpoints.end())
    return alternate->id;
  return endpoints.front().id;
}

std::optional<std::wstring>
firstBluetooth(const std::vector<EndpointInfo> &endpoints) {
  const auto found = std::find_if(
      endpoints.begin(), endpoints.end(),
      [](const EndpointInfo &endpoint) { return endpoint.bluetooth(); });
  if (found == endpoints.end())
    return std::nullopt;
  return found->id;
}

std::string matrixJson(const std::vector<ScenarioResult> &scenarios,
                       const std::optional<ScenarioResult> &bluetooth,
                       bool restart_passed, std::string_view bluetooth_reason) {
  std::ostringstream json;
  json << "{\"schema\":\"syrnike.windows-audio-policy-matrix\",\"version\":1,"
          "\"proof\":\"wasapi_game_media_duck_observer\",\"scenarios\":[";
  for (std::size_t index = 0; index < scenarios.size(); ++index) {
    if (index != 0)
      json << ',';
    json << scenarioJson(scenarios[index]);
  }
  json << "],\"bluetooth\":{";
  if (bluetooth) {
    json << "\"available\":true,\"status\":\""
         << (bluetooth->status == "pass" ? "pass" : "failed") << '"';
    if (!bluetooth->reason.empty()) {
      json << ",\"reason\":\"" << jsonEscape(bluetooth->reason) << '"';
    }
  } else {
    json << "\"available\":false,\"status\":\"blocked\","
            "\"reasonCode\":\"bluetooth_endpoint_pair_absent\",\"reason\":\""
         << jsonEscape(bluetooth_reason) << '"';
  }
  json << "},\"runtimeRestart\":{\"status\":\""
       << (restart_passed ? "pass" : "failed")
       << "\",\"policiesReapplied\":" << (restart_passed ? "true" : "false")
       << ",\"processIsolated\":" << (restart_passed ? "true" : "false")
       << ",\"hostKind\":\"native_wasapi_probe\""
       << ",\"utilityEpochsPerScenario\":2"
       << "}}";
  return json.str();
}

} // namespace

int wmain(int argc, wchar_t **argv) try {
  [[maybe_unused]] const ComApartment com;
  if (argc == 7 && std::wstring_view(argv[1]) == L"--utility-probe") {
    const auto render_id = std::wstring_view(argv[3]) == L"-"
                               ? std::optional<std::wstring>{}
                               : std::optional<std::wstring>{argv[3]};
    const auto capture_id = std::wstring_view(argv[4]) == L"-"
                                ? std::optional<std::wstring>{}
                                : std::optional<std::wstring>{argv[4]};
    return runUtilityProbe(narrow(argv[2]), render_id, capture_id, argv[5],
                           std::filesystem::path(argv[6]));
  }
  EndpointCatalog catalog;
  const auto render_endpoints = catalog.endpoints(eRender);
  const auto capture_endpoints = catalog.endpoints(eCapture);
  if (render_endpoints.empty() || capture_endpoints.empty()) {
    throw std::runtime_error(
        "active render and capture endpoints are required");
  }
  const auto explicit_render =
      firstExplicit(render_endpoints, catalog.defaultId(eRender));
  const auto explicit_capture =
      firstExplicit(capture_endpoints, catalog.defaultId(eCapture));
  std::vector<ScenarioResult> scenarios;
  for (const auto &endpoint :
       {std::string("default"), std::string("explicit")}) {
    const auto render_id = endpoint == "explicit"
                               ? explicit_render
                               : std::optional<std::wstring>{};
    const auto capture_id = endpoint == "explicit"
                                ? explicit_capture
                                : std::optional<std::wstring>{};
    for (const auto &mode :
         {std::string("warm_microphone"), std::string("remote_render"),
          std::string("screen_audio"), std::string("combined")}) {
      scenarios.push_back(
          runScenario(catalog, mode, endpoint, render_id, capture_id));
    }
  }

  const bool restart_passed = std::all_of(
      scenarios.begin(), scenarios.end(), [](const ScenarioResult &scenario) {
        return scenario.status == "pass" && scenario.utility_epochs == 2;
      });

  const auto bluetooth_render = firstBluetooth(render_endpoints);
  const auto bluetooth_capture = firstBluetooth(capture_endpoints);
  std::optional<ScenarioResult> bluetooth;
  std::string bluetooth_reason;
  if (bluetooth_render && bluetooth_capture) {
    bluetooth = runScenario(catalog, "combined", "bluetooth", bluetooth_render,
                            bluetooth_capture);
  } else {
    bluetooth_reason =
        "no active Bluetooth render and capture endpoint pair is installed";
  }

  const auto json =
      matrixJson(scenarios, bluetooth, restart_passed, bluetooth_reason);
  std::cout << json << '\n';
  if (argc == 3 && std::wstring_view(argv[1]) == L"--output") {
    std::ofstream output(std::filesystem::path(argv[2]),
                         std::ios::binary | std::ios::trunc);
    if (!output)
      throw std::runtime_error("open matrix output failed");
    output << json << '\n';
  } else if (argc != 1) {
    throw std::invalid_argument("usage: matrix [--output path]");
  }

  const bool scenarios_passed = std::all_of(
      scenarios.begin(), scenarios.end(),
      [](const ScenarioResult &scenario) { return scenario.status == "pass"; });
  return scenarios_passed && restart_passed &&
                 (!bluetooth || bluetooth->status == "pass")
             ? 0
             : 1;
} catch (const std::exception &error) {
  std::cerr << error.what() << '\n';
  return 1;
}
