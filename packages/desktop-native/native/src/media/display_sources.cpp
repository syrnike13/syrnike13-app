#include "display_sources.hpp"

#include <dwmapi.h>
#include <windows.h>
#include <shellapi.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <sstream>
#include <string>
#include <vector>

namespace syrnike::desktop_native::media {
namespace {

struct ScreenSource {
  std::string id;
  std::string name;
  std::string type;
  std::string thumbnail_data_url;
  std::string app_icon_data_url;
  DWORD process_id = 0;
  std::string process_path;
  std::string classification;
  bool audio_available = false;
  std::string audio_mode;
};

struct WindowEnumContext {
  std::vector<ScreenSource>* sources = nullptr;
  HWND excluded_window = nullptr;
};

const char kBase64Alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64Encode(const std::vector<std::uint8_t>& bytes) {
  std::string out;
  out.reserve(((bytes.size() + 2) / 3) * 4);
  for (size_t i = 0; i < bytes.size(); i += 3) {
    const uint32_t b0 = bytes[i];
    const uint32_t b1 = i + 1 < bytes.size() ? bytes[i + 1] : 0;
    const uint32_t b2 = i + 2 < bytes.size() ? bytes[i + 2] : 0;
    const uint32_t packed = (b0 << 16) | (b1 << 8) | b2;
    out.push_back(kBase64Alphabet[(packed >> 18) & 0x3F]);
    out.push_back(kBase64Alphabet[(packed >> 12) & 0x3F]);
    out.push_back(i + 1 < bytes.size() ? kBase64Alphabet[(packed >> 6) & 0x3F] : '=');
    out.push_back(i + 2 < bytes.size() ? kBase64Alphabet[packed & 0x3F] : '=');
  }
  return out;
}

void appendU16(std::vector<std::uint8_t>& bytes, std::uint16_t value) {
  bytes.push_back(static_cast<std::uint8_t>(value & 0xFF));
  bytes.push_back(static_cast<std::uint8_t>((value >> 8) & 0xFF));
}

void appendU32(std::vector<std::uint8_t>& bytes, std::uint32_t value) {
  bytes.push_back(static_cast<std::uint8_t>(value & 0xFF));
  bytes.push_back(static_cast<std::uint8_t>((value >> 8) & 0xFF));
  bytes.push_back(static_cast<std::uint8_t>((value >> 16) & 0xFF));
  bytes.push_back(static_cast<std::uint8_t>((value >> 24) & 0xFF));
}

std::string bmpDataUrl(const std::vector<std::uint8_t>& bgra, int width, int height) {
  if (bgra.empty() || width <= 0 || height <= 0) return {};

  constexpr std::uint32_t file_header_size = 14;
  constexpr std::uint32_t info_header_size = 40;
  const std::uint32_t pixel_bytes = static_cast<std::uint32_t>(bgra.size());
  const std::uint32_t data_offset = file_header_size + info_header_size;

  std::vector<std::uint8_t> bmp;
  bmp.reserve(data_offset + bgra.size());
  appendU16(bmp, 0x4D42);
  appendU32(bmp, data_offset + pixel_bytes);
  appendU16(bmp, 0);
  appendU16(bmp, 0);
  appendU32(bmp, data_offset);

  appendU32(bmp, info_header_size);
  appendU32(bmp, static_cast<std::uint32_t>(width));
  appendU32(bmp, static_cast<std::uint32_t>(-height));
  appendU16(bmp, 1);
  appendU16(bmp, 32);
  appendU32(bmp, BI_RGB);
  appendU32(bmp, pixel_bytes);
  appendU32(bmp, 0);
  appendU32(bmp, 0);
  appendU32(bmp, 0);
  appendU32(bmp, 0);
  bmp.insert(bmp.end(), bgra.begin(), bgra.end());
  return "data:image/bmp;base64," + base64Encode(bmp);
}

std::string captureThumbnailDataUrl(HWND hwnd, const RECT& rect) {
  constexpr int thumb_width = 320;
  constexpr int thumb_height = 180;
  const int source_width = rect.right - rect.left;
  const int source_height = rect.bottom - rect.top;
  if (source_width <= 0 || source_height <= 0) return {};

  HDC source_dc = hwnd ? GetWindowDC(hwnd) : GetDC(nullptr);
  if (!source_dc) return {};

  HDC memory_dc = CreateCompatibleDC(source_dc);
  if (!memory_dc) {
    ReleaseDC(hwnd, source_dc);
    return {};
  }

  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = thumb_width;
  info.bmiHeader.biHeight = -thumb_height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;

  void* bits = nullptr;
  HBITMAP bitmap = CreateDIBSection(source_dc, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!bitmap || !bits) {
    DeleteDC(memory_dc);
    ReleaseDC(hwnd, source_dc);
    return {};
  }

  HGDIOBJ old = SelectObject(memory_dc, bitmap);
  SetStretchBltMode(memory_dc, HALFTONE);
  const BOOL copied = StretchBlt(
      memory_dc,
      0,
      0,
      thumb_width,
      thumb_height,
      source_dc,
      hwnd ? 0 : rect.left,
      hwnd ? 0 : rect.top,
      source_width,
      source_height,
      SRCCOPY | CAPTUREBLT);

  std::string data_url;
  if (copied) {
    std::vector<std::uint8_t> bgra(static_cast<size_t>(thumb_width) * thumb_height * 4);
    std::memcpy(bgra.data(), bits, bgra.size());
    data_url = bmpDataUrl(bgra, thumb_width, thumb_height);
  }

  SelectObject(memory_dc, old);
  DeleteObject(bitmap);
  DeleteDC(memory_dc);
  ReleaseDC(hwnd, source_dc);
  return data_url;
}

std::wstring processImagePath(DWORD process_id) {
  if (process_id == 0) return {};
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id);
  if (!process) return {};

