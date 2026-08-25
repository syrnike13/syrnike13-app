#include "audio_devices.hpp"

#include <functiondiscoverykeys_devpkey.h>
#include <propsys.h>
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <exception>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <unordered_set>

#include "audio_failure.hpp"
#include "../common/diagnostic_log.hpp"
#include "wasapi_event.hpp"
using Microsoft::WRL::ComPtr;

namespace syrnike::desktop_native::media {
namespace {

std::string utf8(const wchar_t* value) {
  if (!value || *value == L'\0') return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) return {};
  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), size, nullptr, nullptr);
  result.resize(static_cast<std::size_t>(size - 1));
  return result;
}

ComPtr<IMMDeviceEnumerator> enumerator() {
  ComPtr<IMMDeviceEnumerator> value;
  const auto result = CoCreateInstance(
    __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&value)
  );
  if (FAILED(result)) throwAudioFailure(result, "failed to create MMDeviceEnumerator");
  return value;
}

ComPtr<IMMDevice> defaultDevice(EDataFlow flow) {
  ComPtr<IMMDevice> device;
  const auto result = enumerator()->GetDefaultAudioEndpoint(flow, eConsole, &device);
  if (FAILED(result)) {
    throwAudioFailure(
      result,
      "default audio endpoint is unavailable",
      AudioFailureKind::DefaultEndpointUnavailable
    );
  }
  return device;
}

class ScopedCom final {
 public:
  ScopedCom() : result_(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
  ~ScopedCom() { if (SUCCEEDED(result_)) CoUninitialize(); }
  [[nodiscard]] HRESULT result() const noexcept { return result_; }
 private:
  HRESULT result_;
};

std::string deviceId(IMMDevice* device) {
  LPWSTR raw = nullptr;
  if (!device || FAILED(device->GetId(&raw)) || !raw) return {};
  const auto result = utf8(raw);
  CoTaskMemFree(raw);
  return result;
}

std::string deviceLabel(IMMDevice* device) {
  ComPtr<IPropertyStore> properties;
  if (!device || FAILED(device->OpenPropertyStore(STGM_READ, &properties))) return {};
  PROPVARIANT value;
  PropVariantInit(&value);
  const auto result = properties->GetValue(PKEY_Device_FriendlyName, &value);
  const auto label = SUCCEEDED(result) && value.vt == VT_LPWSTR ? utf8(value.pwszVal) : std::string{};
  PropVariantClear(&value);
  return label;
}

void appendDevices(
  EDataFlow flow,
  const char* kind,
  const std::string& default_id,
  std::vector<DeviceInfo>& output
) {
  ComPtr<IMMDeviceCollection> collection;
  if (FAILED(enumerator()->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &collection))) return;
  UINT count = 0;
  if (FAILED(collection->GetCount(&count))) return;
  for (UINT index = 0; index < count; ++index) {
    ComPtr<IMMDevice> device;
    if (FAILED(collection->Item(index, &device))) continue;
    auto id = deviceId(device.Get());
    if (id.empty()) continue;
    output.push_back(DeviceInfo{
      std::move(id),
      deviceLabel(device.Get()),
      kind,
      output.empty() ? false : false,
    });
    output.back().is_default = output.back().device_id == default_id;
  }
}

}  // namespace

ComPtr<IMMDevice> captureDevice(const std::string& device_id) {
  if (device_id.empty() || device_id == "default") return defaultDevice(eCapture);
  const int length = MultiByteToWideChar(
    CP_UTF8, 0, device_id.data(), static_cast<int>(device_id.size()), nullptr, 0
  );
  std::wstring wide(static_cast<std::size_t>(length), L'\0');
  MultiByteToWideChar(
    CP_UTF8, 0, device_id.data(), static_cast<int>(device_id.size()), wide.data(), length
  );
  ComPtr<IMMDevice> device;
  const auto result = enumerator()->GetDevice(wide.c_str(), &device);
  if (FAILED(result)) {
    throwAudioFailure(result, "selected microphone is unavailable", AudioFailureKind::DeviceNotFound);
  }
  return device;
}

ComPtr<IMMDevice> renderDevice() {
  return defaultDevice(eRender);
}

