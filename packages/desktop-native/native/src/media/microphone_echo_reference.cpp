#include "microphone_echo_reference.hpp"

#include <audioclient.h>
#include <avrt.h>
#include <windows.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <stdexcept>
#include <utility>

#include "audio_constants.hpp"
#include "audio_devices.hpp"

using Microsoft::WRL::ComPtr;

namespace syrnike::voice {
namespace {

constexpr int kEchoReferenceChannels = 2;
constexpr std::size_t kMaxReferenceFrames = 50;
constexpr REFERENCE_TIME kEchoReferenceBufferDurationHns = 400'000;
constexpr auto kInitialRetryDelay = std::chrono::milliseconds(250);
constexpr auto kMaximumRetryDelay = std::chrono::milliseconds(5'000);

std::int16_t floatToPcm16(float value) {
  const float clamped = std::clamp(value, -1.0f, 1.0f);
  return static_cast<std::int16_t>(std::lrint(clamped * 32767.0f));
}

WAVEFORMATEX desiredEchoReferenceFormat() {
  WAVEFORMATEX format{};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = kEchoReferenceChannels;
  format.nSamplesPerSec = kSampleRate;
  format.wBitsPerSample = 32;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  return format;
}

}  // namespace

MicrophoneEchoReferenceBuffer::MicrophoneEchoReferenceBuffer(std::size_t max_frames)
  : max_frames_(std::clamp<std::size_t>(max_frames, 1, kSlotCapacity)) {}

void MicrophoneEchoReferenceBuffer::pushInterleavedFloatStereo(
  const float* samples,
  std::size_t frames,
  bool silent
) {
  for (std::size_t index = 0; index < frames; ++index) {
    const float mono = silent || samples == nullptr
      ? 0.0f
      : (samples[index * 2] + samples[index * 2 + 1]) * 0.5f;
    pending_mono_[pending_samples_++] = mono;

    if (pending_samples_ == kSamplesPer10Ms) {
      MicrophoneEchoReferenceFrame next;
      for (std::size_t sample = 0; sample < pending_samples_; ++sample) {
        next.pcm[sample] = floatToPcm16(pending_mono_[sample]);
      }
      pending_samples_ = 0;
      auto timestamp_us = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::steady_clock::now().time_since_epoch()
        ).count()
      );
      timestamp_us = std::max(timestamp_us, last_timestamp_us_ + 1);
      last_timestamp_us_ = timestamp_us;
      next.discontinuity = std::exchange(discontinuity_pending_, false);
      next.sequence = ++next_sequence_;
      next.timestamp_us = timestamp_us;

      Slot* selected = nullptr;
      for (std::size_t slot_index = 0; slot_index < max_frames_; ++slot_index) {
        auto expected = SlotState::Empty;
        if (slots_[slot_index].state.compare_exchange_strong(
              expected, SlotState::Writing, std::memory_order_acq_rel)) {
          selected = &slots_[slot_index];
          queued_frames_.fetch_add(1, std::memory_order_relaxed);
          break;
        }
      }
      if (!selected) {
        Slot* oldest = nullptr;
        std::uint64_t oldest_sequence = UINT64_MAX;
        for (std::size_t slot_index = 0; slot_index < max_frames_; ++slot_index) {
          auto& slot = slots_[slot_index];
          const auto sequence = slot.sequence.load(std::memory_order_acquire);
          if (slot.state.load(std::memory_order_acquire) == SlotState::Ready &&
              sequence < oldest_sequence) {
            oldest = &slot;
            oldest_sequence = sequence;
          }
        }
        if (oldest) {
          auto expected = SlotState::Ready;
          if (oldest->state.compare_exchange_strong(
                expected, SlotState::Writing, std::memory_order_acq_rel)) {
            selected = oldest;
            consumer_discontinuity_pending_.store(
              true, std::memory_order_release
            );
            discontinuities_.fetch_add(1, std::memory_order_relaxed);
            dropped_frames_.fetch_add(1, std::memory_order_relaxed);
          }
        }
      }
      if (!selected) {
        discontinuity_pending_ = true;
        consumer_discontinuity_pending_.store(true, std::memory_order_release);
        discontinuities_.fetch_add(1, std::memory_order_relaxed);
        dropped_frames_.fetch_add(1, std::memory_order_relaxed);
        continue;
      }
      selected->frame = next;
      selected->generation = generation_.load(std::memory_order_acquire);
      selected->sequence.store(next.sequence, std::memory_order_release);
      selected->state.store(SlotState::Ready, std::memory_order_release);
    }
  }
}

