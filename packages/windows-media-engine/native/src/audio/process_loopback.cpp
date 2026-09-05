#include "audio/process_loopback.hpp"
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <wrl.h>
#include <atomic>
#include <cstring>
#include <stdexcept>

namespace syrnike::windows_media::audio {
namespace {
using Microsoft::WRL::ComPtr;
struct Handle {
  HANDLE value = nullptr;
  ~Handle() {
    if (value) CloseHandle(value);
  }
};
struct Cancelled {};
bool processLoopbackSupported() noexcept {
  using GetVersion = LONG(WINAPI*)(OSVERSIONINFOW*);
  const auto address = GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
  GetVersion version = nullptr;
  static_assert(sizeof(version) == sizeof(address));
  std::memcpy(&version, &address, sizeof(version));
  OSVERSIONINFOW info{};
  info.dwOSVersionInfoSize = sizeof(info);
  return version && version(&info) == 0 &&
         (info.dwMajorVersion > 10 || (info.dwMajorVersion == 10 && info.dwBuildNumber >= 20348));
}
std::uint64_t processCreationTime(HANDLE process) noexcept {
  FILETIME creation{}, exit{}, kernel{}, user{};
  if (!GetProcessTimes(process, &creation, &exit, &kernel, &user)) return 0;
  return (static_cast<std::uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
}
std::int64_t now100ns() noexcept {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}
// At most one unresolved Windows activation may survive a timed-out owner.
std::atomic_bool activation_pending{false};
struct Activation {
  Handle completed{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  std::mutex mutex;
  ComPtr<IAudioClient> client;
  HRESULT result = E_PENDING;
  bool abandoned = false;
};
class Completion final : public Microsoft::WRL::RuntimeClass<
                             Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                             IActivateAudioInterfaceCompletionHandler, Microsoft::WRL::FtmBase> {
 public:
  explicit Completion(std::shared_ptr<Activation> activation)
      : activation_(std::move(activation)) {}
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    ComPtr<IUnknown> unknown;
    HRESULT activated = E_FAIL;
    auto result = operation->GetActivateResult(&activated, &unknown);
    if (SUCCEEDED(result)) result = activated;
    {
      std::scoped_lock lock(activation_->mutex);
      if (!activation_->abandoned && SUCCEEDED(result))
        result = unknown ? unknown.As(&activation_->client) : E_NOINTERFACE;
      activation_->result = result;
    }
    activation_pending = false;
    SetEvent(activation_->completed.value);
    return S_OK;
  }

 private:
  std::shared_ptr<Activation> activation_;
};
void checked(HRESULT result, ScreenAudioFailureCode code) {
  if (FAILED(result)) throw ScreenAudioFailure{code, result};
}
}  // namespace
AudioProcessIdentity::~AudioProcessIdentity() {
  if (process_) CloseHandle(process_);
}
bool AudioProcessIdentity::alive() const noexcept {
  return WaitForSingleObject(process_, 0) == WAIT_TIMEOUT;
}
std::shared_ptr<AudioProcessIdentity> AudioProcessIdentity::fromProcess(std::uint32_t pid,
                                                                        std::uint64_t expected) {
  const auto process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (!process) return {};
  const auto created = processCreationTime(process);
  if (!created || !expected || created != expected ||
      WaitForSingleObject(process, 0) != WAIT_TIMEOUT) {
    CloseHandle(process);
    return {};
  }
  return std::shared_ptr<AudioProcessIdentity>(new AudioProcessIdentity(process, pid, created));
}
std::shared_ptr<AudioProcessIdentity> AudioProcessIdentity::current() {
  return fromProcess(GetCurrentProcessId(), processCreationTime(GetCurrentProcess()));
}
std::shared_ptr<AudioProcessIdentity> AudioProcessIdentity::fromWindow(
    sources::SourceRegistry& registry, const std::string& id) {
  const auto target = registry.resolveWindowTarget(id);
  if (target.status != sources::ResolveStatus::Available || !target.target) return {};
  const auto window = reinterpret_cast<HWND>(target.target->platformValue());
  DWORD pid = 0;
  if (!GetWindowThreadProcessId(window, &pid)) return {};
  Handle process{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid)};
  if (!process.value) return {};
  auto identity = fromProcess(pid, processCreationTime(process.value));
  const auto confirmed = registry.resolveWindowTarget(id);
  DWORD confirmed_pid = 0;
  (void)GetWindowThreadProcessId(window, &confirmed_pid);
  if (!confirmed.target || confirmed.status != sources::ResolveStatus::Available ||
      confirmed.target->cacheKey() != target.target->cacheKey() || confirmed_pid != pid)
    return {};
  return identity;
}
ProcessLoopback::ProcessLoopback(std::shared_ptr<PcmQueue> queue) : queue_(std::move(queue)) {
  if (!queue_) throw std::invalid_argument("Process loopback needs a PCM queue");
  stop_event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!stop_event_) throw std::runtime_error("Audio stop event creation failed");
}
ProcessLoopback::~ProcessLoopback() {
  if (!stop(std::chrono::steady_clock::now() + std::chrono::seconds{5})) std::terminate();
  CloseHandle(stop_event_);
}
std::optional<ScreenAudioFailure> ProcessLoopback::start(
    ScreenAudioMode mode, std::shared_ptr<AudioProcessIdentity> target) {
  std::unique_lock lock(mutex_);
  if (worker_.joinable() || !done_)
    return ScreenAudioFailure{ScreenAudioFailureCode::invalid_state};
  if (!processLoopbackSupported())
    return ScreenAudioFailure{ScreenAudioFailureCode::unsupported, E_NOTIMPL};
  if (!target || !target->alive())
    return ScreenAudioFailure{ScreenAudioFailureCode::invalid_target};
  failure_.reset();
  state_ = ScreenAudioState::starting;
  done_ = false;
  const auto generation = stats_.generation + 1;
  stats_ = {};
  stats_.generation = generation;
  stats_.event_handles = 1;
  ResetEvent(stop_event_);
  queue_->begin(generation);
  try {
    worker_ = std::thread(
        [this, mode, target = std::move(target), generation] { run(mode, target, generation); });
  } catch (...) {
    queue_->stop();
    done_ = true;
    state_ = ScreenAudioState::failed;
    failure_ = ScreenAudioFailure{ScreenAudioFailureCode::capture_failed, E_OUTOFMEMORY};
    return failure_;
  }
  if (!changed_.wait_for(lock, std::chrono::seconds{6},
                         [this] { return state_ != ScreenAudioState::starting; })) {
    failure_ = ScreenAudioFailure{ScreenAudioFailureCode::activation_timeout,
                                  HRESULT_FROM_WIN32(WAIT_TIMEOUT), true};
    state_ = ScreenAudioState::failed;
    SetEvent(stop_event_);
  }
  if (!failure_ && state_ != ScreenAudioState::running)
    return ScreenAudioFailure{ScreenAudioFailureCode::cancelled};
  return failure_;
}
void ProcessLoopback::fail(ScreenAudioFailure failure) noexcept {
  std::scoped_lock lock(mutex_);
  failure_ = failure;
  state_ = ScreenAudioState::failed;
  changed_.notify_all();
}
ScreenAudioState ProcessLoopback::state() const noexcept {
  std::scoped_lock lock(mutex_);
  return state_;
}
std::optional<ScreenAudioFailure> ProcessLoopback::failure() const noexcept {
  std::scoped_lock lock(mutex_);
  return failure_;
}
LoopbackStats ProcessLoopback::stats() const noexcept {
  std::scoped_lock lock(mutex_);
  return stats_;
}
bool ProcessLoopback::stop(std::chrono::steady_clock::time_point deadline) noexcept {
  std::unique_lock lock(mutex_);
  SetEvent(stop_event_);
  queue_->stop();
  if (!changed_.wait_until(lock, deadline, [this] { return done_; })) {
    failure_ = ScreenAudioFailure{ScreenAudioFailureCode::stop_timeout,
                                  HRESULT_FROM_WIN32(WAIT_TIMEOUT), true};
    state_ = ScreenAudioState::failed;
    return false;
  }
  // Serialize join and prevent a concurrent start from resetting cancellation
  // between the stop signal and acquisition of this owner lock.
  if (worker_.joinable()) worker_.join();
  return true;
}
void ProcessLoopback::run(ScreenAudioMode mode, std::shared_ptr<AudioProcessIdentity> target,
                          std::uint64_t generation) noexcept {
  const auto com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  ComPtr<IAudioClient> client;
  try {
    checked(com, ScreenAudioFailureCode::activation_failed);
    {
      std::scoped_lock lock(mutex_);
      stats_.capture_threads = 1;
    }
    auto activation = std::make_shared<Activation>();
    if (!activation->completed.value)
      throw ScreenAudioFailure{ScreenAudioFailureCode::activation_failed,
                               HRESULT_FROM_WIN32(GetLastError())};
    if (activation_pending.exchange(true))
      throw ScreenAudioFailure{ScreenAudioFailureCode::activation_timeout, E_PENDING, true};
    auto handler = Microsoft::WRL::Make<Completion>(activation);
    if (!handler) {
      activation_pending = false;
      throw ScreenAudioFailure{ScreenAudioFailureCode::activation_failed, E_OUTOFMEMORY};
    }
    AUDIOCLIENT_ACTIVATION_PARAMS parameters{};
    parameters.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    parameters.ProcessLoopbackParams.TargetProcessId = target->pid();
    parameters.ProcessLoopbackParams.ProcessLoopbackMode =
        mode == ScreenAudioMode::include_process_tree
            ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
            : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT value{};
    value.vt = VT_BLOB;
    value.blob.cbSize = sizeof(parameters);
    value.blob.pBlobData = reinterpret_cast<BYTE*>(&parameters);
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    const auto result =
        ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient),
                                    &value, handler.Get(), &operation);
    if (FAILED(result)) activation_pending = false;
    checked(result, result == E_NOTIMPL || result == E_INVALIDARG
                        ? ScreenAudioFailureCode::unsupported
                        : ScreenAudioFailureCode::activation_failed);
    HANDLE ready[]{stop_event_, activation->completed.value, target->handle()};
    const auto wait = WaitForMultipleObjects(3, ready, FALSE, 5000);
    {
      std::scoped_lock lock(activation->mutex);
      if (wait != WAIT_OBJECT_0 + 1) {
        activation->abandoned = true;
        if (wait == WAIT_OBJECT_0) throw Cancelled{};
        throw ScreenAudioFailure{wait == WAIT_OBJECT_0 + 2
                                     ? ScreenAudioFailureCode::target_exited
                                     : ScreenAudioFailureCode::activation_timeout,
                                 HRESULT_FROM_WIN32(WAIT_TIMEOUT), wait == WAIT_TIMEOUT};
      }
      checked(activation->result,
              activation->result == E_NOTIMPL || activation->result == E_INVALIDARG
                  ? ScreenAudioFailureCode::unsupported
                  : ScreenAudioFailureCode::activation_failed);
      client = std::move(activation->client);
    }
    operation.Reset();
    handler.Reset();
    activation.reset();
    Handle sample_event{CreateEventW(nullptr, FALSE, FALSE, nullptr)};
    if (!sample_event.value)
      throw ScreenAudioFailure{ScreenAudioFailureCode::capture_failed,
                               HRESULT_FROM_WIN32(GetLastError())};
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = kAudioChannels;
    format.nSamplesPerSec = kAudioRate;
    format.wBitsPerSample = 16;
    format.nBlockAlign = 4;
    format.nAvgBytesPerSec = kAudioRate * 4;
    checked(client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                               AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                                   AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                                   AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                               0, 0, &format, nullptr),
            ScreenAudioFailureCode::format_unavailable);
    checked(client->SetEventHandle(sample_event.value), ScreenAudioFailureCode::capture_failed);
    ComPtr<IAudioCaptureClient> capture;
    checked(client->GetService(IID_PPV_ARGS(&capture)), ScreenAudioFailureCode::capture_failed);
    PcmPacketizer packetizer(*queue_);
    packetizer.begin(generation);
    checked(client->Start(), ScreenAudioFailureCode::capture_failed);
    {
      std::scoped_lock lock(mutex_);
      if (!failure_) state_ = ScreenAudioState::running;
      stats_.audio_clients = 1;
      stats_.event_handles = 2;
      changed_.notify_all();
    }
    HANDLE events[]{stop_event_, sample_event.value, target->handle()};
    for (;;) {
      const auto event = WaitForMultipleObjects(3, events, FALSE, INFINITE);
      if (event == WAIT_OBJECT_0) break;
      if (event == WAIT_OBJECT_0 + 2)
        throw ScreenAudioFailure{ScreenAudioFailureCode::target_exited};
      if (event != WAIT_OBJECT_0 + 1)
        throw ScreenAudioFailure{ScreenAudioFailureCode::capture_failed,
                                 HRESULT_FROM_WIN32(GetLastError())};
      if (queue_->stopped()) break;
      for (;;) {
        if (WaitForSingleObject(stop_event_, 0) == WAIT_OBJECT_0) break;
        UINT32 frames = 0;
        checked(capture->GetNextPacketSize(&frames), ScreenAudioFailureCode::device_lost);
        if (!frames) break;
        BYTE* data = nullptr;
        DWORD flags = 0;
        UINT64 position = 0, qpc = 0;
        checked(capture->GetBuffer(&data, &frames, &flags, &position, &qpc),
                ScreenAudioFailureCode::device_lost);
        const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
        packetizer.ingest(
            silent || !data
                ? std::span<const std::int16_t>{}
                : std::span<const std::int16_t>{reinterpret_cast<const std::int16_t*>(data),
                                                static_cast<std::size_t>(frames) * kAudioChannels},
            frames, position, static_cast<std::int64_t>(qpc), silent,
            (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0,
            (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0, now100ns());
        checked(capture->ReleaseBuffer(frames), ScreenAudioFailureCode::capture_failed);
        std::scoped_lock lock(mutex_);
        ++stats_.capture_packets;
        if (silent) ++stats_.silent_packets;
        if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) ++stats_.discontinuities;
        if (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) ++stats_.invalid_timestamps;
      }
    }
  } catch (const Cancelled&) {
  } catch (const ScreenAudioFailure& failure) {
    fail(failure);
  } catch (...) {
    fail({ScreenAudioFailureCode::capture_failed, E_FAIL});
  }
  if (client) {
    (void)client->Stop();
    client.Reset();
  }
  queue_->stop();
  if (SUCCEEDED(com)) CoUninitialize();
  std::scoped_lock lock(mutex_);
  stats_.audio_clients = stats_.capture_threads = 0;
  stats_.event_handles = 1;
  if (!failure_) state_ = ScreenAudioState::stopped;
  done_ = true;
  changed_.notify_all();
}
}  // namespace syrnike::windows_media::audio