ComPtr<IMMDevice> renderDevice(const std::string& device_id) {
  if (device_id.empty() || device_id == "default") return renderDevice();
  const int length = MultiByteToWideChar(
    CP_UTF8, 0, device_id.data(), static_cast<int>(device_id.size()), nullptr, 0
  );
  if (length <= 0) throw std::runtime_error("invalid audio output device id");
  std::wstring wide(static_cast<std::size_t>(length), L'\0');
  MultiByteToWideChar(
    CP_UTF8, 0, device_id.data(), static_cast<int>(device_id.size()), wide.data(), length
  );
  ComPtr<IMMDevice> device;
  const auto result = enumerator()->GetDevice(wide.c_str(), &device);
  if (FAILED(result)) {
    throwAudioFailure(result, "selected audio output is unavailable", AudioFailureKind::DeviceNotFound);
  }
  return device;
}

std::string audioEndpointId(IMMDevice* device) {
  return deviceId(device);
}

std::string resolvedRenderDeviceId(const std::string& device_id) {
  ScopedCom com;
  if (FAILED(com.result())) {
    throwAudioFailure(com.result(), "initialize render endpoint resolver COM failed");
  }
  const auto resolved = deviceId(renderDevice(device_id).Get());
  if (resolved.empty()) {
    throw AudioFailure(
      AudioFailureKind::DeviceNotFound,
      "resolved audio output has no endpoint id",
      HRESULT_FROM_WIN32(ERROR_NOT_FOUND)
    );
  }
  return resolved;
}

std::vector<DeviceInfo> listAudioDevices(EDataFlow flow) {
  std::vector<DeviceInfo> result;
  if (flow != eCapture && flow != eRender) return result;
  std::string default_id;
  try { default_id = deviceId(defaultDevice(flow).Get()); } catch (...) {}
  appendDevices(
    flow,
    flow == eCapture ? "audioinput" : "audiooutput",
    default_id,
    result
  );
  return result;
}

WAVEFORMATEX desiredCaptureFormat() {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = 1;
  format.nSamplesPerSec = 48'000;
  format.wBitsPerSample = 32;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  return format;
}

WAVEFORMATEX desiredRenderFormat() {
  return desiredCaptureFormat();
}

bool audioEndpointChangeRequiresDefaultRetry(
  std::string_view selected_device_id,
  bool fallback_pending,
  const AudioEndpointChange& change
) noexcept {
  const bool follows_default =
    selected_device_id.empty() || selected_device_id == "default";
  const bool default_changed =
    change.kind == AudioEndpointChangeKind::DefaultChanged &&
    change.role == eConsole;
  const bool selected_lost =
    !follows_default && selected_device_id == change.device_id;
  return selected_lost || (default_changed && (follows_default || fallback_pending));
}