void MicrophoneEchoReferenceBuffer::markDiscontinuity() {
  pending_samples_ = 0;
  generation_.fetch_add(1, std::memory_order_acq_rel);
  for (std::size_t slot_index = 0; slot_index < max_frames_; ++slot_index) {
    auto expected = SlotState::Ready;
    if (slots_[slot_index].state.compare_exchange_strong(
          expected, SlotState::Empty, std::memory_order_acq_rel)) {
      queued_frames_.fetch_sub(1, std::memory_order_relaxed);
      dropped_frames_.fetch_add(1, std::memory_order_relaxed);
    }
  }
  discontinuity_pending_ = true;
  consumer_discontinuity_pending_.store(true, std::memory_order_release);
  discontinuities_.fetch_add(1, std::memory_order_relaxed);
}

std::optional<MicrophoneEchoReferenceFrame> MicrophoneEchoReferenceBuffer::popFrame() {
  for (;;) {
    Slot* oldest = nullptr;
    std::uint64_t oldest_sequence = UINT64_MAX;
    for (std::size_t slot_index = 0; slot_index < max_frames_; ++slot_index) {
      auto& slot = slots_[slot_index];
      const auto sequence = slot.sequence.load(std::memory_order_acquire);
      if (slot.state.load(std::memory_order_acquire) == SlotState::Ready &&
          sequence < oldest_sequence) {
        oldest = &slot;
        oldest_sequence = sequence;
      }
    }
    if (!oldest) return std::nullopt;
    auto expected = SlotState::Ready;
    if (!oldest->state.compare_exchange_strong(
          expected, SlotState::Reading, std::memory_order_acq_rel)) {
      continue;
    }
    // The producer may replace a Ready slot between the consumer's sequence
    // and state loads. Once this candidate is Reading its sequence is stable;
    // validate that no older Ready frame remains before exposing it.
    const auto selected_sequence =
      oldest->sequence.load(std::memory_order_acquire);
    bool older_ready = false;
    for (std::size_t slot_index = 0; slot_index < max_frames_; ++slot_index) {
      auto& slot = slots_[slot_index];
      if (&slot == oldest) continue;
      if (slot.state.load(std::memory_order_acquire) == SlotState::Ready &&
          slot.sequence.load(std::memory_order_acquire) < selected_sequence) {
        older_ready = true;
        break;
      }
    }
    if (older_ready) {
      oldest->state.store(SlotState::Ready, std::memory_order_release);
      continue;
    }
    auto frame = oldest->frame;
    const auto frame_generation = oldest->generation;
    oldest->state.store(SlotState::Empty, std::memory_order_release);
    queued_frames_.fetch_sub(1, std::memory_order_relaxed);
    if (frame_generation != generation_.load(std::memory_order_acquire)) {
      dropped_frames_.fetch_add(1, std::memory_order_relaxed);
      continue;
    }
    frame.discontinuity = frame.discontinuity ||
      consumer_discontinuity_pending_.exchange(
        false, std::memory_order_acq_rel
      );
    return frame;
  }
}

std::size_t MicrophoneEchoReferenceBuffer::queuedFrames() const {
  return queued_frames_.load(std::memory_order_acquire);
}

std::uint64_t MicrophoneEchoReferenceBuffer::discontinuities() const {
  return discontinuities_.load(std::memory_order_acquire);
}

std::uint64_t MicrophoneEchoReferenceBuffer::droppedFrames() const {
  return dropped_frames_.load(std::memory_order_acquire);
}

MicrophoneEchoReference::MicrophoneEchoReference(
  CaptureAttempt capture_attempt
) : buffer_(kMaxReferenceFrames),
    capture_attempt_(std::move(capture_attempt)) {}

MicrophoneEchoReference::~MicrophoneEchoReference() {
  stop();
}

void MicrophoneEchoReference::start(std::string render_device_id) {
  std::lock_guard<std::mutex> lock(lifecycle_mutex_);
  if (running_.load()) return;
  if (thread_.joinable()) thread_.join();

  events_ = std::make_shared<
    syrnike::desktop_native::media::WasapiEventPair>();
  running_.store(true);
  setStatus(false, "starting");
  try {
    thread_ = std::thread(
      &MicrophoneEchoReference::captureLoop,
      this,
      std::move(render_device_id),
      events_
    );
  } catch (...) {
    running_.store(false);
    events_.reset();
    setStatus(false, "start_failed");
  }
}

