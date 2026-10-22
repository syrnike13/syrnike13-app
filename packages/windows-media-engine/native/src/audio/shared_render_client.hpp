#pragma once

#include <windows.h>
#include <audioclient.h>
#include <wrl/client.h>

#include <cstdint>
#include <string>

namespace syrnike::windows_media::audio {
inline constexpr std::uint32_t kSharedRenderRate = 48'000;
inline constexpr std::uint32_t kSharedRenderChannels = 2;
// Callers write whole 10 ms periods of interleaved PCM16.
inline constexpr UINT32 kSharedRenderPeriodFrames = kSharedRenderRate / 100;

// One event-driven shared-mode PCM16 stereo render client in the product
// output session, owned by one render thread. open() leaves it started with
// its 20 ms buffer primed with silence; the destructor stops it.
struct SharedRenderClient {
  Microsoft::WRL::ComPtr<IAudioClient2> client;
  Microsoft::WRL::ComPtr<IAudioRenderClient> render;
  HANDLE event = nullptr;
  UINT32 buffer_frames = 0;
  std::uint32_t latency_ms = 0;
  bool started = false;
  SharedRenderClient() = default;
  SharedRenderClient(const SharedRenderClient&) = delete;
  SharedRenderClient& operator=(const SharedRenderClient&) = delete;
  ~SharedRenderClient();
  HRESULT open(const std::wstring& endpoint_id);
};
}  // namespace syrnike::windows_media::audio