namespace {

class EndpointNotificationClient final : public IMMNotificationClient {
 public:
  EndpointNotificationClient(
    EDataFlow flow,
    ComPtr<IMMDeviceEnumerator> device_enumerator,
    AudioEndpointMonitor::Handler handler
  ) : flow_(flow),
      device_enumerator_(std::move(device_enumerator)),
      handler_(std::move(handler)) {
    rememberCurrentEndpoints();
  }

  ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
  ULONG STDMETHODCALLTYPE Release() override {
    const auto remaining = --references_;
    if (remaining == 0) delete this;
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** value) override {
    if (!value) return E_POINTER;
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IMMNotificationClient)) {
      *value = static_cast<IMMNotificationClient*>(this);
      AddRef();
      return S_OK;
    }
    *value = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(
    EDataFlow flow,
    ERole role,
    LPCWSTR id
  ) override {
    if (flow == flow_ && (role == eConsole || role == eCommunications)) {
      notify(AudioEndpointChangeKind::DefaultChanged, id, role);
    }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR id) override {
    if (belongsToMonitoredFlow(id, true)) {
      notify(AudioEndpointChangeKind::Added, id);
    }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR id) override {
    const auto key = utf8(id);
    bool was_monitored = false;
    {
      std::lock_guard lock(endpoints_mutex_);
      was_monitored = known_endpoint_ids_.erase(key) != 0;
    }
    if (was_monitored) notify(AudioEndpointChangeKind::Removed, id);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR id, DWORD state) override {
    if ((state & DEVICE_STATE_ACTIVE) != 0) {
      if (belongsToMonitoredFlow(id, true)) {
        notify(AudioEndpointChangeKind::Active, id);
      }
    } else if (belongsToMonitoredFlow(id, false)) {
      notify(AudioEndpointChangeKind::Disabled, id);
    }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override {
    return S_OK;
  }

 private:
  void rememberCurrentEndpoints() noexcept {
    try {
      if (!device_enumerator_) return;
      ComPtr<IMMDeviceCollection> collection;
      if (FAILED(device_enumerator_->EnumAudioEndpoints(
            flow_, DEVICE_STATEMASK_ALL, &collection))) return;
      UINT count = 0;
      if (FAILED(collection->GetCount(&count))) return;
      std::lock_guard lock(endpoints_mutex_);
      for (UINT index = 0; index < count; ++index) {
        ComPtr<IMMDevice> device;
        if (FAILED(collection->Item(index, &device))) continue;
        auto id = deviceId(device.Get());
        if (!id.empty()) known_endpoint_ids_.insert(std::move(id));
      }
    } catch (...) {
    }
  }

  bool belongsToMonitoredFlow(LPCWSTR id, bool remember) noexcept {
    const auto key = utf8(id);
    if (key.empty()) return false;
    {
      std::lock_guard lock(endpoints_mutex_);
      if (known_endpoint_ids_.contains(key)) return true;
    }
    try {
      if (!device_enumerator_) return false;
      ComPtr<IMMDevice> device;
      if (FAILED(device_enumerator_->GetDevice(id, &device))) return false;
      ComPtr<IMMEndpoint> endpoint;
      if (FAILED(device.As(&endpoint))) return false;
      EDataFlow flow = eAll;
      if (FAILED(endpoint->GetDataFlow(&flow)) || flow != flow_) return false;
      if (remember) {
        std::lock_guard lock(endpoints_mutex_);
        known_endpoint_ids_.insert(key);
      }
      return true;
    } catch (...) {
      return false;
    }
  }

  void notify(
    AudioEndpointChangeKind kind,
    LPCWSTR id,
    ERole role = eConsole
  ) noexcept {
    try {
      if (!handler_) return;
      handler_(AudioEndpointChange{flow_, kind, utf8(id), role});
    } catch (...) {
      // No C++ exception may cross the Windows COM callback ABI. Losing one
      // notification is safe because capture/render failure paths also drive
      // endpoint recovery.
    }
  }

  std::atomic_ulong references_{1};
  EDataFlow flow_;
  ComPtr<IMMDeviceEnumerator> device_enumerator_;
  AudioEndpointMonitor::Handler handler_;
  std::mutex endpoints_mutex_;
  std::unordered_set<std::string> known_endpoint_ids_;
};

// IMMDeviceEnumerator normally releases its callback during unregister, but a
// failed unregister may leave Windows holding the callback past monitor
// destruction. Keep the callback-facing queue independently owned so a late
// notification can only observe a stopped queue, never a freed Implementation.
class EndpointNotificationQueue final {
 public:
  void enqueue(AudioEndpointChange change) {
    {
      std::lock_guard lock(mutex_);
      if (stopping_) return;
      for (auto iterator = pending_.begin(); iterator != pending_.end();) {
        const bool same_default = change.kind == AudioEndpointChangeKind::DefaultChanged &&
          iterator->kind == AudioEndpointChangeKind::DefaultChanged &&
          iterator->role == change.role;
        const bool same_endpoint = iterator->kind == change.kind &&
          iterator->device_id == change.device_id;
        if (same_default || same_endpoint) iterator = pending_.erase(iterator);
        else ++iterator;
      }
      pending_.push_back(std::move(change));
    }
    changed_.notify_one();
  }

  bool waitTake(std::deque<AudioEndpointChange>& batch) {
    std::unique_lock lock(mutex_);
    changed_.wait(lock, [this] { return stopping_ || !pending_.empty(); });
    if (stopping_) return false;
    batch.swap(pending_);
    return true;
  }

  void stop() {
    {
      std::lock_guard lock(mutex_);
      stopping_ = true;
      pending_.clear();
    }
    changed_.notify_one();
  }

 private:
  std::mutex mutex_;
  std::condition_variable changed_;
  std::deque<AudioEndpointChange> pending_;
  bool stopping_ = false;
};

constexpr bool canReleaseEndpointNotificationClient(
  bool registration_active,
  HRESULT unregister_result
) noexcept {
  return !registration_active || SUCCEEDED(unregister_result) ||
    unregister_result == E_NOTFOUND;
}

static_assert(canReleaseEndpointNotificationClient(false, E_FAIL));
static_assert(canReleaseEndpointNotificationClient(true, S_OK));
static_assert(canReleaseEndpointNotificationClient(true, E_NOTFOUND));
static_assert(!canReleaseEndpointNotificationClient(true, E_FAIL));

}  // namespace

