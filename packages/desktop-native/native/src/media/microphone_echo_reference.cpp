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
  : max_frames_(std::max<std::size_t>(1, max_frames)) {}

void MicrophoneEchoReferenceBuffer::pushInterleavedFloatStereo(
  const float* samples,
  std::size_t frames,
  bool silent
) {
  std::lock_guard<std::mutex> lock(mutex_);
  for (std::size_t index = 0; index < frames; ++index) {
    const float mono = silent || samples == nullptr
      ? 0.0f
      : (samples[index * 2] + samples[index * 2 + 1]) * 0.5f;
    pending_mono_.push_back(mono);

    if (pending_mono_.size() == kSamplesPer10Ms) {
      std::vector<std::int16_t> frame;
      frame.reserve(kSamplesPer10Ms);
      for (float sample : pending_mono_) {
        frame.push_back(floatToPcm16(sample));
      }
      pending_mono_.clear();
      if (frames_.size() >= max_frames_) {
        discontinuity_pending_ = true;
        discontinuities_ += 1;
        continue;
      }
      frames_.push_back(MicrophoneEchoReferenceFrame{
        .pcm = std::move(frame),
        .discontinuity = std::exchange(discontinuity_pending_, false),
      });
    }
  }
}

void MicrophoneEchoReferenceBuffer::markDiscontinuity() {
  std::lock_guard<std::mutex> lock(mutex_);
  pending_mono_.clear();
  discontinuity_pending_ = true;
  discontinuities_ += 1;
}

std::optional<MicrophoneEchoReferenceFrame> MicrophoneEchoReferenceBuffer::popFrame() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (frames_.empty()) return std::nullopt;
  auto frame = std::move(frames_.front());
  frames_.erase(frames_.begin());
  return frame;
}

std::size_t MicrophoneEchoReferenceBuffer::queuedFrames() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return frames_.size();
}

std::uint64_t MicrophoneEchoReferenceBuffer::discontinuities() const {
  std::lock_guard<std::mutex> lock(mutex_);
  return discontinuities_;
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

std::size_t MicrophoneEchoReference::queuedFrames() const {
  return buffer_.queuedFrames();
}

MicrophoneEchoReferenceStatus MicrophoneEchoReference::status() const {
  std::lock_guard<std::mutex> lock(status_mutex_);
  return status_;
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
  {
    std::lock_guard<std::mutex> lock(status_mutex_);
    status_.available = available;
    status_.reason = std::move(reason);
    status_.render_latency_ms = render_latency_ms;
    status_.discontinuities = buffer_.discontinuities();
    status_.timing_valid = false;
  }
  status_changed_.notify_all();
}

void MicrophoneEchoReference::updateTiming(
  std::uint64_t device_position,
  std::uint64_t qpc_position
) {
  std::lock_guard lock(status_mutex_);
  status_.device_position = device_position;
  status_.qpc_position_100ns = qpc_position;
  status_.timing_valid = true;
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
