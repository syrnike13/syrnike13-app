#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <cwchar>

namespace {

std::uint32_t frame_number = 0;

LRESULT CALLBACK windowProcedure(HWND window, UINT message, WPARAM wparam,
                                 LPARAM lparam) {
  switch (message) {
    case WM_TIMER:
      ++frame_number;
      InvalidateRect(window, nullptr, FALSE);
      return 0;
    case WM_PAINT: {
      PAINTSTRUCT paint{};
      const HDC device = BeginPaint(window, &paint);
      RECT client{};
      GetClientRect(window, &client);
      const auto red = static_cast<int>((frame_number * 13U) % 224U) + 16;
      const auto green = static_cast<int>((frame_number * 29U) % 224U) + 16;
      const auto blue = static_cast<int>((frame_number * 47U) % 224U) + 16;
      const HBRUSH background =
          CreateSolidBrush(RGB(red, green, blue));
      FillRect(device, &client, background);
      DeleteObject(background);
      const int width = (std::max)(client.right - client.left, 1L);
      const int x = static_cast<int>((frame_number * 11U) %
                                     static_cast<std::uint32_t>(width));
      RECT bar{x, 0, (std::min)(x + 96, width), client.bottom};
      const HBRUSH foreground =
          CreateSolidBrush(RGB(255 - red, 255 - green, 255 - blue));
      FillRect(device, &bar, foreground);
      DeleteObject(foreground);
      wchar_t marker[128]{};
      _snwprintf_s(marker, std::size(marker), _TRUNCATE,
                   L"frame=%u marker=%llu", frame_number,
                   static_cast<unsigned long long>(GetTickCount64()));
      SetBkMode(device, TRANSPARENT);
      SetTextColor(device, RGB(255 - red, 255 - green, 255 - blue));
      RECT text_bounds{24, 24, client.right - 24, client.bottom - 24};
      DrawTextW(device, marker, -1, &text_bounds,
                DT_LEFT | DT_TOP | DT_SINGLELINE);
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
  if (swscanf_s(command_line, L"--monitor-point %ld %ld", &origin.x,
                &origin.y) != 2) {
    return 3;
  }
  const HMONITOR monitor = MonitorFromPoint(origin, MONITOR_DEFAULTTONULL);
  if (monitor == nullptr) return 4;
  MONITORINFO info{sizeof(info)};
  if (!GetMonitorInfoW(monitor, &info)) return 5;
  const int width = 640;
  const int height = 360;
  const int x = info.rcWork.left +
                ((info.rcWork.right - info.rcWork.left) - width) / 2;
  const int y = info.rcWork.top +
                ((info.rcWork.bottom - info.rcWork.top) - height) / 2;
  const HWND window = CreateWindowExW(
      WS_EX_TOPMOST, class_name, L"Syrnike Monitor Capture Pattern",
      WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE, x, y, width,
      height, nullptr, nullptr, instance, nullptr);
  if (!window) return 6;
  if (!SetTimer(window, 1, 16, nullptr)) return 7;

  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  return 0;
}