class AudioEndpointMonitor::Implementation {
 public:
  Implementation(EDataFlow flow, Handler handler)
    : flow_(flow), handler_(std::move(handler)), worker_([this] { run(); }) {
    std::unique_lock lock(mutex_);
    started_.wait(lock, [this] { return startup_complete_; });
    if (startup_error_) {
      const auto error = startup_error_;
      lock.unlock();
      if (worker_.joinable()) worker_.join();
      std::rethrow_exception(error);
    }
  }

  ~Implementation() {
    endpoint_changes_->stop();
    if (worker_.joinable()) worker_.join();
  }

 private:
  void signalStartup(std::exception_ptr error = {}) {
    {
      std::lock_guard lock(mutex_);
      startup_error_ = std::move(error);
      startup_complete_ = true;
    }
    started_.notify_one();
  }

  void run() {
    // The apartment guard must outlive every COM pointer created below. Local
    // objects are destroyed in reverse declaration order, so IMMDeviceEnumerator
    // is released before ScopedCom tears the apartment down.
    ScopedCom com;
    if (FAILED(com.result())) {
      signalStartup(std::make_exception_ptr(AudioFailure(
        AudioFailureKind::Unknown, "initialize audio endpoint monitor COM failed", com.result())));
      return;
    }
    ComPtr<IMMDeviceEnumerator> device_enumerator;
    EndpointNotificationClient* client = nullptr;
    bool registration_active = false;
    const auto retire_client = [&]() noexcept {
      if (!client) return;
      HRESULT unregister_result = S_OK;
      if (registration_active) {
        unregister_result = device_enumerator
          ? device_enumerator->UnregisterEndpointNotificationCallback(client)
          : E_UNEXPECTED;
      }
      if (canReleaseEndpointNotificationClient(registration_active, unregister_result)) {
        registration_active = false;
        client->Release();
      } else {
        // Windows keeps a raw callback pointer and does not AddRef it. On an
        // indeterminate unregister failure, leaking this stopped callback is
        // the only fail-closed option; deleting it would create a system-call UAF.
        auto& logger = diagnostics::DiagnosticLog::instance();
        if (logger.enabled()) {
          logger.write(
            "audio_endpoint_monitor_unregister_failed",
            {{"hresult", static_cast<std::int64_t>(unregister_result)}}
          );
        }
      }
      client = nullptr;
    };
    try {
      device_enumerator = enumerator();
      client = new EndpointNotificationClient(
        flow_,
        device_enumerator,
        [queue = endpoint_changes_](AudioEndpointChange change) {
          queue->enqueue(std::move(change));
        }
      );
      const auto result = device_enumerator->RegisterEndpointNotificationCallback(client);
      if (FAILED(result)) {
        throw AudioFailure(
          classifyAudioHresult(result),
          "register audio endpoint notifications failed",
          result
        );
      }
      registration_active = true;
      signalStartup();
      for (;;) {
        std::deque<AudioEndpointChange> batch;
        if (!endpoint_changes_->waitTake(batch)) break;
        for (auto& change : batch) {
          try { handler_(std::move(change)); } catch (...) {}
        }
      }
      retire_client();
    } catch (...) {
      bool startup_complete = false;
      {
        std::lock_guard lock(mutex_);
        startup_complete = startup_complete_;
      }
      if (!startup_complete) signalStartup(std::current_exception());
      retire_client();
    }
  }

  EDataFlow flow_;
  Handler handler_;
  std::mutex mutex_;
  std::condition_variable started_;
  std::shared_ptr<EndpointNotificationQueue> endpoint_changes_ =
    std::make_shared<EndpointNotificationQueue>();
  bool startup_complete_ = false;
  std::exception_ptr startup_error_;
  std::thread worker_;
};

AudioEndpointMonitor::AudioEndpointMonitor(EDataFlow flow, Handler handler)
  : implementation_(std::make_unique<Implementation>(flow, std::move(handler))) {}
AudioEndpointMonitor::~AudioEndpointMonitor() = default;

