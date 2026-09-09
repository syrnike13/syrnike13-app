#include "audio/microphone_capture.hpp"
#include "testing/product_fault_gate.hpp"

#include <windows.h>
#include <audioclient.h>
#include <avrt.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>
#include <algorithm>
#include <stdexcept>
#if defined(WINDOWS_MEDIA_CAPTURE_HEAP_PROBE) || defined(WINDOWS_MEDIA_CAPTURE_FAULT_PROBE)
#include "lab/microphone_capture_probe.hpp"
#endif

namespace syrnike::windows_media::audio {
namespace {
using Clock = std::chrono::steady_clock;
using Microsoft::WRL::ComPtr;
struct Event {
  HANDLE value;
  explicit Event(bool manual_reset = true) : value(CreateEventW(nullptr, manual_reset, FALSE, nullptr)) {
    if (!value) throw std::runtime_error("Microphone event creation failed");
  }
  ~Event() { CloseHandle(value); }
};
struct Apartment {
  HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
};
struct Mmcss {
  DWORD task = 0;
  HANDLE handle = AvSetMmThreadCharacteristicsW(L"Audio", &task);
  ~Mmcss() { if (handle) AvRevertMmThreadCharacteristics(handle); }
};
struct Failure { MicrophoneCaptureFailure code; HRESULT platform; };
void check(HRESULT result, MicrophoneCaptureFailure code) {
  if (FAILED(result))
    throw Failure{result == AUDCLNT_E_DEVICE_INVALIDATED ? MicrophoneCaptureFailure::device_lost : code, result};
}
DWORD remainingMilliseconds(Clock::time_point deadline) noexcept {
  const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
  return static_cast<DWORD>((std::clamp)(remaining, std::int64_t{0}, std::int64_t{10'000}));
}
}  // namespace
struct MicrophoneCapture::State {
  Event stop;
  Event ready;
  Event done;
  Event frame{false};
  std::shared_ptr<MicrophonePcmPort> port = std::make_shared<MicrophonePcmPort>();
  std::atomic<MicrophoneCaptureState> state{MicrophoneCaptureState::idle};
  std::atomic<MicrophoneCaptureFailure> failure{MicrophoneCaptureFailure::none};
  std::atomic<std::int32_t> platform{0};
  std::atomic<std::uint64_t> generation{0};
  std::atomic<std::uint64_t> frames{0}, discontinuities{0}, invalid_timestamps{0}, invalid_buffers{0};
  std::atomic<std::uint64_t> platform_discontinuities{0}, first_position_step{0};
  std::atomic<std::uint32_t> first_packet_frames{0};
  std::atomic<std::uint64_t> callback_count{0}, callback_total_us{0}, callback_max_us{0};
  std::array<std::atomic<std::uint64_t>, 8> callback_histogram{};
  std::atomic<bool> client_alive{false}, thread_alive{false}, mmcss_registered{false};
  void fail(MicrophoneCaptureFailure code, HRESULT result) noexcept {
    platform.store(result, std::memory_order_relaxed);
    failure.store(code, std::memory_order_release);
    state.store(MicrophoneCaptureState::failed, std::memory_order_release);
    SetEvent(ready.value);
    SetEvent(frame.value);
  }
};
MicrophoneCapture::MicrophoneCapture() : state_(std::make_shared<State>()) {}
MicrophoneCapture::~MicrophoneCapture() {
  if (!stop(Clock::now() + std::chrono::seconds{5})) std::terminate();
}
MicrophoneCaptureFailure MicrophoneCapture::start(AudioEndpoint endpoint, std::uint64_t generation,
                                                 bool bypass_system_processing, std::stop_token cancellation) {
  if (owner_ != std::this_thread::get_id() || state_->state.load() != MicrophoneCaptureState::idle || !generation ||
      endpoint.direction != AudioDirection::input || endpoint.endpoint_id.empty())
    return MicrophoneCaptureFailure::invalid_state;
  if (cancellation.stop_requested()) return MicrophoneCaptureFailure::cancelled;
  state_->generation = generation;
  state_->state = MicrophoneCaptureState::starting;
  try {
    worker_ = std::thread([state = state_, endpoint = std::move(endpoint), bypass_system_processing]() mutable {
      run(state, std::move(endpoint), bypass_system_processing);
    });
  } catch (...) {
    state_->fail(MicrophoneCaptureFailure::activation_failed, E_OUTOFMEMORY);
    SetEvent(state_->done.value);
    return MicrophoneCaptureFailure::activation_failed;
  }
  std::stop_callback cancel(cancellation, [state = state_] { SetEvent(state->stop.value); });
  const HANDLE events[]{state_->stop.value, state_->ready.value};
  const auto wake = WaitForMultipleObjects(2, events, FALSE, 5000);
  if (cancellation.stop_requested() || wake == WAIT_OBJECT_0)
    return MicrophoneCaptureFailure::cancelled;
  if (wake != WAIT_OBJECT_0 + 1) {
    SetEvent(state_->stop.value);
    state_->fail(MicrophoneCaptureFailure::start_timeout, HRESULT_FROM_WIN32(WAIT_TIMEOUT));
    return MicrophoneCaptureFailure::start_timeout;
  }
  const auto failure = state_->failure.load(std::memory_order_acquire);
  if (failure != MicrophoneCaptureFailure::none) return failure;
  return state_->state.load() == MicrophoneCaptureState::healthy ? MicrophoneCaptureFailure::none :
                                                                MicrophoneCaptureFailure::cancelled;
}
bool MicrophoneCapture::stop(Clock::time_point deadline) noexcept {
  if (owner_ != std::this_thread::get_id()) return false;
  if (!worker_.joinable()) return true;
  SetEvent(state_->stop.value);
  if (WaitForSingleObject(state_->done.value, remainingMilliseconds(deadline)) != WAIT_OBJECT_0) {
    state_->fail(MicrophoneCaptureFailure::stop_timeout, HRESULT_FROM_WIN32(WAIT_TIMEOUT));
    return false;
  }
  worker_.join();
  return true;
}
std::shared_ptr<MicrophonePcmPort> MicrophoneCapture::pcm() const noexcept { return state_->port; }
void* MicrophoneCapture::frameEvent() const noexcept { return state_->frame.value; }
MicrophoneCaptureStats MicrophoneCapture::stats() const noexcept {
  MicrophoneCaptureStats result;
  result.state = state_->state.load(std::memory_order_acquire);
  result.failure = state_->failure.load(std::memory_order_acquire);
  result.platform_result = state_->platform.load(std::memory_order_relaxed);
  result.generation = state_->generation;
  result.frames = state_->frames.load(std::memory_order_relaxed);
  result.discontinuities = state_->discontinuities.load(std::memory_order_relaxed);
  result.invalid_timestamps = state_->invalid_timestamps.load(std::memory_order_relaxed);
  result.invalid_buffers = state_->invalid_buffers.load(std::memory_order_relaxed);
  result.platform_discontinuities = state_->platform_discontinuities.load(std::memory_order_relaxed);
  result.first_position_step = state_->first_position_step.load(std::memory_order_relaxed);
  result.first_packet_frames = state_->first_packet_frames.load(std::memory_order_relaxed);
  result.callback_count = state_->callback_count.load(std::memory_order_relaxed);
  result.callback_total_us = state_->callback_total_us.load(std::memory_order_relaxed);
  result.callback_max_us = state_->callback_max_us.load(std::memory_order_relaxed);
  for (std::size_t index = 0; index < result.callback_histogram.size(); ++index)
    result.callback_histogram[index] = state_->callback_histogram[index].load(std::memory_order_relaxed);
  result.client_alive = state_->client_alive.load(std::memory_order_relaxed);
  result.thread_alive = state_->thread_alive.load(std::memory_order_relaxed);
  result.mmcss_registered = state_->mmcss_registered.load(std::memory_order_relaxed);
  return result;
}
void MicrophoneCapture::run(const std::shared_ptr<State>& state, AudioEndpoint endpoint,
                            bool bypass_system_processing) noexcept {
  state->thread_alive = true;
  try {
#ifdef WINDOWS_MEDIA_CAPTURE_FAULT_PROBE
    if (lab::capture_block_generation.load() == state->generation) {
      lab::capture_prepare_entered = true;
      WaitForSingleObject(state->stop.value, INFINITE);
      throw Failure{MicrophoneCaptureFailure::cancelled, HRESULT_FROM_WIN32(ERROR_CANCELLED)};
    }
#endif
    Apartment apartment;
    check(apartment.result, MicrophoneCaptureFailure::activation_failed);
    ComPtr<IMMDeviceEnumerator> enumerator;
    check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                            IID_PPV_ARGS(&enumerator)), MicrophoneCaptureFailure::activation_failed);
    ComPtr<IMMDevice> device;
    check(enumerator->GetDevice(endpoint.endpoint_id.c_str(), &device), MicrophoneCaptureFailure::device_lost);
    ComPtr<IAudioClient2> client;
    check(device->Activate(__uuidof(IAudioClient2), CLSCTX_ALL, nullptr, &client),
          MicrophoneCaptureFailure::activation_failed);
    AudioClientProperties properties{};
    properties.cbSize = sizeof(properties);
    properties.eCategory = AudioCategory_Other;
    properties.Options = bypass_system_processing ? AUDCLNT_STREAMOPTIONS_RAW : AUDCLNT_STREAMOPTIONS_NONE;
    check(client->SetClientProperties(&properties), MicrophoneCaptureFailure::policy_unavailable);
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = 1;
    format.nSamplesPerSec = kMicrophoneRate;
    format.wBitsPerSample = 16;
    format.nBlockAlign = 2;
    format.nAvgBytesPerSec = kMicrophoneRate * 2;
    testing::holdProductFault("microphone-initialize");
    check(client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                             AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                               AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                             0, 0, &format, nullptr), MicrophoneCaptureFailure::format_unavailable);
    Event sample(false);
    check(client->SetEventHandle(sample.value), MicrophoneCaptureFailure::capture_failed);
    ComPtr<IAudioCaptureClient> capture;
    check(client->GetService(IID_PPV_ARGS(&capture)), MicrophoneCaptureFailure::capture_failed);
    UINT32 buffer_frames = 0;
    check(client->GetBufferSize(&buffer_frames), MicrophoneCaptureFailure::capture_failed);
    if (!buffer_frames || buffer_frames > kMicrophoneRate)
      throw Failure{MicrophoneCaptureFailure::format_unavailable, E_INVALIDARG};
    Mmcss mmcss;
    if (!mmcss.handle) throw Failure{MicrophoneCaptureFailure::policy_unavailable, HRESULT_FROM_WIN32(GetLastError())};
    state->mmcss_registered = true;
    MicrophonePacketizer packetizer(*state->port, state->generation);
    check(client->Start(), MicrophoneCaptureFailure::capture_failed);
    struct StopClient {
      IAudioClient2* client;
      ~StopClient() { (void)client->Stop(); }
    } stop_client{client.Get()};
    state->client_alive = true;
#ifdef WINDOWS_MEDIA_CAPTURE_HEAP_PROBE
    lab::CaptureAllocationProbe allocation_probe;
#endif
    HANDLE events[]{state->stop.value, sample.value};
    auto last_progress = Clock::now();
    std::uint64_t previous_frames = 0;
    std::optional<UINT64> first_position;
#ifdef WINDOWS_MEDIA_CAPTURE_HEAP_PROBE
    bool stopped_client_for_probe = false;
#endif
    while (WaitForSingleObject(state->stop.value, 0) != WAIT_OBJECT_0) {
      const auto wake = WaitForMultipleObjects(2, events, FALSE, 1000);
      if (wake == WAIT_OBJECT_0) break;
      if (wake == WAIT_TIMEOUT) throw Failure{MicrophoneCaptureFailure::no_progress, HRESULT_FROM_WIN32(WAIT_TIMEOUT)};
      if (wake != WAIT_OBJECT_0 + 1)
        throw Failure{MicrophoneCaptureFailure::capture_failed, HRESULT_FROM_WIN32(GetLastError())};
      const auto began = Clock::now();
#ifdef WINDOWS_MEDIA_CAPTURE_HEAP_PROBE
      if (lab::capture_fault_armed && lab::capture_device_loss_after_frames &&
          previous_frames >= lab::capture_device_loss_after_frames)
        check(AUDCLNT_E_DEVICE_INVALIDATED, MicrophoneCaptureFailure::capture_failed);
      if (lab::capture_fault_armed && !stopped_client_for_probe && lab::capture_stop_client_after_frames &&
          previous_frames >= lab::capture_stop_client_after_frames) {
        check(client->Stop(), MicrophoneCaptureFailure::capture_failed);
        stopped_client_for_probe = true;
      }
#endif
      // At most the endpoint's negotiated capacity per wake; additional data is
      // handled on the next wake. Cancellation never waits on an endless drain.
      UINT32 drained = 0;
      while (drained < buffer_frames && WaitForSingleObject(state->stop.value, 0) != WAIT_OBJECT_0) {
        UINT32 available = 0;
        check(capture->GetNextPacketSize(&available), MicrophoneCaptureFailure::device_lost);
        if (!available) break;
        BYTE* data = nullptr;
        DWORD flags = 0;
        UINT64 position = 0, qpc = 0;
        testing::holdProductFault("microphone-capture");
        const auto buffer_result = capture->GetBuffer(&data, &available, &flags, &position, &qpc);
        check(buffer_result, MicrophoneCaptureFailure::device_lost);
        if (buffer_result == AUDCLNT_S_BUFFER_EMPTY || available == 0) break;
        const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
        const bool valid_buffer = available <= buffer_frames && (silent || data);
        if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY)
          state->platform_discontinuities.fetch_add(1, std::memory_order_relaxed);
        if (valid_buffer && !(flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR)) {
          if (!first_position) {
            first_position = position;
            state->first_packet_frames = available;
          } else if (!state->first_position_step.load() && position > *first_position) {
            state->first_position_step = position - *first_position;
          }
        }
        if (valid_buffer) {
          packetizer.ingest(silent ? std::span<const std::int16_t>{} :
                             std::span<const std::int16_t>{reinterpret_cast<const std::int16_t*>(data), available},
                             available, position, static_cast<std::int64_t>(qpc), silent,
                             (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0,
                             (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0);
        }
        check(capture->ReleaseBuffer(available), MicrophoneCaptureFailure::capture_failed);
        if (!valid_buffer) throw Failure{MicrophoneCaptureFailure::capture_failed, E_INVALIDARG};
        drained += available;
      }
      const auto stats = packetizer.stats();
      state->frames.store(stats.frames, std::memory_order_relaxed);
      state->discontinuities.store(stats.discontinuities, std::memory_order_relaxed);
      state->invalid_timestamps.store(stats.invalid_timestamps, std::memory_order_relaxed);
      state->invalid_buffers.store(stats.invalid_buffers, std::memory_order_relaxed);
      if (stats.frames != previous_frames) {
        SetEvent(state->frame.value);
        last_progress = Clock::now();
        previous_frames = stats.frames;
      }
      if (stats.consecutive_healthy_frames >= 3) {
        auto expected = MicrophoneCaptureState::starting;
        if (state->state.compare_exchange_strong(expected, MicrophoneCaptureState::healthy))
          SetEvent(state->ready.value);
      }
      if (Clock::now() - last_progress >= std::chrono::seconds{1})
        throw Failure{MicrophoneCaptureFailure::no_progress, HRESULT_FROM_WIN32(WAIT_TIMEOUT)};
      const auto elapsed = static_cast<std::uint64_t>(
          std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - began).count());
      state->callback_count.fetch_add(1, std::memory_order_relaxed);
      state->callback_total_us.fetch_add(elapsed, std::memory_order_relaxed);
      state->callback_max_us.store((std::max)(state->callback_max_us.load(std::memory_order_relaxed), elapsed),
                                   std::memory_order_relaxed);
      constexpr std::array<std::uint64_t, 7> limits{10, 25, 50, 100, 250, 1000, 10'000};
      const auto bucket = static_cast<std::size_t>(std::lower_bound(limits.begin(), limits.end(), elapsed) - limits.begin());
      state->callback_histogram[bucket].fetch_add(1, std::memory_order_relaxed);
    }
  } catch (const Failure& failure) {
    state->fail(failure.code, failure.platform);
  } catch (...) {
    state->fail(MicrophoneCaptureFailure::capture_failed, E_FAIL);
  }
  state->client_alive = false;
  state->mmcss_registered = false;
  state->thread_alive = false;
  if (state->failure.load() == MicrophoneCaptureFailure::none) state->state = MicrophoneCaptureState::stopped;
  SetEvent(state->ready.value);
  SetEvent(state->done.value);
  SetEvent(state->frame.value);
}
}  // namespace syrnike::windows_media::audio
