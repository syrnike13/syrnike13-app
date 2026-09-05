#pragma once
#include <windows.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace syrnike::windows_media::lab {
// Read-only observation. Never changes another application's volume, category,
// mute state, ducking preference, or default endpoint.
class AudioSessionVolumeProbe {
  template <class T>
  using ComPtr = Microsoft::WRL::ComPtr<T>;
  struct Sample {
    ComPtr<ISimpleAudioVolume> volume;
    float level;
    BOOL muted;
  };
  struct ComScope {
    ComScope() {
      if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED)))
        throw std::runtime_error("Audio session probe COM initialization failed");
    }
    ~ComScope() { CoUninitialize(); }
  };

 public:
  AudioSessionVolumeProbe() {
    ComPtr<IMMDeviceEnumerator> enumerator;
    check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                           IID_PPV_ARGS(&enumerator)));
    ComPtr<IMMDeviceCollection> devices;
    check(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices));
    UINT count = 0;
    check(devices->GetCount(&count));
    for (UINT i = 0; i < count; ++i) {
      ComPtr<IMMDevice> device;
      check(devices->Item(i, &device));
      ComPtr<IAudioSessionManager2> manager;
      check(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, &manager));
      ComPtr<IAudioSessionEnumerator> sessions;
      check(manager->GetSessionEnumerator(&sessions));
      int session_count = 0;
      check(sessions->GetCount(&session_count));
      for (int index = 0; index < session_count; ++index) {
        ComPtr<IAudioSessionControl> session;
        check(sessions->GetSession(index, &session));
        ComPtr<IAudioSessionControl2> control;
        check(session.As(&control));
        DWORD pid = 0;
        check(control->GetProcessId(&pid));
        AudioSessionState state{};
        check(control->GetState(&state));
        if (pid == GetCurrentProcessId() || state != AudioSessionStateActive) continue;
        Sample sample{};
        check(session.As(&sample.volume));
        check(sample.volume->GetMasterVolume(&sample.level));
        check(sample.volume->GetMute(&sample.muted));
        if (samples_.size() >= 128) throw std::runtime_error("Session probe capacity exceeded");
        samples_.push_back(std::move(sample));
      }
    }
  }
  ~AudioSessionVolumeProbe() = default;
  AudioSessionVolumeProbe(const AudioSessionVolumeProbe&) = delete;
  AudioSessionVolumeProbe& operator=(const AudioSessionVolumeProbe&) = delete;
  void observe() {
    for (const auto& sample : samples_) {
      float level = 0;
      BOOL muted = FALSE;
      check(sample.volume->GetMasterVolume(&level));
      check(sample.volume->GetMute(&muted));
      if (std::abs(level - sample.level) > 0.0001f || muted != sample.muted)
        throw std::runtime_error("Foreign session volume or mute changed during capture");
    }
    ++observations_;
  }
  std::size_t sessions() const noexcept { return samples_.size(); }
  std::uint64_t observations() const noexcept { return observations_; }

 private:
  static void check(HRESULT result) {
    if (FAILED(result)) throw std::runtime_error("Audio session volume observation failed");
  }
  ComScope com_;
  std::vector<Sample> samples_;
  std::uint64_t observations_ = 0;
};
}  // namespace syrnike::windows_media::lab
