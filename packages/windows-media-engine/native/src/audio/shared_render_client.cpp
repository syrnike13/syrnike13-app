#include "audio/shared_render_client.hpp"

#include <mmdeviceapi.h>

namespace syrnike::windows_media::audio {
namespace {
using Microsoft::WRL::ComPtr;
// LiveKit disables its built-in playback through the default process session.
// Keep product output in a dedicated, stable session so device replacement
// preserves Windows mixer preferences without inheriting the SDK's mute.
constexpr GUID kOutputAudioSession{
    0x3a1665b2, 0xa3b5, 0x467c, {0x9b, 0x1c, 0x39, 0xf0, 0x46, 0x2f, 0xe3, 0x57}};
// 20 ms device buffer, written in whole 10 ms periods.
constexpr REFERENCE_TIME kDeviceBuffer100ns = 200'000;
}  // namespace

SharedRenderClient::~SharedRenderClient() {
  if (client && started) { (void)client->Stop(); (void)client->Reset(); }
  if (event) CloseHandle(event);
}

HRESULT SharedRenderClient::open(const std::wstring& endpoint_id) {
  ComPtr<IMMDeviceEnumerator> enumerator;
  HRESULT status = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
  ComPtr<IMMDevice> endpoint;
  if (SUCCEEDED(status)) status = enumerator->GetDevice(endpoint_id.c_str(), &endpoint);
  if (SUCCEEDED(status)) status = endpoint->Activate(__uuidof(IAudioClient2), CLSCTX_ALL, nullptr,
      reinterpret_cast<void**>(client.GetAddressOf()));
  if (SUCCEEDED(status)) {
    AudioClientProperties properties{};
    properties.cbSize = sizeof(properties);
    properties.eCategory = AudioCategory_Other;
    status = client->SetClientProperties(&properties);
  }
  WAVEFORMATEX format{WAVE_FORMAT_PCM, kSharedRenderChannels, kSharedRenderRate,
                      kSharedRenderRate * kSharedRenderChannels * 2, kSharedRenderChannels * 2, 16, 0};
  if (SUCCEEDED(status)) status = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
      kDeviceBuffer100ns, 0, &format, &kOutputAudioSession);
  if (SUCCEEDED(status)) {
    event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    status = event ? client->SetEventHandle(event) : HRESULT_FROM_WIN32(GetLastError());
  }
  if (SUCCEEDED(status)) status = client->GetService(IID_PPV_ARGS(&render));
  if (SUCCEEDED(status)) status = client->GetBufferSize(&buffer_frames);
  REFERENCE_TIME latency = 0;
  if (SUCCEEDED(status)) status = client->GetStreamLatency(&latency);
  if (SUCCEEDED(status) && buffer_frames < kSharedRenderPeriodFrames) status = AUDCLNT_E_BUFFER_SIZE_ERROR;
  if (SUCCEEDED(status)) {
    // Prime the whole buffer with silence so the first period cannot starve.
    BYTE* data = nullptr;
    status = render->GetBuffer(buffer_frames, &data);
    if (SUCCEEDED(status)) status = render->ReleaseBuffer(buffer_frames, AUDCLNT_BUFFERFLAGS_SILENT);
  }
  if (SUCCEEDED(status)) status = client->Start();
  if (FAILED(status)) return status;
  started = true;
  latency_ms = static_cast<std::uint32_t>(latency / 10'000);
  return S_OK;
}
}  // namespace syrnike::windows_media::audio