  wchar_t path[MAX_PATH]{};
  DWORD path_size = MAX_PATH;
  const BOOL got_path = QueryFullProcessImageNameW(process, 0, path, &path_size);
  CloseHandle(process);
  if (!got_path) return {};
  return std::wstring(path, path_size);
}

std::string iconDataUrl(HICON icon) {
  if (!icon) return {};

  constexpr int icon_size = 32;
  HDC screen_dc = GetDC(nullptr);
  if (!screen_dc) return {};

  HDC memory_dc = CreateCompatibleDC(screen_dc);
  if (!memory_dc) {
    ReleaseDC(nullptr, screen_dc);
    return {};
  }

  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = icon_size;
  info.bmiHeader.biHeight = -icon_size;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;

  void* bits = nullptr;
  HBITMAP bitmap = CreateDIBSection(screen_dc, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!bitmap || !bits) {
    DeleteDC(memory_dc);
    ReleaseDC(nullptr, screen_dc);
    return {};
  }

  HGDIOBJ old = SelectObject(memory_dc, bitmap);
  RECT clear_rect{0, 0, icon_size, icon_size};
  FillRect(memory_dc, &clear_rect, reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
  const BOOL drawn = DrawIconEx(
      memory_dc,
      0,
      0,
      icon,
      icon_size,
      icon_size,
      0,
      nullptr,
      DI_NORMAL);

  std::string data_url;
  if (drawn) {
    std::vector<std::uint8_t> bgra(static_cast<size_t>(icon_size) * icon_size * 4);
    std::memcpy(bgra.data(), bits, bgra.size());
    data_url = bmpDataUrl(bgra, icon_size, icon_size);
  }

  SelectObject(memory_dc, old);
  DeleteObject(bitmap);
  DeleteDC(memory_dc);
  ReleaseDC(nullptr, screen_dc);
  return data_url;
}

std::string appIconDataUrl(HWND hwnd, DWORD process_id) {
  HICON icon = reinterpret_cast<HICON>(SendMessageW(hwnd, WM_GETICON, ICON_SMALL2, 0));
  if (!icon) icon = reinterpret_cast<HICON>(SendMessageW(hwnd, WM_GETICON, ICON_SMALL, 0));
  if (!icon) icon = reinterpret_cast<HICON>(GetClassLongPtrW(hwnd, GCLP_HICONSM));
  if (!icon) icon = reinterpret_cast<HICON>(GetClassLongPtrW(hwnd, GCLP_HICON));
  if (icon) return iconDataUrl(icon);

  const std::wstring path = processImagePath(process_id);
  if (path.empty()) return {};

  HICON small_icon = nullptr;
  HICON large_icon = nullptr;
  const UINT extracted = ExtractIconExW(path.c_str(), 0, &large_icon, &small_icon, 1);
  HICON extracted_icon = small_icon ? small_icon : large_icon;
  std::string data_url;
  if (extracted > 0 && extracted_icon) {
    data_url = iconDataUrl(extracted_icon);
  }
  if (small_icon) DestroyIcon(small_icon);
  if (large_icon) DestroyIcon(large_icon);
  return data_url;
}

std::string gameClassification(HWND hwnd, const RECT& rect, const std::wstring& process_path) {
  const LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
  const LONG_PTR ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  if ((ex_style & WS_EX_TOOLWINDOW) != 0) return "window";
  if (process_path.empty()) return "window";

  std::wstring lower_path(process_path);
  for (wchar_t& ch : lower_path) {
    ch = static_cast<wchar_t>(towlower(ch));
  }
  if (lower_path.find(L"\\windows\\systemapps\\") != std::wstring::npos) return "window";
  if (lower_path.find(L"\\windows\\system32\\") != std::wstring::npos) return "window";
  if (lower_path.find(L"\\windows\\syswow64\\") != std::wstring::npos) return "window";

  const std::vector<std::wstring> game_path_markers = {
      L"\\steamapps\\common\\",
      L"\\epic games\\",
      L"\\gog games\\",
      L"\\gog galaxy\\games\\",
      L"\\xboxgames\\",
      L"\\riot games\\",
      L"\\battle.net\\",
      L"\\ubisoft game launcher\\games\\",
      L"\\ea games\\",
      L"\\origin games\\",
  };
  for (const auto& marker : game_path_markers) {
    if (lower_path.find(marker) != std::wstring::npos) return "game_path";
  }

  const bool popup = (style & WS_POPUP) != 0;
  const bool captionless = (style & WS_CAPTION) == 0;
  if (!popup && !captionless) return "window";

  HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  MONITORINFO info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(monitor, &info)) return "window";

  const int width = rect.right - rect.left;
  const int height = rect.bottom - rect.top;
  const int monitor_width = info.rcMonitor.right - info.rcMonitor.left;
  const int monitor_height = info.rcMonitor.bottom - info.rcMonitor.top;
  const long long area = static_cast<long long>(width) * height;
  const long long monitor_area = static_cast<long long>(monitor_width) * monitor_height;
  if (monitor_area <= 0 || area * 100 < monitor_area * 70) return "window";
  return "fullscreen_or_borderless";
}

bool isCloakedWindow(HWND hwnd) {
  DWORD cloaked = 0;
  const HRESULT hr = DwmGetWindowAttribute(
      hwnd,
      DWMWA_CLOAKED,
      &cloaked,
      sizeof(cloaked));
  return SUCCEEDED(hr) && cloaked != 0;
}

std::string toUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(
      CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string out(size, '\0');
  WideCharToMultiByte(
      CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), size, nullptr, nullptr);
  return out;
}

