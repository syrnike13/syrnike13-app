#pragma once
#include <livekit/livekit.h>
#include <windows.h>
#include <mmsystem.h>
#include <array>
#include <atomic>
#include <mutex>
#include <thread>

namespace syrnike::windows_media::lab {
// Reference playback only. This is deliberately outside production microphone
// and remote-render ownership; it proves the process exclusion at the OS mixer.
class ReferenceAudioPlayback {
  struct State {
    std::mutex mutex;
    std::array<std::array<std::int16_t, 960>, 8> queue{};
    std::size_t head = 0, depth = 0;
    std::atomic_bool stop{false}, failed{false};
    std::atomic_uint64_t received{0}, audible{0}, played{0};
  };

 public:
  explicit ReferenceAudioPlayback(std::shared_ptr<livekit::Room> room)
      : room_(std::move(room)), state_(std::make_shared<State>()) {
    const auto state = state_;
    worker_ = std::thread([state] { play(state); });
    livekit::AudioStream::Options options;
    options.capacity = 8;
    room_->setOnAudioFrameCallback(
        "remote-audio-reference", "reference-voice",
        [state](const livekit::AudioFrame& frame) {
          if (state->stop || frame.sampleRate() != 48000 || frame.samplesPerChannel() != 480 ||
              frame.numChannels() < 1 || frame.numChannels() > 2)
            return;
          std::scoped_lock lock(state->mutex);
          if (state->depth == state->queue.size()) {
            state->head = (state->head + 1) % state->queue.size();
            --state->depth;
          }
          auto& packet = state->queue[(state->head + state->depth) % state->queue.size()];
          for (std::size_t i = 0; i < 480; ++i)
            for (std::size_t channel = 0; channel < 2; ++channel)
              packet[i * 2 + channel] =
                  frame.data()[i * static_cast<std::size_t>(frame.numChannels()) +
                               (frame.numChannels() == 1 ? 0 : channel)];
          ++state->depth;
          ++state->received;
        },
        options);
    // The production transport intentionally disables automatic subscriptions.
    // This fixture was published before the native participant connected.
    for (const auto& weak : room_->remoteParticipants()) {
      if (const auto participant = weak.lock();
          participant && participant->identity() == "remote-audio-reference") {
        for (const auto& [sid, publication] : participant->trackPublications()) {
          if (publication->name() == "reference-voice") publication->setSubscribed(true);
        }
      }
    }
  }
  ~ReferenceAudioPlayback() {
    room_->clearOnAudioFrameCallback("remote-audio-reference", "reference-voice");
    state_->stop = true;
    if (worker_.joinable()) worker_.join();
  }
  std::uint64_t audiblePackets() const noexcept { return state_->audible; }
  std::uint64_t playedSamples() const noexcept { return state_->played; }
  bool failed() const noexcept { return state_->failed; }

 private:
  static void play(const std::shared_ptr<State>& state) noexcept {
    HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    HWAVEOUT device = nullptr;
    WAVEFORMATEX format{WAVE_FORMAT_PCM, 2, 48000, 192000, 4, 16, 0};
    if (!event || waveOutOpen(&device, WAVE_MAPPER, &format, reinterpret_cast<DWORD_PTR>(event), 0,
                              CALLBACK_EVENT) != MMSYSERR_NOERROR) {
      if (event) CloseHandle(event);
      state->failed = true;
      return;
    }
    std::array<std::array<std::int16_t, 960>, 4> buffers{};
    std::array<WAVEHDR, 4> headers{};
    std::array<bool, 4> submitted{};
    std::size_t prepared = 0;
    for (std::size_t i = 0; i < headers.size(); ++i) {
      headers[i].lpData = reinterpret_cast<LPSTR>(buffers[i].data());
      headers[i].dwBufferLength = 1920;
      if (waveOutPrepareHeader(device, &headers[i], sizeof(WAVEHDR)) != MMSYSERR_NOERROR) {
        state->failed = true;
        break;
      }
      ++prepared;
    }
    while (!state->stop && !state->failed) {
      for (std::size_t i = 0; i < prepared; ++i) {
        if (submitted[i] && !(headers[i].dwFlags & WHDR_DONE)) continue;
        buffers[i].fill(0);
        {
          std::scoped_lock lock(state->mutex);
          if (state->depth) {
            buffers[i] = state->queue[state->head];
            state->head = (state->head + 1) % state->queue.size();
            --state->depth;
          }
        }
        bool audible = false;
        for (const auto sample : buffers[i])
          if (sample > 200 || sample < -200) {
            audible = true;
            break;
          }
        if (waveOutWrite(device, &headers[i], sizeof(WAVEHDR)) != MMSYSERR_NOERROR) {
          state->failed = true;
          break;
        }
        if (audible) ++state->audible;
        submitted[i] = true;
      }
      MMTIME position{};
      position.wType = TIME_SAMPLES;
      if (waveOutGetPosition(device, &position, sizeof(position)) == MMSYSERR_NOERROR &&
          position.wType == TIME_SAMPLES)
        state->played = position.u.sample;
      (void)WaitForSingleObject(event, 20);
    }
    (void)waveOutReset(device);
    for (std::size_t i = 0; i < prepared; ++i)
      (void)waveOutUnprepareHeader(device, &headers[i], sizeof(WAVEHDR));
    (void)waveOutClose(device);
    CloseHandle(event);
  }
  std::shared_ptr<livekit::Room> room_;
  std::shared_ptr<State> state_;
  std::thread worker_;
};
}  // namespace syrnike::windows_media::lab
