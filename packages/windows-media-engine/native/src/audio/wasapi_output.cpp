#include "audio/wasapi_output.hpp"
#include "testing/product_fault_gate.hpp"

#include <windows.h>
#include <audioclient.h>
#include <avrt.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>
#include <algorithm>
#include <stdexcept>
#ifdef WINDOWS_MEDIA_REMOTE_AUDIO_PROBE
#include "lab/remote_audio_probe.hpp"
#endif

namespace syrnike::windows_media::audio {
namespace {
using Clock = std::chrono::steady_clock;
using Microsoft::WRL::ComPtr;
// LiveKit disables its built-in playback through the default process session.
// Keep product output in a dedicated, stable session so replacement workers
// preserve Windows mixer preferences without inheriting the SDK's mute.
constexpr GUID kOutputAudioSession{
    0x3a1665b2, 0xa3b5, 0x467c, {0x9b, 0x1c, 0x39, 0xf0, 0x46, 0x2f, 0xe3, 0x57}};
struct Event {
  HANDLE value;
  explicit Event(bool manual = true) : value(CreateEventW(nullptr, manual, FALSE, nullptr)) {
    if (!value) throw std::runtime_error("Output event creation failed");
  }
  ~Event() { CloseHandle(value); }
};
struct Apartment {
  HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
};
struct Mmcss {
  DWORD task = 0;
  HANDLE value = AvSetMmThreadCharacteristicsW(L"Audio", &task);
  ~Mmcss() { if (value) AvRevertMmThreadCharacteristics(value); }
};
struct Failure { WasapiOutputFailure code; HRESULT platform; };
void check(HRESULT result, WasapiOutputFailure code) {
  if (FAILED(result))
    throw Failure{result == AUDCLNT_E_DEVICE_INVALIDATED ? WasapiOutputFailure::device_lost : code, result};
}
std::int64_t timestamp() noexcept {
  return std::chrono::duration_cast<std::chrono::duration<std::int64_t, std::ratio<1, 10'000'000>>>(
      Clock::now().time_since_epoch()).count();
}
DWORD remaining(Clock::time_point deadline) noexcept {
  return static_cast<DWORD>((std::clamp)(
      std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count(),
      std::int64_t{0}, std::int64_t{5000}));
}
}  // namespace

struct WasapiOutput::State {
  Event stop, ready, done;
  std::shared_ptr<RemoteAudioPcmPort> input;
  std::shared_ptr<RenderedEchoReference> echo;
  std::uint64_t epoch = 0;
  std::atomic<WasapiOutputState> status{WasapiOutputState::stopped};
  std::atomic<WasapiOutputFailure> failure{WasapiOutputFailure::none};
  std::atomic<std::int32_t> platform{0};
  std::atomic_bool committed{false}, deafened{false}, client_alive{false}, thread_alive{false};
  std::atomic<std::int64_t> minimum_timestamp{0}, maximum_wake_gap{0}, maximum_age{0};
  std::atomic_uint64_t submitted{0}, consumed{0}, echo_frames{0}, stale_fragments{0};
  std::atomic_uint64_t underruns{0}, delayed_wakes{0};
  std::array<std::atomic_uint64_t, 7> age_histogram{};
  std::atomic_uint32_t padding{0}, buffer{0};
  void fail(WasapiOutputFailure code, HRESULT result) noexcept {
    platform = result;
    failure = code;
    status = WasapiOutputState::failed;
    if (echo) echo->retire();
    SetEvent(ready.value);
  }
};

WasapiOutput::WasapiOutput() : state_(std::make_shared<State>()) {}
WasapiOutput::~WasapiOutput() {
  if (!stop(Clock::now() + std::chrono::seconds{5})) std::terminate();
}
WasapiOutputFailure WasapiOutput::start(AudioEndpoint endpoint, std::uint64_t epoch, std::stop_token cancellation) {
  if (owner_ != std::this_thread::get_id() || worker_.joinable() || !epoch ||
      state_->status != WasapiOutputState::stopped || state_->input ||
      endpoint.direction != AudioDirection::output || endpoint.endpoint_id.empty())
    return WasapiOutputFailure::invalid_state;
  if (cancellation.stop_requested()) return WasapiOutputFailure::cancelled;
  state_->epoch = epoch;
  state_->input = std::make_shared<RemoteAudioPcmPort>(epoch, 2);
  state_->echo = std::make_shared<RenderedEchoReference>(epoch);
  state_->status = WasapiOutputState::starting;
  try {
    worker_ = std::thread([state = state_, endpoint = std::move(endpoint)]() mutable {
      run(state, std::move(endpoint));
    });
  } catch (...) {
    state_->fail(WasapiOutputFailure::activation_failed, E_OUTOFMEMORY);
    SetEvent(state_->done.value);
    return WasapiOutputFailure::activation_failed;
  }
  // Cancellation only signals the worker's owned event; it never waits for the
  // platform call on the submitting control lane. Teardown retains its deadline.
  std::stop_callback cancel(cancellation, [state = state_] { SetEvent(state->stop.value); });
  const HANDLE events[]{state_->stop.value, state_->ready.value};
  const auto wake = WaitForMultipleObjects(2, events, FALSE, 5000);
  if (cancellation.stop_requested() || wake == WAIT_OBJECT_0)
    return WasapiOutputFailure::cancelled;
  if (wake != WAIT_OBJECT_0 + 1) {
    state_->fail(WasapiOutputFailure::start_timeout, HRESULT_FROM_WIN32(WAIT_TIMEOUT));
    SetEvent(state_->stop.value);
    return WasapiOutputFailure::start_timeout;
  }
  return state_->failure.load();
}
bool WasapiOutput::commit(std::int64_t minimum_timestamp) noexcept {
  if (owner_ != std::this_thread::get_id() || minimum_timestamp <= 0 ||
      state_->status != WasapiOutputState::running || state_->committed) return false;
  state_->minimum_timestamp.store(minimum_timestamp, std::memory_order_relaxed);
  state_->committed.store(true, std::memory_order_release);
  return true;
}
bool WasapiOutput::setDeafened(bool value) noexcept {
  if (owner_ != std::this_thread::get_id()) return false;
  state_->deafened.store(value, std::memory_order_release);
  return true;
}
bool WasapiOutput::stop(Clock::time_point deadline) noexcept {
  if (owner_ != std::this_thread::get_id()) return false;
  if (state_->echo) state_->echo->retire();
  if (state_->input) state_->input->retire();
  SetEvent(state_->stop.value);
  if (worker_.joinable()) {
    if (WaitForSingleObject(state_->done.value, remaining(deadline)) != WAIT_OBJECT_0) return false;
    worker_.join();
  }
  return true;
}
std::shared_ptr<RemoteAudioPcmPort> WasapiOutput::input() const noexcept { return state_->input; }
std::shared_ptr<RenderedEchoReference> WasapiOutput::echoReference() const noexcept { return state_->echo; }
WasapiOutputStats WasapiOutput::stats() const noexcept {
  WasapiOutputStats result{state_->status.load(), state_->failure.load(), state_->platform.load(), state_->epoch,
          state_->submitted.load(), state_->consumed.load(), state_->echo_frames.load(),
          state_->stale_fragments.load(), state_->underruns.load(), state_->delayed_wakes.load(),
          state_->maximum_wake_gap.load(), state_->maximum_age.load(), state_->padding.load(),
          state_->buffer.load(), state_->committed.load(), state_->client_alive.load(), state_->thread_alive.load()};
  for (std::size_t index = 0; index < result.scheduled_age_histogram.size(); ++index)
    result.scheduled_age_histogram[index] = state_->age_histogram[index].load();
  return result;
}

void WasapiOutput::run(const std::shared_ptr<State>& state, AudioEndpoint endpoint) noexcept {
  state->thread_alive = true;
  try {
#ifdef WINDOWS_MEDIA_REMOTE_AUDIO_PROBE
    if (lab::render_probe_epoch.load() == state->epoch && lab::render_block_prepare.load()) {
      lab::render_prepare_entered = true;
      WaitForSingleObject(state->stop.value, INFINITE);
      throw Failure{WasapiOutputFailure::cancelled, HRESULT_FROM_WIN32(ERROR_CANCELLED)};
    }
#endif
    Apartment apartment;
    check(apartment.result, WasapiOutputFailure::activation_failed);
    ComPtr<IMMDeviceEnumerator> enumerator;
    check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator)),
          WasapiOutputFailure::activation_failed);
    ComPtr<IMMDevice> device;
    check(enumerator->GetDevice(endpoint.endpoint_id.c_str(), &device), WasapiOutputFailure::device_lost);
    ComPtr<IAudioClient2> client;
    check(device->Activate(__uuidof(IAudioClient2), CLSCTX_ALL, nullptr,
                          reinterpret_cast<void**>(client.GetAddressOf())), WasapiOutputFailure::activation_failed);
    AudioClientProperties properties{};
    properties.cbSize = sizeof(properties);
    properties.eCategory = AudioCategory_Other;
    check(client->SetClientProperties(&properties), WasapiOutputFailure::policy_unavailable);
    WAVEFORMATEX format{WAVE_FORMAT_PCM, 2, kRemoteAudioRate, kRemoteAudioRate * 4, 4, 16, 0};
    testing::holdProductFault("output-initialize");
    check(client->Initialize(AUDCLNT_SHAREMODE_SHARED,
          AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
              AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
          200'000, 0, &format, &kOutputAudioSession), WasapiOutputFailure::format_unavailable);
    Event sample(false);
    check(client->SetEventHandle(sample.value), WasapiOutputFailure::render_failed);
    ComPtr<IAudioRenderClient> render;
    ComPtr<IAudioClock> clock;
    check(client->GetService(IID_PPV_ARGS(&render)), WasapiOutputFailure::render_failed);
    check(client->GetService(IID_PPV_ARGS(&clock)), WasapiOutputFailure::render_failed);
    UINT32 buffer_frames = 0;
    REFERENCE_TIME latency = 0;
    check(client->GetBufferSize(&buffer_frames), WasapiOutputFailure::format_unavailable);
    check(client->GetStreamLatency(&latency), WasapiOutputFailure::format_unavailable);
    if (buffer_frames < kRemoteAudioTargetPadding || buffer_frames > kRemoteAudioRate || latency < 0 || latency > 2'000'000)
      throw Failure{WasapiOutputFailure::format_unavailable, E_INVALIDARG};
    state->buffer = buffer_frames;
    Mmcss mmcss;
    if (!mmcss.value) throw Failure{WasapiOutputFailure::policy_unavailable, HRESULT_FROM_WIN32(GetLastError())};
    RemoteRenderPlan plan;
    const auto initial = plan.observe({buffer_frames, 0, 0, timestamp()});
    BYTE* initial_buffer = nullptr;
    check(render->GetBuffer(initial.writable_frames, &initial_buffer), WasapiOutputFailure::render_failed);
    check(render->ReleaseBuffer(initial.writable_frames, AUDCLNT_BUFFERFLAGS_SILENT), WasapiOutputFailure::render_failed);
    if (!plan.released(initial.writable_frames)) throw Failure{WasapiOutputFailure::render_failed, E_UNEXPECTED};
    check(client->Start(), WasapiOutputFailure::render_failed);
    struct StopClient {
      IAudioClient2* client;
      ~StopClient() { (void)client->Stop(); (void)client->Reset(); }
    } stop_client{client.Get()};
    state->client_alive = true;
    std::optional<RemoteAudioFrame> pending;
    std::size_t cursor = 0;
    EchoReferenceFrame echo;
    echo.renderer_epoch = state->epoch;
    std::size_t echo_filled = 0;
    const HANDLE events[]{state->stop.value, sample.value};
    while (WaitForSingleObject(state->stop.value, 0) != WAIT_OBJECT_0) {
      const auto wake = WaitForMultipleObjects(2, events, FALSE, 50);
      if (wake == WAIT_OBJECT_0) break;
      if (wake != WAIT_OBJECT_0 + 1 && wake != WAIT_TIMEOUT)
        throw Failure{WasapiOutputFailure::render_failed, HRESULT_FROM_WIN32(GetLastError())};
#ifdef WINDOWS_MEDIA_REMOTE_AUDIO_PROBE
      if (lab::render_probe_epoch.load() == state->epoch) {
        const auto delay = (std::min)(lab::render_delay_ms.exchange(0), std::uint32_t{1500});
        if (delay && WaitForSingleObject(state->stop.value, delay) == WAIT_OBJECT_0) break;
        if (lab::render_stop_client.exchange(false)) check(client->Stop(), WasapiOutputFailure::render_failed);
        if (lab::render_device_loss.exchange(false)) check(AUDCLNT_E_DEVICE_INVALIDATED, WasapiOutputFailure::device_lost);
      }
#endif
      UINT32 padding = 0;
      UINT64 position = 0, qpc = 0;
      check(client->GetCurrentPadding(&padding), WasapiOutputFailure::device_lost);
      check(clock->GetPosition(&position, &qpc), WasapiOutputFailure::device_lost);
      const auto now = timestamp();
      const auto decision = plan.observe({buffer_frames, padding, position, now});
      if (decision.invalid) throw Failure{WasapiOutputFailure::render_failed, E_UNEXPECTED};
      if (decision.no_progress) throw Failure{WasapiOutputFailure::no_progress, HRESULT_FROM_WIN32(WAIT_TIMEOUT)};
      if (decision.healthy && state->status == WasapiOutputState::starting) {
        state->status = WasapiOutputState::running;
        SetEvent(state->ready.value);
      }
      if (decision.delayed_wake || decision.underrun) { pending.reset(); cursor = 0; echo_filled = 0; }
      const auto count = decision.writable_frames;
      std::array<std::int16_t, kRemoteAudioTargetPadding * kRemoteAudioChannels> prepared{};
      const bool committed = state->committed.load(std::memory_order_acquire);
      const bool deafened = state->deafened.load(std::memory_order_acquire);
      const auto minimum = state->minimum_timestamp.load(std::memory_order_relaxed);
      for (std::uint32_t offset = 0; committed && offset < count;) {
        const auto scheduled = now + static_cast<std::int64_t>(padding + offset) * 10'000'000 / kRemoteAudioRate;
        if (pending && scheduled - pending->decoded_timestamp_100ns > kRemoteAudioMaximumAge100ns) {
          pending.reset(); cursor = 0; ++state->stale_fragments;
        }
        if (!pending) { pending = state->input->take(scheduled, minimum); cursor = 0; }
        if (!pending) break;
        const auto length = (std::min)(static_cast<std::size_t>(count - offset), kRemoteAudioFrames - cursor);
        const auto scheduled_end = now + static_cast<std::int64_t>(padding + offset + length - 1) * 10'000'000 / kRemoteAudioRate;
        const auto age = scheduled_end - pending->decoded_timestamp_100ns;
        if (age > kRemoteAudioMaximumAge100ns) {
          pending.reset(); cursor = 0; ++state->stale_fragments;
          continue;
        }
        if (!deafened) {
          std::copy_n(pending->samples.begin() + cursor * 2, length * 2, prepared.begin() + offset * 2);
          state->maximum_age = (std::max)(state->maximum_age.load(), age);
          const auto bucket = static_cast<std::size_t>((std::clamp)((age - 1) / 100'000, std::int64_t{0}, std::int64_t{6}));
          state->age_histogram[bucket].fetch_add(length, std::memory_order_relaxed);
        }
        offset += static_cast<std::uint32_t>(length);
        cursor += length;
        if (cursor == kRemoteAudioFrames) { pending.reset(); cursor = 0; }
      }
      if (count) {
        BYTE* destination = nullptr;
        testing::holdProductFault("output-render");
        check(render->GetBuffer(count, &destination), WasapiOutputFailure::render_failed);
        std::copy_n(prepared.begin(), static_cast<std::size_t>(count) * 2, reinterpret_cast<std::int16_t*>(destination));
        check(render->ReleaseBuffer(count, 0), WasapiOutputFailure::render_failed);
        if (!plan.released(count)) throw Failure{WasapiOutputFailure::render_failed, E_UNEXPECTED};
        // Reference is formed only from PCM whose ReleaseBuffer succeeded.
        for (std::uint32_t index = 0; committed && index < count; ++index) {
          if (!echo_filled) {
            echo.rendered_timestamp_100ns = timestamp();
            echo.stream_delay_ms = static_cast<std::uint32_t>(latency / 10'000) + (padding + index) / 48;
          }
          echo.samples[echo_filled++] = static_cast<std::int16_t>(
              (static_cast<std::int32_t>(prepared[index * 2]) + prepared[index * 2 + 1]) / 2);
          if (echo_filled == echo.samples.size()) {
            ++echo.sequence;
            if (state->echo->publish(echo)) ++state->echo_frames;
            echo_filled = 0;
          }
        }
      }
      const auto progress = plan.stats();
      state->submitted = progress.submitted_frames;
      state->consumed = progress.consumed_frames;
      state->padding = padding + count;
      state->underruns = progress.underruns;
      state->delayed_wakes = progress.delayed_wakes;
      state->maximum_wake_gap = progress.maximum_wake_gap_100ns;
    }
    state->status = WasapiOutputState::stopped;
  } catch (const Failure& failure) { state->fail(failure.code, failure.platform); }
    catch (...) { state->fail(WasapiOutputFailure::render_failed, E_UNEXPECTED); }
  state->echo->retire();
  state->input->retire();
  state->client_alive = false;
  state->thread_alive = false;
  SetEvent(state->ready.value);
  SetEvent(state->done.value);
}
}  // namespace syrnike::windows_media::audio