BOOL CALLBACK enumMonitorProc(
    HMONITOR monitor, HDC, LPRECT, LPARAM data) {
  auto* sources = reinterpret_cast<std::vector<ScreenSource>*>(data);

  MONITORINFOEXW info{};
  info.cbSize = sizeof(info);
  if (!GetMonitorInfoW(monitor, &info)) return TRUE;

  const int index = static_cast<int>(sources->size()) + 1;
  const int width = info.rcMonitor.right - info.rcMonitor.left;
  const int height = info.rcMonitor.bottom - info.rcMonitor.top;

  std::ostringstream name;
  name << "Screen " << index << " (" << width << "x" << height << ")";
  sources->push_back({
      "screen:" + std::to_string(index),
      name.str(),
      "screen",
      captureThumbnailDataUrl(nullptr, info.rcMonitor),
      "",
      0,
      "",
      "monitor",
      true,
      "system_exclude",
  });
  return TRUE;
}

BOOL CALLBACK enumWindowProc(HWND hwnd, LPARAM data) {
  if (!IsWindowVisible(hwnd)) return TRUE;
  if (GetAncestor(hwnd, GA_ROOT) != hwnd) return TRUE;
  auto* context = reinterpret_cast<WindowEnumContext*>(data);
  if (context && context->excluded_window && hwnd == context->excluded_window) return TRUE;
  if (isCloakedWindow(hwnd)) return TRUE;

  const LONG_PTR ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  if ((ex_style & WS_EX_TOOLWINDOW) != 0) return TRUE;
  if ((ex_style & WS_EX_NOACTIVATE) != 0) return TRUE;

  RECT rect{};
  if (!GetWindowRect(hwnd, &rect)) return TRUE;
  if (rect.right - rect.left < 80 || rect.bottom - rect.top < 80) return TRUE;

  wchar_t title[512]{};
  const int title_length = GetWindowTextW(hwnd, title, static_cast<int>(std::size(title)));
  if (title_length <= 0) return TRUE;

  auto* sources = context ? context->sources : nullptr;
  if (!sources) return TRUE;
  const auto hwnd_id = std::to_string(reinterpret_cast<uintptr_t>(hwnd));
  DWORD process_id = 0;
  GetWindowThreadProcessId(hwnd, &process_id);
  const std::wstring image_path = processImagePath(process_id);
  const std::string classification = gameClassification(hwnd, rect, image_path);
  const bool game = classification != "window";
  sources->push_back({
      (game ? "game:" : "window:") + hwnd_id,
      toUtf8(std::wstring(title, title_length)),
      game ? "game" : "window",
      captureThumbnailDataUrl(hwnd, rect),
      appIconDataUrl(hwnd, process_id),
      process_id,
      toUtf8(image_path),
      classification,
      process_id != 0,
      process_id != 0 ? "process" : "none",
  });
  return TRUE;
}

}  // namespace

