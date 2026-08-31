#include <windows.h>

#include <atomic>
#include <iostream>
#include <string>
#include <thread>

namespace {

constexpr wchar_t kClassName[] = L"SyrnikeSourceFixtureWindow";
constexpr UINT kSetTitle = WM_APP + 1;
constexpr UINT kCreateSecond = WM_APP + 2;
constexpr UINT kDestroyPrimary = WM_APP + 3;
constexpr UINT kCreatePrimary = WM_APP + 4;
constexpr UINT kHang = WM_APP + 5;
constexpr UINT kMinimize = WM_APP + 6;
constexpr UINT kRestore = WM_APP + 7;
constexpr UINT kRapidRecreate = WM_APP + 8;
constexpr UINT kHide = WM_APP + 9;
constexpr UINT kShow = WM_APP + 10;
constexpr UINT kCloseSecond = WM_APP + 11;
constexpr UINT kSetSecondTitle = WM_APP + 12;

std::atomic<HWND> primary_window = nullptr;
HWND second_window = nullptr;
HWND controller_window = nullptr;
HANDLE hang_release = nullptr;
HANDLE hang_entered = nullptr;
bool rapid_recycled = false;
int rapid_attempts = 0;

HWND createSourceWindow(const wchar_t* title, int offset) {
  return CreateWindowExW(0, kClassName, title, WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                         120 + offset, 120 + offset, 640, 360, nullptr, nullptr,
                         GetModuleHandleW(nullptr), nullptr);
}

LRESULT CALLBACK windowProcedure(HWND window, UINT message, WPARAM wparam,
                                 LPARAM lparam) {
  if (message == kHang) {
    SetEvent(hang_entered);
    WaitForSingleObject(hang_release, INFINITE);
    return 0;
  }
  if (window != controller_window) return DefWindowProcW(window, message, wparam, lparam);
  switch (message) {
    case kSetTitle: {
      const auto* title = reinterpret_cast<const wchar_t*>(lparam);
      SetWindowTextW(primary_window.load(), title);
      return 0;
    }
    case kCreateSecond:
      if (second_window == nullptr) {
        second_window = createSourceWindow(L"Syrnike Source Fixture Second", 60);
      }
      return 0;
    case kSetSecondTitle: {
      const auto* title = reinterpret_cast<const wchar_t*>(lparam);
      if (second_window != nullptr) SetWindowTextW(second_window, title);
      return 0;
    }
    case kDestroyPrimary: {
      const HWND current = primary_window.exchange(nullptr);
      if (current != nullptr) DestroyWindow(current);
      return 0;
    }
    case kCreatePrimary:
      if (primary_window.load() == nullptr) {
        primary_window = createSourceWindow(L"Syrnike Source Fixture Recreated", 0);
      }
      return 0;
    case kMinimize:
      ShowWindow(primary_window.load(), SW_MINIMIZE);
      return 0;
    case kRestore:
      ShowWindow(primary_window.load(), SW_RESTORE);
      return 0;
    case kRapidRecreate: {
      const HWND current = primary_window.exchange(nullptr);
      if (current != nullptr) DestroyWindow(current);
      rapid_recycled = false;
      rapid_attempts = 0;
      for (int attempt = 1; attempt <= 64; ++attempt) {
        const HWND replacement =
            createSourceWindow(L"Syrnike Source Fixture Rapid", 0);
        rapid_attempts = attempt;
        if (replacement == current) {
          rapid_recycled = true;
          primary_window = replacement;
          break;
        }
        if (attempt == 64) {
          primary_window = replacement;
          break;
        }
        DestroyWindow(replacement);
      }
      return 0;
    }
    case kHide:
      ShowWindow(primary_window.load(), SW_HIDE);
      return 0;
    case kShow:
      ShowWindow(primary_window.load(), SW_SHOW);
      return 0;
    case kCloseSecond:
      if (second_window != nullptr) {
        DestroyWindow(second_window);
        second_window = nullptr;
      }
      return 0;
    case WM_CLOSE:
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(window, message, wparam, lparam);
  }
}

void acknowledge(const char* command) {
  std::cout << "OK " << command << std::endl;
}

void controlLoop() {
  std::string command;
  while (std::getline(std::cin, command)) {
    if (command.rfind("title ", 0) == 0) {
      const std::string text = command.substr(6);
      const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                                text.data(),
                                                static_cast<int>(text.size()),
                                                nullptr, 0);
      std::wstring wide(static_cast<std::size_t>(required), L'\0');
      if (required > 0) {
        MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                            static_cast<int>(text.size()), wide.data(), required);
      }
      SendMessageW(controller_window, kSetTitle, 0,
                   reinterpret_cast<LPARAM>(wide.c_str()));
      acknowledge("title");
    } else if (command.rfind("second-title ", 0) == 0) {
      const std::string text = command.substr(13);
      const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                                text.data(),
                                                static_cast<int>(text.size()),
                                                nullptr, 0);
      std::wstring wide(static_cast<std::size_t>(required), L'\0');
      if (required > 0) {
        MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                            static_cast<int>(text.size()), wide.data(), required);
      }
      SendMessageW(controller_window, kSetSecondTitle, 0,
                   reinterpret_cast<LPARAM>(wide.c_str()));
      acknowledge("second-title");
    } else if (command == "second") {
      SendMessageW(controller_window, kCreateSecond, 0, 0);
      acknowledge("second");
    } else if (command == "minimize") {
      SendMessageW(controller_window, kMinimize, 0, 0);
      acknowledge("minimize");
    } else if (command == "restore") {
      SendMessageW(controller_window, kRestore, 0, 0);
      acknowledge("restore");
    } else if (command == "hang") {
      ResetEvent(hang_release);
      ResetEvent(hang_entered);
      if (!PostMessageW(primary_window.load(), kHang, 0, 0)) {
        std::cout << "ERROR hang-post" << std::endl;
      } else if (WaitForSingleObject(hang_entered, 1000) != WAIT_OBJECT_0) {
        std::cout << "ERROR hang-entry-timeout" << std::endl;
      } else {
        acknowledge("hang");
      }
    } else if (command == "unhang") {
      SetEvent(hang_release);
      acknowledge("unhang");
    } else if (command == "destroy") {
      SendMessageW(controller_window, kDestroyPrimary, 0, 0);
      acknowledge("destroy");
    } else if (command == "create") {
      SendMessageW(controller_window, kCreatePrimary, 0, 0);
      acknowledge("create");
    } else if (command == "rapid") {
      SendMessageW(controller_window, kRapidRecreate, 0, 0);
      std::cout << "OK rapid recycled=" << (rapid_recycled ? 1 : 0)
                << " attempts=" << rapid_attempts << std::endl;
    } else if (command == "close-second") {
      SendMessageW(controller_window, kCloseSecond, 0, 0);
      acknowledge("close-second");
    } else if (command == "hide") {
      SendMessageW(controller_window, kHide, 0, 0);
      acknowledge("hide");
    } else if (command == "show") {
      SendMessageW(controller_window, kShow, 0, 0);
      acknowledge("show");
    } else if (command == "quit") {
      SetEvent(hang_release);
      PostMessageW(controller_window, WM_CLOSE, 0, 0);
      acknowledge("quit");
      return;
    } else {
      std::cout << "ERROR unknown-command" << std::endl;
    }
  }
  SetEvent(hang_release);
  PostMessageW(controller_window, WM_CLOSE, 0, 0);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  WNDCLASSW window_class{};
  window_class.lpfnWndProc = windowProcedure;
  window_class.hInstance = instance;
  window_class.lpszClassName = kClassName;
  if (RegisterClassW(&window_class) == 0) return 2;
  hang_release = CreateEventW(nullptr, TRUE, TRUE, nullptr);
  hang_entered = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (hang_release == nullptr || hang_entered == nullptr) return 3;
  controller_window = CreateWindowExW(0, kClassName, L"", 0, 0, 0, 0, 0,
                                      HWND_MESSAGE, nullptr, instance, nullptr);
  primary_window = createSourceWindow(L"Syrnike Source Fixture Primary", 0);
  if (controller_window == nullptr || primary_window.load() == nullptr) return 4;

  std::thread control(controlLoop);
  std::cout << "READY" << std::endl;
  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  SetEvent(hang_release);
  control.join();
  if (second_window != nullptr) DestroyWindow(second_window);
  const HWND primary = primary_window.exchange(nullptr);
  if (primary != nullptr) DestroyWindow(primary);
  DestroyWindow(controller_window);
  CloseHandle(hang_release);
  CloseHandle(hang_entered);
  return 0;
}