void probeCaptureDevice(
  const std::string& device_id,
  const WAVEFORMATEX& format,
  std::chrono::milliseconds timeout
) {
  ScopedCom com;
  auto device = captureDevice(device_id);
  ComPtr<IAudioClient> client;
  auto result = device->Activate(
    __uuidof(IAudioClient), CLSCTX_ALL, nullptr,
    reinterpret_cast<void**>(client.GetAddressOf())
  );
  if (FAILED(result)) throwAudioFailure(result, "activate microphone candidate failed");
  WasapiEventPair stream_events;
  result = client->Initialize(
    AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
      AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
      AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    400'000, 0, &format, nullptr
  );
  if (FAILED(result)) {
    throwAudioFailure(result, "initialize microphone candidate failed");
  }
  result = client->SetEventHandle(stream_events.audioReadyHandle());
  if (FAILED(result)) {
    throwAudioFailure(result, "set microphone candidate event failed");
  }
  ComPtr<IAudioCaptureClient> capture;
  result = client->GetService(IID_PPV_ARGS(&capture));
  if (FAILED(result)) throwAudioFailure(result, "open microphone candidate failed");
  result = client->Start();
  if (FAILED(result)) {
    throwAudioFailure(result, "start microphone candidate failed", AudioFailureKind::ClientStartFailed);
  }
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
      deadline - std::chrono::steady_clock::now()
    );
    const auto wait_result = stream_events.wait(static_cast<DWORD>(
      std::max<std::int64_t>(1, remaining.count())
    ));
    if (wait_result == WasapiEventPair::WaitResult::TimedOut) break;
    UINT32 frames = 0;
    result = capture->GetNextPacketSize(&frames);
    if (FAILED(result)) {
      client->Stop();
      throwAudioFailure(result, "read microphone candidate health failed", AudioFailureKind::IoFailed);
    }
    if (frames != 0) {
      BYTE* data = nullptr;
      DWORD flags = 0;
      result = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (SUCCEEDED(result)) capture->ReleaseBuffer(frames);
      client->Stop();
      if (FAILED(result)) {
        throwAudioFailure(result, "read microphone candidate frame failed", AudioFailureKind::IoFailed);
      }
      return;
    }
  }
  client->Stop();
  throw AudioFailure(
    AudioFailureKind::OperationTimedOut,
    "microphone candidate produced no PCM before deadline",
    HRESULT_FROM_WIN32(WAIT_TIMEOUT)
  );
}

void probeRenderDevice(
  const std::string& device_id,
  const WAVEFORMATEX& format,
  std::chrono::milliseconds
) {
  ScopedCom com;
  auto device = renderDevice(device_id);
  ComPtr<IAudioClient> client;
  auto result = device->Activate(
    __uuidof(IAudioClient), CLSCTX_ALL, nullptr,
    reinterpret_cast<void**>(client.GetAddressOf())
  );
  if (FAILED(result)) throwAudioFailure(result, "activate output candidate failed");
  result = client->Initialize(
    AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    500'000, 0, &format, nullptr
  );
  if (FAILED(result)) throwAudioFailure(result, "initialize output candidate failed");
  ComPtr<IAudioRenderClient> render;
  result = client->GetService(IID_PPV_ARGS(&render));
  if (FAILED(result)) throwAudioFailure(result, "open output candidate failed");
  UINT32 capacity = 0;
  result = client->GetBufferSize(&capacity);
  if (FAILED(result) || capacity == 0) {
    throwAudioFailure(
      FAILED(result) ? result : E_FAIL,
      "query output candidate capacity failed",
      AudioFailureKind::IoFailed
    );
  }
  BYTE* output = nullptr;
  result = render->GetBuffer(capacity, &output);
  if (FAILED(result)) throwAudioFailure(result, "prime output candidate failed");
  result = render->ReleaseBuffer(capacity, AUDCLNT_BUFFERFLAGS_SILENT);
  if (FAILED(result)) throwAudioFailure(result, "release output candidate buffer failed");
  result = client->Start();
  if (FAILED(result)) {
    throwAudioFailure(result, "start output candidate failed", AudioFailureKind::ClientStartFailed);
  }
  client->Stop();
}

}  // namespace syrnike::desktop_native::media

namespace syrnike::voice {

Microsoft::WRL::ComPtr<IMMDevice> getCaptureDevice(const std::string& device_id) {
  return desktop_native::media::captureDevice(device_id);
}

Microsoft::WRL::ComPtr<IMMDevice> getRenderDevice() {
  return desktop_native::media::renderDevice();
}

}  // namespace syrnike::voice