std::vector<DisplaySourceInfo> listDisplaySources(std::uint64_t excluded_window_handle) {
  std::vector<ScreenSource> sources;
  EnumDisplayMonitors(nullptr, nullptr, enumMonitorProc, reinterpret_cast<LPARAM>(&sources));
  WindowEnumContext window_context{
      &sources,
      reinterpret_cast<HWND>(static_cast<std::uintptr_t>(excluded_window_handle)),
  };
  EnumWindows(enumWindowProc, reinterpret_cast<LPARAM>(&window_context));

  std::vector<DisplaySourceInfo> result;
  result.reserve(sources.size());
  for (auto& source : sources) {
    result.push_back(DisplaySourceInfo{
      std::move(source.id),
      std::move(source.name),
      std::move(source.type),
      0,
      source.process_id,
      source.thumbnail_data_url.empty()
        ? std::nullopt
        : std::optional<std::string>(std::move(source.thumbnail_data_url)),
      source.app_icon_data_url.empty()
        ? std::nullopt
        : std::optional<std::string>(std::move(source.app_icon_data_url)),
      source.process_path.empty()
        ? std::nullopt
        : std::optional<std::string>(std::move(source.process_path)),
      std::move(source.classification),
      source.audio_available,
      std::move(source.audio_mode),
    });
  }
  return result;
}

}  // namespace syrnike::desktop_native::media
