#include "audio/microphone_monitor.hpp"
#include "audio/shared_render_client.hpp"

#include <avrt.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <stdexcept>

namespace syrnike::windows_media::audio {
namespace {
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
constexpr auto kDeviceRetry = 2s;
// Frames waiting beyond the device buffer. A late wake drops the oldest ones
// so the user hears themselves within tens of milliseconds, never seconds.
constexpr std::uint32_t kMaximumQueuedFrames = 2;
static_assert(kMicrophoneRate == kSharedRenderRate && kMicrophoneFrameSamples == kSharedRenderPeriodFrames,
              "Monitor frames must match the render client period");

struct Apartment {
  HRESULT result = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  ~Apartment() { if (SUCCEEDED(result)) CoUninitialize(); }
};
struct Mmcss {
  DWORD task = 0;
  HANDLE value = AvSetMmThreadCharacteristicsW(L"Audio", &task);
  ~Mmcss() { if (value) AvRevertMmThreadCharacteristics(value); }
};
}  // namespace

MicrophoneMonitor::MicrophoneMonitor(AudioEndpoint endpoint, std::shared_ptr<MicrophonePcmPort> source, float volume)
    : endpoint_(std::move(endpoint)), source_(std::move(source)), volume_(volume),
      stop_event_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
  if (!stop_event_) throw std::runtime_error("Microphone monitor event creation failed");
  if (!source_ || endpoint_.direction != AudioDirection::output || endpoint_.endpoint_id.empty()) {
    CloseHandle(stop_event_);
    throw std::invalid_argument("Microphone monitor needs an output endpoint and a source");
  }
  worker_ = std::thread([this] { run(); });
}
MicrophoneMonitor::~MicrophoneMonitor() {
  SetEvent(stop_event_);
  if (worker_.joinable()) worker_.join();
  CloseHandle(stop_event_);
}
MicrophoneMonitorStats MicrophoneMonitor::stats() const noexcept {
  return {
      rendered_frames_.load(std::memory_order_relaxed),
      silent_frames_.load(std::memory_order_relaxed),
      dropped_frames_.load(std::memory_order_relaxed),
      device_opens_.load(std::memory_order_relaxed),
      device_platform_result_.load(std::memory_order_relaxed),
      device_open_.load(std::memory_order_relaxed),
  };
}

void MicrophoneMonitor::run() noexcept {
  try {
    Apartment apartment;
    Mmcss mmcss;  // Scheduling hint only; absent when the MMCSS service is disabled.
    std::unique_ptr<SharedRenderClient> device;
    auto retry_at = Clock::now();
    for (;;) {
      const HANDLE events[]{stop_event_, device ? device->event : nullptr};
      const auto wake = WaitForMultipleObjects(device ? 2 : 1, events, FALSE, device ? 50 : 10);
      if (wake == WAIT_OBJECT_0 || wake == WAIT_FAILED) break;
      if (!device) {
        // Frames produced while no device renders are never heard later.
        while (source_->take()) dropped_frames_.fetch_add(1, std::memory_order_relaxed);
        if (Clock::now() < retry_at) continue;
        device = std::make_unique<SharedRenderClient>();
        const auto status = device->open(endpoint_.endpoint_id);
        if (FAILED(status)) {
          device.reset();
          device_platform_result_.store(status, std::memory_order_relaxed);
          retry_at = Clock::now() + kDeviceRetry;
          continue;
        }
        device_opens_.fetch_add(1, std::memory_order_relaxed);
        device_open_.store(true, std::memory_order_relaxed);
      }
      while (source_->pendingFrames() > kMaximumQueuedFrames && source_->take())
        dropped_frames_.fetch_add(1, std::memory_order_relaxed);
      UINT32 padding = 0;
      HRESULT status = device->client->GetCurrentPadding(&padding);
      while (SUCCEEDED(status) && device->buffer_frames - padding >= kMicrophoneFrameSamples) {
        const auto frame = source_->take();
        // Keep one period queued so the device never starves between frames;
        // beyond that, wait for speech instead of stacking silence.
        if (!frame && padding >= kMicrophoneFrameSamples) break;
        BYTE* data = nullptr;
        status = device->render->GetBuffer(static_cast<UINT32>(kMicrophoneFrameSamples), &data);
        if (FAILED(status)) break;
        if (frame) {
          const float volume = volume_.load(std::memory_order_relaxed);
          auto* output = reinterpret_cast<std::int16_t*>(data);
          for (std::size_t index = 0; index < kMicrophoneFrameSamples; ++index) {
            const auto sample = static_cast<std::int16_t>(std::lround((std::clamp)(
                static_cast<float>(frame->samples[index]) * volume, -32768.0f, 32767.0f)));
            output[index * kSharedRenderChannels] = sample;
            output[index * kSharedRenderChannels + 1] = sample;
          }
          status = device->render->ReleaseBuffer(static_cast<UINT32>(kMicrophoneFrameSamples), 0);
          rendered_frames_.fetch_add(1, std::memory_order_relaxed);
        } else {
          status = device->render->ReleaseBuffer(static_cast<UINT32>(kMicrophoneFrameSamples),
                                                 AUDCLNT_BUFFERFLAGS_SILENT);
          silent_frames_.fetch_add(1, std::memory_order_relaxed);
        }
        padding += static_cast<UINT32>(kMicrophoneFrameSamples);
      }
      if (FAILED(status)) {
        device_platform_result_.store(status, std::memory_order_relaxed);
        device.reset();
        device_open_.store(false, std::memory_order_relaxed);
        retry_at = Clock::now() + 250ms;
      }
    }
  } catch (...) {}
  device_open_.store(false, std::memory_order_relaxed);
}
}  // namespace syrnike::windows_media::audio
