#include <windows.h>
#include <mmsystem.h>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <string>
#include <thread>

namespace {
constexpr DWORD rate = 48000;
constexpr DWORD frames = 480;
constexpr double pi = 3.14159265358979323846;
std::atomic_uint64_t played{0};
std::atomic_bool failed{false};
HANDLE stopped = nullptr;
unsigned tone_offset = 0;
unsigned phase_ms = 0;
bool keep_audio_after_close = false;

void renderAudio() {
  HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HWAVEOUT device = nullptr;
  WAVEFORMATEX format{WAVE_FORMAT_PCM, 2, rate, rate * 4, 4, 16, 0};
  if (!event || waveOutOpen(&device, WAVE_MAPPER, &format, reinterpret_cast<DWORD_PTR>(event), 0,
                            CALLBACK_EVENT) != MMSYSERR_NOERROR) {
    if (event) CloseHandle(event);
    failed = true;
    return;
  }
  std::array<std::array<std::int16_t, frames * 2>, 4> data{};
  std::array<WAVEHDR, 4> headers{};
  std::array<bool, 4> submitted{};
  const auto phase_frames = static_cast<std::uint64_t>(phase_ms) * rate / 1000;
  std::uint64_t next_frame = phase_frames;
  std::size_t prepared = 0;
  for (std::size_t i = 0; i < headers.size(); ++i) {
    headers[i].lpData = reinterpret_cast<LPSTR>(data[i].data());
    headers[i].dwBufferLength = static_cast<DWORD>(sizeof(data[i]));
    if (waveOutPrepareHeader(device, &headers[i], sizeof(WAVEHDR)) != MMSYSERR_NOERROR) {
      failed = true;
      break;
    }
    ++prepared;
  }
  HANDLE events[]{stopped, event};
  while (!failed && WaitForSingleObject(stopped, 0) != WAIT_OBJECT_0) {
    for (std::size_t i = 0; i < prepared; ++i) {
      if (submitted[i] && !(headers[i].dwFlags & WHDR_DONE)) continue;
      for (DWORD sample = 0; sample < frames; ++sample) {
        const auto position = next_frame + sample;
        const auto second = position / rate;
        const bool pulse = second > 0 && position % rate < rate / 10;
        // A frequency-coded second number distinguishes missing/delayed pulses.
        const double frequency = 600.0 + 100.0 * static_cast<double>((second + tone_offset) % 16);
        const auto value =
            pulse
                ? static_cast<std::int16_t>(
                      1500.0 * std::sin(2 * pi * frequency * static_cast<double>(position) / rate))
                : std::int16_t{0};
        data[i][sample * 2] = data[i][sample * 2 + 1] = value;
      }
      next_frame += frames;
      if (waveOutWrite(device, &headers[i], sizeof(WAVEHDR)) != MMSYSERR_NOERROR) {
        failed = true;
        break;
      }
      submitted[i] = true;
    }
    MMTIME position{};
    position.wType = TIME_SAMPLES;
    if (waveOutGetPosition(device, &position, sizeof(position)) == MMSYSERR_NOERROR &&
        position.wType == TIME_SAMPLES)
      played = position.u.sample + phase_frames;
    if (WaitForMultipleObjects(2, events, FALSE, 1000) == WAIT_FAILED) {
      failed = true;
      break;
    }
  }
  waveOutReset(device);
  for (std::size_t i = 0; i < prepared; ++i)
    waveOutUnprepareHeader(device, &headers[i], sizeof(WAVEHDR));
  waveOutClose(device);
  CloseHandle(event);
}
LRESULT CALLBACK windowProcedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_TIMER) {
    if (failed)
      DestroyWindow(window);
    else
      InvalidateRect(window, nullptr, FALSE);
    return 0;
  }
  if (message == WM_PAINT) {
    PAINTSTRUCT paint{};
    const auto window_dc = BeginPaint(window, &paint);
    RECT bounds{};
    GetClientRect(window, &bounds);
    const auto dc = CreateCompatibleDC(window_dc);
    const auto bitmap = CreateCompatibleBitmap(window_dc, bounds.right, bounds.bottom);
    if (!dc || !bitmap) {
      if (bitmap) DeleteObject(bitmap);
      if (dc) DeleteDC(dc);
      failed = true;
      EndPaint(window, &paint);
      return 0;
    }
    const auto previous = SelectObject(dc, bitmap);
    const auto position = played.load();
    // A 100 ms plateau spans multiple frames at the 30 fps test profile.
    // The rising edge still follows the played sample clock exactly.
    const bool pulse = position >= rate && position % rate < rate / 10;
    FillRect(dc, &bounds, static_cast<HBRUSH>(GetStockObject(pulse ? WHITE_BRUSH : BLACK_BRUSH)));
    const auto code = (position / rate + tone_offset) % 16;
    for (unsigned bit = 0; bit < 4; ++bit) {
      RECT cell{bounds.right * static_cast<LONG>(2 + bit) / 8, bounds.bottom / 4,
                bounds.right * static_cast<LONG>(3 + bit) / 8, bounds.bottom * 9 / 20};
      FillRect(
          dc, &cell,
          static_cast<HBRUSH>(GetStockObject((code & (1ULL << bit)) ? WHITE_BRUSH : BLACK_BRUSH)));
    }
    // The visible transition follows the device's played sample position, not
    // submission time or a manually chosen A/V offset.
    BitBlt(window_dc, 0, 0, bounds.right, bounds.bottom, dc, 0, 0, SRCCOPY);
    SelectObject(dc, previous);
    DeleteObject(bitmap);
    DeleteDC(dc);
    EndPaint(window, &paint);
    return 0;
  }
  if (message == WM_DESTROY) {
    if (!keep_audio_after_close) {
      SetEvent(stopped);
      PostQuitMessage(0);
    }
    return 0;
  }
  return DefWindowProcW(window, message, wparam, lparam);
}
}  // namespace
int main(int argc, char** argv) {
  if (argc >= 2) tone_offset = static_cast<unsigned>(std::stoul(argv[1]));
  if (argc >= 3) phase_ms = static_cast<unsigned>(std::stoul(argv[2]));
  if (argc == 4) keep_audio_after_close = std::string(argv[3]) == "keep-audio";
  if (argc > 4 || tone_offset >= 16 || phase_ms >= 1000 || (argc == 4 && !keep_audio_after_close))
    return 1;
  stopped = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!stopped) return 1;
  const auto instance = GetModuleHandleW(nullptr);
  WNDCLASSW type{};
  type.lpfnWndProc = windowProcedure;
  type.hInstance = instance;
  type.lpszClassName = L"SyrnikeAudioSyncFixture";
  if (!RegisterClassW(&type)) {
    CloseHandle(stopped);
    return 1;
  }
  const auto window = CreateWindowExW(0, type.lpszClassName, L"Syrnike audio sync fixture",
                                      WS_OVERLAPPEDWINDOW | WS_VISIBLE, tone_offset ? 820 : 120,
                                      120, 640, 400, nullptr, nullptr, instance, nullptr);
  if (!window) {
    CloseHandle(stopped);
    return 1;
  }
  // The harness hides the console through STARTUPINFO. Explicitly show the
  // capture fixture itself after creation without stealing keyboard focus.
  ShowWindow(window, SW_SHOWNOACTIVATE);
  SetTimer(window, 1, 10, nullptr);
  std::thread audio(renderAudio);
  std::cout << "AUDIO_FIXTURE_READY " << GetCurrentProcessId() << std::endl;
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  SetEvent(stopped);
  audio.join();
  CloseHandle(stopped);
  return failed ? 1 : 0;
}
