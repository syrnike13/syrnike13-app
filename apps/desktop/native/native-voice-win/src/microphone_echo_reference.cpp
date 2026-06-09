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
      frames_.push_back(std::move(frame));
      pending_mono_.clear();
      while (frames_.size() > max_frames_) {
        frames_.erase(frames_.begin());
      }
    }
  }
}

std::optional<std::vector<std::int16_t>> MicrophoneEchoReferenceBuffer::popFrame() {
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

MicrophoneEchoReference::MicrophoneEchoReference()
  : buffer_(kMaxReferenceFrames) {}

MicrophoneEchoReference::~MicrophoneEchoReference() {
  stop();
}

void MicrophoneEchoReference::start() {
  bool expected = false;
  if (!running_.compare_exchange_strong(expected, true)) return;
  setStatus(false, "starting");
  thread_ = std::thread(&MicrophoneEchoReference::captureLoop, this);
}

void MicrophoneEchoReference::stop() {
  if (!running_.exchange(false) && !thread_.joinable()) return;
  if (thread_.joinable()) thread_.join();
  setStatus(false, "stopped");
}

std::optional<std::vector<std::int16_t>> MicrophoneEchoReference::popFrame() {
  return buffer_.popFrame();
}

MicrophoneEchoReferenceStatus MicrophoneEchoReference::status() const {
  std::lock_guard<std::mutex> lock(status_mutex_);
  return status_;
}

void MicrophoneEchoReference::setStatus(bool available, std::string reason) {
  std::lock_guard<std::mutex> lock(status_mutex_);
  status_.available = available;
  status_.reason = std::move(reason);
}

void MicrophoneEchoReference::captureLoop() {
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool com_initialized = SUCCEEDED(hr);

  DWORD task_index = 0;
  HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task_index);

  try {
    ComPtr<IMMDevice> render_device = getRenderDevice();
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
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
        AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
      kBufferDurationHns,
      0,
      &format,
      nullptr
    );
    if (FAILED(hr)) throw std::runtime_error("failed to initialize echo reference stream");

    ComPtr<IAudioCaptureClient> capture_client;
    hr = audio_client->GetService(IID_PPV_ARGS(&capture_client));
    if (FAILED(hr)) throw std::runtime_error("failed to open echo reference capture client");

    hr = audio_client->Start();
    if (FAILED(hr)) throw std::runtime_error("failed to start echo reference stream");

    setStatus(true, {});

    while (running_.load()) {
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

      const auto* samples = reinterpret_cast<const float*>(data);
      buffer_.pushInterleavedFloatStereo(
        samples,
        frames,
        (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == nullptr
      );
      capture_client->ReleaseBuffer(frames);
    }

    audio_client->Stop();
    if (running_.load()) {
      setStatus(false, "capture_failed");
    }
  } catch (const std::exception& error) {
    setStatus(false, error.what());
  }

  running_.store(false);
  if (avrt) AvRevertMmThreadCharacteristics(avrt);
  if (com_initialized) CoUninitialize();
}

}  // namespace syrnike::voice