void MicrophoneEchoReference::stop() {
  std::lock_guard<std::mutex> lock(lifecycle_mutex_);
  if (!running_.exchange(false) && !thread_.joinable()) {
    setStatus(false, "stopped");
    return;
  }
  if (events_) events_->requestStop();
  if (thread_.joinable()) thread_.join();
  events_.reset();
  setStatus(false, "stopped");
}

std::optional<MicrophoneEchoReferenceFrame> MicrophoneEchoReference::popFrame() {
  return buffer_.popFrame();
}

MicrophoneEchoReferenceRealtimeFrame
MicrophoneEchoReference::pollRealtimeFrame() {
  MicrophoneEchoReferenceRealtimeFrame result;
  result.frame = buffer_.popFrame();
  result.queued_frames = buffer_.queuedFrames();
  result.available = realtime_available_.load(std::memory_order_acquire);
  result.render_latency_ms =
    realtime_render_latency_ms_.load(std::memory_order_acquire);
  result.device_position =
    realtime_device_position_.load(std::memory_order_acquire);
  result.qpc_position_100ns =
    realtime_qpc_position_100ns_.load(std::memory_order_acquire);
  result.timing_valid = realtime_timing_valid_.load(std::memory_order_acquire);
  return result;
}

std::size_t MicrophoneEchoReference::queuedFrames() const {
  return buffer_.queuedFrames();
}

MicrophoneEchoReferenceStatus MicrophoneEchoReference::status() const {
  MicrophoneEchoReferenceStatus result;
  {
    std::lock_guard<std::mutex> lock(status_mutex_);
    result = status_;
  }
  result.render_latency_ms =
    realtime_render_latency_ms_.load(std::memory_order_acquire);
  result.device_position =
    realtime_device_position_.load(std::memory_order_acquire);
  result.qpc_position_100ns =
    realtime_qpc_position_100ns_.load(std::memory_order_acquire);
  result.timing_valid = realtime_timing_valid_.load(std::memory_order_acquire);
  result.discontinuities = buffer_.discontinuities();
  result.dropped_frames = buffer_.droppedFrames();
  return result;
}

bool MicrophoneEchoReference::waitForAvailable(
  std::chrono::milliseconds timeout
) const {
  std::unique_lock lock(status_mutex_);
  return status_changed_.wait_for(lock, timeout, [&] {
    return status_.available;
  });
}

void MicrophoneEchoReference::setStatus(
  bool available,
  std::string reason,
  int render_latency_ms
) {
  realtime_render_latency_ms_.store(render_latency_ms, std::memory_order_release);
  realtime_timing_valid_.store(false, std::memory_order_release);
  realtime_available_.store(available, std::memory_order_release);
  {
    std::lock_guard<std::mutex> lock(status_mutex_);
    status_.available = available;
    status_.reason = std::move(reason);
    status_.render_latency_ms = render_latency_ms;
    status_.discontinuities = buffer_.discontinuities();
    status_.dropped_frames = buffer_.droppedFrames();
    status_.timing_valid = false;
  }
  status_changed_.notify_all();
}

void MicrophoneEchoReference::updateTiming(
  std::uint64_t device_position,
  std::uint64_t qpc_position
) {
  realtime_device_position_.store(device_position, std::memory_order_relaxed);
  realtime_qpc_position_100ns_.store(qpc_position, std::memory_order_relaxed);
  realtime_timing_valid_.store(true, std::memory_order_release);
}

