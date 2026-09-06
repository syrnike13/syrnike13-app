#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <cwchar>
#include <memory>

namespace {

std::uint32_t frame_number = 0;

LRESULT CALLBACK windowProcedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  switch (message) {
    case WM_TIMER:
      if (wparam == 2) {
        DestroyWindow(window);
        return 0;
      }
      return 0;
    case WM_PAINT: {
      PAINTSTRUCT paint{};
      const HDC device = BeginPaint(window, &paint);
      RECT client{};
      GetClientRect(window, &client);
      const auto red = static_cast<int>((frame_number * 13U) % 224U) + 16;
      const auto green = static_cast<int>((frame_number * 29U) % 224U) + 16;
      const auto blue = static_cast<int>((frame_number * 47U) % 224U) + 16;
      const HBRUSH background = CreateSolidBrush(RGB(red, green, blue));
      FillRect(device, &client, background);
      DeleteObject(background);
      const int width = (std::max)(client.right - client.left, 1L);
      const int x = static_cast<int>((frame_number * 11U) % static_cast<std::uint32_t>(width));
      RECT bar{x, 0, (std::min)(x + 96, width), client.bottom};
      const HBRUSH foreground = CreateSolidBrush(RGB(255 - red, 255 - green, 255 - blue));
      FillRect(device, &bar, foreground);
      DeleteObject(foreground);
      wchar_t marker[128]{};
      _snwprintf_s(marker, std::size(marker), _TRUNCATE, L"frame=%u marker=%llu", frame_number,
                   static_cast<unsigned long long>(GetTickCount64()));
      SetBkMode(device, TRANSPARENT);
      SetTextColor(device, RGB(255 - red, 255 - green, 255 - blue));
      RECT text_bounds{24, 24, client.right - 24, client.bottom - 24};
      DrawTextW(device, marker, -1, &text_bounds, DT_LEFT | DT_TOP | DT_SINGLELINE);
      EndPaint(window, &paint);
      return 0;
    }
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(window, message, wparam, lparam);
  }
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR command_line, int) {
  constexpr wchar_t class_name[] = L"SyrnikeMonitorPatternFixture";
  WNDCLASSW window_class{};
  window_class.lpfnWndProc = windowProcedure;
  window_class.hInstance = instance;
  window_class.lpszClassName = class_name;
  window_class.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
  if (!RegisterClassW(&window_class)) return 2;

  POINT origin{};
  if (swscanf_s(command_line, L"--monitor-point %ld %ld", &origin.x, &origin.y) != 2) {
    return 3;
  }
  const HMONITOR monitor = MonitorFromPoint(origin, MONITOR_DEFAULTTONULL);
  if (monitor == nullptr) return 4;
  MONITORINFO info{sizeof(info)};
  if (!GetMonitorInfoW(monitor, &info)) return 5;
  const bool static_fullscreen = wcsstr(command_line, L"--static-fullscreen") != nullptr;
  const int width = static_fullscreen ? info.rcMonitor.right - info.rcMonitor.left : 640;
  const int height = static_fullscreen ? info.rcMonitor.bottom - info.rcMonitor.top : 360;
  const int x = static_fullscreen
                    ? info.rcMonitor.left
                    : info.rcWork.left + ((info.rcWork.right - info.rcWork.left) - width) / 2;
  const int y = static_fullscreen
                    ? info.rcMonitor.top
                    : info.rcWork.top + ((info.rcWork.bottom - info.rcWork.top) - height) / 2;
  const HWND window = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_NOACTIVATE, class_name, L"Syrnike Monitor Capture Pattern",
      (static_fullscreen ? WS_POPUP : WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU) | WS_VISIBLE, x, y,
      width, height, nullptr, nullptr, instance, nullptr);
  if (!window) return 6;
  if (static_fullscreen && !SetTimer(window, 2, 75000, nullptr)) return 7;

  // WM_TIMER coalescing can undersupply a 60 fps capture test even at 10 ms.
  // This fixture uses one private high-resolution timer, with no global timer
  // resolution change and no animation thread. WGC already requires a Windows
  // version newer than the high-resolution timer's Windows 10 1803 minimum.
  const std::unique_ptr<void, decltype(&CloseHandle)> animation_timer{
      static_fullscreen
          ? nullptr
          : CreateWaitableTimerExW(nullptr, nullptr, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                                   TIMER_MODIFY_STATE | SYNCHRONIZE),
      &CloseHandle};
  if (!static_fullscreen) {
    LARGE_INTEGER due{};
    due.QuadPart = -80'000;
    if (!animation_timer ||
        !SetWaitableTimer(animation_timer.get(), &due, 8, nullptr, nullptr, FALSE))
      return 7;
  }

  MSG message{};
  if (animation_timer) {
    const HANDLE timer = animation_timer.get();
    for (;;) {
      const auto ready =
          MsgWaitForMultipleObjectsEx(1, &timer, INFINITE, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
      if (ready == WAIT_FAILED) return 8;
      if (ready == WAIT_OBJECT_0) {
        ++frame_number;
        InvalidateRect(window, nullptr, FALSE);
      }
      while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
        if (message.message == WM_QUIT) return 0;
        TranslateMessage(&message);
        DispatchMessageW(&message);
      }
    }
  }
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  return 0;
}
