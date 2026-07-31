#pragma once

#include <windows.h>

#include <stdexcept>
#include <system_error>

namespace syrnike::desktop_native::media {

class WasapiEventPair final {
 public:
  enum class WaitResult {
    AudioReady,
    StopRequested,
    TimedOut,
  };

  WasapiEventPair()
    : audio_ready_(CreateEventW(nullptr, FALSE, FALSE, nullptr)),
      stop_requested_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
    if (!audio_ready_ || !stop_requested_) {
      const auto error = GetLastError();
      close();
      throw std::system_error(
        static_cast<int>(error),
        std::system_category(),
        "create WASAPI stream events"
      );
    }
  }

  ~WasapiEventPair() { close(); }

  WasapiEventPair(const WasapiEventPair&) = delete;
  WasapiEventPair& operator=(const WasapiEventPair&) = delete;

  [[nodiscard]] HANDLE audioReadyHandle() const noexcept { return audio_ready_; }
  [[nodiscard]] HANDLE stopRequestedHandle() const noexcept {
    return stop_requested_;
  }

  void requestStop() noexcept {
    if (stop_requested_) SetEvent(stop_requested_);
  }

  [[nodiscard]] WaitResult wait(DWORD timeout_ms = INFINITE) const {
    const HANDLE handles[] = {stop_requested_, audio_ready_};
    const auto result = WaitForMultipleObjects(2, handles, FALSE, timeout_ms);
    if (result == WAIT_OBJECT_0) return WaitResult::StopRequested;
    if (result == WAIT_OBJECT_0 + 1) return WaitResult::AudioReady;
    if (result == WAIT_TIMEOUT) return WaitResult::TimedOut;
    throw std::system_error(
      static_cast<int>(GetLastError()),
      std::system_category(),
      "wait for WASAPI stream event"
    );
  }

 private:
  void close() noexcept {
    if (audio_ready_) {
      CloseHandle(audio_ready_);
      audio_ready_ = nullptr;
    }
    if (stop_requested_) {
      CloseHandle(stop_requested_);
      stop_requested_ = nullptr;
    }
  }

  HANDLE audio_ready_ = nullptr;
  HANDLE stop_requested_ = nullptr;
};

}  // namespace syrnike::desktop_native::media