void MicrophoneEchoReference::captureLoop(
  std::string render_device_id,
  std::shared_ptr<syrnike::desktop_native::media::WasapiEventPair> events
) {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool com_initialized = SUCCEEDED(hr);

  DWORD task_index = 0;
  HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);

  auto retry_delay = kInitialRetryDelay;
  std::size_t attempt_index = 0;
  while (running_.load()) {
    if (capture_attempt_) {
      try {
        capture_attempt_(attempt_index++);
        retry_delay = kInitialRetryDelay;
        setStatus(true, {});
        static_cast<void>(WaitForSingleObject(events->stopRequestedHandle(), INFINITE));
        break;
      } catch (const std::exception& error) {
        buffer_.markDiscontinuity();
        setStatus(false, error.what());
      } catch (...) {
        buffer_.markDiscontinuity();
        setStatus(false, "capture_failed");
      }
      if (!running_.load()) break;
      if (WaitForSingleObject(
            events->stopRequestedHandle(),
            static_cast<DWORD>(retry_delay.count())) == WAIT_OBJECT_0) {
        break;
      }
      retry_delay = std::min(kMaximumRetryDelay, retry_delay * 2);
      continue;
    }
    try {
      ResetEvent(events->audioReadyHandle());
      ComPtr<IMMDevice> render_device =
        syrnike::desktop_native::media::renderDevice(render_device_id);
      ComPtr<IAudioClient> audio_client;
      hr = render_device->Activate(
        __uuidof(IAudioClient),
        CLSCTX_ALL,
        nullptr,
        reinterpret_cast<void**>(audio_client.GetAddressOf())
      );
      if (FAILED(hr)) throw std::runtime_error("failed to activate echo reference client");

      WAVEFORMATEX format = desiredEchoReferenceFormat();
      hr = audio_client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK |
          AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
          AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
          AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        kEchoReferenceBufferDurationHns,
        0,
        &format,
        nullptr
      );
      if (FAILED(hr)) throw std::runtime_error("failed to initialize echo reference stream");
      hr = audio_client->SetEventHandle(events->audioReadyHandle());
      if (FAILED(hr)) throw std::runtime_error("failed to set echo reference event");

      ComPtr<IAudioCaptureClient> capture_client;
      hr = audio_client->GetService(IID_PPV_ARGS(&capture_client));
      if (FAILED(hr)) throw std::runtime_error("failed to open echo reference capture client");

      REFERENCE_TIME stream_latency = 0;
      if (FAILED(audio_client->GetStreamLatency(&stream_latency))) {
        stream_latency = 0;
      }
      const int render_latency_ms = static_cast<int>(
        std::clamp<REFERENCE_TIME>(
          stream_latency / 10'000,
          0,
          500
        )
      );

      hr = audio_client->Start();
      if (FAILED(hr)) throw std::runtime_error("failed to start echo reference stream");

      retry_delay = kInitialRetryDelay;
      setStatus(true, {}, render_latency_ms);

      bool stream_failed = false;
      while (running_.load() && !stream_failed) {
        const auto wait_result = events->wait(1'000);
        if (wait_result ==
            syrnike::desktop_native::media::WasapiEventPair::WaitResult::StopRequested) {
          break;
        }
        if (wait_result ==
            syrnike::desktop_native::media::WasapiEventPair::WaitResult::TimedOut) {
          continue;
        }

        for (;;) {
          UINT32 packet_frames = 0;
          hr = capture_client->GetNextPacketSize(&packet_frames);
          if (FAILED(hr)) {
            stream_failed = true;
            break;
          }
          if (packet_frames == 0) break;

          BYTE* data = nullptr;
          UINT32 frames = 0;
          DWORD flags = 0;
          UINT64 device_position = 0;
          UINT64 qpc_position = 0;
          hr = capture_client->GetBuffer(
            &data,
            &frames,
            &flags,
            &device_position,
            &qpc_position
          );
          if (FAILED(hr)) {
            stream_failed = true;
            break;
          }

          if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0) {
            buffer_.markDiscontinuity();
          }
          updateTiming(device_position, qpc_position);
          const auto* samples = reinterpret_cast<const float*>(data);
          buffer_.pushInterleavedFloatStereo(
            samples,
            frames,
            (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == nullptr
          );
          const auto release_result = capture_client->ReleaseBuffer(frames);
          if (FAILED(release_result)) {
            stream_failed = true;
            break;
          }
        }
      }

      audio_client->Stop();
      if (!running_.load()) break;
      buffer_.markDiscontinuity();
      setStatus(false, "capture_failed");
    } catch (const std::exception& error) {
      buffer_.markDiscontinuity();
      setStatus(false, error.what());
    }

    if (!running_.load()) break;
    if (WaitForSingleObject(
          events->stopRequestedHandle(),
          static_cast<DWORD>(retry_delay.count())) == WAIT_OBJECT_0) {
      break;
    }
    retry_delay = std::min(kMaximumRetryDelay, retry_delay * 2);
  }

  if (avrt) AvRevertMmThreadCharacteristics(avrt);
  if (com_initialized) CoUninitialize();
}

}  // namespace syrnike::voice
